import { describe, expect, test } from "vitest";

import { VOICE, voiceExtension } from "../src/voice.ts";

/**
 * Render the section the way pi does for a request, with the conversation
 * inputs left out: the section is static prose and must not need them.
 */
const rendered = (): string => {
  const voiceSection = voiceExtension.sections?.[0];
  if (voiceSection === undefined) throw new Error("the voice extension has no section");
  // SAFETY: the section renders a constant and reads nothing from its request
  // inputs, so calling it without them is the production path minus arguments.
  const render = voiceSection.render as () => string;
  return render();
};

describe("voice", () => {
  test("is installed under a stable name with one section", () => {
    expect(voiceExtension.name).toBe("mackbot-voice");
    expect(voiceExtension.sections).toHaveLength(1);
    expect(voiceExtension.sections?.[0]?.key).toBe("voice");
  });

  test("renders its whole text with no arguments", () => {
    expect(rendered()).toBe(VOICE);
  });

  test("tells an unchanged check-in it is one sentence, not a report", () => {
    expect(rendered()).toContain(
      'If the news is "nothing changed", that sentence is the whole message.',
    );
  });

  test("numbers the actions and keeps work the bot can do itself out of them", () => {
    expect(rendered()).toContain('"What needs them" is a numbered list, one action per item');
    expect(rendered()).toContain("Nothing that you can do yourself belongs here.");
  });

  test("bans restating state that has not changed", () => {
    expect(rendered()).toContain(
      "Never restate state you already reported and that has not changed.",
    );
    expect(rendered()).toContain("Never re-describe a calendar or inbox you already summarised.");
  });

  test("allows one question, and only when it changes what happens next", () => {
    expect(rendered()).toContain(
      "Ask at most one question, and only when the answer changes what you do next.",
    );
  });
});
