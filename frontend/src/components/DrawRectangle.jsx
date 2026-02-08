import { useState, useRef, useCallback } from 'react';
import { Rectangle, useMapEvents, useMap } from 'react-leaflet';

export default function DrawRectangle({ drawMode, drawnBounds, onDrawComplete }) {
  const map = useMap();
  const [previewBounds, setPreviewBounds] = useState(null);
  const startLatLng = useRef(null);
  const isDrawing = useRef(false);

  const makeBounds = useCallback((a, b) => {
    return [
      [Math.min(a.lat, b.lat), Math.min(a.lng, b.lng)],
      [Math.max(a.lat, b.lat), Math.max(a.lng, b.lng)],
    ];
  }, []);

  useMapEvents({
    mousedown(e) {
      if (!drawMode) return;
      startLatLng.current = e.latlng;
      isDrawing.current = true;
      map.dragging.disable();
    },
    mousemove(e) {
      if (!isDrawing.current || !startLatLng.current) return;
      setPreviewBounds(makeBounds(startLatLng.current, e.latlng));
    },
    mouseup(e) {
      if (!isDrawing.current || !startLatLng.current) return;
      isDrawing.current = false;
      map.dragging.enable();

      const bounds = makeBounds(startLatLng.current, e.latlng);
      startLatLng.current = null;
      setPreviewBounds(null);

      // Ignore tiny accidental clicks (less than ~100m)
      const sw = { lat: bounds[0][0], lng: bounds[0][1] };
      const ne = { lat: bounds[1][0], lng: bounds[1][1] };
      if (Math.abs(ne.lat - sw.lat) < 0.001 && Math.abs(ne.lng - sw.lng) < 0.001) return;

      onDrawComplete(bounds);
    },
  });

  // Live preview while dragging
  if (previewBounds) {
    return (
      <Rectangle
        bounds={previewBounds}
        pathOptions={{
          color: '#34d399',
          weight: 2,
          dashArray: '6 4',
          fillColor: '#34d399',
          fillOpacity: 0.1,
        }}
      />
    );
  }

  // Persistent drawn area
  if (drawnBounds) {
    return (
      <Rectangle
        bounds={drawnBounds}
        pathOptions={{
          color: '#34d399',
          weight: 2,
          dashArray: '6 4',
          fillColor: '#34d399',
          fillOpacity: 0.08,
        }}
      />
    );
  }

  return null;
}
