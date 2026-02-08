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

/**
 * Batch fetch tax lien data for multiple addresses in a single API call.
 *
 * @param {Array<{street, city, state, zip}>} addresses
 * @returns {Map<string, {hasTaxLien, priceDropPercent, taxLienAmount}>} keyed by street
 */
async function fetchDatafinitiBatch(addresses) {
  const results = new Map();
  const apiKey = process.env.DATAFINITI_API_KEY;

  if (!apiKey || apiKey.includes('your_datafiniti') || addresses.length === 0) {
    for (const addr of addresses) {
      results.set(addr.street, { hasTaxLien: false, priceDropPercent: 0, taxLienAmount: 0 });
    }
    return results;
  }

  try {
    // Build OR query for all addresses in one call
    const clauses = addresses.map(
      (a) => `(address:"${a.street}" AND city:"${a.city}" AND province:"${a.state}")`
    );
    const query = clauses.join(' OR ');

    const res = await axios.post(
      DATAFINITI_BASE_URL,
      {
        query,
        format: 'JSON',
        num_records: addresses.length,
        download: false,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const records = res.data?.records || [];
    console.log(`Datafiniti batch: ${records.length} records for ${addresses.length} addresses`);

    // Index records by street address
    const recordMap = new Map();
    for (const record of records) {
      const street = record.address || record.streetAddress || '';
      if (street) recordMap.set(street.toLowerCase(), record);
    }

    for (const addr of addresses) {
      const record = recordMap.get(addr.street.toLowerCase());
      if (!record) {
        results.set(addr.street, { hasTaxLien: false, priceDropPercent: 0, taxLienAmount: 0 });
        continue;
      }

      const features = (record.features || []).map((f) => (f.key || '').toLowerCase());
      const hasTaxLien =
        features.some((f) => f.includes('tax lien') || f.includes('lien')) ||
        (record.taxLienAmount && record.taxLienAmount > 0);
      const taxLienAmount = record.taxLienAmount || 0;

      let priceDropPercent = 0;
      const prices = record.prices || [];
      if (prices.length >= 2) {
        const sorted = [...prices].sort((a, b) => new Date(a.dateSeen) - new Date(b.dateSeen));
        const oldest = sorted[0].amountMax || sorted[0].amountMin;
        const newest = sorted[sorted.length - 1].amountMax || sorted[sorted.length - 1].amountMin;
        if (oldest && newest && oldest > newest) {
          priceDropPercent = Math.round(((oldest - newest) / oldest) * 100);
        }
      }

      results.set(addr.street, { hasTaxLien, priceDropPercent, taxLienAmount });
    }

    // Fill any missing
    for (const addr of addresses) {
      if (!results.has(addr.street)) {
        results.set(addr.street, { hasTaxLien: false, priceDropPercent: 0, taxLienAmount: 0 });
      }
    }
  } catch (err) {
    console.error('Datafiniti batch error:', err.message);
    for (const addr of addresses) {
      results.set(addr.street, { hasTaxLien: false, priceDropPercent: 0, taxLienAmount: 0 });
    }
  }

  return results;
}

module.exports = { fetchDatafinitiData, fetchDatafinitiBatch };
