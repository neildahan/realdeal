const { fetchAttomData } = require('./attomService');
const { fetchDatafinitiData, fetchDatafinitiBatch } = require('./datafinitiService');
const { fetchZillowData } = require('./zillowService');
const { fetchRentCastAVM } = require('./rentcastService');
const { scoreDeal, computeValuationMeta } = require('../utils/dealScorer');

const MAX_ENRICH = 15; // Max properties to enrich per search
const MAX_ZILLOW_REFINE = 20; // Max per-property Zillow lookups (Tier 2)
const MAX_RENTCAST = 2; // Max RentCast AVM calls (Tier 3)

/**
 * Check if a property looks like a potential deal worth enriching.
 * Only call expensive APIs on properties that show promise.
 */
function isWorthEnriching(property) {
  // Already flagged as pre-foreclosure by Zillow
  if (property.distressIndicators?.isPreForeclosure) return true;
  // Has distress keywords
  if (property.distressIndicators?.isAsIs) return true;
  // Price is below Zestimate/market (potential deal)
  if (property.price && property.marketMedian && property.price < property.marketMedian * 0.9) return true;
  // Sitting on market a long time
  if (property.daysOnMarket > 45) return true;
  // Significant price drop
  if (property.distressIndicators?.priceDropPercent > 10) return true;
  return false;
}

/**
 * Enrich a property with ATTOM + Datafiniti data, then score it.
 * Skips Zillow API call if the property already has a Zestimate (from search results).
 * Only calls ATTOM/Datafiniti — the expensive distress lookups.
 *
 * @param {object} property - Property object (may already have Zillow data from search)
 * @returns {object} Enriched property ready for MongoDB save
 */
async function enrichDeal(property) {
  const address = property.address;

  // Skip Zillow API if we already have a zestimate from the search results
  const needsZillow = !property.zestimate && !property.marketMedian;

  // Call only the APIs we need in parallel
  const promises = [
    fetchAttomData(address),
    fetchDatafinitiData(address),
  ];
  if (needsZillow) promises.push(fetchZillowData(address));

  const [attom, datafiniti, zillow] = await Promise.all(promises);

  // Market median priority: existing Zestimate > fetched Zestimate > ATTOM
  if (needsZillow && zillow?.zestimate) {
    property.marketMedian = zillow.zestimate;
    property.zestimate = zillow.zestimate;
    property.rentZestimate = zillow.rentZestimate || null;
  } else if (attom.marketMedian && !property.marketMedian) {
    property.marketMedian = attom.marketMedian;
  }

  // Days on market from ATTOM if not already set
  if (attom.daysOnMarket && !property.daysOnMarket) {
    property.daysOnMarket = attom.daysOnMarket;
  }

  // Build distress indicators from all sources
  property.distressIndicators = {
    isDelinquent:
      attom.isDelinquent || property.distressIndicators?.isDelinquent || false,
    isPreForeclosure:
      attom.isPreForeclosure ||
      property.distressIndicators?.isPreForeclosure ||
      false,
    hasTaxLien:
      datafiniti.hasTaxLien ||
      property.distressIndicators?.hasTaxLien ||
      false,
    isAsIs: property.distressIndicators?.isAsIs || false,
    equityPercent: attom.equityPercent,
    priceDropPercent: datafiniti.priceDropPercent || 0,
  };

  // Score the deal
  property.dealScore = scoreDeal(property);

  // Mark as enriched
  property.enriched = true;
  property.enrichedAt = new Date();

  return property;
}

/**
 * Batch enrich multiple properties efficiently.
 * - Caps at MAX_ENRICH properties (sorted by deal potential)
 * - Batches Datafiniti into 1 API call
 * - Only calls ATTOM per-property (no bulk endpoint available)
 *
 * @param {Array} properties - all candidate properties
 * @param {Function} onProgress - optional callback(current, total, address)
 * @returns {Array} enriched properties
 */
async function enrichBatch(properties, onProgress) {
  // Sort by deal potential: lowest price/market ratio first
  const sorted = [...properties].sort((a, b) => {
    const ratioA = a.price && a.marketMedian ? a.price / a.marketMedian : 1;
    const ratioB = b.price && b.marketMedian ? b.price / b.marketMedian : 1;
    return ratioA - ratioB;
  });

  const batch = sorted.slice(0, MAX_ENRICH);
  console.log(`Enriching top ${batch.length} of ${properties.length} candidates`);

  // 1. Batch Datafiniti: 1 API call for all addresses
  const addresses = batch.map((p) => p.address);
  const datafinMap = await fetchDatafinitiBatch(addresses);

  // 2. ATTOM: per-property (no batch endpoint)
  for (let i = 0; i < batch.length; i++) {
    const property = batch[i];
    if (onProgress) onProgress(i + 1, batch.length, property.address?.street);

    try {
      const attom = await fetchAttomData(property.address);
      const datafin = datafinMap.get(property.address.street) ||
        { hasTaxLien: false, priceDropPercent: 0, taxLienAmount: 0 };

      property.distressIndicators = {
        isDelinquent: attom.isDelinquent || property.distressIndicators?.isDelinquent || false,
        isPreForeclosure: attom.isPreForeclosure || property.distressIndicators?.isPreForeclosure || false,
        hasTaxLien: datafin.hasTaxLien || property.distressIndicators?.hasTaxLien || false,
        isAsIs: property.distressIndicators?.isAsIs || false,
        equityPercent: attom.equityPercent,
        priceDropPercent: datafin.priceDropPercent || 0,
      };

      if (attom.marketMedian && !property.marketMedian) {
        property.marketMedian = attom.marketMedian;
      }
      if (attom.daysOnMarket && !property.daysOnMarket) {
        property.daysOnMarket = attom.daysOnMarket;
      }

      property.dealScore = scoreDeal(property);
      property.enriched = true;
      property.enrichedAt = new Date();
    } catch (err) {
      console.error(`Enrich failed for ${property.address?.street}:`, err.message);
      property.dealScore = scoreDeal(property);
    }
  }

  return batch;
}

/**
 * Tier 2: Refine valuations by fetching per-property Zillow data for
 * the top candidates missing a reliable zestimate.
 *
 * @param {Array} properties - all listings (mutated in place)
 * @param {Function} onProgress - optional callback(current, total, address)
 * @returns {number} count of properties refined
 */
async function refineBatchValuations(properties, onProgress) {
  // Filter to properties without a per-property zestimate
  const missing = properties.filter((p) => !p.zestimate || p.valuationSource === 'ppsf_median');

  // Sort by preliminary deal score descending (best candidates first)
  missing.sort((a, b) => (b.dealScore || 0) - (a.dealScore || 0));
  const batch = missing.slice(0, MAX_ZILLOW_REFINE);

  if (batch.length === 0) return 0;
  console.log(`Tier 2: Refining valuations for ${batch.length} candidates`);

  let refined = 0;
  for (let i = 0; i < batch.length; i++) {
    const property = batch[i];
    if (onProgress) onProgress(i + 1, batch.length, property.address?.street);

    try {
      const zillow = await fetchZillowData(property.address);
      if (zillow?.zestimate && zillow.zestimate > 0) {
        // Sanity check: zestimate shouldn't be wildly off from listing price
        const ratio = zillow.zestimate / property.price;
        if (ratio >= 0.4 && ratio <= 2.5) {
          property.zestimate = zillow.zestimate;
          property.marketMedian = zillow.zestimate;
          property.valuationSource = 'zillow_per_property';
          property.rentZestimate = zillow.rentZestimate || property.rentZestimate;
          property.dealScore = scoreDeal(property);
          const meta = computeValuationMeta(property);
          property.valuationConfidence = meta.confidence;
          refined++;
        } else {
          console.log(`Tier 2: Zestimate for "${property.address?.street}" failed sanity (ratio: ${ratio.toFixed(2)})`);
        }
      }
    } catch (err) {
      console.error(`Tier 2: Failed for "${property.address?.street}":`, err.message);
    }
  }

  console.log(`Tier 2: Refined ${refined} of ${batch.length} properties`);
  return refined;
}

/**
 * Tier 3: Validate top deal candidates with RentCast AVM + sold comps.
 * Only called for the best deals to confirm they're real.
 *
 * @param {Array} properties - all listings (mutated in place)
 * @param {Function} onProgress - optional callback(current, total, address)
 * @returns {number} count of properties validated
 */
async function validateTopDeals(properties, onProgress) {
  // Filter to high-score candidates worth validating
  const candidates = properties
    .filter((p) => (p.dealScore || 0) >= 70)
    .sort((a, b) => (b.dealScore || 0) - (a.dealScore || 0))
    .slice(0, MAX_RENTCAST);

  if (candidates.length === 0) return 0;
  console.log(`Tier 3: RentCast validation for ${candidates.length} deals`);

  let validated = 0;
  for (let i = 0; i < candidates.length; i++) {
    const property = candidates[i];
    if (onProgress) onProgress(i + 1, candidates.length, property.address?.street);

    try {
      const avm = await fetchRentCastAVM(property.address);
      if (!avm || !avm.value) continue;

      property.rentcastAVM = avm;

      // Weighted average: if we have both Zillow zestimate and RentCast, blend them
      if (property.zestimate && property.zestimate > 0) {
        // 60% Zillow, 40% RentCast
        property.marketMedian = Math.round(property.zestimate * 0.6 + avm.value * 0.4);
        property.valuationSource = 'zillow+rentcast';
      } else {
        property.marketMedian = avm.value;
        property.valuationSource = 'rentcast';
      }

      property.dealScore = scoreDeal(property);
      const meta = computeValuationMeta(property);
      property.valuationConfidence = meta.confidence;
      validated++;

      console.log(`Tier 3: "${property.address?.street}" → RentCast $${avm.value}, final market $${property.marketMedian}, score ${property.dealScore}`);
    } catch (err) {
      console.error(`Tier 3: Failed for "${property.address?.street}":`, err.message);
    }
  }

  console.log(`Tier 3: Validated ${validated} of ${candidates.length} deals`);
  return validated;
}

module.exports = {
  enrichDeal, isWorthEnriching, enrichBatch, MAX_ENRICH,
  refineBatchValuations, validateTopDeals, MAX_ZILLOW_REFINE, MAX_RENTCAST,
};
