const { fetchAttomData } = require('./attomService');
const { fetchDatafinitiData } = require('./datafinitiService');
const { fetchZillowData } = require('./zillowService');
const { scoreDeal } = require('../utils/dealScorer');

/**
 * Enrich a scraped property with Zillow + ATTOM + Datafiniti data, then score it.
 *
 * Data sources:
 *   - Zillow (Bridge API): Zestimate (market value), public records
 *   - ATTOM: Mortgage delinquency, pre-foreclosure, equity
 *   - Datafiniti: Tax liens, price drop history
 *
 * @param {object} property - Raw scraped property object
 * @returns {object} Enriched property ready for MongoDB save
 */
async function enrichDeal(property) {
  const address = property.address;

  // Call all three APIs in parallel
  const [zillow, attom, datafiniti] = await Promise.all([
    fetchZillowData(address),
    fetchAttomData(address),
    fetchDatafinitiData(address),
  ]);

  // Market median priority: Zestimate > ATTOM > existing
  if (zillow.zestimate) {
    property.marketMedian = zillow.zestimate;
  } else if (attom.marketMedian && !property.marketMedian) {
    property.marketMedian = attom.marketMedian;
  }

  // Days on market from ATTOM if scraper didn't capture it
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

  // Store Zillow extras
  property.zestimate = zillow.zestimate || null;
  property.rentZestimate = zillow.rentZestimate || null;

  // Score the deal
  property.dealScore = scoreDeal(property);

  // Mark as enriched
  property.enriched = true;
  property.enrichedAt = new Date();

  return property;
}

module.exports = { enrichDeal };
