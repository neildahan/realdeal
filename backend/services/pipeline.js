const cron = require('node-cron');
const { searchByCoordinates } = require('./zillowService');
const { enrichBatch, isWorthEnriching } = require('./enrichmentService');
const { scoreDeal } = require('../utils/dealScorer');
const Property = require('../models/Property');

// Default search: Miami, FL
const DEFAULT_LOCATION = { lat: 25.7617, lng: -80.1918, radius: 10 };

/**
 * Run the full pipeline: Zillow Search -> Enrich -> Score -> Save.
 */
async function runPipeline(location = DEFAULT_LOCATION) {
  console.log(`\n=== Pipeline started at ${new Date().toISOString()} ===`);

  try {
    // 1. Fetch listings from Zillow RapidAPI
    console.log(`Step 1: Fetching Zillow listings near [${location.lat}, ${location.lng}]...`);
    const { properties: listings } = await searchByCoordinates(
      location.lat, location.lng, location.radius || 10
    );
    console.log(`  Found ${listings.length} listings`);

    if (listings.length === 0) {
      console.log('  No listings found, pipeline complete.');
      return { scraped: 0, enriched: 0, saved: 0 };
    }

    // 2. Compute $/sqft market data for per-property estimates
    function med(arr) {
      if (!arr.length) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    }
    function trimMed(arr) {
      if (arr.length < 5) return med(arr);
      const sorted = [...arr].sort((a, b) => a - b);
      const trim = Math.floor(sorted.length * 0.15);
      return med(sorted.slice(trim, sorted.length - trim));
    }

    const ppsf_zip = {};
    const price_zip = {};
    for (const l of listings) {
      const zip = l.address?.zip || 'unknown';
      if (!l.price || l.price <= 0) continue;
      if (!price_zip[zip]) price_zip[zip] = [];
      price_zip[zip].push(l.price);
      if (l.sqft && l.sqft > 0) {
        if (!ppsf_zip[zip]) ppsf_zip[zip] = [];
        ppsf_zip[zip].push(l.price / l.sqft);
      }
    }

    const ppsfMedians = {};
    for (const [zip, vals] of Object.entries(ppsf_zip)) {
      if (vals.length >= 3) ppsfMedians[zip] = trimMed(vals);
    }
    const priceMedians = {};
    for (const [zip, vals] of Object.entries(price_zip)) {
      priceMedians[zip] = trimMed(vals);
    }
    const allPpsf = Object.values(ppsf_zip).flat();
    const areaPpsf = trimMed(allPpsf);
    const allPrices = listings.map((l) => l.price).filter((p) => p && p > 0);
    const areaMedian = allPrices.length > 0 ? trimMed(allPrices) : 0;

    for (const l of listings) {
      // Sanity-check zestimate: skip if ratio vs price is >2.5x or <0.4x (likely building value)
      const zestOk = l.zestimate && l.zestimate > 0 && l.price > 0
        && (l.zestimate / l.price) <= 2.5 && (l.zestimate / l.price) >= 0.4
        && (!l.sqft || l.sqft <= 0 || (l.zestimate / l.sqft) < 2000);

      if (zestOk) {
        l.marketMedian = l.zestimate;
      } else if (l.sqft && l.sqft > 0) {
        const zip = l.address?.zip || 'unknown';
        const ppsf = ppsfMedians[zip] || areaPpsf;
        l.marketMedian = ppsf > 0 ? Math.round(ppsf * l.sqft) : (priceMedians[zip] || areaMedian || 0);
      } else {
        const zip = l.address?.zip || 'unknown';
        l.marketMedian = priceMedians[zip] || areaMedian || 0;
      }
    }
    console.log(`  $/sqft medians for ${Object.keys(ppsfMedians).length} zips, area $/sqft = $${Math.round(areaPpsf)}`);

    // Filter to promising listings, batch enrich top candidates
    const candidates = listings.filter(isWorthEnriching);
    console.log(`Step 2: ${candidates.length}/${listings.length} look promising, enriching top candidates...`);
    const enriched = await enrichBatch(candidates, (current, total, street) => {
      console.log(`  [${current}/${total}] ${street}`);
    });

    // Score the rest that weren't enriched
    for (const listing of listings) {
      if (!listing.enriched) {
        listing.dealScore = scoreDeal(listing);
      }
    }

    // 3. Save deals with score > 50
    console.log('Step 3: Saving qualifying deals (score > 50)...');
    let savedCount = 0;
    for (const property of enriched) {
      if (property.dealScore > 50) {
        try {
          // Upsert by address to avoid duplicates
          await Property.findOneAndUpdate(
            {
              'address.street': property.address.street,
              'address.zip': property.address.zip,
            },
            property,
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );
          savedCount++;
          console.log(
            `  SAVED: ${property.address.street} (score: ${property.dealScore})`
          );
        } catch (err) {
          console.error(`  Failed to save ${property.address.street}:`, err.message);
        }
      } else {
        console.log(
          `  SKIP: ${property.address.street} (score: ${property.dealScore})`
        );
      }
    }

    const summary = {
      scraped: listings.length,
      enriched: enriched.length,
      saved: savedCount,
    };
    console.log(`=== Pipeline complete: ${JSON.stringify(summary)} ===\n`);
    return summary;
  } catch (err) {
    console.error('Pipeline error:', err.message);
    throw err;
  }
}

/**
 * Start the cron job: runs every 30 minutes.
 */
function startCronPipeline(location = DEFAULT_LOCATION) {
  console.log('Cron pipeline scheduled: every 30 minutes');

  // Run immediately on startup
  runPipeline(location).catch((err) =>
    console.error('Initial pipeline run failed:', err.message)
  );

  // Then every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    runPipeline(location).catch((err) =>
      console.error('Cron pipeline run failed:', err.message)
    );
  });
}

module.exports = { runPipeline, startCronPipeline };
