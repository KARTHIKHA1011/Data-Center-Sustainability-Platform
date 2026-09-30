import { useEffect, useState } from "react";
import api from "../api";

export function useServerForecast(id, horizon) {
  const [forecast, setForecast] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;

    const loadForecast = async () => {
      if (!id) return;
      try {
        const f = await api.serverForecast(id, horizon);
        if (!mounted) return;
        setForecast(f.data);
        setError(null);
      } catch (err) {
        if (mounted) {
          setForecast(null);
          setError(err?.response?.data?.detail || "Forecast is currently unavailable.");
        }
      }
    };

    loadForecast();
    const interval = setInterval(loadForecast, 15000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [id, horizon]);

  return { forecast, error };
}