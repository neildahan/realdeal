const axios = require('axios');

const DATAFINITI_BASE_URL = 'https://api.datafiniti.co/v4/properties/search';

/**
 * Mock Datafiniti response for development.
 */
function getMockDatafinitiData(address) {
  const rand = Math.random();
  return {
    hasTaxLien: rand < 0.35,
    priceDropPercent: rand < 0.5 ? Math.round(Math.random() * 30) : 0,
    taxLienAmount: rand < 0.35 ? Math.round(Math.random() * 15000) : 0,
  };
}

/**
 * Fetch tax lien and price drop history from Datafiniti.
 *
 * @param {object} address - { street, city, state, zip }
 * @returns {{ hasTaxLien, priceDropPercent, taxLienAmount }}
 */
async function fetchDatafinitiData(address) {
  const apiKey = process.env.DATAFINITI_API_KEY;

  if (!apiKey || apiKey.includes('your_datafiniti')) {
    console.log('Datafiniti: No API key, using mock data');
    return getMockDatafinitiData(address);
  }

  try {
    const query = `address:"${address.street}" AND city:"${address.city}" AND province:"${address.state}"`;

    const res = await axios.post(
      DATAFINITI_BASE_URL,
      {
        query,
        format: 'JSON',
        num_records: 1,
        download: false,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const record = res.data?.records?.[0];
    if (!record) {
      console.log(`Datafiniti: No records found for ${address.street}`);
      return { hasTaxLien: false, priceDropPercent: 0, taxLienAmount: 0 };
    }

    // Check for tax liens in features or tax history
    const features = (record.features || []).map((f) =>
      (f.key || '').toLowerCase()
    );
    const hasTaxLien =
      features.some((f) => f.includes('tax lien') || f.includes('lien')) ||
      (record.taxLienAmount && record.taxLienAmount > 0);

    const taxLienAmount = record.taxLienAmount || 0;

    // Calculate price drop from price history
    let priceDropPercent = 0;
    const prices = record.prices || [];
    if (prices.length >= 2) {
      const sorted = [...prices].sort(
        (a, b) => new Date(a.dateSeen) - new Date(b.dateSeen)
      );
      const oldest = sorted[0].amountMax || sorted[0].amountMin;
      const newest =
        sorted[sorted.length - 1].amountMax ||
        sorted[sorted.length - 1].amountMin;
      if (oldest && newest && oldest > newest) {
        priceDropPercent = Math.round(((oldest - newest) / oldest) * 100);
      }
    }

    return { hasTaxLien, priceDropPercent, taxLienAmount };
  } catch (err) {
    console.error(`Datafiniti API error for ${address.street}:`, err.message);
    return getMockDatafinitiData(address);
  }
}

module.exports = { fetchDatafinitiData };
