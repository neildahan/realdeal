import { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';

const POLL_INTERVAL = 15000; // 15 seconds

export function useProperties() {
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const intervalRef = useRef(null);

  const fetchProperties = useCallback(async () => {
    try {
      const res = await axios.get('/api/properties');
      setProperties(res.data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchProperties();

    // Poll for real-time updates
    intervalRef.current = setInterval(fetchProperties, POLL_INTERVAL);
    return () => clearInterval(intervalRef.current);
  }, [fetchProperties]);

  return { properties, loading, error, refetch: fetchProperties };
}
