import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { SlidersHorizontal, AlertTriangle, Home, TrendingDown, Gavel, RefreshCw, Search, MapPin, Loader2, X, Info, Building, PenTool, BarChart3, Clock } from 'lucide-react';

const RECENT_SEARCHES_KEY = 'realdeal_recent_searches';
const MAX_RECENT = 10;

function getRecentSearches() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY)) || [];
  } catch { return []; }
}

function saveRecentSearch(entry) {
  const recent = getRecentSearches().filter((r) => r.label !== entry.label);
  recent.unshift(entry);
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(recent));
}

const DISTRESS_OPTIONS = [
  { value: '', label: 'All Types' },
  { value: 'preForeclosure', label: 'Pre-Foreclosure' },
  { value: 'delinquent', label: 'Mortgage Delinquent' },
  { value: 'taxLien', label: 'Tax Lien' },
  { value: 'asIs', label: 'As-Is / Cash Only' },
];

const PROPERTY_TYPE_OPTIONS = [
  { value: '', label: 'All Property Types' },
  { value: 'singleFamily', label: 'Single Family' },
  { value: 'condo', label: 'Condo' },
  { value: 'townhouse', label: 'Townhouse' },
  { value: 'multiFamily', label: 'Multi-Family' },
  { value: 'lot', label: 'Lot / Land' },
  { value: 'manufactured', label: 'Manufactured' },
];

export default function Sidebar({ filters, setFilters, properties, onTriggerPipeline, pipelineRunning, onLocationSearch, searchLoading, searchLabel, onClearSearch, drawMode, onToggleDrawMode, drawnBounds, onClearDraw, areaMedian, areaListingCount, drawSearchLoading, onSearchDrawnArea }) {
  const [searchInput, setSearchInput] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [showScoreInfo, setShowScoreInfo] = useState(false);
  const debounceRef = useRef(null);
  const wrapperRef = useRef(null);
  const hotDeals = properties.filter((p) => p.dealScore > 80).length;
  const warmDeals = properties.filter((p) => p.dealScore >= 60 && p.dealScore <= 80).length;

  // Close suggestions on outside click
  useEffect(() => {
    function handleClick(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Show recent searches when input is short, Nominatim when >= 3 chars
  function handleInputChange(value) {
    setSearchInput(value);
    clearTimeout(debounceRef.current);

    if (value.trim().length < 3) {
      // Show recent searches filtered by input
      const recent = getRecentSearches();
      const filtered = value.trim().length === 0
        ? recent
        : recent.filter((r) => r.label.toLowerCase().includes(value.trim().toLowerCase()));
      setSuggestions(filtered.map((r) => ({ ...r, isRecent: true })));
      setShowSuggestions(filtered.length > 0);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const isZip = /^\d{3,5}$/.test(value.trim());
        const params = isZip
          ? { postalcode: value.trim(), country: 'US', format: 'json', limit: 5 }
          : { q: `${value.trim()}, USA`, format: 'json', limit: 5, addressdetails: 1 };

        const res = await axios.get('https://nominatim.openstreetmap.org/search', { params });
        const results = (res.data || []).map((r) => ({
          label: r.display_name.split(',').slice(0, 3).join(','),
          fullLabel: r.display_name,
          lat: parseFloat(r.lat),
          lng: parseFloat(r.lon),
          boundingbox: r.boundingbox,
        }));
        setSuggestions(results);
        setShowSuggestions(results.length > 0);
      } catch {
        setSuggestions([]);
      }
    }, 350);
  }

  function handleInputFocus() {
    if (suggestions.length > 0) {
      setShowSuggestions(true);
    } else if (searchInput.trim().length < 3) {
      // Show recent searches on focus
      const recent = getRecentSearches();
      if (recent.length > 0) {
        setSuggestions(recent.map((r) => ({ ...r, isRecent: true })));
        setShowSuggestions(true);
      }
    }
  }

  function handleSelectSuggestion(suggestion) {
    setSearchInput(suggestion.label);
    setSuggestions([]);
    setShowSuggestions(false);
    saveRecentSearch({ label: suggestion.label, lat: suggestion.lat, lng: suggestion.lng, boundingbox: suggestion.boundingbox });
    onLocationSearch(suggestion.label, suggestion);
  }

  function handleSearch(e) {
    e.preventDefault();
    if (searchInput.trim().length >= 2) {
      setShowSuggestions(false);
      // Save text-only search (no geo data — will be geocoded by parent)
      saveRecentSearch({ label: searchInput.trim() });
      onLocationSearch(searchInput.trim());
    }
  }

  return (
    <div className="w-80 bg-gray-900 border-r border-gray-800 flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="p-4 border-b border-gray-800">
        <div className="flex items-center gap-2 mb-1">
          <Home className="w-6 h-6 text-emerald-400" />
          <h1 className="text-xl font-bold text-white">RealDeal AI</h1>
        </div>
        <p className="text-xs text-gray-500">Real estate deal-finding engine</p>
      </div>

      {/* Location Search */}
      <form onSubmit={handleSearch} className="p-4 border-b border-gray-800">
        <label className="text-xs text-gray-400 block mb-2">
          <MapPin className="w-3 h-3 inline mr-1" />
          Search by Location
        </label>
        <div className="flex gap-2">
          <div className="flex-1 relative" ref={wrapperRef}>
            <input
              type="text"
              value={searchInput}
              onChange={(e) => handleInputChange(e.target.value)}
              onFocus={handleInputFocus}
              placeholder="Zip, neighborhood, or city..."
              className="w-full bg-gray-800 text-gray-200 text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-emerald-500 focus:outline-none placeholder-gray-600"
            />
            {showSuggestions && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-gray-800 border border-gray-700 rounded-lg overflow-hidden shadow-xl z-50 max-h-56 overflow-y-auto">
                {suggestions.length > 0 && suggestions[0].isRecent && (
                  <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-700">
                    Recent Searches
                  </div>
                )}
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => handleSelectSuggestion(s)}
                    className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
                  >
                    {s.isRecent ? (
                      <Clock className="w-3 h-3 text-gray-500 shrink-0" />
                    ) : (
                      <MapPin className="w-3 h-3 text-gray-500 shrink-0" />
                    )}
                    <span className="truncate">{s.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="submit"
            disabled={searchInput.trim().length < 2 || searchLoading}
            className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium px-3 py-2 rounded-lg transition-colors"
          >
            {searchLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
          </button>
        </div>
      </form>

      {/* Draw Area to Search */}
      <div className="px-4 py-3 border-b border-gray-800">
        {!drawnBounds ? (
          <button
            onClick={onToggleDrawMode}
            className={`w-full flex items-center justify-center gap-2 text-sm font-medium py-2 px-4 rounded-lg transition-colors ${
              drawMode
                ? 'bg-emerald-600 text-white'
                : 'bg-gray-800 text-gray-300 hover:bg-gray-700 border border-gray-700'
            }`}
          >
            <PenTool className="w-4 h-4" />
            {drawMode ? 'Drawing... click & drag on map' : 'Draw Area to Search'}
          </button>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-emerald-400 font-medium flex items-center gap-1">
                <PenTool className="w-3 h-3" />
                Drawn area active
              </span>
              <button
                onClick={onClearDraw}
                className="text-xs text-gray-400 hover:text-white flex items-center gap-1 transition-colors"
              >
                <X className="w-3 h-3" />
                Clear
              </button>
            </div>

            {/* Search This Area button */}
            {!areaMedian && (
              <button
                onClick={onSearchDrawnArea}
                disabled={drawSearchLoading}
                className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors"
              >
                {drawSearchLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Search className="w-4 h-4" />
                )}
                {drawSearchLoading ? 'Searching...' : 'Search This Area'}
              </button>
            )}

            {/* Area Median Display */}
            {areaMedian != null && areaMedian > 0 && (
              <div className="bg-gray-800 rounded-lg p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-xs text-gray-400">
                  <BarChart3 className="w-3 h-3" />
                  Area Market Median
                </div>
                <p className="text-lg font-bold text-emerald-400">
                  ${areaMedian.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </p>
                <p className="text-[11px] text-gray-500">
                  Based on {areaListingCount} listing{areaListingCount !== 1 ? 's' : ''} in drawn area
                </p>
              </div>
            )}

            {/* Scoring note */}
            {areaMedian != null && areaMedian > 0 && (
              <p className="text-[11px] text-gray-500">
                Deal scores are based on the area median above
              </p>
            )}
          </div>
        )}
      </div>

      {/* Active Search Banner */}
      {searchLabel && (
        <div className="px-4 py-2 bg-emerald-900/30 border-b border-emerald-800/50 flex items-center justify-between">
          <span className="text-xs text-emerald-400">
            Showing results for <span className="font-bold">{searchLabel}</span>
          </span>
          <button
            onClick={onClearSearch}
            className="text-xs text-gray-400 hover:text-white flex items-center gap-1 transition-colors"
          >
            <X className="w-3 h-3" />
            Clear
          </button>
        </div>
      )}

      {/* Stats */}
      <div className="p-4 border-b border-gray-800 grid grid-cols-3 gap-2">
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-white">{properties.length}</p>
          <p className="text-xs text-gray-400">Total</p>
        </div>
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-red-400">{hotDeals}</p>
          <p className="text-xs text-gray-400">Hot</p>
        </div>
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-yellow-400">{warmDeals}</p>
          <p className="text-xs text-gray-400">Warm</p>
        </div>
      </div>

      {/* Filters */}
      <div className="p-4 border-b border-gray-800 space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-300">
          <SlidersHorizontal className="w-4 h-4" />
          Filters
        </div>

        {/* Distress Type */}
        <div>
          <label className="text-xs text-gray-400 block mb-1">
            <AlertTriangle className="w-3 h-3 inline mr-1" />
            Distress Type
          </label>
          <select
            value={filters.distressType}
            onChange={(e) => setFilters((f) => ({ ...f, distressType: e.target.value }))}
            className="w-full bg-gray-800 text-gray-200 text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-emerald-500 focus:outline-none"
          >
            {DISTRESS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {(filters.distressType === 'delinquent' || filters.distressType === 'taxLien') && (
            <p className="text-[11px] text-amber-400/70 mt-1.5 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              Requires enrichment — search may be slower
            </p>
          )}
        </div>

        {/* Property Type */}
        <div>
          <label className="text-xs text-gray-400 block mb-1">
            <Building className="w-3 h-3 inline mr-1" />
            Property Type
          </label>
          <select
            value={filters.propertyType || ''}
            onChange={(e) => setFilters((f) => ({ ...f, propertyType: e.target.value }))}
            className="w-full bg-gray-800 text-gray-200 text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-emerald-500 focus:outline-none"
          >
            {PROPERTY_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Min Discount */}
        <div>
          <label className="text-xs text-gray-400 block mb-1">
            <TrendingDown className="w-3 h-3 inline mr-1" />
            Minimum Discount: {filters.minDiscount}%
          </label>
          <input
            type="range"
            min="0"
            max="50"
            value={filters.minDiscount}
            onChange={(e) => setFilters((f) => ({ ...f, minDiscount: Number(e.target.value) }))}
            className="w-full accent-emerald-400"
          />
          <div className="flex justify-between text-xs text-gray-600">
            <span>0%</span>
            <span>50%</span>
          </div>
        </div>

        {/* Min Score */}
        <div>
          <div className="flex items-center gap-1 mb-1">
            <label className="text-xs text-gray-400">
              <Gavel className="w-3 h-3 inline mr-1" />
              Minimum Deal Score: {filters.minScore}
            </label>
            <button
              onClick={() => setShowScoreInfo((v) => !v)}
              className="text-gray-500 hover:text-emerald-400 transition-colors"
            >
              <Info className="w-3.5 h-3.5" />
            </button>
          </div>
          {showScoreInfo && (
            <div className="mb-2 bg-gray-800 border border-gray-700 rounded-lg p-3 text-[11px] text-gray-400 space-y-1.5">
              <p className="text-gray-300 font-semibold">How Deal Score is calculated:</p>
              <div className="space-y-1">
                <div className="flex justify-between"><span>Price &lt; 75% of market</span><span className="text-emerald-400 font-medium">+40 pts</span></div>
                <div className="flex justify-between"><span>Price 75-80% of market</span><span className="text-emerald-400 font-medium">+25 pts</span></div>
                <div className="flex justify-between"><span>Price 80-85% of market</span><span className="text-emerald-400 font-medium">+15 pts</span></div>
                <div className="flex justify-between"><span>Mortgage delinquent</span><span className="text-emerald-400 font-medium">+30 pts</span></div>
                <div className="flex justify-between"><span>Days on market &gt; 60</span><span className="text-emerald-400 font-medium">+10 pts</span></div>
                <div className="flex justify-between"><span>Tax lien present</span><span className="text-emerald-400 font-medium">+10 pts</span></div>
                <div className="flex justify-between"><span>As-is / Cash only</span><span className="text-emerald-400 font-medium">+10 pts</span></div>
              </div>
              <div className="border-t border-gray-700 pt-1.5 flex justify-between text-gray-300 font-semibold">
                <span>Max score</span><span>100 pts</span>
              </div>
            </div>
          )}
          <input
            type="range"
            min="0"
            max="100"
            step="10"
            value={filters.minScore}
            onChange={(e) => setFilters((f) => ({ ...f, minScore: Number(e.target.value) }))}
            className="w-full accent-emerald-400"
          />
          <div className="flex justify-between text-xs text-gray-600">
            <span>0</span>
            <span>100</span>
          </div>
        </div>
      </div>

      {/* Pipeline Trigger */}
      <div className="p-4 border-b border-gray-800">
        <button
          onClick={onTriggerPipeline}
          disabled={pipelineRunning}
          className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium py-2.5 px-4 rounded-lg transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${pipelineRunning ? 'animate-spin' : ''}`} />
          {pipelineRunning ? 'Scanning...' : searchLabel ? `Find Deals in ${searchLabel}` : 'Find Deals'}
        </button>
      </div>

    </div>
  );
}
