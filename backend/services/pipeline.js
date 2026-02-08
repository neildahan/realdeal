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

    // 2. Pre-fill market median for scoring
    const prices = listings.map((l) => l.price).filter((p) => p && p > 0);
    const areaMedian = prices.length > 0
      ? [...prices].sort((a, b) => a - b)[Math.floor(prices.length / 2)]
      : 0;
    for (const l of listings) {
      if (!l.marketMedian && areaMedian > 0) l.marketMedian = areaMedian;
    }

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
