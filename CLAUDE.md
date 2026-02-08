# RealDeal AI - Architecture

## Overview
Real estate deal-finding engine that identifies properties 20-30% below market value
by analyzing price data and financial distress signals.

## Tech Stack
- **Frontend**: React (Vite), Tailwind CSS, Lucide React, React-Leaflet
- **Backend**: Node.js, Express
- **Database**: MongoDB (geospatial indexing for property coordinates)

## Project Structure
```
real deal/
├── backend/
│   ├── server.js                    # Express entry point + cron startup
│   ├── config/db.js                 # MongoDB connection
│   ├── models/
│   │   └── Property.js              # Mongoose schema + post-save alert hook
│   ├── routes/
│   │   └── properties.js            # /api/properties CRUD + pipeline trigger
│   ├── services/
│   │   ├── scraper.js               # Puppeteer stealth scraper (Realtor.com)
│   │   ├── attomService.js          # ATTOM API (mortgage/foreclosure)
│   │   ├── datafinitiService.js     # Datafiniti API (tax liens)
│   │   ├── enrichmentService.js     # Orchestrator: enrich + score a deal
│   │   ├── notificationService.js   # Twilio WhatsApp alerts
│   │   └── pipeline.js              # Cron job: scrape -> enrich -> score -> save
│   ├── utils/
│   │   └── dealScorer.js            # Deal scoring algorithm (0-100)
│   └── .env                         # API keys and config
├── frontend/
│   ├── src/
│   │   ├── App.jsx                  # Main layout: sidebar + map
│   │   ├── index.css                # Tailwind entry
│   │   ├── components/
│   │   │   ├── Sidebar.jsx          # Filters, stats, property list
│   │   │   └── DealMap.jsx          # Leaflet map with color-coded pins
│   │   └── hooks/
│   │       └── useProperties.js     # Polling hook for real-time updates
│   └── vite.config.js               # Vite + Tailwind + API proxy
├── docker-compose.yml               # Local MongoDB
└── CLAUDE.md                        # This file
```

## Data Pipeline
1. **Scrape** - Puppeteer stealth scrapes Realtor.com via proxy (mock mode for dev)
2. **Enrich** - ATTOM (mortgage distress) + Datafiniti (tax liens) in parallel
3. **Score** - Deal scorer: price vs market, distress signals, DOM
4. **Save** - MongoDB upserts properties with score > 50
5. **Alert** - WhatsApp notification auto-triggers for score > 80 (post-save hook)

## Deal Scoring Algorithm
| Signal                        | Points |
|-------------------------------|--------|
| Price < 75% of market median  | 40     |
| Price 75-80% of median        | 25     |
| Price 80-85% of median        | 15     |
| Mortgage delinquent           | 30     |
| Days on market > 60           | 10     |
| Tax lien                      | 10     |
| "As-is" / "Cash only" listing | 10     |
| **Max score**                 | **100** |

## API Endpoints
- `GET /api/properties` - List properties (query: minScore, minDiscount, distressType)
- `GET /api/properties/:id` - Single property detail
- `POST /api/properties/pipeline` - Manually trigger scrape/enrich/score pipeline
- `GET /api/health` - Health check

## Frontend Features
- **Map**: Dark-themed Leaflet map with CARTO tiles
- **Pins**: Red (score > 80), Yellow (60-79), Gray (< 60)
- **Sidebar**: Stats (total/hot/warm), filters (discount %, distress type, score), property cards
- **Real-time**: Polls every 15 seconds for new deals
- **Pipeline trigger**: "Run Pipeline Now" button

## Running Locally
```bash
# Start MongoDB
docker compose up -d

# Backend (port 5000)
cd backend && npm install && npm run dev

# Frontend (port 5173, proxies /api to backend)
cd frontend && npm install && npm run dev
```

## Environment Variables (.env)
```
MONGODB_URI, ATTOM_API_KEY, DATAFINITI_API_KEY,
TWILIO_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM, TWILIO_WHATSAPP_TO,
PROXY_URL, MOCK_SCRAPER, NODE_ENV, PORT
```
All services fall back to mock data when API keys are not set.
