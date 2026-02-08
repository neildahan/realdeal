import { useState, useRef } from 'react';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Bed, Bath, Ruler, Clock, TrendingDown, Target } from 'lucide-react';

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

export default function ListingCarousel({ properties, onSelectProperty }) {
  const [collapsed, setCollapsed] = useState(true);
  const scrollRef = useRef(null);

  // Filter out properties with missing/zero coordinates (e.g. old scraper data)
  const validProperties = properties.filter((p) => {
    const c = p.coordinates?.coordinates;
    return c && !(c[0] === 0 && c[1] === 0);
  });

  if (validProperties.length === 0) return null;

  const sorted = [...validProperties].sort((a, b) => b.dealScore - a.dealScore);

  function scrollBy(dir) {
    if (scrollRef.current) {
      scrollRef.current.scrollBy({ left: dir * 320, behavior: 'smooth' });
    }
  }

  return (
    <div className="absolute bottom-0 left-0 right-0 z-[1000] transition-transform duration-300"
      style={{ transform: collapsed ? 'translateY(calc(100% - 36px))' : 'translateY(0)' }}
    >
      {/* Toggle bar */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="mx-auto flex items-center gap-1.5 bg-gray-900/95 border border-gray-700 border-b-0 rounded-t-lg px-4 py-1.5 text-xs text-gray-400 hover:text-white transition-colors"
        style={{ marginLeft: '50%', transform: 'translateX(-50%)' }}
      >
        {collapsed ? (
          <>
            <ChevronUp className="w-3.5 h-3.5" />
            Show Listings ({sorted.length})
          </>
        ) : (
          <>
            <ChevronDown className="w-3.5 h-3.5" />
            Hide Listings
          </>
        )}
      </button>

      {/* Carousel body */}
      <div className="bg-gray-900/95 border-t border-gray-700 backdrop-blur-sm max-h-[45vh] overflow-hidden">
        <div className="relative flex items-center h-full">
          {/* Left arrow */}
          <button
            onClick={() => scrollBy(-1)}
            className="shrink-0 p-1.5 text-gray-500 hover:text-white transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>

          {/* Scrollable cards */}
          <div
            ref={scrollRef}
            className="flex gap-3 overflow-x-auto overflow-y-auto py-3 px-1 scrollbar-hide"
            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', maxHeight: 'calc(45vh - 16px)' }}
          >
            {sorted.map((property, i) => {
              const discount =
                property.price && property.marketMedian
                  ? Math.round(((property.marketMedian - property.price) / property.marketMedian) * 100)
                  : 0;

              const photoSrc = property.photoUrl || property.photos?.[0] || null;

              return (
                <div
                  key={property._id || `${property.address?.street}-${property.address?.zip}-${i}`}
                  className="shrink-0 w-72 bg-gray-800 rounded-lg overflow-hidden border border-gray-700 hover:border-emerald-600/50 transition-colors cursor-pointer"
                  onClick={() => onSelectProperty?.(property)}
                >
                  {/* Photo */}
                  <div className="h-36 bg-gray-700 relative">
                    {photoSrc ? (
                      <img
                        src={photoSrc}
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
                      {property.propertyType && property.propertyType !== 'unknown' && (
                        <span className="ml-1 text-gray-600">· {property.propertyType}</span>
                      )}
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
                        onClick={(e) => e.stopPropagation()}
                      >
                        <ExternalLink className="w-3 h-3" /> View on Zillow
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right arrow */}
          <button
            onClick={() => scrollBy(1)}
            className="shrink-0 p-1.5 text-gray-500 hover:text-white transition-colors"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
