// import { useEffect, useState } from "react";
// import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
// import api from "../api";

// export default function Analytics() {
//   const [cpuSeries, setCpuSeries] = useState([]);
//   const [powerSeries, setPowerSeries] = useState([]);
//   const [summary, setSummary] = useState(null);

//   useEffect(() => {
//     const load = async () => {
//       try {
//         const [h, s] = await Promise.all([api.analyticsHistory(6), api.analyticsSummary()]);
//         setCpuSeries(h.data.cpu_series.map((p) => ({ time: new Date(p.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), v: p.v })));
//         setPowerSeries(h.data.power_series.map((p) => ({ time: new Date(p.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), v: p.v })));
//         setSummary(s.data);
//       } catch {
//         setCpuSeries([]);
//         setPowerSeries([]);
//       }
//     };
//     load();
//     const interval = setInterval(load, 15000);
//     return () => clearInterval(interval);
//   }, []);

//   return (
//     <div>
//       <div className="page-header">
//         <div className="page-header-top">
//           <div>
//             <p className="page-title">Analytics</p>
//             <p className="page-subtitle">
//               A single reading can be misleading — a server could be mid-spike or mid-lull.
//               These charts show behaviour over the last 6 hours, which is what the idle-detection
//               rule actually looks at (an average, not one instant).
//             </p>
//           </div>
//         </div>
//       </div>

//       <div className="two-col section-gap">
//         <div className="card">
//           <p className="card-title">Average CPU (%) over time</p>
//           <p className="card-subtitle">Average CPU across all servers, sampled every 15 seconds</p>
//           {cpuSeries.length === 0 ? <div className="empty-state">No history yet.</div> : (
//             <ResponsiveContainer width="100%" height={220}>
//               <AreaChart data={cpuSeries}>
//                 <defs>
//                   <linearGradient id="cpuFill" x1="0" y1="0" x2="0" y2="1">
//                     <stop offset="0%" stopColor="#1D9E75" stopOpacity={0.35} />
//                     <stop offset="100%" stopColor="#1D9E75" stopOpacity={0.02} />
//                   </linearGradient>
//                 </defs>
//                 <CartesianGrid stroke="#E3ECE8" vertical={false} />
//                 <XAxis dataKey="time" fontSize={12.5} stroke="#8A9691" tickLine={false} axisLine={false} />
//                 <YAxis fontSize={12.5} stroke="#8A9691" tickLine={false} axisLine={false} unit="%" />
//                 <Tooltip />
//                 <Area type="monotone" dataKey="v" stroke="#1D9E75" strokeWidth={2.5} fill="url(#cpuFill)" dot={false} name="CPU %" />
//               </AreaChart>
//             </ResponsiveContainer>
//           )}
//         </div>
//         <div className="card">
//           <p className="card-title">Facility power (kW) over time</p>
//           <p className="card-subtitle">Total electricity draw — this is what drives your actual bill</p>
//           {powerSeries.length === 0 ? <div className="empty-state">No history yet.</div> : (
//             <ResponsiveContainer width="100%" height={220}>
//               <AreaChart data={powerSeries}>
//                 <defs>
//                   <linearGradient id="powerFill" x1="0" y1="0" x2="0" y2="1">
//                     <stop offset="0%" stopColor="#EF9F27" stopOpacity={0.35} />
//                     <stop offset="100%" stopColor="#EF9F27" stopOpacity={0.02} />
//                   </linearGradient>
//                 </defs>
//                 <CartesianGrid stroke="#E3ECE8" vertical={false} />
//                 <XAxis dataKey="time" fontSize={12.5} stroke="#8A9691" tickLine={false} axisLine={false} />
//                 <YAxis fontSize={12.5} stroke="#8A9691" tickLine={false} axisLine={false} unit=" kW" />
//                 <Tooltip />
//                 <Area type="monotone" dataKey="v" stroke="#EF9F27" strokeWidth={2.5} fill="url(#powerFill)" dot={false} name="kW" />
//               </AreaChart>
//             </ResponsiveContainer>
//           )}
//         </div>
//       </div>

//       {summary && (
//         <>
//           <p className="section-label">Current window summary</p>
//           <div className="metric-grid">
//             <div className="metric-card">
//               <p className="metric-label">Avg CPU</p>
//               <p className="metric-value">{summary.avg_cpu}%</p>
//               <p className="metric-hint">Across all servers, all readings</p>
//             </div>
//             <div className="metric-card">
//               <p className="metric-label">Avg memory</p>
//               <p className="metric-value">{summary.avg_memory}%</p>
//               <p className="metric-hint">Across all servers, all readings</p>
//             </div>
//             <div className="metric-card">
//               <p className="metric-label">PUE</p>
//               <p className="metric-value">{summary.pue}</p>
//               <p className="metric-hint">Facility power ÷ IT power</p>
//             </div>
//             <div className="metric-card neutral">
//               <p className="metric-label">Est. cost</p>
//               <p className="metric-value">₹{summary.estimated_cost}</p>
//               <p className="metric-hint">Energy (integrated since telemetry began) × tariff</p>
//             </div>
//             <div className="metric-card neutral">
//               <p className="metric-label">Est. carbon</p>
//               <p className="metric-value">{summary.estimated_carbon_kg} kg</p>
//               <p className="metric-hint">Energy × carbon intensity factor</p>
//             </div>
//           </div>
//         </>
//       )}
//     </div>
//   );
// }

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Link } from "react-router-dom";
import api from "../api";

const COLORS = {
  green: "#1D9E75",
  darkGreen: "#0F6E56",
  teal: "#2F9C95",
  orange: "#D97706",
  red: "#C2413B",
  grid: "#E3ECE8",
  muted: "#71807A",
};

const formatDate = (value, options = { month: "short", day: "numeric" }) => {
  if (!value) return "—";
  return new Date(`${value}T00:00:00Z`).toLocaleDateString([], options);
};

const formatNumber = (value, digits = 2) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
};

function TrendPill({ value, invert = false }) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return <span className="trend-pill neutral">Awaiting history</span>;
  }
  const direction = value > 0.05 ? "up" : value < -0.05 ? "down" : "flat";
  const interpreted = invert ? (direction === "up" ? "down" : direction === "down" ? "up" : "flat") : direction;
  const symbol = direction === "up" ? "↑" : direction === "down" ? "↓" : "→";
  return (
    <span className={`trend-pill ${interpreted}`}>
      {symbol} {Math.abs(value).toFixed(1)}% vs first observed day
    </span>
  );
}

function getTrend(rows, key) {
  const observed = rows.filter((row) => row.status !== "no_data" && row[key] !== null && row[key] !== undefined);
  if (observed.length < 2 || !observed[0][key]) return null;
  return ((observed[observed.length - 1][key] - observed[0][key]) / Math.abs(observed[0][key])) * 100;
}

function Stat({ label, value, unit, detail, trend, tone = "green", invertTrend = false }) {
  return (
    <div className={`analytics-stat ${tone}`}>
      <div className="stat-heading">
        <span>{label}</span>
        <span className="stat-marker" />
      </div>
      <div className="stat-value-line">
        <strong>{value}</strong>
        {unit && <span>{unit}</span>}
      </div>
      <p>{detail}</p>
      {trend !== undefined && <TrendPill value={trend} invert={invertTrend} />}
    </div>
  );
}

function EmptyState({ text }) {
  return <div className="analytics-empty"><strong>No observed records in this window.</strong><span>{text}</span></div>;
}

export default function Analytics() {
  const [filters, setFilters] = useState({ days: 7, serverId: "all", region: "all" });
  const [payload, setPayload] = useState(null);
  const [servers, setServers] = useState([]);
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedServerId, setSelectedServerId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);

  const loadDaily = useCallback(async () => {
    try {
      setError("");
      const response = await api.analyticsDaily(filters);
      setPayload(response.data);
      setLastUpdated(new Date());
    } catch (requestError) {
      setError(requestError?.response?.data?.detail || "Analytics API is not reachable. Start the FastAPI backend on port 8000.");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    let active = true;
    api.servers().then((response) => {
      if (active) setServers(response.data || []);
    }).catch(() => {
      if (active) setServers([]);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    loadDaily();
    const interval = setInterval(loadDaily, 15000);
    return () => clearInterval(interval);
  }, [loadDaily]);

  const daily = payload?.daily || [];
  const period = payload?.period_summary || {};
  const observedDays = daily.filter((row) => row.status !== "no_data");
  const regions = useMemo(() => [...new Set(servers.map((server) => server.region).filter(Boolean))].sort(), [servers]);
  const filteredServers = useMemo(
    () => filters.region === "all" ? servers : servers.filter((server) => server.region === filters.region),
    [filters.region, servers],
  );

  useEffect(() => {
    if (!daily.length) return;
    const validDate = daily.some((row) => row.date === selectedDate && row.status !== "no_data");
    if (!validDate) setSelectedDate(observedDays[observedDays.length - 1]?.date || daily[daily.length - 1].date);
  }, [daily, observedDays, selectedDate]);

  const selectedDay = daily.find((row) => row.date === selectedDate) || observedDays[observedDays.length - 1];
  const selectedServer = selectedDay?.server_breakdown?.find((server) => server.server_id === selectedServerId);
  const chartData = daily.map((row) => ({
    ...row,
    label: formatDate(row.date),
    cpu: row.avg_cpu,
    memory: row.avg_memory,
    energy: row.energy_kwh,
    carbon: row.estimated_carbon_kg,
  }));

  const updateFilter = (key, value) => {
    if (key === "region") {
      setFilters((current) => ({ ...current, region: value, serverId: "all" }));
      setSelectedServerId("");
      return;
    }
    setFilters((current) => ({ ...current, [key]: value }));
    if (key === "serverId") setSelectedServerId("");
  };

  return (
    <div className="analytics-page">
      <div className="page-header analytics-header">
        <div>
          <div className="eyebrow">Operational intelligence / daily view</div>
          <p className="page-title">Analytics, with the story behind the average</p>
          <p className="page-subtitle">Move from a single KPI to a seven-day operating record. Select a day to inspect contributing servers, telemetry coverage, and sustainability impact.</p>
        </div>
        <div className="analytics-live-status">
          <span className="live-dot" />
          <div><strong>Live refresh</strong><span>{lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Connecting…"}</span></div>
        </div>
      </div>

      <div className="analytics-filter-bar">
        <div className="filter-intro"><span className="filter-kicker">Time window</span><strong>Past {filters.days} days</strong><span>UTC calendar days · raw observations only</span></div>
        <div className="filter-group" aria-label="Analytics filters">
          <div className="range-toggle" role="group" aria-label="Time window">
            {[1, 3, 7].map((days) => <button key={days} className={filters.days === days ? "active" : ""} onClick={() => updateFilter("days", days)}>{days === 1 ? "1d" : `${days}d`}</button>)}
          </div>
          <label>Region<select value={filters.region} onChange={(event) => updateFilter("region", event.target.value)}><option value="all">All regions</option>{regions.map((region) => <option key={region} value={region}>{region}</option>)}</select></label>
          <label>Server<select value={filters.serverId} onChange={(event) => updateFilter("serverId", event.target.value)}><option value="all">All servers</option>{filteredServers.map((server) => <option key={server.server_id} value={server.server_id}>{server.server_id} · {server.server_type}</option>)}</select></label>
          <button className="refresh-button" onClick={loadDaily} aria-label="Refresh analytics">↻ <span>Refresh</span></button>
        </div>
      </div>

      {error && <div className="info-banner muted analytics-error">⚠ {error}</div>}

      <div className="analytics-coverage-row">
        <div><span className="coverage-label">Data coverage</span><strong>{period.observed_days || 0} / {period.total_days || filters.days} days observed</strong><span>{period.total_readings || 0} telemetry records in the selected scope</span></div>
        <div className="coverage-track"><span style={{ width: `${period.total_days ? Math.min(100, (period.observed_days / period.total_days) * 100) : 0}%` }} /></div>
        <div className="coverage-note">Missing days stay visible as <b>no data</b>; the dashboard never invents history.</div>
      </div>

      {loading && !payload ? <div className="analytics-loading">Loading the selected telemetry window…</div> : (
        <>
          <div className="analytics-stat-grid">
            <Stat label="Average CPU" value={formatNumber(period.avg_cpu)} unit="%" detail="Fleet mean across observed server readings" trend={getTrend(daily, "avg_cpu")} tone="green" />
            <Stat label="Facility power" value={formatNumber(observedDays.length ? observedDays[observedDays.length - 1].avg_facility_power_kw : null)} unit="kW" detail="Latest observed daily facility draw" trend={getTrend(daily, "avg_facility_power_kw")} tone="orange" />
            <Stat label="Energy in window" value={formatNumber(period.total_energy_kwh)} unit="kWh" detail="Integrated from adjacent power timestamps" tone="teal" />
            <Stat label="Average PUE" value={formatNumber(period.avg_pue, 3)} detail="Facility power ÷ IT power" trend={getTrend(daily, "pue")} tone="purple" invertTrend />
            <Stat label="Carbon estimate" value={formatNumber(period.estimated_carbon_kg)} unit="kg" detail="Energy × configured carbon factor" tone="red" />
          </div>

          <div className="analytics-section-heading"><div><span className="eyebrow">Trend layer</span><h2>How the week moved</h2></div><span className="section-context">Click a day below to inspect its server contribution</span></div>
          <div className="analytics-chart-grid">
            <section className="analytics-panel chart-panel">
              <div className="panel-title-row"><div><h3>Utilization trend</h3><p>Daily fleet averages for CPU and memory</p></div><div className="legend-inline"><span><i className="legend-line cpu" />CPU</span><span><i className="legend-line memory" />Memory</span></div></div>
              {observedDays.length ? <ResponsiveContainer width="100%" height={260}><LineChart data={chartData} margin={{ top: 12, right: 12, left: -16, bottom: 0 }}><CartesianGrid stroke={COLORS.grid} vertical={false} /><XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: COLORS.muted }} /><YAxis domain={[0, 100]} unit="%" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: COLORS.muted }} /><Tooltip contentStyle={{ border: "0", borderRadius: "10px", boxShadow: "0 8px 28px rgba(4,52,44,.12)" }} formatter={(value, name) => [`${formatNumber(value)}%`, name === "cpu" ? "CPU" : "Memory"]} /><Line type="monotone" dataKey="cpu" stroke={COLORS.green} strokeWidth={3} dot={{ r: 4, fill: COLORS.green, strokeWidth: 2, stroke: "#fff" }} connectNulls={false} /><Line type="monotone" dataKey="memory" stroke={COLORS.teal} strokeWidth={2.5} dot={{ r: 3, fill: COLORS.teal, strokeWidth: 2, stroke: "#fff" }} connectNulls={false} /></LineChart></ResponsiveContainer> : <EmptyState text="Start the server simulator or select another range." />}
            </section>
            <section className="analytics-panel chart-panel">
              <div className="panel-title-row"><div><h3>Energy and carbon footprint</h3><p>Daily integrated energy and derived carbon estimate</p></div><div className="chart-callout"><strong>{formatNumber(period.estimated_cost)}</strong><span>estimated cost in window</span></div></div>
              {observedDays.length ? <ResponsiveContainer width="100%" height={260}><AreaChart data={chartData} margin={{ top: 12, right: 12, left: -16, bottom: 0 }}><defs><linearGradient id="energyFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.orange} stopOpacity={0.32} /><stop offset="100%" stopColor={COLORS.orange} stopOpacity={0.03} /></linearGradient></defs><CartesianGrid stroke={COLORS.grid} vertical={false} /><XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: COLORS.muted }} /><YAxis yAxisId="energy" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: COLORS.muted }} /><YAxis yAxisId="carbon" orientation="right" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: COLORS.muted }} /><Tooltip contentStyle={{ border: "0", borderRadius: "10px", boxShadow: "0 8px 28px rgba(4,52,44,.12)" }} formatter={(value, name) => [formatNumber(value), name === "energy" ? "Energy (kWh)" : "Carbon (kg)"]} /><Area yAxisId="energy" type="monotone" dataKey="energy" stroke={COLORS.orange} strokeWidth={3} fill="url(#energyFill)" connectNulls={false} /><Line yAxisId="carbon" type="monotone" dataKey="carbon" stroke={COLORS.red} strokeWidth={2.5} dot={{ r: 3, fill: COLORS.red, strokeWidth: 2, stroke: "#fff" }} connectNulls={false} /></AreaChart></ResponsiveContainer> : <EmptyState text="Power telemetry is required to calculate energy." />}
            </section>
          </div>

          <div className="analytics-section-heading"><div><span className="eyebrow">Daily ledger</span><h2>Seven-day operating record</h2></div><span className="section-context">{selectedDay ? `Selected: ${formatDate(selectedDay.date, { weekday: "short", month: "short", day: "numeric" })}` : "Select a day"}</span></div>
          <section className="analytics-panel daily-ledger-panel">
            <div className="table-scroll"><table className="data-table daily-ledger"><thead><tr><th>Day</th><th>Status</th><th>CPU / memory</th><th>Facility power</th><th>PUE</th><th>Energy</th><th>Carbon</th><th>Readings</th></tr></thead><tbody>{daily.map((row) => <tr key={row.date} className={selectedDay?.date === row.date ? "selected" : ""} onClick={() => row.status !== "no_data" && setSelectedDate(row.date)} onKeyDown={(event) => event.key === "Enter" && row.status !== "no_data" && setSelectedDate(row.date)} tabIndex={row.status === "no_data" ? -1 : 0}><td><button className="table-link" disabled={row.status === "no_data"} onClick={() => setSelectedDate(row.date)}>{formatDate(row.date, { weekday: "short", month: "short", day: "numeric" })}</button>{period.peak_cpu_day === row.date && <small className="mini-tag">Peak CPU</small>}</td><td><span className={`record-status ${row.status}`}>{row.status === "complete" ? "Complete" : row.status === "partial" ? "Partial" : "No data"}</span></td><td><strong>{formatNumber(row.avg_cpu)}%</strong><span className="cell-secondary">{formatNumber(row.avg_memory)}% mem</span></td><td>{formatNumber(row.avg_facility_power_kw)} <span className="unit">kW</span></td><td>{formatNumber(row.pue, 3)}</td><td>{formatNumber(row.energy_kwh)} <span className="unit">kWh</span></td><td>{formatNumber(row.estimated_carbon_kg)} <span className="unit">kg</span></td><td><span className="reading-count">{Object.values(row.readings || {}).reduce((sum, value) => sum + value, 0)}</span><span className="cell-secondary">{row.active_servers || 0} servers</span></td></tr>)}</tbody></table></div>
            {selectedDay && selectedDay.status !== "no_data" && <div className="day-detail-drawer"><div className="day-detail-header"><div><span className="eyebrow">Day drill-down</span><h3>{formatDate(selectedDay.date, { weekday: "long", month: "long", day: "numeric" })}</h3><p>{selectedDay.status === "complete" ? "All four telemetry domains observed." : `Partial coverage: ${selectedDay.observed_domains.join(", ")}.`}</p></div><div className="day-detail-kpis"><span><b>{selectedDay.avg_cooling_efficiency === null || selectedDay.avg_cooling_efficiency === undefined ? "—" : `${formatNumber(selectedDay.avg_cooling_efficiency * 100, 1)}%`}</b> cooling efficiency</span><span><b>{formatNumber(selectedDay.avg_inlet_temperature_c)}°C</b> inlet temperature</span><span><b>{formatNumber(selectedDay.estimated_water_l)} L</b> water estimate</span></div></div><div className="server-drill-table"><div className="drill-table-title"><h4>Server contribution</h4><span>{selectedDay.server_breakdown.length} servers observed · select a row for details</span></div><div className="table-scroll"><table className="data-table"><thead><tr><th>Server</th><th>Type / region</th><th>CPU</th><th>Facility kW</th><th>Energy kWh</th><th>PUE</th><th>Storage used</th></tr></thead><tbody>{selectedDay.server_breakdown.map((server) => <tr key={server.server_id} className={selectedServerId === server.server_id ? "selected" : ""} onClick={() => setSelectedServerId(selectedServerId === server.server_id ? "" : server.server_id)} onKeyDown={(event) => event.key === "Enter" && setSelectedServerId(selectedServerId === server.server_id ? "" : server.server_id)} tabIndex={0}><td><strong className="server-code">{server.server_id}</strong><span className="cell-secondary">{server.observations} observations</span></td><td>{server.server_type}<span className="cell-secondary">{server.region} · {server.cooling_type}</span></td><td>{formatNumber(server.avg_cpu)}%</td><td>{formatNumber(server.avg_facility_power_kw)}</td><td>{formatNumber(server.energy_kwh)}</td><td>{formatNumber(server.pue, 3)}</td><td>{formatNumber(server.storage_utilization_pct)}%</td></tr>)}</tbody></table></div></div>{selectedServer && <div className="server-detail-strip"><div className="server-detail-title"><span className="server-code">{selectedServer.server_id}</span><span>{selectedServer.server_type} · {selectedServer.region}</span><Link to={`/servers/${selectedServer.server_id}`}>Open server page →</Link></div><div className="server-detail-metrics"><span><b>{formatNumber(selectedServer.avg_memory)}%</b> memory</span><span><b>{formatNumber(selectedServer.avg_network_gbps)}</b> Gbps network</span><span><b>{formatNumber(selectedServer.avg_workload_intensity)}%</b> workload</span><span><b>{formatNumber(selectedServer.avg_inlet_temperature_c)}°C</b> inlet</span><span><b>{selectedServer.avg_cooling_efficiency === null || selectedServer.avg_cooling_efficiency === undefined ? "—" : `${formatNumber(selectedServer.avg_cooling_efficiency * 100, 1)}%`}</b> cooling efficiency</span><span><b>{formatNumber(selectedServer.duplicate_data_gb)} GB</b> duplicate data</span><span><b>₹{formatNumber(selectedServer.estimated_cost)}</b> estimated cost</span></div></div>}</div>}
          </section>

        </>
      )}
    </div>
  );
}
