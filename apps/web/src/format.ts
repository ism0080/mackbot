import type { EntryView } from "@mackbot/contract";

/** Clock labels are UTC so a fixture renders the same wherever it is opened. */
const CLOCK = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

export const clockOf = (at: number): string => CLOCK.format(new Date(at));

/** "4m", the way the sketch's "waiting 4m" and "running 6m" read. */
export const elapsedOf = (at: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "moments";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

/**
 * The words an entry contributes as a chat message, or `undefined` when it
 * contributes none.
 *
 * pi commits an entry for every turn it takes, so the transcript holds entries
 * that are not things a person said: a bookkeeping entry, and an assistant
 * message whose only content was a tool call. Both project to empty text, and
 * rendering one paints a blank bubble between the tool rows — so the viewer
 * asks this rather than reading `text` directly. A tool result is never a
 * message either: it is the collapsed row beside them, whatever its body holds.
 */
export const wordsOf = (entry: EntryView): string | undefined => {
  if (entry.role === "tool") return undefined;
  return entry.text.trim().length === 0 ? undefined : entry.text;
};
