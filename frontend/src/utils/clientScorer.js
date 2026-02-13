/**
 * Client-side deal scoring and market estimation.
 * Uses $/sqft to estimate market value — mirrors backend logic.
 */

export function calculateMedian(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function trimmedMedian(arr) {
  if (arr.length < 5) return calculateMedian(arr);
  const sorted = [...arr].sort((a, b) => a - b);
  const trim = Math.floor(sorted.length * 0.15);
  return calculateMedian(sorted.slice(trim, sorted.length - trim));
}

function isZestimateReliable(zestimate, property) {
  if (!zestimate || zestimate <= 0 || !property.price || property.price <= 0) return false;
  const ratio = zestimate / property.price;
  if (ratio > 2.5 || ratio < 0.4) return false;
  if (property.sqft && property.sqft > 0 && (zestimate / property.sqft) > 2000) return false;
  return true;
}

/**
 * Compute $/sqft and price medians grouped by zip+type and zip.
 * Uses trimmed medians to remove luxury/outlier skew.
 */
export function computeMarketData(properties) {
  const MIN_SAMPLES = 3;
  const ppsf_zipType = {};
  const ppsf_zip = {};
  const price_zipType = {};
  const price_zip = {};

  for (const p of properties) {
    const zip = p.address?.zip || 'unknown';
    const type = p.propertyType || 'unknown';
    if (!p.price || p.price <= 0) continue;

    const key = `${zip}|${type}`;

    if (p.sqft && p.sqft > 0) {
      const ppsf = p.price / p.sqft;
      if (!ppsf_zipType[key]) ppsf_zipType[key] = [];
      ppsf_zipType[key].push(ppsf);
      if (!ppsf_zip[zip]) ppsf_zip[zip] = [];
      ppsf_zip[zip].push(ppsf);
    }

    if (!price_zipType[key]) price_zipType[key] = [];
    price_zipType[key].push(p.price);
    if (!price_zip[zip]) price_zip[zip] = [];
    price_zip[zip].push(p.price);
  }

  const ppsfMedians_zipType = {};
  for (const [key, vals] of Object.entries(ppsf_zipType)) {
    if (vals.length >= MIN_SAMPLES) ppsfMedians_zipType[key] = trimmedMedian(vals);
  }
  const ppsfMedians_zip = {};
  for (const [zip, vals] of Object.entries(ppsf_zip)) {
    if (vals.length >= MIN_SAMPLES) ppsfMedians_zip[zip] = trimmedMedian(vals);
  }
  const priceMedians_zipType = {};
  for (const [key, vals] of Object.entries(price_zipType)) {
    if (vals.length >= MIN_SAMPLES) priceMedians_zipType[key] = trimmedMedian(vals);
  }
  const priceMedians_zip = {};
  for (const [zip, vals] of Object.entries(price_zip)) {
    priceMedians_zip[zip] = trimmedMedian(vals);
  }

  const allPpsf = Object.values(ppsf_zip).flat();
  const areaPpsfMedian = trimmedMedian(allPpsf);
  const allPrices = properties.map((p) => p.price).filter((p) => p && p > 0);
  const areaPriceMedian = trimmedMedian(allPrices);

  return {
    ppsfMedians_zipType, ppsfMedians_zip, areaPpsfMedian,
    priceMedians_zipType, priceMedians_zip, areaPriceMedian,
  };
}

/**
 * Estimate market value for a single property.
 * Priority: verified zestimate > $/sqft estimate > raw price median
 */
export function estimateMarketValue(property, marketData) {
  const {
    ppsfMedians_zipType, ppsfMedians_zip, areaPpsfMedian,
    priceMedians_zipType, priceMedians_zip, areaPriceMedian,
  } = marketData;

  if (isZestimateReliable(property.zestimate, property)) return property.zestimate;

  const zip = property.address?.zip || 'unknown';
  const type = property.propertyType || 'unknown';
  const key = `${zip}|${type}`;
  const sqft = property.sqft;
  const priceMedian = priceMedians_zipType[key] || priceMedians_zip[zip] || areaPriceMedian || 0;

  // $/sqft estimate, cross-validated against price median
  if (sqft && sqft > 0) {
    const ppsf = ppsfMedians_zipType[key] || ppsfMedians_zip[zip] || areaPpsfMedian;
    if (ppsf > 0) {
      const ppsfEstimate = Math.round(ppsf * sqft);
      if (priceMedian > 0) {
        const divergence = ppsfEstimate / priceMedian;
        // Extreme divergence: $/sqft completely unreliable for this size, use price median
        if (divergence > 3 || divergence < 0.25) {
          return priceMedian;
        }
        // Moderate divergence: blend toward price median
        if (divergence > 1.5 || divergence < 0.5) {
          return Math.round(priceMedian * 0.7 + ppsfEstimate * 0.3);
        }
      }
      return ppsfEstimate;
    }
  }

  return priceMedian;
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
