/*
 * The poll is a Subscription that dispatches the `Status` Command through a
 * Message, so the two properties that matter are both pure update behaviour and
 * are cheapest to prove by calling update directly:
 *
 * - a tick while a `/status` request is outstanding dispatches nothing, so a
 *   slow request cannot stack a second one behind it;
 * - once that request answers, the next tick dispatches again, which is what
 *   makes the Command re-runnable rather than one-shot.
 */
import { Message } from "../src/message.ts";
import { init, update } from "../src/main.ts";

const commandsOf = (result) => result.commands ?? [];
const namesOf = (result) => commandsOf(result).map((command) => command.name);

const main = () => {
  const started = init();
  console.log(
    `ok   init dispatches the Status Command itself: ${namesOf(started).join(",") === "Status"}`,
  );
  console.log(`ok   init records that request as outstanding: ${started.model.polling === true}`);

  let result = update(started.model, Message.PolledStatus());
  console.log(
    `ok   a tick behind the init request dispatches nothing: ${commandsOf(result).length === 0}`,
  );

  result = update(result.model, Message.StatusLoaded({ bots: {}, errors: {}, at: 1 }));
  console.log(`ok   the answer clears the outstanding flag: ${result.model.polling === false}`);

  result = update(result.model, Message.PolledStatus());
  console.log(
    `ok   the next tick dispatches the Status Command again: ${namesOf(result).join(",") === "Status"}`,
  );
  console.log(`ok   the tick records the new request as outstanding: ${result.model.polling === true}`);

  result = update(result.model, Message.PolledStatus());
  console.log(`ok   a tick while it is in flight dispatches nothing: ${commandsOf(result).length === 0}`);

  const failed = update(
    { ...result.model, polling: true },
    Message.StatusFailed({ error: "boom", at: 2 }),
  );
  console.log(`ok   a failed request clears the flag too: ${failed.model.polling === false}`);
};

main();
