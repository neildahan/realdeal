const twilio = require('twilio');

let client = null;

function getClient() {
  if (client) return client;

  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || sid.includes('your_twilio') || !token || token.includes('your_twilio')) {
    return null;
  }

  client = twilio(sid, token);
  return client;
}

/**
 * Build the formatted WhatsApp alert message for a deal.
 */
function formatDealAlert(property) {
  const addr = property.address;
  const fullAddress = `${addr.street}, ${addr.city}, ${addr.state} ${addr.zip}`;

  // Calculate discount percentage
  let discountText = '';
  if (property.price && property.marketMedian && property.marketMedian > 0) {
    const discount = Math.round(
      ((property.marketMedian - property.price) / property.marketMedian) * 100
    );
    discountText = `${discount}% under market`;
  } else {
    discountText = 'below market value';
  }

  // Build distress summary
  const distress = [];
  const d = property.distressIndicators || {};
  if (d.isDelinquent) distress.push('Mortgage Delinquent');
  if (d.isPreForeclosure) distress.push('Pre-Foreclosure');
  if (d.hasTaxLien) distress.push('Tax Lien');
  if (d.isAsIs) distress.push('As-Is / Cash Only');
  const distressText = distress.length > 0 ? distress.join(', ') : 'None confirmed';

  const link = property.listingUrl || 'No link available';

  return [
    `🔥 DEAL ALERT: ${fullAddress} is ${discountText}.`,
    `💰 Price: $${property.price?.toLocaleString()} | Market: $${property.marketMedian?.toLocaleString()}`,
    `📊 Deal Score: ${property.dealScore}/100`,
    `⚠️ Distress: ${distressText}`,
    `🏠 ${property.sqft ? property.sqft + ' sqft | ' : ''}${property.daysOnMarket} days on market`,
    `🔗 ${link}`,
  ].join('\n');
}

/**
 * Send a WhatsApp deal alert via Twilio.
 * Returns true if sent, false if skipped (no credentials).
 */
async function sendWhatsAppAlert(property) {
  const message = formatDealAlert(property);

  const twilioClient = getClient();
  if (!twilioClient) {
    console.log('Twilio: No credentials, logging alert instead:');
    console.log('--- WhatsApp Alert ---');
    console.log(message);
    console.log('--- End Alert ---');
    return false;
  }

  try {
    const result = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: process.env.TWILIO_WHATSAPP_TO,
    });
    console.log(`WhatsApp alert sent: SID ${result.sid}`);
    return true;
  } catch (err) {
    console.error('WhatsApp send failed:', err.message);
    return false;
  }
}

module.exports = { sendWhatsAppAlert, formatDealAlert };
