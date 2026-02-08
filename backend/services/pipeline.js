const cron = require('node-cron');
const { scrapeListings } = require('./scraper');
const { enrichDeal } = require('./enrichmentService');
const Property = require('../models/Property');

// Default search URL - can be overridden
const DEFAULT_SEARCH_URL =
  'https://www.realtor.com/realestateandhomes-search/Houston_TX/price-na-200000';

/**
 * Run the full pipeline: Scrape -> Enrich -> Score -> Save.
 */
async function runPipeline(searchUrl = DEFAULT_SEARCH_URL) {
  console.log(`\n=== Pipeline started at ${new Date().toISOString()} ===`);

  try {
    // 1. Scrape
    console.log('Step 1: Scraping listings...');
    const listings = await scrapeListings(searchUrl);
    console.log(`  Found ${listings.length} listings`);

    if (listings.length === 0) {
      console.log('  No listings found, pipeline complete.');
      return { scraped: 0, enriched: 0, saved: 0 };
    }

    // 2. Enrich + Score
    console.log('Step 2: Enriching with ATTOM + Datafiniti...');
    const enriched = [];
    for (const listing of listings) {
      try {
        const result = await enrichDeal(listing);
        enriched.push(result);
        console.log(
          `  ${result.address.street}: score=${result.dealScore}, delinquent=${result.distressIndicators.isDelinquent}, lien=${result.distressIndicators.hasTaxLien}`
        );
      } catch (err) {
        console.error(`  Failed to enrich ${listing.address?.street}:`, err.message);
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
function startCronPipeline(searchUrl = DEFAULT_SEARCH_URL) {
  console.log('Cron pipeline scheduled: every 30 minutes');

  // Run immediately on startup
  runPipeline(searchUrl).catch((err) =>
    console.error('Initial pipeline run failed:', err.message)
  );

  // Then every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    runPipeline(searchUrl).catch((err) =>
      console.error('Cron pipeline run failed:', err.message)
    );
  });
}

module.exports = { runPipeline, startCronPipeline };
