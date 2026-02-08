const axios = require('axios');

const ATTOM_BASE_URL = 'https://api.gateway.attomdata.com/propertyapi/v1.0.0';

/**
 * Mock ATTOM response for development.
 * Returns randomized mortgage distress data.
 */
function getMockAttomData(address) {
  const rand = Math.random();
  return {
    isDelinquent: rand < 0.4,
    isPreForeclosure: rand < 0.2,
    equityPercent: Math.round(Math.random() * 100),
    marketMedian: 180000 + Math.round(Math.random() * 120000),
    daysOnMarket: Math.round(Math.random() * 180),
  };
}

/**
 * Fetch mortgage delinquency, pre-foreclosure status, and equity from ATTOM.
 *
 * @param {object} address - { street, city, state, zip }
 * @returns {{ isDelinquent, isPreForeclosure, equityPercent, marketMedian, daysOnMarket }}
 */
async function fetchAttomData(address) {
  const apiKey = process.env.ATTOM_API_KEY;

  if (!apiKey || apiKey.includes('your_attom')) {
    console.log('ATTOM: No API key, using mock data');
    return getMockAttomData(address);
  }

  try {
    // Fetch property detail with mortgage info
    const params = {
      address1: address.street,
      address2: `${address.city}, ${address.state} ${address.zip}`,
    };

    const [propertyRes, saleRes] = await Promise.all([
      axios.get(`${ATTOM_BASE_URL}/property/detail`, {
        params,
        headers: { apikey: apiKey, Accept: 'application/json' },
      }),
      axios.get(`${ATTOM_BASE_URL}/sale/detail`, {
        params,
        headers: { apikey: apiKey, Accept: 'application/json' },
      }),
    ]);

    const prop = propertyRes.data?.property?.[0] || {};
    const sale = saleRes.data?.property?.[0] || {};

    const mortgage = prop.mortgage || {};
    const assessment = prop.assessment || {};
    const market = sale.sale?.amount?.saleAmt || null;

    // Delinquency: check if mortgage status indicates default
    const loanStatus = (mortgage.loanStatusCode || '').toLowerCase();
    const isDelinquent =
      loanStatus.includes('default') ||
      loanStatus.includes('delinqu') ||
      loanStatus.includes('forbear');

    const isPreForeclosure =
      loanStatus.includes('foreclos') ||
      loanStatus.includes('pre-foreclosure');

    // Equity estimate: assessed value vs outstanding mortgage
    const assessedValue = assessment.assessed?.assdTtlValue || 0;
    const loanAmount = mortgage.amount?.loanAmt || 0;
    const equityPercent =
      assessedValue > 0
        ? Math.round(((assessedValue - loanAmount) / assessedValue) * 100)
        : null;

    return {
      isDelinquent,
      isPreForeclosure,
      equityPercent,
      marketMedian: market,
      daysOnMarket: null, // ATTOM doesn't always provide this
    };
  } catch (err) {
    console.error(`ATTOM API error for ${address.street}:`, err.message);
    return getMockAttomData(address);
  }
}

module.exports = { fetchAttomData };
