import { useEffect, useRef, useState } from "react";
import api from "../api";

const MAX_HISTORY_HOURS = 24;

function timeLabel(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function useServerTelemetry(id) {
  const [rawHistory, setRawHistory] = useState([]);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const isFirstLoad = useRef(true);

  useEffect(() => {
    let mounted = true;
    isFirstLoad.current = true;

    const load = async () => {
      if (!id) return;
      if (isFirstLoad.current) setLoading(true);

      try {
        const h = await api.serverHistory(id, MAX_HISTORY_HOURS);
        if (!mounted) return;
        const historyData = Array.isArray(h.data) ? h.data : h.data?.records || [];
        setRawHistory(
          historyData.map((r) => ({
            time: r.timestamp ? timeLabel(r.timestamp) : "—",
            cpu: r.cpu === null || r.cpu === undefined ? 0 : Number(r.cpu),
            memory: r.memory === null || r.memory === undefined ? 0 : Number(r.memory),
            network: r.network_gbps === null || r.network_gbps === undefined ? 0 : Number(r.network_gbps),
            timestamp: r.timestamp,
          }))
        );
      } catch (error) {
        if (mounted && isFirstLoad.current) setRawHistory([]);
      }

      try {
        const d = await api.serverDetail(id);
        if (!mounted) return;
        setDetail(d.data);
      } catch (error) {
        if (mounted && isFirstLoad.current) setDetail(null);
      }

      if (mounted) {
        setLoading(false);
        isFirstLoad.current = false;
      }
    };

    load();
    const interval = setInterval(load, 15000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [id]);

  return { rawHistory, detail, loading };
}