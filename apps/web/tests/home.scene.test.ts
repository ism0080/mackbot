/**
 * Scene tests for the triage home.
 *
 * Each test starts from the Model the routes would leave behind and drives the
 * rendered home: it reads what the person sees and spends the Commands a
 * click produces. A test fails when the wiring between a click, a Command and
 * the next render regresses, not when a helper does.
 */
import { AsyncData } from "foldkit";
import {
  all,
  Command,
  click,
  expect,
  expectAll,
  given,
  Mount,
  role,
  scene,
  selector,
  within,
} from "foldkit/scene";
import { test } from "vitest";

import { Dialog } from "@foldkit/ui";

import {
  Catalog,
  DecideApproval,
  RetryTask,
  Roster,
  SignOut,
  Status,
  StopBot,
  Transcript,
} from "../src/api.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { Navigate } from "../src/route.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view.ts";
import {
  approvalOf,
  CATALOG,
  entryOf,
  FIXTURE_NOW,
  rosterOf,
  statusOf,
  transcriptOf,
} from "./support/fixtures.ts";
import { appModel, botChannel, idleChannel } from "./support/scene.ts";
import { settleToastScene } from "./support/toast.ts";
const at = (minutesAgo: number): number => FIXTURE_NOW - minutesAgo * 60_000;

const stream = {
  stream: "feed:hermes:3",
  generation: 3,
  cursor: 0,
  state: "streaming" as const,
};

const runOf = () => ({
  ordinal: 1,
  inputs: ["Draft the weekly update"],
  startedAt: at(6),
  session: "sess_hermes",
  stream,
});

const homeScreen = () => Screen.Home();

test("a pending approval is a card with its tool, question, draft and foot", () => {
  const body = "Hi Arena — the numbers are attached.";

  scene(
    { update, view },
    given(
      appModel(homeScreen(), {
        hermes: botChannel({
          status: statusOf({
            approvals: [
              approvalOf({
                artifact: { label: "Draft reply", body },
              }),
            ],
          }),
        }),
      }),
    ),
    expect(role("heading", { name: "Needs you", level: 1 })).toExist(),
    expect(selector('[data-group="blocked"]')).toBeVisible(),
    expect(selector('[data-approval="apr_send"]')).toExist(),
    expect(within(selector('[data-approval="apr_send"]'), selector(".ap-tool"))).toHaveText(
      "botmail.send",
    ),
    expect(within(selector('[data-approval="apr_send"]'), selector(".ap-q"))).toContainText(
      "Send the drafted reply to arena@northwind.co?",
    ),
    // The artifact is opt-in reading, and reading it means the whole draft.
    expect(within(selector('[data-approval="apr_send"]'), selector(".ap-draft"))).toContainText(
      "Draft reply",
    ),
    expect(within(selector('[data-approval="apr_send"]'), selector(".ap-draft"))).toContainText(
      body,
    ),
    expect(within(selector('[data-approval="apr_send"]'), selector(".ap-foot"))).toContainText(
      "waiting 4m",
    ),
    expect(
      within(
        selector('[data-approval="apr_send"]'),
        role("button", { name: "Allow botmail.send for Hermes" }),
      ),
    ).toBeEnabled(),
    expect(
      within(
        selector('[data-approval="apr_send"]'),
        role("button", { name: "Deny botmail.send for Hermes" }),
      ),
    ).toBeEnabled(),
  );
});

test("the draft button opens the whole draft in a dialog, with the decision in it", () => {
  const body = "Hi Arena — the numbers are attached.";

  scene(
    { update, view },
    given(
      appModel(homeScreen(), {
        hermes: botChannel({
          status: statusOf({
            approvals: [approvalOf({ artifact: { label: "Draft reply", body } })],
          }),
        }),
      }),
    ),
    // Reading is opt-in: nothing is open until the draft line is pressed.
    expect(selector(".dlg-panel")).toBeAbsent(),
    click(selector('[data-review="apr_send"]')),
    Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
    // The dialog element mounts itself once it is in the tree; the acquisition
    // is what takes the scroll lock and the focus trap.
    Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
    expect(within(selector(".dlg-panel"), role("heading", { name: "Draft reply" }))).toExist(),
    expect(within(selector(".dlg-panel"), selector(".dlg-artifact"))).toHaveText(body),
    expect(within(selector(".dlg-panel"), selector(".dlg-question"))).toHaveText(
      "Send the drafted reply to arena@northwind.co?",
    ),
    // The decision sits with the draft rather than behind it.
    expect(
      within(selector(".dlg-panel"), role("button", { name: "Allow botmail.send for Hermes" })),
    ).toExist(),
    expect(
      within(selector(".dlg-panel"), role("button", { name: "Deny botmail.send for Hermes" })),
    ).toExist(),
  );
});

test("Allow sends the decision and the card leaves once the server agrees", () => {
  scene(
    { update, view },
    given(
      appModel(homeScreen(), {
        hermes: botChannel({ status: statusOf({ approvals: [approvalOf()] }) }),
      }),
    ),
    expect(selector(".hdr-sub")).toContainText("1 blocked"),
    click(role("button", { name: "Allow botmail.send for Hermes" })),
    Command.expectExact(DecideApproval({ bot: "hermes", approvalId: "apr_send", action: "allow" })),
    Command.resolve(
      DecideApproval,
      Message.ApprovalDecided({
        bot: "hermes",
        approvalId: "apr_send",
        status: "allowed",
        decidedAt: FIXTURE_NOW,
      }),
    ),
    expect(selector('[data-approval="apr_send"]')).toBeAbsent(),
    expect(selector('[data-group="blocked"]')).not.toBeVisible(),
    expect(selector(".hdr-sub")).toContainText("0 blocked"),
    expect(role("heading", { name: "Nothing needs you", level: 1 })).toExist(),
  );
});

test("Deny sends the other decision", () => {
  scene(
    { update, view },
    given(
      appModel(homeScreen(), {
        hermes: botChannel({ status: statusOf({ approvals: [approvalOf()] }) }),
      }),
    ),
    click(role("button", { name: "Deny botmail.send for Hermes" })),
    Command.expectExact(DecideApproval({ bot: "hermes", approvalId: "apr_send", action: "deny" })),
    Command.resolve(
      DecideApproval,
      Message.ApprovalDecided({
        bot: "hermes",
        approvalId: "apr_send",
        status: "denied",
        decidedAt: FIXTURE_NOW,
      }),
    ),
    expect(selector('[data-approval="apr_send"]')).toBeAbsent(),
  );
});

test("a running bot is a row with its title and a Stop that asks the server", () => {
  scene(
    { update, view },
    given(
      appModel(homeScreen(), {
        hermes: botChannel({
          status: statusOf({ busy: true, activeRun: runOf() }),
          page: transcriptOf(),
        }),
      }),
    ),
    expect(selector('[data-group="running"]')).toBeVisible(),
    expect(selector('[data-group="running"] [data-bot="hermes"] .rt')).toHaveText(
      "Draft the weekly update",
    ),
    expect(selector('[data-group="running"] [data-bot="hermes"] .rmeta')).toContainText(
      "running 6m",
    ),
    click(selector('[data-stop="hermes"]')),
    Command.expectExact(StopBot({ bot: "hermes", session: "sess_hermes" })),
    Command.resolve(
      StopBot,
      Message.StoppedBot({ bot: "hermes", session: "sess_hermes", aborted: true }),
    ),
    // The stop is only a request; the run leaves the screen when status says so.
    expect(selector('[data-group="running"]')).toBeVisible(),
    settleToastScene(),
    Command.expectExact(Status()),
    Command.resolve(
      Status,
      Message.StatusLoaded({ bots: { hermes: statusOf() }, errors: {}, at: FIXTURE_NOW }),
    ),
    expect(selector("[data-toast]")).toHaveText("Stopped Hermes."),
    expect(selector('[data-group="running"]')).not.toBeVisible(),
  );
});

test("a harness failure says Needs attention and names the fault", () => {
  const detail = 'Cannot read properties of undefined (reading "id")';

  scene(
    { update, view },
    given(
      appModel(homeScreen(), {
        hermes: botChannel({
          status: statusOf({
            failures: [{ at: at(2), kind: "task_faulted", name: "TypeError", detail }],
          }),
        }),
      }),
    ),
    expect(role("heading", { name: "Needs attention", level: 1 })).toExist(),
    expect(selector('[data-group="failures"]')).toBeVisible(),
    expect(selector('[data-group="failures"] [data-failure="TypeError"] .sp-detail')).toHaveText(
      detail,
    ),
    expect(selector('[data-group="failures"] [data-failure="TypeError"] .sp-foot')).toContainText(
      "reported 2m",
    ),
    // A fault is not a decision waiting on the person, so no all-clear either.
    expect(selector('[data-group="empty"]')).not.toBeVisible(),
  );
});

test("a parked task sits under Parked with a Retry, and live work does not", () => {
  scene(
    { update, view },
    given(
      appModel(homeScreen(), {
        hermes: botChannel({
          status: statusOf({
            tasks: [
              {
                id: "task_parked",
                kind: "summarise inbox",
                session: "sess_hermes",
                status: "blocked",
                reason: "restart_limit",
                background: false,
              },
              {
                id: "task_live",
                kind: "send digest",
                session: "sess_hermes",
                status: "running",
                background: false,
              },
            ],
          }),
          page: transcriptOf(),
        }),
      }),
    ),
    expect(selector('[data-group="parked"]')).toBeVisible(),
    expect(selector('[data-parked="task_parked"]')).toContainText("summarise inbox"),
    expect(selector('[data-parked="task_parked"] .sp-reason')).toHaveText("restart_limit"),
    expect(selector('[data-group="tasks"]')).toBeVisible(),
    expect(selector('[data-group="tasks"] [data-task="task_live"]')).toExist(),
    expect(selector('[data-group="tasks"] [data-task="task_parked"]')).toBeAbsent(),
    // Retry is only offered for work the harness will not pick up again.
    expect(selector('[data-group="tasks"] [data-retry]')).toBeAbsent(),

    click(selector('[data-retry="task_parked"]')),
    Command.expectExact(RetryTask({ bot: "hermes", taskId: "task_parked" })),
    Command.resolve(
      RetryTask,
      Message.TaskRetried({ bot: "hermes", taskId: "task_parked", retried: true }),
    ),
    settleToastScene(),
    Command.expectExact(Status()),
    Command.resolve(
      Status,
      Message.StatusLoaded({ bots: { hermes: statusOf() }, errors: {}, at: FIXTURE_NOW }),
    ),
    expect(selector("[data-toast]")).toHaveText("Reran Hermes's parked task."),
  );
});

test("the chats list holds one row per bot with its preview and work state", () => {
  scene(
    { update, view },
    given(
      appModel(homeScreen(), {
        hermes: botChannel({
          status: statusOf({ busy: true }),
          page: transcriptOf({
            entries: [entryOf({ id: 1, text: "Three things moved overnight." })],
          }),
        }),
        scribe: botChannel({
          status: statusOf({ busy: false }),
          page: transcriptOf({
            session: "scribe",
            entries: [entryOf({ id: 2, text: "Notes filed." })],
          }),
        }),
      }),
    ),
    expect(selector('[data-group="chats"]')).toBeVisible(),
    expectAll(all.selector('[data-group="chats"] [data-bot]')).toHaveCount(2),
    expect(selector('[data-group="chats"] [data-bot="hermes"] .chat-preview')).toContainText(
      "Three things moved overnight.",
    ),
    expect(selector('[data-group="chats"] [data-bot="hermes"] .tag')).toHaveText("working"),
    expect(selector('[data-group="chats"] [data-bot="scribe"] .tag')).toHaveText("idle"),
    expect(selector('[data-group="chats"] [data-bot="scribe"] .chat-preview')).toContainText(
      "Notes filed.",
    ),
  );
});

test("a chat preview skips turns with nothing to read", () => {
  scene(
    { update, view },
    given(
      appModel(homeScreen(), {
        hermes: botChannel({
          status: statusOf(),
          page: transcriptOf({
            entries: [
              entryOf({ id: 1, text: "Three things moved overnight." }),
              entryOf({ id: 2, role: "assistant", text: "" }),
              entryOf({
                id: 3,
                role: "tool",
                text: '{"delivered":true}',
                toolName: "botmail.send",
              }),
            ],
          }),
        }),
      }),
    ),
    expect(selector('[data-group="chats"] [data-bot="hermes"] .chat-preview')).toContainText(
      "Three things moved overnight.",
    ),
  );
});

test("opening a chat the home has no page for asks for that page", () => {
  scene(
    { update, view },
    given(
      appModel(homeScreen(), {
        hermes: botChannel({ status: statusOf() }),
        scribe: botChannel({ status: statusOf({ busy: false }) }),
      }),
    ),
    click(selector('[data-group="chats"] [data-bot="scribe"]')),
    Command.expectExact(Navigate({ path: "/chat/scribe" }), Transcript({ bot: "scribe" })),
    Command.resolve(
      Transcript,
      Message.TranscriptLoaded({
        bot: "scribe",
        page: transcriptOf({ session: "scribe" }),
      }),
    ),
    Command.resolve(Navigate, Message.Navigated()),
    expect(role("heading", { name: "Scribe", level: 1 })).toExist(),
  );
});

test("an unreachable fleet is a notice, not a quiet home", () => {
  scene(
    { update, view },
    given(appModel(homeScreen(), {}, { roster: AsyncData.fail("connection refused") })),
    expect(selector('[data-group="error"]')).toBeVisible(),
    expect(selector('[data-group="error"]')).toContainText(
      "Couldn't reach the fleet (connection refused).",
    ),
    expect(selector('[data-group="empty"]')).not.toBeVisible(),
  );
});

test("a bot whose status could not be read is named in the notice", () => {
  scene(
    { update, view },
    given(
      appModel(homeScreen(), {
        hermes: idleChannel({ status: AsyncData.fail("timed out") }),
      }),
    ),
    expect(selector('[data-group="error"]')).toBeVisible(),
    expect(selector('[data-group="error"]')).toContainText("No status from Hermes."),
    // The fleet answered, so this is not the unreachable-fleet wording.
    expect(selector('[data-group="error"]')).not.toContainText("Couldn't reach the fleet"),
  );
});

test("an all-clear home says Nothing needs you", () => {
  scene(
    { update, view },
    given(appModel(homeScreen(), { hermes: botChannel({ status: statusOf() }) })),
    expect(role("heading", { name: "Nothing needs you", level: 1 })).toExist(),
    expect(selector('[data-group="empty"]')).toBeVisible(),
    expect(selector('[data-group="empty"]')).toContainText("Nothing needs you"),
    expect(selector('[data-group="empty"]')).toContainText("All quiet. Every bot is idle."),
    expect(selector('[data-group="error"]')).not.toBeVisible(),
  );
});

test("New chat pushes its route", () => {
  scene(
    { update, view },
    given(appModel(homeScreen(), { hermes: botChannel({ status: statusOf() }) })),
    click(role("button", { name: "New chat" })),
    Command.expectExact(Navigate({ path: "/new" })),
    Command.resolve(Navigate, Message.Navigated()),
    expect(role("heading", { name: "New chat", level: 1 })).toExist(),
  );
});

test("Bots pushes its route and asks for the roster and catalog", () => {
  scene(
    { update, view },
    given(appModel(homeScreen(), { hermes: botChannel({ status: statusOf() }) })),
    click(role("button", { name: "Bots" })),
    Command.expectExact(Navigate({ path: "/bots" }), Roster(), Catalog()),
    Command.resolve(Roster, Message.RosterLoaded({ roster: rosterOf() })),
    Command.resolve(Catalog, Message.CatalogLoaded({ catalog: CATALOG })),
    Command.resolve(Navigate, Message.Navigated()),
    expect(role("heading", { name: "Bots", level: 1 })).toExist(),
  );
});

test("Sign out asks the server to end the session, and says so when it cannot", () => {
  scene(
    { update, view },
    given(appModel(homeScreen())),
    click(role("button", { name: "Sign out" })),
    Command.expectExact(SignOut()),
    Command.resolve(SignOut, Message.SignOutFailed({ error: "offline" })),
    settleToastScene(),
    expect(selector("[data-toast]")).toHaveText("Couldn't sign out (offline)."),
  );
});
