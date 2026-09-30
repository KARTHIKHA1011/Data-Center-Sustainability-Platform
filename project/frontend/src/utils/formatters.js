export function formatValue(value, suffix = "") {
  return value === null || value === undefined ? "—" : `${value}${suffix}`;
}

export function dedupedTickFormatter(data) {
  return (value, index) => (index > 0 && data[index]?.time === data[index - 1]?.time ? "" : value);
}

export function windowData(rawHistory, hours, maxHours = 24) {
  if (hours >= maxHours) return rawHistory;
  const cutoff = Date.now() - hours * 3600 * 1000;
  return rawHistory.filter((point) => !point.timestamp || new Date(point.timestamp).getTime() >= cutoff);
}

export function flagLabel(flagType) {
  return (
    {
      idle_server: "Idle Server",
      stale_data: "Stale Data",
      duplicate_data: "Duplicate Data",
      overprovisioned: "Over-Provisioned",
    }[flagType] || flagType
  );
}