/**
 * Scores a property deal from 0-100 based on price discount and distress signals.
 *
 * Breakdown:
 *   40 pts - Price < 75% of market median
 *   30 pts - Mortgage delinquent
 *   10 pts - Days on market > 60
 *   10 pts - Tax lien present
 *   10 pts - Listed as-is / cash only
 */
function scoreDeal(property) {
  let score = 0;

  // Price vs market median (40 pts)
  if (property.price && property.marketMedian && property.marketMedian > 0) {
    const ratio = property.price / property.marketMedian;
    if (ratio < 0.75) {
      score += 40;
    } else if (ratio < 0.80) {
      // Partial credit for 75-80% range
      score += 25;
    } else if (ratio < 0.85) {
      score += 15;
    }
  }

  // Distress indicators
  const d = property.distressIndicators || {};

  if (d.isDelinquent) {
    score += 30;
  }

  if (property.daysOnMarket > 60) {
    score += 10;
  }

  if (d.hasTaxLien) {
    score += 10;
  }

  if (d.isAsIs) {
    score += 10;
  }

  return Math.min(score, 100);
}

/**
 * Compute valuation metadata for frontend display.
 * Returns source label, confidence level, and comp count.
 */
function computeValuationMeta(property) {
  const source = property.valuationSource || 'ppsf_median';
  const comps = property.rentcastAVM?.comparables?.length || 0;

  let confidence;
  if (source === 'zillow+rentcast') {
    confidence = 'high';
  } else if (source === 'rentcast') {
    confidence = 'high';
  } else if (source === 'zillow_per_property') {
    confidence = 'medium';
  } else if (source === 'zillow_search') {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return { source, confidence, compCount: comps };
}

module.exports = { scoreDeal, computeValuationMeta };
