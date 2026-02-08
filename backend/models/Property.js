const mongoose = require('mongoose');
const { sendWhatsAppAlert } = require('../services/notificationService');

const propertySchema = new mongoose.Schema(
  {
    // Listing basics
    address: {
      street: { type: String, required: true },
      city: { type: String, required: true },
      state: { type: String, required: true },
      zip: { type: String, required: true },
    },
    price: { type: Number, required: true },
    marketMedian: { type: Number, default: null },
    sqft: { type: Number, default: null },
    bedrooms: { type: Number, default: null },
    bathrooms: { type: Number, default: null },
    propertyType: { type: String, default: 'unknown' },
    listingStatus: { type: String, default: 'unknown' },
    daysOnMarket: { type: Number, default: 0 },
    listingUrl: { type: String, default: null },
    photoUrl: { type: String, default: null },
    photos: { type: [String], default: [] },
    description: { type: String, default: '' },

    // GeoJSON point for geospatial queries
    coordinates: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: true,
      },
    },

    // Financial distress signals
    distressIndicators: {
      isDelinquent: { type: Boolean, default: false },
      hasTaxLien: { type: Boolean, default: false },
      isAsIs: { type: Boolean, default: false },
      isPreForeclosure: { type: Boolean, default: false },
      equityPercent: { type: Number, default: null },
      priceDropPercent: { type: Number, default: null },
    },

    // Zillow data
    zestimate: { type: Number, default: null },
    rentZestimate: { type: Number, default: null },

    // Computed deal score (0-100)
    dealScore: { type: Number, default: 0 },

    // Track enrichment status
    enriched: { type: Boolean, default: false },
    enrichedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Geospatial index for proximity queries
propertySchema.index({ coordinates: '2dsphere' });

// Index for fast deal lookups
propertySchema.index({ dealScore: -1 });

// Track which properties already triggered an alert to avoid duplicates
propertySchema.add({ alertSent: { type: Boolean, default: false } });

// Post-save hook: send WhatsApp alert for hot deals (score > 80)
propertySchema.post('save', async function (doc) {
  if (doc.dealScore > 80 && !doc.alertSent) {
    console.log(`Hot deal detected (${doc.dealScore}): ${doc.address.street} — sending alert`);
    await sendWhatsAppAlert(doc);
    // Mark alert as sent to avoid re-sending on future updates
    await doc.constructor.updateOne({ _id: doc._id }, { alertSent: true });
  }
});

// Also trigger on findOneAndUpdate (used by the pipeline upsert)
propertySchema.post('findOneAndUpdate', async function (doc) {
  if (doc && doc.dealScore > 80 && !doc.alertSent) {
    console.log(`Hot deal detected (${doc.dealScore}): ${doc.address.street} — sending alert`);
    await sendWhatsAppAlert(doc);
    await doc.constructor.updateOne({ _id: doc._id }, { alertSent: true });
  }
});

module.exports = mongoose.model('Property', propertySchema);
