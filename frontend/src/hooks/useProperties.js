import { useState, useCallback } from 'react';
import axios from 'axios';

export function useProperties() {
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchProperties = useCallback(async () => {
    try {
      setLoading(true);
      const res = await axios.get('/api/properties');
      setProperties(res.data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  return { properties, loading, error, refetch: fetchProperties };
}
