require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const propertyRoutes = require('./routes/properties');
const { startCronPipeline } = require('./services/pipeline');

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

    // Start the scrape -> enrich -> score pipeline (every 30 min)
    startCronPipeline();
  });
});

module.exports = app;
