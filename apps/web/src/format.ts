import type { EntryView } from "@mackbot/contract";

/** Clock labels are the reader's own local time: a person reads "09:14" as
 *  the hour on their wall, not the hour in Greenwich. */
const CLOCK = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
});

export const clockOf = (at: number): string => CLOCK.format(new Date(at));

const DAY = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** The local calendar day an instant falls on, as a key two instants share
 *  exactly when they fall on the same day. */
export const dayKeyOf = (at: number): string => {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

/** A transcript's day divider: "Today" and "Yesterday" relative to `now`, and
 *  the date itself for anything older. */
export const dayLabelOf = (at: number, now: number): string => {
  const key = dayKeyOf(at);
  if (key === dayKeyOf(now)) return "Today";
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (key === dayKeyOf(yesterday.getTime())) return "Yesterday";
  return DAY.format(new Date(at));
};

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
