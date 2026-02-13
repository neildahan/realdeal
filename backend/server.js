require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const propertyRoutes = require('./routes/properties');
// Cron pipeline disabled — ATTOM calls only happen on explicit user searches
// const { startCronPipeline } = require('./services/pipeline');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/properties', propertyRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Connect to DB and start server
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`RealDeal backend running on port ${PORT}`);

    // Cron pipeline disabled to save ATTOM API calls.
    // Enrichment only runs when user explicitly searches with distress filters.
    // Manual pipeline trigger still available via POST /api/properties/pipeline.
  });
});

module.exports = app;
