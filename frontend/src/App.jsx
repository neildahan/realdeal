import { useState, useRef, useCallback } from 'react';
import axios from 'axios';
import Sidebar from './components/Sidebar';
import DealMap from './components/DealMap';
import ListingCarousel from './components/ListingCarousel';
import { useProperties } from './hooks/useProperties';
import { computeMarketData, estimateMarketValue, scoreDealClient } from './utils/clientScorer';
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
  const [searchResults, setSearchResults] = useState(null);
  const [searchLabel, setSearchLabel] = useState('');
  const [searchCoords, setSearchCoords] = useState(null);
  const [searchRadius, setSearchRadius] = useState(null); // miles, computed from bounding box
  const [areaBounds, setAreaBounds] = useState(null); // visual boundary overlay on map
  const [mapCenter, setMapCenter] = useState(null);
  const [mapBounds, setMapBounds] = useState(null);
  const [enrichProgress, setEnrichProgress] = useState(null);
  const [noResults, setNoResults] = useState(false);
  const searchCache = useRef({});
  const { properties: dbProperties, loading, error, refetch } = useProperties();

  // Draw area state
  const [drawMode, setDrawMode] = useState(false);
  const [drawnBounds, setDrawnBounds] = useState(null);
  const [areaMedian, setAreaMedian] = useState(null);
  const [areaListingCount, setAreaListingCount] = useState(0);
  const [medianRange, setMedianRange] = useState(null);
  const [drawSearchLoading, setDrawSearchLoading] = useState(false);

  const rawProperties = searchResults || dbProperties;

  const scoredProperties = rawProperties.map((p) => {
    if (areaMedian && p._areaMedianScore != null) {
      return { ...p, dealScore: p._areaMedianScore, marketMedian: areaMedian };
    }
    return p;
  });

  // Determine active geographic bounds (location search OR drawn area)
  const activeBounds = areaBounds || drawnBounds;

  const properties = scoredProperties.filter((p) => {
    // Geographic bounds filter — only show pins inside the search area
    if (activeBounds) {
      const coords = p.coordinates?.coordinates;
      if (!coords || (coords[0] === 0 && coords[1] === 0)) return false;
      const pLat = coords[1];
      const pLng = coords[0];
      const [[south, west], [north, east]] = activeBounds;
      if (pLat < south || pLat > north || pLng < west || pLng > east) return false;
    }

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

  /**
   * Compute radius in miles from a Nominatim bounding box [south, north, west, east].
   */
  function radiusFromBounds(bounds) {
    if (!bounds || bounds.length < 4) return 5;
    const [south, north, west, east] = bounds.map(Number);
    const toRad = (deg) => (deg * Math.PI) / 180;
    const centerLat = (south + north) / 2;
    const dLat = toRad(north - south);
    const dLng = toRad(east - west);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(centerLat)) * Math.cos(toRad(centerLat)) * Math.sin(dLng / 2) ** 2;
    const miles = 3959 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    // Clamp between 1 and 15 miles
    return Math.max(1, Math.min(15, Math.round(miles * 10) / 10));
  }

  /**
   * Run the SSE search pipeline for given coordinates.
   */
  const runSearch = useCallback(async (lat, lng, radius, currentFilters, searchBounds) => {
    setPipelineRunning(true);
    setEnrichProgress(null);
    setNoResults(false);

    const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    const filterKey = JSON.stringify(currentFilters);
    const boundsKey = searchBounds ? JSON.stringify(searchBounds) : 'none';
    const fullCacheKey = `${cacheKey}|${filterKey}|${boundsKey}`;
    const cached = searchCache.current[fullCacheKey];

    try {
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        setSearchResults(cached.results);
        setNoResults(cached.results.length === 0);
        if (cached.areaMedian) {
          setAreaMedian(cached.areaMedian);
          setAreaListingCount(cached.results.length);
        }
      } else {
        const params = new URLSearchParams({
          latitude: lat,
          longitude: lng,
          radius: radius || 5,
          filters: JSON.stringify(currentFilters),
        });
        if (searchBounds) {
          params.set('bounds', JSON.stringify(searchBounds));
        }
        await new Promise((resolve, reject) => {
          const es = new EventSource(`/api/properties/search/stream?${params}`);
          es.addEventListener('progress', (e) => {
            setEnrichProgress(JSON.parse(e.data));
          });
          es.addEventListener('results', (e) => {
            const { results, areaMedian: serverMedian } = JSON.parse(e.data);
            searchCache.current[fullCacheKey] = { results: results || [], areaMedian: serverMedian, timestamp: Date.now() };
            setSearchResults(results || []);
            setNoResults((results || []).length === 0);
            if (serverMedian) {
              setAreaMedian(serverMedian);
              setAreaListingCount((results || []).length);
            }
            es.close();
            resolve();
          });
          es.addEventListener('error', () => {
            es.close();
            reject(new Error('Stream error'));
          });
          es.onerror = () => { es.close(); reject(new Error('SSE connection error')); };
        });
      }
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setPipelineRunning(false);
      setEnrichProgress(null);
    }
  }, []);

  /**
   * "Find Deals" button — re-search current area with current filters.
   */
  async function handleTriggerPipeline() {
    if (searchCoords) {
      await runSearch(searchCoords.lat, searchCoords.lng, searchRadius, filters, areaBounds);
    } else if (drawnBounds) {
      await handleSearchDrawnArea();
    }
  }

  /**
   * Location search: geocode → fly map + show area boundary. No auto-search.
   */
  async function handleLocationSearch(query, resolvedGeo) {
    setSearchLoading(true);
    setDrawMode(false);
    setDrawnBounds(null);
    setAreaMedian(null);
    setAreaListingCount(0);
    setMedianRange(null);
    // Clear search cache so stale results from previous searches don't persist
    searchCache.current = {};

    try {
      let lat, lng, bounds, label;

      if (resolvedGeo && resolvedGeo.lat != null && resolvedGeo.lng != null) {
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

      // Compute radius from bounding box
      const radius = radiusFromBounds(bounds);

      // Build area bounds — fallback to ~2 mile box around center if no bounding box
      let boundsArr;
      if (bounds && bounds.length >= 4) {
        const [south, north, west, east] = bounds.map(Number);
        boundsArr = [[south, west], [north, east]];
      } else {
        const delta = 0.03; // ~2 miles
        boundsArr = [[lat - delta, lng - delta], [lat + delta, lng + delta]];
      }

      setMapCenter([lat, lng]);
      setSearchCoords({ lat, lng });
      setSearchRadius(radius);
      setMapBounds(boundsArr);
      setAreaBounds(boundsArr);
      setSearchLabel(label);
      setSearchResults(null);
      setSearchLoading(false);
    } catch (err) {
      console.error('Location lookup failed:', err);
      setSearchLoading(false);
    }
  }

  function handleClearSearch() {
    setSearchResults(null);
    setSearchLabel('');
    setSearchCoords(null);
    setSearchRadius(null);
    setMapCenter(null);
    setMapBounds(null);
    setAreaBounds(null);
    setDrawMode(false);
    setDrawnBounds(null);
    setAreaMedian(null);
    setAreaListingCount(0);
    setMedianRange(null);
  }

  function handleToggleDrawMode() {
    const entering = !drawMode;
    setDrawMode(entering);
    if (entering) {
      setSearchResults(null);
      setSearchLabel('');
      setSearchCoords(null);
      setSearchRadius(null);
    }
  }

  function handleClearDraw() {
    setDrawMode(false);
    setDrawnBounds(null);
    setAreaMedian(null);
    setAreaListingCount(0);
    setMedianRange(null);
    setSearchResults(null);
  }

  function handleDrawComplete(bounds) {
    setDrawMode(false);
    setDrawnBounds(bounds);
    setAreaMedian(null);
    setAreaListingCount(0);
    setMedianRange(null);
    setSearchResults(null);
    setSearchLabel('');
    setSearchCoords(null);
    setSearchRadius(null);
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

      const toRad = (deg) => (deg * Math.PI) / 180;
      const dLat = toRad(ne.lat - centerLat);
      const dLng = toRad(ne.lng - centerLng);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(centerLat)) * Math.cos(toRad(ne.lat)) * Math.sin(dLng / 2) ** 2;
      const radiusMiles = 3959 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

      const boundsArr = [[sw.lat, sw.lng], [ne.lat, ne.lng]];
      const res = await axios.post('/api/properties/search', {
        latitude: centerLat,
        longitude: centerLng,
        radius: Math.max(radiusMiles, 0.5),
        filters,
        bounds: boundsArr,
      });

      // Results are already bounds-filtered by the backend
      const filtered = (res.data?.results || []).filter((p) => {
        const coords = p.coordinates?.coordinates;
        return coords && !(coords[0] === 0 && coords[1] === 0);
      });

      const marketData = computeMarketData(filtered);
      const drawnAreaMedian = marketData.areaPriceMedian;

      const rescored = filtered.map((p) => {
        const bestMedian = estimateMarketValue(p, marketData);
        return {
          ...p,
          _originalScore: p.dealScore,
          _originalMedian: p.marketMedian,
          marketMedian: bestMedian,
          _areaMedianScore: scoreDealClient(p, bestMedian),
        };
      });

      const uniqueMedians = [...new Set(rescored.map((p) => p.marketMedian).filter(Boolean))];
      const minMedian = Math.min(...uniqueMedians);
      const maxMedian = Math.max(...uniqueMedians);

      setSearchResults(rescored);
      setAreaMedian(drawnAreaMedian);
      setMedianRange(uniqueMedians.length > 1 ? { min: minMedian, max: maxMedian } : null);
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
        hasLocation={!!searchCoords}
        onClearSearch={handleClearSearch}
        drawMode={drawMode}
        onToggleDrawMode={handleToggleDrawMode}
        drawnBounds={drawnBounds}
        onClearDraw={handleClearDraw}
        areaMedian={areaMedian}
        areaListingCount={areaListingCount}
        drawSearchLoading={drawSearchLoading}
        onSearchDrawnArea={handleSearchDrawnArea}
        hasSearchResults={searchResults !== null}
        medianRange={medianRange}
      />

      <div className="flex-1 relative overflow-hidden">
        {noResults && !pipelineRunning && !drawSearchLoading && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-gray-900/90 border border-gray-700 rounded-xl px-8 py-6 text-center">
            <p className="text-gray-300 font-semibold mb-1">No deals found</p>
            <p className="text-gray-500 text-sm">Try a different location or adjust your filters.</p>
          </div>
        )}

        {error && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-red-900/80 text-red-200 text-sm px-4 py-2 rounded-lg">
            {error}
          </div>
        )}

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

        {enrichProgress && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-950/70 z-50 backdrop-blur-sm">
            <div className="bg-gray-900 border border-gray-700 rounded-2xl px-10 py-8 w-[420px] shadow-2xl">
              <div className="flex items-center gap-3 mb-4">
                <Loader2 className="w-5 h-5 animate-spin text-emerald-400 flex-shrink-0" />
                <p className="text-white font-semibold text-base">
                  {enrichProgress.phase === 'fetching' && 'Fetching Listings'}
                  {enrichProgress.phase === 'fetched' && 'Listings Found'}
                  {enrichProgress.phase === 'refining' && 'Refining Valuations'}
                  {enrichProgress.phase === 'enriching' && 'Checking Distress Signals'}
                  {enrichProgress.phase === 'validating' && 'Verifying Top Deals'}
                  {enrichProgress.phase === 'done' && 'Complete'}
                </p>
              </div>
              <div className="w-full bg-gray-800 rounded-full h-3 mb-3 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-300 ease-out"
                  style={{ width: `${enrichProgress.percent || 0}%` }}
                />
              </div>
              <div className="flex justify-between items-center">
                <p className="text-gray-400 text-sm truncate max-w-[280px]">
                  {enrichProgress.message}
                </p>
                {enrichProgress.total && (
                  <p className="text-gray-500 text-xs flex-shrink-0 ml-2">
                    {enrichProgress.current}/{enrichProgress.total}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        <DealMap
          properties={properties}
          center={mapCenter}
          bounds={mapBounds}
          areaBounds={areaBounds}
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

        {searchResults && properties.length > 0 && (
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
        )}
      </div>
    </div>
  );
}

export default App;
