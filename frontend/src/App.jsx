import { useState, useRef } from 'react';
import axios from 'axios';
import Sidebar from './components/Sidebar';
import DealMap from './components/DealMap';
import ListingCarousel from './components/ListingCarousel';
import { useProperties } from './hooks/useProperties';
import { calculateMedian, scoreDealClient } from './utils/clientScorer';
import { Loader2 } from 'lucide-react';

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function App() {
  const [filters, setFilters] = useState({
    minDiscount: 0,
    distressType: '',
    minScore: 0,
    propertyType: '',
  });

  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState(null); // null = no active search
  const [searchLabel, setSearchLabel] = useState(''); // display name for the searched location
  const [searchCoords, setSearchCoords] = useState(null); // { lat, lng } for API search
  const [mapCenter, setMapCenter] = useState(null);
  const [mapBounds, setMapBounds] = useState(null);
  const searchCache = useRef({}); // { "lat,lng": { results, timestamp } }
  const { properties: dbProperties, loading, error, refetch } = useProperties();

  // Draw area state
  const [drawMode, setDrawMode] = useState(false);
  const [drawnBounds, setDrawnBounds] = useState(null);
  const [areaMedian, setAreaMedian] = useState(null);
  const [areaListingCount, setAreaListingCount] = useState(0);
  const [drawSearchLoading, setDrawSearchLoading] = useState(false);

  // When search is active, show search results; otherwise show DB properties
  const rawProperties = searchResults || dbProperties;

  // When area median is active, use area-based scores automatically
  const scoredProperties = rawProperties.map((p) => {
    if (areaMedian && p._areaMedianScore != null) {
      return {
        ...p,
        dealScore: p._areaMedianScore,
        marketMedian: areaMedian,
      };
    }
    return p;
  });

  // Apply filters client-side on all properties for instant feedback.
  // Backend also filters during search to paginate and fetch more matching results.
  const properties = scoredProperties.filter((p) => {
    if (filters.propertyType && p.propertyType !== filters.propertyType) return false;
    if (filters.minScore && (p.dealScore || 0) < filters.minScore) return false;
    if (filters.minDiscount) {
      const discount = p.price && p.marketMedian
        ? ((p.marketMedian - p.price) / p.marketMedian) * 100
        : 0;
      if (discount < filters.minDiscount) return false;
    }
    if (filters.distressType === 'preForeclosure' && !p.distressIndicators?.isPreForeclosure) return false;
    if (filters.distressType === 'delinquent' && !p.distressIndicators?.isDelinquent) return false;
    if (filters.distressType === 'taxLien' && !p.distressIndicators?.hasTaxLien) return false;
    if (filters.distressType === 'asIs' && !p.distressIndicators?.isAsIs) return false;
    return true;
  });

  async function handleTriggerPipeline() {
    setPipelineRunning(true);
    try {
      if (searchCoords) {
        // Include filters in cache key so different filter combos don't share cache
        const cacheKey = `${searchCoords.lat.toFixed(4)},${searchCoords.lng.toFixed(4)}`;
        const filterKey = JSON.stringify(filters);
        const fullCacheKey = `${cacheKey}|${filterKey}`;
        const cached = searchCache.current[fullCacheKey];

        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
          console.log(`Using cached results for ${fullCacheKey} (${Math.round((Date.now() - cached.timestamp) / 1000)}s old)`);
          setSearchResults(cached.results);
          if (cached.areaMedian) {
            setAreaMedian(cached.areaMedian);
            setAreaListingCount(cached.results.length);
          }
        } else {
          const res = await axios.post('/api/properties/search', {
            latitude: searchCoords.lat,
            longitude: searchCoords.lng,
            filters,
          });
          const { results, areaMedian: serverMedian } = res.data;
          searchCache.current[fullCacheKey] = { results: results || [], areaMedian: serverMedian, timestamp: Date.now() };
          setSearchResults(results || []);
          if (serverMedian) {
            setAreaMedian(serverMedian);
            setAreaListingCount((results || []).length);
          }
        }
      } else {
        await axios.post('/api/properties/pipeline');
        await refetch();
      }
    } catch (err) {
      console.error('Pipeline trigger failed:', err);
    } finally {
      setPipelineRunning(false);
    }
  }

  async function handleLocationSearch(query, resolvedGeo) {
    setSearchLoading(true);
    // Clear draw state — mutual exclusivity
    setDrawMode(false);
    setDrawnBounds(null);
    setAreaMedian(null);
    setAreaListingCount(0);

    try {
      let lat, lng, bounds, label;

      if (resolvedGeo) {
        lat = resolvedGeo.lat;
        lng = resolvedGeo.lng;
        bounds = resolvedGeo.boundingbox;
        label = resolvedGeo.label || query;
      } else {
        const isZip = /^\d{5}$/.test(query);
        const params = isZip
          ? { postalcode: query, country: 'US', format: 'json', limit: 1 }
          : { q: `${query}, USA`, format: 'json', limit: 1 };

        const res = await axios.get('https://nominatim.openstreetmap.org/search', { params });
        const result = res.data?.[0];
        if (!result) {
          setSearchLoading(false);
          return;
        }
        lat = parseFloat(result.lat);
        lng = parseFloat(result.lon);
        bounds = result.boundingbox;
        label = isZip ? query : result.display_name.split(',').slice(0, 2).join(',');
      }

      setMapCenter([lat, lng]);
      setSearchCoords({ lat, lng });
      if (bounds) {
        const [south, north, west, east] = bounds.map(Number);
        setMapBounds([[south, west], [north, east]]);
      }
      setSearchLabel(label);
      setSearchResults(null);
    } catch (err) {
      console.error('Location lookup failed:', err);
    } finally {
      setSearchLoading(false);
    }
  }

  function handleClearSearch() {
    setSearchResults(null);
    setSearchLabel('');
    setSearchCoords(null);
    setMapCenter(null);
    setMapBounds(null);
    // Also clear draw state
    setDrawMode(false);
    setDrawnBounds(null);
    setAreaMedian(null);
    setAreaListingCount(0);

  }

  function handleToggleDrawMode() {
    const entering = !drawMode;
    setDrawMode(entering);
    if (entering) {
      // Clear location search — mutual exclusivity
      setSearchResults(null);
      setSearchLabel('');
      setSearchCoords(null);
    }
  }

  function handleClearDraw() {
    setDrawMode(false);
    setDrawnBounds(null);
    setAreaMedian(null);
    setAreaListingCount(0);

    setSearchResults(null);
  }

  function handleDrawComplete(bounds) {
    setDrawMode(false);
    setDrawnBounds(bounds);
    // Just save the rectangle — no API call until button press
    setAreaMedian(null);
    setAreaListingCount(0);

    setSearchResults(null);
    setSearchLabel('');
    setSearchCoords(null);
    // Fly map to the drawn area
    setMapBounds(bounds);
  }

  async function handleSearchDrawnArea() {
    if (!drawnBounds) return;
    setDrawSearchLoading(true);

    try {
      const sw = { lat: drawnBounds[0][0], lng: drawnBounds[0][1] };
      const ne = { lat: drawnBounds[1][0], lng: drawnBounds[1][1] };
      const centerLat = (sw.lat + ne.lat) / 2;
      const centerLng = (sw.lng + ne.lng) / 2;

      // Haversine distance from center to corner (in miles)
      const toRad = (deg) => (deg * Math.PI) / 180;
      const dLat = toRad(ne.lat - centerLat);
      const dLng = toRad(ne.lng - centerLng);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(centerLat)) * Math.cos(toRad(ne.lat)) * Math.sin(dLng / 2) ** 2;
      const radiusMiles = 3959 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

      const res = await axios.post('/api/properties/search', {
        latitude: centerLat,
        longitude: centerLng,
        radius: Math.max(radiusMiles, 0.5),
        filters,
      });

      const allResults = res.data?.results || [];

      // Filter to only properties inside the drawn rectangle
      const filtered = allResults.filter((p) => {
        const coords = p.coordinates?.coordinates;
        if (!coords || (coords[0] === 0 && coords[1] === 0)) return false;
        const pLat = coords[1];
        const pLng = coords[0];
        return pLat >= sw.lat && pLat <= ne.lat && pLng >= sw.lng && pLng <= ne.lng;
      });

      // Calculate area median from filtered prices
      const prices = filtered.map((p) => p.price).filter((p) => p && p > 0);
      const median = calculateMedian(prices);

      // Re-score each property with the area median
      const rescored = filtered.map((p) => ({
        ...p,
        _originalScore: p.dealScore,
        _originalMedian: p.marketMedian,
        _areaMedianScore: scoreDealClient(p, median),
      }));

      setSearchResults(rescored);
      setAreaMedian(median);
      setAreaListingCount(filtered.length);
    } catch (err) {
      console.error('Draw area search failed:', err);
    } finally {
      setDrawSearchLoading(false);
    }
  }

  return (
    <div className="flex h-screen bg-gray-950 text-white">
      <Sidebar
        filters={filters}
        setFilters={setFilters}
        properties={properties}
        onTriggerPipeline={handleTriggerPipeline}
        pipelineRunning={pipelineRunning}
        onLocationSearch={handleLocationSearch}
        searchLoading={searchLoading}
        searchLabel={searchLabel}
        onClearSearch={handleClearSearch}
        drawMode={drawMode}
        onToggleDrawMode={handleToggleDrawMode}
        drawnBounds={drawnBounds}
        onClearDraw={handleClearDraw}
        areaMedian={areaMedian}
        areaListingCount={areaListingCount}
        drawSearchLoading={drawSearchLoading}
        onSearchDrawnArea={handleSearchDrawnArea}
      />

      <div className="flex-1 relative overflow-hidden">
        {loading && properties.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-950 z-50">
            <div className="text-center">
              <Loader2 className="w-8 h-8 animate-spin text-emerald-400 mx-auto mb-2" />
              <p className="text-gray-400 text-sm">Loading deals...</p>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-red-900/80 text-red-200 text-sm px-4 py-2 rounded-lg">
            {error}
          </div>
        )}

        {searchResults && properties.length === 0 && !pipelineRunning && !drawSearchLoading && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-gray-900/90 border border-gray-700 rounded-xl px-8 py-6 text-center">
            <p className="text-gray-300 font-semibold mb-1">No listings found</p>
            <p className="text-gray-500 text-sm">Try a different location or adjust your filters.</p>
          </div>
        )}

        {/* Draw mode indicator */}
        {drawMode && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[1001] bg-emerald-900/90 border border-emerald-600 rounded-lg px-4 py-2 text-sm text-emerald-300 font-medium pointer-events-none">
            Click and drag on the map to draw a search area
          </div>
        )}

        {drawSearchLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-950/60 z-50">
            <div className="text-center bg-gray-900 border border-gray-700 rounded-xl px-8 py-6">
              <Loader2 className="w-8 h-8 animate-spin text-emerald-400 mx-auto mb-2" />
              <p className="text-gray-300 text-sm">Searching drawn area...</p>
            </div>
          </div>
        )}

        <DealMap
          properties={properties}
          center={mapCenter}
          bounds={mapBounds}
          drawMode={drawMode}
          drawnBounds={drawnBounds}
          onDrawComplete={handleDrawComplete}
        />

        {/* Legend */}
        <div className="absolute top-4 left-4 bg-gray-900/90 border border-gray-700 rounded-lg px-4 py-3 z-[1000]">
          <p className="text-xs font-semibold text-gray-400 mb-2">Deal Score</p>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-red-400 inline-block" />
              <span className="text-xs text-gray-300">Hot (&gt; 80)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-yellow-400 inline-block" />
              <span className="text-xs text-gray-300">Warm (60-79)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-gray-400 inline-block" />
              <span className="text-xs text-gray-300">Cool (&lt; 60)</span>
            </div>
          </div>
        </div>

        {/* Listing Carousel */}
        <ListingCarousel
          properties={properties}
          onSelectProperty={(p) => {
            const coords = p.coordinates?.coordinates;
            if (coords && !(coords[0] === 0 && coords[1] === 0)) {
              setMapCenter([coords[1], coords[0]]);
              setMapBounds(null);
            }
          }}
        />
      </div>
    </div>
  );
}

export default App;
