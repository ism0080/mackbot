import { describe, expect, test } from "vitest";

import { commitmentsExtension, openCommitments } from "../src/commitments.ts";
import type { Commitment } from "../src/commitments.ts";

/** One conversation's commitments document, behind the slice of pi's api the tools use. */
const conversation = () => {
  const items: Commitment[] = [];
  const doc = { items };
  const apiFor = (taskId: number) =>
    // SAFETY: the tools read only these fields of their api.
    ({
      taskId,
      conversationId: 1,
      commit: async <T>(change: (tx: { doc: () => Promise<typeof doc> }) => Promise<T>) =>
        await change({ doc: async () => doc }),
    }) as never;
  const tool = (name: string) => {
    const found = commitmentsExtension.tools?.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`no tool ${name}`);
    return found;
  };
  // SAFETY: the tools hand the call context to `commit` and read nothing from it.
  const callContext = {} as never;
  const add = async (taskId: number, text: string) =>
    await tool("commitment_add").execute({ text }, apiFor(taskId), callContext);
  const close = async (taskId: number, id: string) =>
    await tool("commitment_close").execute({ id }, apiFor(taskId), callContext);
  const render = async () => {
    const section = commitmentsExtension.sections?.[0];
    if (section === undefined) throw new Error("no section");
    // SAFETY: the section reads only the conversation id and the snapshot.
    const input = { conversationId: 1, read: { snapshot: async () => doc } } as never;
    return await section.render(input, callContext);
  };
  return { doc, add, close, render };
};

const textOf = (result: { output?: readonly unknown[] }): string =>
  JSON.stringify(result.output ?? []);

describe("commitments", () => {
  test("a replayed call lands on the commitment it already recorded", async () => {
    const { doc, add } = conversation();
    await add(5, "Send the deck by Friday");
    const replay = await add(5, "Send the deck by Friday");
    expect(doc.items).toHaveLength(1);
    expect(textOf(replay)).toContain("already recorded");
  });

  test("a second call for a commitment that is still open does not add another", async () => {
    const { doc, add } = conversation();
    await add(5, "Send the deck by Friday");
    const again = await add(6, "Send the deck by Friday");
    expect(doc.items).toHaveLength(1);
    expect(textOf(again)).toContain("already open");
  });

  test("two calls give two commitments distinct ids", async () => {
    const { doc, add } = conversation();
    await add(5, "Book the room");
    await add(6, "Chase the invoice");
    const ids = doc.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/u);
  });

  test("closing an unknown id is an error and changes nothing", async () => {
    const { doc, add, close } = conversation();
    await add(5, "Book the room");
    const result = await close(6, "0000000000000000");
    expect(result.isError).toBe(true);
    expect(openCommitments(doc.items)).toHaveLength(1);
  });

  test("a closed commitment can be taken on again", async () => {
    const { doc, add, close } = conversation();
    await add(5, "Book the room");
    await close(6, doc.items[0]?.id ?? "");
    await add(7, "Book the room");
    expect(doc.items.map((item) => item.status)).toEqual(["closed", "open"]);
  });

  test("the section shows only open commitments, and nothing while none are open", async () => {
    const { doc, add, close, render } = conversation();
    expect(await render()).toBeUndefined();
    await add(5, "Book the room");
    await add(6, "Chase the invoice");
    const booked = doc.items[0]?.id ?? "";
    await close(7, booked);
    const rendered = await render();
    expect(rendered).toContain("Chase the invoice");
    expect(rendered).not.toContain("Book the room");
    await close(8, doc.items[1]?.id ?? "");
    expect(await render()).toBeUndefined();
  });
});
