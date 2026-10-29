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

/**
 * The first thing an entry says, as plain words, for a one-line preview.
 *
 * A bot writes markdown, and a list row is not the place to render it: the
 * escapes would show as `**` and `-` in the middle of the row. This strips the
 * syntax a preview can meet — headings, emphasis, list markers, links — and
 * keeps the words, not the markup. It is a preview, not a parser: anything it
 * does not know how to strip survives as the text it was, which is what a
 * reader would have seen in the raw entry anyway.
 */
export const plainOf = (text: string): string => {
  const line = text
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (line === undefined) return "";

  return (
    line
      .replace(/^#{1,6}\s+/u, "")
      .replace(/^[-*+]\s+/u, "")
      .replace(/^\d+[.)]\s+/u, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
      .replace(/(\*\*|__|\*|_|`)/gu, "")
      .trim()
      // A preview is one line, so a very long first line is the row's problem
      // to elide rather than the layout's to break.
      .slice(0, 240)
  );
};
