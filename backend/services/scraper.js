const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const DISTRESS_KEYWORDS = [
  'cash only',
  'motivated seller',
  'as-is',
  'as is',
  'handyman special',
  'fixer upper',
  'fixer-upper',
  'investor special',
  'below market',
  'must sell',
  'estate sale',
  'bank owned',
  'reo',
  'short sale',
  'foreclosure',
  'pre-foreclosure',
  'tax lien',
  'needs work',
  'needs rehab',
  'price reduced',
  'bring all offers',
];

/**
 * Mock data for development/testing so we don't hit Realtor.com.
 */
function getMockListings() {
  return [
    {
      address: {
        street: '123 Maple St',
        city: 'Houston',
        state: 'TX',
        zip: '77001',
      },
      price: 120000,
      sqft: 1800,
      daysOnMarket: 95,
      listingUrl: 'https://www.realtor.com/mock/123-maple',
      description:
        'Motivated seller! This as-is property needs some TLC but is priced to sell. Cash only preferred. Great bones in an up-and-coming neighborhood.',
      coordinates: { type: 'Point', coordinates: [-95.3698, 29.7604] },
    },
    {
      address: {
        street: '456 Oak Ave',
        city: 'Houston',
        state: 'TX',
        zip: '77002',
      },
      price: 85000,
      sqft: 1200,
      daysOnMarket: 120,
      listingUrl: 'https://www.realtor.com/mock/456-oak',
      description:
        'Estate sale - investor special! Handyman special in a great school district. Bring all offers.',
      coordinates: { type: 'Point', coordinates: [-95.3563, 29.7545] },
    },
    {
      address: {
        street: '789 Pine Blvd',
        city: 'Houston',
        state: 'TX',
        zip: '77003',
      },
      price: 210000,
      sqft: 2400,
      daysOnMarket: 15,
      listingUrl: 'https://www.realtor.com/mock/789-pine',
      description:
        'Beautiful updated home with granite counters, new roof, and fresh paint. Move-in ready!',
      coordinates: { type: 'Point', coordinates: [-95.3444, 29.7488] },
    },
    {
      address: {
        street: '321 Elm Dr',
        city: 'Houston',
        state: 'TX',
        zip: '77004',
      },
      price: 95000,
      sqft: 1500,
      daysOnMarket: 200,
      listingUrl: 'https://www.realtor.com/mock/321-elm',
      description:
        'Pre-foreclosure - must sell ASAP. Price reduced multiple times. Needs rehab but massive potential. Below market value.',
      coordinates: { type: 'Point', coordinates: [-95.3621, 29.7321] },
    },
    {
      address: {
        street: '555 Cedar Ln',
        city: 'Houston',
        state: 'TX',
        zip: '77005',
      },
      price: 175000,
      sqft: 2000,
      daysOnMarket: 45,
      listingUrl: 'https://www.realtor.com/mock/555-cedar',
      description:
        'Short sale approved. Bank owned property in desirable area. Fixer-upper with pool.',
      coordinates: { type: 'Point', coordinates: [-95.4321, 29.7178] },
    },
  ];
}

/**
 * Detect distress keywords in a listing description.
 */
function detectKeywords(description) {
  const lower = (description || '').toLowerCase();
  const found = DISTRESS_KEYWORDS.filter((kw) => lower.includes(kw));
  const isAsIs =
    lower.includes('as-is') ||
    lower.includes('as is') ||
    lower.includes('cash only');
  return { keywords: found, isAsIs };
}

/**
 * Launch a stealth browser configured with optional proxy.
 */
async function launchBrowser() {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
  ];

  const proxyUrl = process.env.PROXY_URL;
  if (proxyUrl && !proxyUrl.includes('your_proxy')) {
    args.push(`--proxy-server=${proxyUrl}`);
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args,
  });

  return browser;
}

/**
 * Scrape listings from a Realtor.com search results page.
 * Returns an array of raw property objects.
 */
async function scrapeRealtorPage(searchUrl) {
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();

    // Randomize viewport to look human
    await page.setViewport({
      width: 1280 + Math.floor(Math.random() * 200),
      height: 800 + Math.floor(Math.random() * 200),
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    );

    console.log(`Navigating to: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for listing cards to load
    await page.waitForSelector('[data-testid="card-content"]', {
      timeout: 15000,
    }).catch(() => {
      console.warn('Listing cards selector not found, trying fallback...');
    });

    // Extract listing data from the page
    const listings = await page.evaluate(() => {
      const cards = document.querySelectorAll(
        '[data-testid="card-content"], .property-card, .CardContent__StyledCardContent'
      );
      const results = [];

      cards.forEach((card) => {
        try {
          // Price
          const priceEl = card.querySelector(
            '[data-testid="card-price"], .card-price, .price'
          );
          const priceText = priceEl ? priceEl.textContent : '';
          const price = parseInt(priceText.replace(/[^0-9]/g, ''), 10) || null;

          // Address
          const addressEl = card.querySelector(
            '[data-testid="card-address-1"], .card-address'
          );
          const addressLine = addressEl ? addressEl.textContent.trim() : '';

          const cityStateEl = card.querySelector(
            '[data-testid="card-address-2"], .card-address-2'
          );
          const cityStateZip = cityStateEl
            ? cityStateEl.textContent.trim()
            : '';

          // Sqft
          const metaEls = card.querySelectorAll(
            '[data-testid="property-meta-item"], .property-meta li'
          );
          let sqft = null;
          metaEls.forEach((el) => {
            const text = el.textContent.toLowerCase();
            if (text.includes('sqft') || text.includes('sq ft')) {
              sqft =
                parseInt(text.replace(/[^0-9]/g, ''), 10) || null;
            }
          });

          // Link
          const linkEl = card.closest('a') || card.querySelector('a');
          const href = linkEl ? linkEl.href : null;

          if (price && addressLine) {
            results.push({
              price,
              addressLine,
              cityStateZip,
              sqft,
              listingUrl: href,
            });
          }
        } catch (e) {
          // Skip malformed card
        }
      });

      return results;
    });

    console.log(`Scraped ${listings.length} listings from page`);
    return listings;
  } finally {
    await browser.close();
  }
}

/**
 * Parse a city/state/zip string like "Houston, TX 77001"
 */
function parseCityStateZip(str) {
  const match = (str || '').match(/^(.+),\s*([A-Z]{2})\s*(\d{5})/);
  if (match) {
    return { city: match[1].trim(), state: match[2], zip: match[3] };
  }
  return { city: str || '', state: '', zip: '' };
}

/**
 * Main scrape function. Uses mock mode when MOCK_SCRAPER=true or NODE_ENV=development.
 *
 * @param {string} searchUrl - Realtor.com search URL
 * @param {object} options - { mock: boolean }
 * @returns {Array} Normalized property objects ready for enrichment
 */
async function scrapeListings(searchUrl, options = {}) {
  const useMock =
    options.mock ||
    process.env.MOCK_SCRAPER === 'true' ||
    process.env.NODE_ENV === 'development';

  if (useMock) {
    console.log('Using MOCK scraper data (dev mode)');
    const mockListings = getMockListings();
    return mockListings.map((listing) => {
      const { keywords, isAsIs } = detectKeywords(listing.description);
      return {
        ...listing,
        distressIndicators: { isAsIs, isDelinquent: false, hasTaxLien: false },
        keywordsFound: keywords,
      };
    });
  }

  // Live scrape
  const rawListings = await scrapeRealtorPage(searchUrl);

  return rawListings.map((raw) => {
    const { city, state, zip } = parseCityStateZip(raw.cityStateZip);
    const { keywords, isAsIs } = detectKeywords(raw.description || '');

    return {
      address: { street: raw.addressLine, city, state, zip },
      price: raw.price,
      sqft: raw.sqft,
      daysOnMarket: 0, // Will be enriched later
      listingUrl: raw.listingUrl,
      description: raw.description || '',
      coordinates: { type: 'Point', coordinates: [0, 0] }, // Will be geocoded
      distressIndicators: { isAsIs, isDelinquent: false, hasTaxLien: false },
      keywordsFound: keywords,
    };
  });
}

module.exports = { scrapeListings, detectKeywords, DISTRESS_KEYWORDS };
