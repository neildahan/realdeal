const axios = require('axios');

// --- RapidAPI (ZLLW Working API) — primary source ---
const RAPIDAPI_HOST = process.env.RAPIDAPI_ZILLOW_HOST || 'zllw-working-api.p.rapidapi.com';
const RAPIDAPI_BASE = `https://${RAPIDAPI_HOST}`;

// --- Bridge API — fallback when approved ---
const BRIDGE_BASE = 'https://api.bridgedataoutput.com/api/v2';

function hasRapidApi() {
  const key = process.env.RAPIDAPI_KEY;
  return key && !key.includes('your_rapidapi') && key.length > 10;
}

function hasBridge() {
  const token = process.env.BRIDGE_API_TOKEN;
  return token && token.length > 10;
}

function rapidApiHeaders() {
  return {
    'x-rapidapi-key': process.env.RAPIDAPI_KEY,
    'x-rapidapi-host': RAPIDAPI_HOST,
  };
}

/**
 * Fetch Zillow data for a property via RapidAPI (ZLLW Working API).
 */
async function fetchFromRapidApi(fullAddress) {
  try {
    const res = await axios.get(`${RAPIDAPI_BASE}/byaddress`, {
      params: { propertyaddress: fullAddress },
      headers: rapidApiHeaders(),
      timeout: 10000,
    });

    const d = res.data;
    if (!d || d.message !== '200: Success') {
      console.log(`Zillow RapidAPI: No data for "${fullAddress}"`);
      return null;
    }

    return {
      zestimate: d.zestimate || null,
      rentZestimate: d.rentZestimate || null,
      price: d.Price || null,
      sqft: d['Area(sqft)'] || null,
      bedrooms: d.Bedrooms || null,
      bathrooms: d.Bathrooms || null,
      yearBuilt: d.yearBuilt || null,
      daysOnMarket: d.daysOnZillow || null,
      zpid: d.PropertyZPID || null,
      listingUrl: d.PropertyZillowURL || null,
    };
  } catch (err) {
    console.error(`Zillow RapidAPI error for "${fullAddress}":`, err.message);
    return null;
  }
}

/**
 * Fetch Zestimate from Bridge API (fallback).
 */
async function fetchFromBridge(fullAddress) {
  try {
    const res = await axios.get(`${BRIDGE_BASE}/zestimates_v2/zestimates`, {
      params: { access_token: process.env.BRIDGE_API_TOKEN, address: fullAddress },
      timeout: 10000,
    });

    const record = res.data?.bundle?.[0] || res.data?.[0] || null;
    if (!record) return null;

    return {
      zestimate: record.zestimate || null,
      rentZestimate: record.rentalZestimate || record.rentZestimate || null,
    };
  } catch (err) {
    console.error(`Zillow Bridge error for "${fullAddress}":`, err.message);
    return null;
  }
}

/**
 * Mock data for when no API is available.
 */
function getMockData() {
  const base = 180000 + Math.round(Math.random() * 150000);
  return {
    zestimate: base,
    rentZestimate: Math.round(base * 0.007),
  };
}

/**
 * Main entry point: fetch Zillow data for a property.
 * Priority: RapidAPI → Bridge → Mock
 *
 * @param {object} addressObj - { street, city, state, zip }
 * @returns {{ zestimate, rentZestimate, sqft, bedrooms, bathrooms, yearBuilt, zpid }}
 */
async function fetchZillowData(addressObj) {
  const fullAddress = `${addressObj.street}, ${addressObj.city}, ${addressObj.state} ${addressObj.zip}`;

  // Try RapidAPI first (active now)
  if (hasRapidApi()) {
    const result = await fetchFromRapidApi(fullAddress);
    if (result) {
      console.log(`Zillow: Got data via RapidAPI for "${addressObj.street}" (zestimate: ${result.zestimate})`);
      return result;
    }
  }

  // Fallback to Bridge API (once approved)
  if (hasBridge()) {
    const result = await fetchFromBridge(fullAddress);
    if (result) {
      console.log(`Zillow: Got data via Bridge for "${addressObj.street}" (zestimate: ${result.zestimate})`);
      return result;
    }
  }

  // Last resort: mock
  console.log(`Zillow: No API available, using mock data for "${addressObj.street}"`);
  return getMockData();
}

/**
 * Geocode a zip code to lat/lng using zippopotam.us (no API key needed).
 */
async function geocodeZip(zip) {
  try {
    const res = await axios.get(`https://api.zippopotam.us/us/${zip}`, { timeout: 5000 });
    const place = res.data?.places?.[0];
    if (!place) return null;
    return {
      lat: parseFloat(place.latitude),
      lng: parseFloat(place.longitude),
      city: place['place name'],
      state: res.data['state abbreviation'],
    };
  } catch (err) {
    console.error(`Geocode error for zip "${zip}":`, err.message);
    return null;
  }
}

/**
 * Search Zillow listings by coordinates using ZLLW RapidAPI /search/bycoordinates.
 * Accepts lat/lng directly (geocoding done on frontend via Nominatim).
 * Returns normalized property objects ready for enrichment/scoring.
 */
async function searchByCoordinates(lat, lng, radius = 10, { page = 1, home_type } = {}) {
  const geo = { lat, lng };

  if (!hasRapidApi()) {
    console.log('Zillow search: No RapidAPI key, returning mock results');
    return { properties: getMockSearchResults(geo, 'search'), geo, hasMore: false };
  }

  try {
    const params = { latitude: lat, longitude: lng, radius, page };
    if (home_type) params.home_type = home_type;

    const res = await axios.get(`${RAPIDAPI_BASE}/search/bycoordinates`, {
      params,
      headers: rapidApiHeaders(),
      timeout: 20000,
    });

    const allResults = res.data?.searchResults || [];
    const totalCount = res.data?.resultsCount?.totalMatchingCount || 0;
    const totalPages = res.data?.resultsCount?.totalPages || 1;
    console.log(`Zillow search: ${totalCount} total listings near [${lat}, ${lng}], page ${page}/${totalPages}, fetched ${allResults.length}`);

    if (allResults.length === 0) {
      if (page === 1) {
        console.log('Zillow search: No results from API, returning mock results');
        return { properties: getMockSearchResults(geo, 'search'), geo, hasMore: false };
      }
      return { properties: [], geo, hasMore: false };
    }

    const properties = allResults.map((item) => normalizeZillowListing(item, geo, ''));
    console.log(`Zillow search: ${properties.length} listings normalized`);

    return { properties, geo, hasMore: page < totalPages };
  } catch (err) {
    console.error(`Zillow search error:`, err.message);
    if (page === 1) {
      return { properties: getMockSearchResults(geo, 'search'), geo, hasMore: false };
    }
    return { properties: [], geo, hasMore: false };
  }
}

/**
 * Normalize a raw ZLLW search result into our property format.
 * API returns: { property: { address, price: { value }, location, listing, ... } }
 */
function normalizeZillowListing(item, geo, zip) {
  const p = item.property || item;
  const addr = p.address || {};
  const loc = p.location || {};
  const listing = p.listing || {};
  const priceObj = p.price || {};

  const street = addr.streetAddress || addr.street || 'Unknown';
  const city = addr.city || geo.city || '';
  const state = addr.state || geo.state || '';
  const zipCode = addr.zipcode || addr.zip || zip;
  const price = priceObj.value || p.price || 0;

  // Try multiple paths for coordinates — ZLLW API nests them differently
  // Use || (not ??) so that 0 values (equator/prime meridian) fall through — no US property is at 0,0
  const lat = loc.latitude || p.latitude || p.lat || addr.latitude || geo.lat;
  const lng = loc.longitude || p.longitude || p.lng || addr.longitude || geo.lng;
  const zpid = p.zpid || null;
  const isPreForeclosure = listing.listingStatus === 'preForeclosure';
  const priceChange = priceObj.priceChange || 0;
  const priceDropPct = priceChange < 0 && priceObj.value
    ? Math.round(Math.abs(priceChange) / (priceObj.value - priceChange) * 100)
    : 0;

  // Estimates (zestimate + rent) — already included in search results, no extra API call
  const estimates = p.estimates || {};
  const zestimate = estimates.zestimate || null;
  const rentZestimate = estimates.rentZestimate || null;

  // Photos
  const media = p.media || {};
  const photoLinks = media.propertyPhotoLinks || {};
  const allPhotos = media.allPropertyPhotos || {};
  const photoUrl = photoLinks.highResolutionLink || photoLinks.mediumSizeLink || null;
  const photos = allPhotos.medium || (photoUrl ? [photoUrl] : []);

  return {
    address: { street, city, state, zip: zipCode },
    price,
    marketMedian: zestimate,
    sqft: p.livingArea || null,
    bedrooms: p.bedrooms || null,
    bathrooms: p.bathrooms || null,
    propertyType: p.propertyType || 'unknown',
    listingStatus: listing.listingStatus || 'unknown',
    daysOnMarket: p.daysOnZillow || 0,
    listingUrl: zpid ? `https://www.zillow.com/homedetails/${zpid}_zpid/` : null,
    photoUrl,
    photos,
    description: '',
    coordinates: {
      type: 'Point',
      coordinates: [parseFloat(lng), parseFloat(lat)],
    },
    distressIndicators: {
      isDelinquent: false,
      hasTaxLien: false,
      isAsIs: false,
      isPreForeclosure,
      equityPercent: null,
      priceDropPercent: priceDropPct,
    },
    zestimate,
    rentZestimate,
    dealScore: 0,
    enriched: false,
  };
}

/**
 * Generate mock search results for development/testing.
 */
function getMockSearchResults(geo, zip) {
  const streets = [
    '123 Main St', '456 Oak Ave', '789 Elm Blvd', '321 Pine Rd', '654 Maple Dr',
    '987 Cedar Ln', '147 Birch Way', '258 Walnut St', '369 Spruce Ave', '741 Ash Ct',
  ];
  return streets.map((street, i) => {
    const base = 150000 + Math.round(Math.random() * 200000);
    const market = base + Math.round(Math.random() * 80000);
    const types = ['singleFamily', 'condo', 'townhouse', 'multiFamily'];
    return {
      address: { street, city: geo.city, state: geo.state, zip },
      price: base,
      marketMedian: market,
      sqft: 1000 + Math.round(Math.random() * 2000),
      bedrooms: 2 + Math.floor(Math.random() * 4),
      bathrooms: 1 + Math.floor(Math.random() * 3),
      propertyType: types[Math.floor(Math.random() * types.length)],
      listingStatus: 'forSale',
      daysOnMarket: Math.round(Math.random() * 120),
      listingUrl: null,
      photoUrl: `https://picsum.photos/seed/${zip}${i}/400/300`,
      photos: [`https://picsum.photos/seed/${zip}${i}/400/300`, `https://picsum.photos/seed/${zip}${i}b/400/300`],
      description: '',
      coordinates: {
        type: 'Point',
        coordinates: [
          geo.lng + (Math.random() - 0.5) * 0.1,
          geo.lat + (Math.random() - 0.5) * 0.1,
        ],
      },
      distressIndicators: {
        isDelinquent: Math.random() > 0.7,
        hasTaxLien: Math.random() > 0.8,
        isAsIs: Math.random() > 0.8,
        isPreForeclosure: Math.random() > 0.85,
        equityPercent: null,
        priceDropPercent: null,
      },
      zestimate: market,
      rentZestimate: Math.round(market * 0.007),
      dealScore: 0,
      enriched: false,
    };
  });
}

module.exports = { fetchZillowData, searchByCoordinates, geocodeZip };
