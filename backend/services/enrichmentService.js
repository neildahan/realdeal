const { fetchAttomData } = require('./attomService');
const { fetchDatafinitiData, fetchDatafinitiBatch } = require('./datafinitiService');
const { fetchZillowData } = require('./zillowService');
const { scoreDeal } = require('../utils/dealScorer');

const MAX_ENRICH = 15; // Max properties to enrich per search

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

module.exports = { enrichDeal, isWorthEnriching, enrichBatch, MAX_ENRICH };
