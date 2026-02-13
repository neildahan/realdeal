const express = require('express');
const router = express.Router();
const Property = require('../models/Property');
const { runPipeline } = require('../services/pipeline');
const { searchByCoordinates } = require('../services/zillowService');
const { enrichBatch, isWorthEnriching, refineBatchValuations, validateTopDeals } = require('../services/enrichmentService');
const { scoreDeal, computeValuationMeta } = require('../utils/dealScorer');

// GET /api/properties - List all scored properties
router.get('/', async (req, res) => {
  try {
    const { minScore, minDiscount, distressType } = req.query;
    const filter = {};

    if (minScore) {
      filter.dealScore = { $gte: Number(minScore) };
    }

    if (minDiscount) {
      filter.$expr = {
        $lte: [
          '$price',
          { $multiply: ['$marketMedian', 1 - Number(minDiscount) / 100] }
        ]
      };
    }

    if (distressType === 'delinquent') {
      filter['distressIndicators.isDelinquent'] = true;
    } else if (distressType === 'taxLien') {
      filter['distressIndicators.hasTaxLien'] = true;
    } else if (distressType === 'asIs') {
      filter['distressIndicators.isAsIs'] = true;
    }

    const properties = await Property.find(filter).sort({ dealScore: -1 });
    res.json(properties);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: compute median of an array of numbers
function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Helper: trimmed median — removes top/bottom 15% outliers before computing median
function trimmedMedian(arr) {
  if (arr.length < 5) return median(arr);
  const sorted = [...arr].sort((a, b) => a - b);
  const trim = Math.floor(sorted.length * 0.15);
  return median(sorted.slice(trim, sorted.length - trim));
}

// Helper: check if a zestimate is plausible for this listing
function isZestimateReliable(zestimate, listing) {
  if (!zestimate || zestimate <= 0 || !listing.price || listing.price <= 0) return false;
  const ratio = zestimate / listing.price;
  // If zestimate is >2.5x or <0.4x the listing price, it's likely a building/lot value
  if (ratio > 2.5 || ratio < 0.4) return false;
  // For condos: also check $/sqft sanity — a $3M zestimate on 764sqft = $3,927/sqft is absurd
  if (listing.sqft && listing.sqft > 0) {
    const zestPpsf = zestimate / listing.sqft;
    if (zestPpsf > 2000) return false; // No US condo is genuinely $2,000+/sqft in most markets
  }
  return true;
}

/**
 * Check if a property's valuation is trustworthy enough to persist to DB.
 * Prevents saving garbage estimates that haunt future page loads.
 */
function isWorthSaving(listing) {
  // Must have a deal score worth saving
  if (!listing.dealScore || listing.dealScore <= 50) return false;

  // If valuation came from a real source (not just a statistical guess), trust it
  const source = listing.valuationSource;
  if (source === 'zillow_search' || source === 'zillow_per_property' ||
      source === 'rentcast' || source === 'zillow+rentcast') {
    return true;
  }

  // For ppsf_median (statistical estimate): sanity check the implied discount.
  // A -60%+ "discount" on an unverified estimate is almost certainly a bad estimate, not a deal.
  if (listing.price && listing.marketMedian && listing.marketMedian > 0) {
    const ratio = listing.price / listing.marketMedian;
    if (ratio < 0.4) return false; // Implied >60% discount on unverified estimate = don't save
  }

  return true;
}

/**
 * Compute $/sqft medians grouped by zip+type and zip for accurate per-property estimates.
 * Uses trimmed medians to remove luxury/outlier skew.
 */
function computeMarketData(listings) {
  const MIN_SAMPLES = 3;

  const ppsf_zipType = {};   // "33131|condo" => [$/sqft values]
  const ppsf_zip = {};       // "33131" => [$/sqft values]
  const price_zipType = {};
  const price_zip = {};

  for (const l of listings) {
    const zip = l.address?.zip || 'unknown';
    const type = l.propertyType || 'unknown';
    const price = l.price;
    if (!price || price <= 0) continue;

    const key = `${zip}|${type}`;

    if (l.sqft && l.sqft > 0) {
      const ppsf = price / l.sqft;
      if (!ppsf_zipType[key]) ppsf_zipType[key] = [];
      ppsf_zipType[key].push(ppsf);
      if (!ppsf_zip[zip]) ppsf_zip[zip] = [];
      ppsf_zip[zip].push(ppsf);
    }

    if (!price_zipType[key]) price_zipType[key] = [];
    price_zipType[key].push(price);
    if (!price_zip[zip]) price_zip[zip] = [];
    price_zip[zip].push(price);
  }

  // Use trimmed medians to remove outlier skew (luxury penthouses, etc.)
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
  const allPrices = listings.map((l) => l.price).filter((p) => p && p > 0);
  const areaPriceMedian = trimmedMedian(allPrices);

  return {
    ppsfMedians_zipType, ppsfMedians_zip, areaPpsfMedian,
    priceMedians_zipType, priceMedians_zip, areaPriceMedian,
  };
}

/**
 * Estimate market value for a single listing.
 * Priority: verified zestimate > $/sqft estimate > raw price median
 */
function estimateMarketValue(listing, marketData) {
  const {
    ppsfMedians_zipType, ppsfMedians_zip, areaPpsfMedian,
    priceMedians_zipType, priceMedians_zip, areaPriceMedian,
  } = marketData;

  // 1. Per-property zestimate — only if it passes sanity checks
  if (isZestimateReliable(listing.zestimate, listing)) {
    return listing.zestimate;
  }

  const zip = listing.address?.zip || 'unknown';
  const type = listing.propertyType || 'unknown';
  const key = `${zip}|${type}`;
  const sqft = listing.sqft;
  const priceMedian = priceMedians_zipType[key] || priceMedians_zip[zip] || areaPriceMedian || 0;

  // 2. $/sqft estimate (size-adjusted) — cross-validated against price median
  if (sqft && sqft > 0) {
    const ppsf = ppsfMedians_zipType[key] || ppsfMedians_zip[zip] || areaPpsfMedian;
    if (ppsf > 0) {
      const ppsfEstimate = Math.round(ppsf * sqft);
      if (priceMedian > 0) {
        const divergence = ppsfEstimate / priceMedian;
        // Extreme divergence (>3x): $/sqft is completely unreliable for this property size,
        // just use price median (e.g., 650sqft condo in zip with luxury towers)
        if (divergence > 3 || divergence < 0.25) {
          return priceMedian;
        }
        // Moderate divergence (>1.5x): blend toward price median
        if (divergence > 1.5 || divergence < 0.5) {
          return Math.round(priceMedian * 0.7 + ppsfEstimate * 0.3);
        }
      }
      return ppsfEstimate;
    }
  }

  // 3. Raw price median fallback
  return priceMedian;
}

// POST /api/properties/search - Search by location via Zillow (with server-side filtering)
router.post('/search', async (req, res) => {
  try {
    const { latitude, longitude, radius, filters } = req.body;
    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'latitude and longitude are required' });
    }

    const { propertyType, distressType, minScore, minDiscount } = filters || {};
    const bounds = req.body.bounds || null; // [[south, west], [north, east]]
    const needsEnrichment = distressType === 'delinquent' || distressType === 'taxLien';
    const MAX_PAGES = 1;
    const MIN_RESULTS = 20;

    // --- Phase 1: Fetch all raw listings (with basic pre-filters) ---
    let allListings = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= MAX_PAGES) {
      const { properties: rawListings, hasMore: morePages } = await searchByCoordinates(
        latitude, longitude, radius || 10, { page }
      );

      for (const listing of rawListings) {
        // Property type filter (available directly from Zillow)
        if (propertyType && listing.propertyType !== propertyType) continue;

        // Pre-foreclosure filter (available from Zillow listing status)
        if (distressType === 'preForeclosure' && listing.listingStatus !== 'preForeclosure') continue;

        // As-is filter (from listing description keywords)
        if (distressType === 'asIs' && !listing.distressIndicators?.isAsIs) continue;

        // Geographic bounds filter — only keep properties inside the search area
        if (bounds) {
          const coords = listing.coordinates?.coordinates;
          if (coords && !(coords[0] === 0 && coords[1] === 0)) {
            const pLat = coords[1];
            const pLng = coords[0];
            const [sw, ne] = bounds;
            if (pLat < sw[0] || pLat > ne[0] || pLng < sw[1] || pLng > ne[1]) continue;
          }
        }

        allListings.push(listing);
      }

      hasMore = morePages;
      const hasActiveFilter = propertyType || distressType || minScore || minDiscount;
      if (!hasActiveFilter || allListings.length >= MIN_RESULTS) break;
      page++;
    }

    // --- Phase 2: Compute $/sqft market data for accurate per-property estimates ---
    const marketData = computeMarketData(allListings);
    const areaMedian = marketData.areaPriceMedian;
    console.log(`Search: $/sqft medians — ${Object.keys(marketData.ppsfMedians_zipType).length} zip+type, ${Object.keys(marketData.ppsfMedians_zip).length} zip, area $/sqft = $${Math.round(marketData.areaPpsfMedian)}`);

    // --- Phase 3: Estimate market value per listing, preliminary score ---
    for (const listing of allListings) {
      listing.marketMedian = estimateMarketValue(listing, marketData);
      // Tag valuation source from Tier 1
      if (isZestimateReliable(listing.zestimate, listing)) {
        listing.valuationSource = 'zillow_search';
      } else {
        listing.valuationSource = 'ppsf_median';
      }
      listing.dealScore = scoreDeal(listing);
      const meta = computeValuationMeta(listing);
      listing.valuationConfidence = meta.confidence;
    }

    // --- Tier 2: Refine valuations for top candidates missing zestimates ---
    await refineBatchValuations(allListings);

    // --- Tier 3a: Batch enrich only if distress filter is active ---
    if (needsEnrichment) {
      const candidates = allListings.filter((l) => !l.enriched && isWorthEnriching(l));
      console.log(`Batch enriching ${candidates.length} of ${allListings.length} listings`);
      await enrichBatch(candidates);
    }

    // --- Tier 3b: Validate top deals with RentCast ---
    await validateTopDeals(allListings);

    // --- Phase 4: Filter and save ---
    let results = [];

    for (const listing of allListings) {
      try {
        // Distress filters (require enrichment data)
        if (distressType === 'delinquent' && !listing.distressIndicators?.isDelinquent) continue;
        if (distressType === 'taxLien' && !listing.distressIndicators?.hasTaxLien) continue;

        // Min score filter
        if (minScore && listing.dealScore < minScore) continue;

        // Min discount filter
        if (minDiscount && listing.price && listing.marketMedian && listing.marketMedian > 0) {
          const discount = ((listing.marketMedian - listing.price) / listing.marketMedian) * 100;
          if (discount < minDiscount) continue;
        }

        // Only save to DB if valuation is trustworthy (prevents stale bad estimates)
        if (isWorthSaving(listing)) {
          const saved = await Property.findOneAndUpdate(
            { 'address.street': listing.address.street, 'address.zip': listing.address.zip },
            listing,
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );
          results.push(saved);
        } else {
          results.push(listing);
        }
      } catch (innerErr) {
        console.error(`Error processing listing ${listing.address?.street}:`, innerErr.message);
        results.push(listing);
      }
    }

    // Sort by deal score descending
    results.sort((a, b) => (b.dealScore || 0) - (a.dealScore || 0));

    res.json({ results, areaMedian, geo: { lat: latitude, lng: longitude } });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/properties/search/stream - SSE search with progress updates
router.get('/search/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  function send(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    const { latitude, longitude, radius, filters: filtersJson, bounds: boundsJson } = req.query;
    if (!latitude || !longitude) {
      send('error', { error: 'latitude and longitude are required' });
      return res.end();
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    const rad = parseFloat(radius) || 10;
    const filters = filtersJson ? JSON.parse(filtersJson) : {};
    const bounds = boundsJson ? JSON.parse(boundsJson) : null; // [[south, west], [north, east]]
    const { propertyType, distressType, minScore, minDiscount } = filters;
    const needsEnrichment = distressType === 'delinquent' || distressType === 'taxLien';

    send('progress', { phase: 'fetching', message: 'Fetching listings...', percent: 5 });

    // Phase 1: Fetch listings (single page — Zillow returns plenty per page)
    const MAX_PAGES = 1;
    const MIN_RESULTS = 20;
    let allListings = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= MAX_PAGES) {
      const { properties: rawListings, hasMore: morePages } = await searchByCoordinates(
        lat, lng, rad, { page }
      );

      for (const listing of rawListings) {
        if (propertyType && listing.propertyType !== propertyType) continue;
        if (distressType === 'preForeclosure' && listing.listingStatus !== 'preForeclosure') continue;
        if (distressType === 'asIs' && !listing.distressIndicators?.isAsIs) continue;

        // Geographic bounds filter — only keep properties inside the search area
        if (bounds) {
          const coords = listing.coordinates?.coordinates;
          if (coords && !(coords[0] === 0 && coords[1] === 0)) {
            const pLat = coords[1];
            const pLng = coords[0];
            const [sw, ne] = bounds;
            if (pLat < sw[0] || pLat > ne[0] || pLng < sw[1] || pLng > ne[1]) continue;
          }
        }

        allListings.push(listing);
      }

      hasMore = morePages;
      const hasActiveFilter = propertyType || distressType || minScore || minDiscount;
      if (!hasActiveFilter || allListings.length >= MIN_RESULTS) break;
      page++;
    }

    // Phase 2: Compute $/sqft market data + preliminary score
    const marketData = computeMarketData(allListings);
    const areaMedian = marketData.areaPriceMedian;
    for (const listing of allListings) {
      listing.marketMedian = estimateMarketValue(listing, marketData);
      listing.valuationSource = isZestimateReliable(listing.zestimate, listing) ? 'zillow_search' : 'ppsf_median';
      listing.dealScore = scoreDeal(listing);
      const meta = computeValuationMeta(listing);
      listing.valuationConfidence = meta.confidence;
    }

    send('progress', {
      phase: 'fetched',
      message: `Found ${allListings.length} listings`,
      percent: 15,
    });

    // Tier 2: Refine valuations for top candidates
    send('progress', { phase: 'refining', message: 'Refining valuations...', percent: 20 });
    await refineBatchValuations(allListings, (current, total, street) => {
      const percent = 20 + Math.round((current / total) * 25);
      send('progress', {
        phase: 'refining',
        message: `Checking ${street || 'property'}...`,
        current,
        total,
        percent,
      });
    });

    // Tier 3a: Batch enrich if distress filter active
    const enrichCandidates = needsEnrichment
      ? allListings.filter((l) => !l.enriched && isWorthEnriching(l))
      : [];

    if (enrichCandidates.length > 0) {
      await enrichBatch(enrichCandidates, (current, total, street) => {
        const percent = 45 + Math.round((current / total) * 30);
        send('progress', {
          phase: 'enriching',
          message: `Checking ${street || 'property'}...`,
          current,
          total,
          percent,
        });
      });
    }

    // Tier 3b: RentCast validation for top deals
    send('progress', { phase: 'validating', message: 'Validating top deals...', percent: 80 });
    await validateTopDeals(allListings, (current, total, street) => {
      const percent = 80 + Math.round((current / total) * 15);
      send('progress', {
        phase: 'validating',
        message: `Verifying ${street || 'property'}...`,
        current,
        total,
        percent,
      });
    });

    // Phase 4: Filter and save
    let results = [];

    for (const listing of allListings) {
      try {
        if (distressType === 'delinquent' && !listing.distressIndicators?.isDelinquent) continue;
        if (distressType === 'taxLien' && !listing.distressIndicators?.hasTaxLien) continue;

        if (minScore && listing.dealScore < minScore) continue;
        if (minDiscount && listing.price && listing.marketMedian && listing.marketMedian > 0) {
          const discount = ((listing.marketMedian - listing.price) / listing.marketMedian) * 100;
          if (discount < minDiscount) continue;
        }

        if (listing.dealScore > 50) {
          const saved = await Property.findOneAndUpdate(
            { 'address.street': listing.address.street, 'address.zip': listing.address.zip },
            listing,
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );
          results.push(saved);
        } else {
          results.push(listing);
        }
      } catch (innerErr) {
        results.push(listing);
      }
    }

    results.sort((a, b) => (b.dealScore || 0) - (a.dealScore || 0));

    send('progress', { phase: 'done', message: 'Complete', percent: 100 });
    send('results', { results, areaMedian, geo: { lat, lng } });
  } catch (err) {
    send('error', { error: err.message });
  } finally {
    res.end();
  }
});

// GET /api/properties/:id - Single property
router.get('/:id', async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).json({ error: 'Not found' });
    res.json(property);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/properties/pipeline - Manually trigger the pipeline
router.post('/pipeline', async (req, res) => {
  try {
    const { latitude, longitude, radius } = req.body;
    const location = latitude && longitude
      ? { lat: latitude, lng: longitude, radius: radius || 10 }
      : undefined;
    const result = await runPipeline(location);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
