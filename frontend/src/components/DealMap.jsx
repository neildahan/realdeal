import { useState, useEffect } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { Map, ChevronDown, Bed, Bath, Ruler, Clock, ExternalLink, Target, TrendingDown } from 'lucide-react';
import DrawRectangle from './DrawRectangle';

const DEFAULT_CENTER = [25.7617, -80.1918]; // Miami, FL
const DEFAULT_ZOOM = 11;

const TILES = [
  { id: 'dark',      label: 'Dark',      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',      bg: '#111827' },
  { id: 'light',     label: 'Light',     url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',     bg: '#f3f4f6' },
  { id: 'voyager',   label: 'Voyager',   url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', bg: '#f5f3f0' },
  { id: 'satellite', label: 'Satellite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', bg: '#0a1628' },
  { id: 'topo',      label: 'Terrain',   url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', bg: '#e8e4d8' },
  { id: 'streets',   label: 'Streets',   url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', bg: '#e8e4d8' },
];

function getMarkerColor(score) {
  if (score > 80) return '#f87171';  // red-400
  if (score >= 60) return '#facc15'; // yellow-400
  return '#9ca3af';                  // gray-400
}

function getMarkerRadius(score) {
  if (score > 80) return 12;
  if (score >= 60) return 9;
  return 6;
}

function getScoreColor(score) {
  if (score > 80) return 'text-red-400';
  if (score >= 60) return 'text-yellow-400';
  return 'text-gray-400';
}

function getScoreBg(score) {
  if (score > 80) return 'bg-red-500/20 border-red-500/40';
  if (score >= 60) return 'bg-yellow-500/20 border-yellow-500/40';
  return 'bg-gray-500/20 border-gray-500/40';
}

function MapController({ center, bounds }) {
  const map = useMap();
  const lat = center?.[0];
  const lng = center?.[1];
  const boundsKey = bounds ? bounds.flat().join(',') : null;
  useEffect(() => {
    if (bounds) {
      map.flyToBounds(bounds, { duration: 1.5, padding: [20, 20] });
    } else if (lat != null && lng != null) {
      map.flyTo([lat, lng], 16, { duration: 1.5 });
    }
  }, [boundsKey, lat, lng, map]);
  return null;
}

export default function DealMap({ properties, center: centerProp, bounds: boundsProp, drawMode, drawnBounds, onDrawComplete }) {
  const [tileId, setTileId] = useState('voyager');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const tile = TILES.find((t) => t.id === tileId) || TILES[0];

  // Determine map center from prop, properties, or fall back to Houston
  const center = centerProp
    ? centerProp
    : properties.length > 0 && properties[0].coordinates?.coordinates?.[0] !== 0
      ? [properties[0].coordinates.coordinates[1], properties[0].coordinates.coordinates[0]]
      : DEFAULT_CENTER;

  return (
    <>
      {/* Map style picker */}
      <div className="absolute top-4 right-4 z-[1000]">
        <button
          onClick={() => setDropdownOpen((o) => !o)}
          className="flex items-center gap-2 bg-gray-900/90 hover:bg-gray-800 border border-gray-700 text-gray-300 rounded-lg px-3 py-2 text-xs font-medium transition-colors"
        >
          <Map className="w-3.5 h-3.5" />
          {tile.label}
          <ChevronDown className={`w-3 h-3 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
        </button>
        {dropdownOpen && (
          <div className="mt-1 bg-gray-900/95 border border-gray-700 rounded-lg overflow-hidden shadow-xl">
            {TILES.map((t) => (
              <button
                key={t.id}
                onClick={() => { setTileId(t.id); setDropdownOpen(false); }}
                className={`block w-full text-left px-3 py-2 text-xs transition-colors ${
                  t.id === tileId
                    ? 'bg-emerald-600/30 text-emerald-400'
                    : 'text-gray-300 hover:bg-gray-800'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <MapContainer
        center={center}
        zoom={DEFAULT_ZOOM}
        className="h-full w-full"
        style={{ background: tile.bg, cursor: drawMode ? 'crosshair' : '' }}
      >
        <MapController center={centerProp} bounds={boundsProp} />
        <TileLayer
          key={tileId}
          attribution='&copy; CARTO / OSM / Esri'
          url={tile.url}
        />
        <DrawRectangle drawMode={drawMode} drawnBounds={drawnBounds} onDrawComplete={onDrawComplete} />

      {properties.map((property) => {
        const coords = property.coordinates?.coordinates;
        if (!coords || (coords[0] === 0 && coords[1] === 0)) return null;

        const lat = coords[1];
        const lng = coords[0];
        const color = getMarkerColor(property.dealScore);
        const radius = getMarkerRadius(property.dealScore);

        const discount =
          property.price && property.marketMedian
            ? Math.round(
                ((property.marketMedian - property.price) / property.marketMedian) * 100
              )
            : 0;

        return (
          <CircleMarker
            key={property._id || `${property.address?.street}-${property.address?.zip}-${lat}-${lng}`}
            center={[lat, lng]}
            radius={radius}
            pathOptions={{
              color,
              fillColor: color,
              fillOpacity: 0.7,
              weight: 2,
            }}
          >
            <Popup className="deal-popup">
              <div className="w-64 bg-gray-800 rounded-lg overflow-hidden -m-[13px] -mt-[13px]">
                {/* Photo */}
                <div className="h-32 bg-gray-700 relative">
                  {(property.photoUrl || property.photos?.[0]) ? (
                    <img
                      src={property.photoUrl || property.photos?.[0]}
                      alt={property.address?.street}
                      className="w-full h-full object-cover"
                      onError={(e) => { e.target.style.display = 'none'; }}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-600 text-xs">
                      No Photo
                    </div>
                  )}

                  {/* Score badge */}
                  <div className={`absolute top-2 right-2 ${getScoreBg(property.dealScore)} border rounded-md px-2 py-0.5`}>
                    <span className={`text-xs font-bold ${getScoreColor(property.dealScore)}`}>
                      {property.dealScore}
                    </span>
                  </div>

                  {/* Discount badge */}
                  {discount > 0 && (
                    <div className="absolute top-2 left-2 bg-emerald-600/90 rounded-md px-2 py-0.5">
                      <span className="text-xs font-bold text-white">-{discount}%</span>
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="p-3">
                  <p className="text-sm font-semibold text-white truncate">{property.address?.street}</p>
                  <p className="text-xs text-gray-500 truncate">
                    {property.address?.city}, {property.address?.state} {property.address?.zip}
                  </p>

                  <div className="flex items-baseline gap-2 mt-1.5">
                    <span className="text-base font-bold text-emerald-400">
                      ${property.price?.toLocaleString()}
                    </span>
                    {property.marketMedian && (
                      <span className="text-xs text-gray-500 line-through">
                        ${property.marketMedian?.toLocaleString()}
                      </span>
                    )}
                  </div>

                  {/* Score & Discount row */}
                  <div className="flex items-center gap-3 mt-1.5">
                    <span className={`flex items-center gap-1 text-xs font-semibold ${getScoreColor(property.dealScore)}`}>
                      <Target className="w-3 h-3" />
                      Score: {property.dealScore || 0}
                    </span>
                    <span className={`flex items-center gap-1 text-xs font-semibold ${discount > 0 ? 'text-emerald-400' : 'text-gray-500'}`}>
                      <TrendingDown className="w-3 h-3" />
                      {discount > 0 ? `-${discount}%` : `${discount}%`}
                    </span>
                  </div>

                  {/* Details row */}
                  <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                    {property.bedrooms && (
                      <span className="flex items-center gap-1">
                        <Bed className="w-3 h-3" /> {property.bedrooms}
                      </span>
                    )}
                    {property.bathrooms && (
                      <span className="flex items-center gap-1">
                        <Bath className="w-3 h-3" /> {property.bathrooms}
                      </span>
                    )}
                    {property.sqft && (
                      <span className="flex items-center gap-1">
                        <Ruler className="w-3 h-3" /> {property.sqft?.toLocaleString()}
                      </span>
                    )}
                    {property.daysOnMarket > 0 && (
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" /> {property.daysOnMarket}d
                      </span>
                    )}
                  </div>

                  {/* Distress badges */}
                  <div className="flex flex-wrap gap-1 mt-2">
                    {property.distressIndicators?.isDelinquent && (
                      <span className="bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded text-[10px]">Delinquent</span>
                    )}
                    {property.distressIndicators?.hasTaxLien && (
                      <span className="bg-orange-500/20 text-orange-400 px-1.5 py-0.5 rounded text-[10px]">Tax Lien</span>
                    )}
                    {property.distressIndicators?.isAsIs && (
                      <span className="bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded text-[10px]">As-Is</span>
                    )}
                    {property.distressIndicators?.isPreForeclosure && (
                      <span className="bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded text-[10px]">Pre-Foreclosure</span>
                    )}
                  </div>

                  {/* Listing link */}
                  {property.listingUrl && (
                    <a
                      href={property.listingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 mt-2 transition-colors"
                    >
                      <ExternalLink className="w-3 h-3" /> View on Zillow
                    </a>
                  )}
                </div>
              </div>
            </Popup>
          </CircleMarker>
        );
      })}
    </MapContainer>
    </>
  );
}
