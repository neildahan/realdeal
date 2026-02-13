const axios = require('axios');

const RENTCAST_BASE = 'https://api.rentcast.io/v1';

function hasRentCastKey() {
  const key = process.env.RENTCAST_API_KEY;
  return key && key.length > 10 && !key.includes('your_');
}

/**
 * Fetch AVM (Automated Valuation Model) data from RentCast for a property.
 * Returns estimated value + sold comparables for validation.
 *
 * @param {object} addressObj - { street, city, state, zip }
 * @returns {object|null} { value, valueHigh, valueLow, comparables } or null on failure
 */
async function fetchRentCastAVM(addressObj) {
  if (!hasRentCastKey()) {
    console.log(`RentCast: No API key, using mock for "${addressObj.street}"`);
    return getMockAVM(addressObj);
  }

  const fullAddress = `${addressObj.street}, ${addressObj.city}, ${addressObj.state} ${addressObj.zip}`;

  try {
    const res = await axios.get(`${RENTCAST_BASE}/avm/value`, {
      params: { address: fullAddress },
      headers: { 'X-Api-Key': process.env.RENTCAST_API_KEY },
      timeout: 15000,
    });

    const d = res.data;
    if (!d || !d.price) {
      console.log(`RentCast: No valuation for "${addressObj.street}"`);
      return null;
    }

    const comparables = (d.comparables || []).map((c) => ({
      address: c.formattedAddress || c.addressLine1 || '',
      price: c.price || c.lastSalePrice || 0,
      sqft: c.squareFootage || 0,
      distance: c.distance || null,
      saleDate: c.lastSaleDate || null,
    }));

    console.log(`RentCast: "${addressObj.street}" → $${d.price} (${d.priceLow}-${d.priceHigh}), ${comparables.length} comps`);

    return {
      value: d.price,
      valueHigh: d.priceHigh || null,
      valueLow: d.priceLow || null,
      comparables,
    };
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`RentCast: No data found for "${addressObj.street}"`);
    } else {
      console.error(`RentCast error for "${addressObj.street}":`, err.message);
    }
    return null;
  }
}

/**
 * Mock AVM for dev/testing when no API key is available.
 */
function getMockAVM(addressObj) {
  const base = 200000 + Math.round(Math.random() * 300000);
  return {
    value: base,
    valueHigh: Math.round(base * 1.1),
    valueLow: Math.round(base * 0.9),
    comparables: [
      { address: '100 Mock Comp St', price: Math.round(base * 0.95), sqft: 1200, distance: 0.3, saleDate: '2024-06-15' },
      { address: '200 Mock Comp Ave', price: Math.round(base * 1.02), sqft: 1350, distance: 0.5, saleDate: '2024-08-22' },
    ],
  };
}

module.exports = { fetchRentCastAVM };
