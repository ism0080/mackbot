/** Clock labels are UTC so a fixture renders the same wherever it is opened. */
const CLOCK = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

export const clockOf = (at: number): string => CLOCK.format(new Date(at));

/** "4m", the way the sketch's "waiting 4m" and "running 6m" read. */
export const elapsedOf = (at: number, now: number): string => {
  const minutes = globalThis.Math.max(0, globalThis.Math.round((now - at) / 60_000));
  if (minutes < 1) return "moments";
  if (minutes < 60) return `${minutes}m`;
  const hours = globalThis.Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${globalThis.Math.round(hours / 24)}d`;
};
