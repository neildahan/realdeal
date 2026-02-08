/**
 * Client-side deal scoring using an area median price.
 * Mirrors backend/utils/dealScorer.js logic.
 */

export function calculateMedian(prices) {
  if (!prices.length) return 0;
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function scoreDealClient(property, overrideMedian) {
  let score = 0;
  const median = overrideMedian ?? property.marketMedian;

  if (property.price && median && median > 0) {
    const ratio = property.price / median;
    if (ratio < 0.75) {
      score += 40;
    } else if (ratio < 0.80) {
      score += 25;
    } else if (ratio < 0.85) {
      score += 15;
    }
  }

  const d = property.distressIndicators || {};

  if (d.isDelinquent) score += 30;
  if (property.daysOnMarket > 60) score += 10;
  if (d.hasTaxLien) score += 10;
  if (d.isAsIs) score += 10;

  return Math.min(score, 100);
}
