const express = require('express');
const router = express.Router();
const Property = require('../models/Property');
const { runPipeline } = require('../services/pipeline');
const { searchByCoordinates } = require('../services/zillowService');
const { enrichBatch, isWorthEnriching } = require('../services/enrichmentService');
const { scoreDeal } = require('../utils/dealScorer');

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

// POST /api/properties/search - Search by location via Zillow (with server-side filtering)
router.post('/search', async (req, res) => {
  try {
    const { latitude, longitude, radius, filters } = req.body;
    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'latitude and longitude are required' });
    }

    const { propertyType, distressType, minScore, minDiscount } = filters || {};
    const needsEnrichment = distressType === 'delinquent' || distressType === 'taxLien';
    const MAX_PAGES = 3;
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

        allListings.push(listing);
      }

      hasMore = morePages;
      const hasActiveFilter = propertyType || distressType || minScore || minDiscount;
      if (!hasActiveFilter || allListings.length >= MIN_RESULTS) break;
      page++;
    }

    // --- Phase 2: Calculate area median from all listing prices ---
    const prices = allListings.map((l) => l.price).filter((p) => p && p > 0);
    const areaMedian = median(prices);
    console.log(`Search: area median = $${areaMedian.toLocaleString()} from ${prices.length} listings`);

    // --- Phase 3: Backfill marketMedian, batch enrich, score, and filter ---
    let results = [];

    for (const listing of allListings) {
      if (!listing.marketMedian && areaMedian > 0) listing.marketMedian = areaMedian;
    }

    if (needsEnrichment) {
      const candidates = allListings.filter((l) => !l.enriched && isWorthEnriching(l));
      console.log(`Batch enriching ${candidates.length} of ${allListings.length} listings`);
      await enrichBatch(candidates);
    }

    for (const listing of allListings) {
      try {

        // Distress filters (require enrichment data)
        if (distressType === 'delinquent' && !listing.distressIndicators?.isDelinquent) continue;
        if (distressType === 'taxLien' && !listing.distressIndicators?.hasTaxLien) continue;

        // Score the deal (now with marketMedian set)
        listing.dealScore = scoreDeal(listing);

        // Min score filter
        if (minScore && listing.dealScore < minScore) continue;

        // Min discount filter
        if (minDiscount && listing.price && listing.marketMedian && listing.marketMedian > 0) {
          const discount = ((listing.marketMedian - listing.price) / listing.marketMedian) * 100;
          if (discount < minDiscount) continue;
        }

        // Save deals with score > 50 to DB
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
    const { latitude, longitude, radius, filters: filtersJson } = req.query;
    if (!latitude || !longitude) {
      send('error', { error: 'latitude and longitude are required' });
      return res.end();
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    const rad = parseFloat(radius) || 10;
    const filters = filtersJson ? JSON.parse(filtersJson) : {};
    const { propertyType, distressType, minScore, minDiscount } = filters;
    const needsEnrichment = distressType === 'delinquent' || distressType === 'taxLien';

    send('progress', { phase: 'fetching', message: 'Fetching listings...', percent: 5 });

    // Phase 1: Fetch listings
    const MAX_PAGES = 3;
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
        allListings.push(listing);
      }

      hasMore = morePages;
      const hasActiveFilter = propertyType || distressType || minScore || minDiscount;
      if (!hasActiveFilter || allListings.length >= MIN_RESULTS) break;
      page++;
    }

    // Phase 2: Area median + pre-fill market values
    const prices = allListings.map((l) => l.price).filter((p) => p && p > 0);
    const areaMedian = median(prices);
    for (const listing of allListings) {
      if (!listing.marketMedian && areaMedian > 0) listing.marketMedian = areaMedian;
    }

    // Phase 3: Batch enrich only promising listings
    const candidates = needsEnrichment
      ? allListings.filter((l) => !l.enriched && isWorthEnriching(l))
      : [];

    send('progress', {
      phase: 'fetched',
      message: `Found ${allListings.length} listings, ${candidates.length} to check`,
      percent: 15,
    });

    let results = [];

    if (candidates.length > 0) {
      await enrichBatch(candidates, (current, total, street) => {
        const percent = 15 + Math.round((current / total) * 80);
        send('progress', {
          phase: 'enriching',
          message: `Checking ${street || 'property'}...`,
          current,
          total,
          percent,
        });
      });
    }

    for (const listing of allListings) {
      try {
        if (distressType === 'delinquent' && !listing.distressIndicators?.isDelinquent) continue;
        if (distressType === 'taxLien' && !listing.distressIndicators?.hasTaxLien) continue;

        listing.dealScore = scoreDeal(listing);

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
