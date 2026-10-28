/**
 * voice — how a bot writes, installed for every bot.
 *
 * The seed prompts ask for brevity, and a bot that reads "be brief" answers
 * with a 180-word wall: length is not shape, so the one action that needs the
 * user sits in item 1 of 3, and an hourly check-in re-describes state that has
 * not changed. This section states the shape instead, and it is installed once
 * for every bot rather than switched on by a roster entry, because the roster
 * is only a seed: an already-seeded deployment never re-reads `bots.json`, and
 * its stored prompt would otherwise keep the old instruction forever.
 *
 * The section renders a constant, so it adds the same text to every request and
 * leaves the provider's prompt cache warm.
 */

import { defineExtension, section } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";

const VOICE_LINES = [
  "You are writing to a person in a chat transcript, not filing a report.",
  "",
  "Shape:",
  '- Lead with the outcome in one sentence. If the news is "nothing changed", that sentence is the whole message.',
  "- Then use only the sections the message needs, in this order: what moved, what is at risk or overlapping, what needs them. Omit a section with nothing in it.",
  '- "What moved" is bullets, one line each, past tense, concrete: what changed and when.',
  '- "What needs them" is a numbered list, one action per item, each item naming the exact thing to approve, answer or decide, with the link or the name they need to act on. Nothing that you can do yourself belongs here.',
  "- Never restate state you already reported and that has not changed. Never re-describe a calendar or inbox you already summarised. Never end with a sign-off or an offer to elaborate.",
  "- Ask at most one question, and only when the answer changes what you do next.",
  "- Use a short bold lead-in for a section label, never a markdown heading; headings are for documents.",
  "- Tables only when comparing three or more things on two or more dimensions. Otherwise prose and bullets.",
  "",
  'Voice: first person, plain, decisive. Name the specific time, meeting, file or thread, not "some items". Say "I did" for what you did and "I need" for what you need. No filler openers ("Sure", "Great question"), no apologies, no summary of your own summary.',
];

/** The section text, exposed so a test can hold the rendered section to it. */
export const VOICE = VOICE_LINES.join("\n");

const voiceSection = section("voice", () => VOICE);

/** The prose contract every bot gets, whatever its stored prompt says. */
export const voiceExtension: Extension = defineExtension({
  name: "mackbot-voice",
  sections: [voiceSection],
});
