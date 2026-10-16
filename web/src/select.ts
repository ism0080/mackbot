import type { ActiveRunView, ApprovalView, BotView, EntryView } from "@mackbot/web-contract";
import { Option } from "effect";
import { AsyncData } from "foldkit";

import { clockOf } from "./format.ts";
import { botName } from "./partials.ts";
import type { Channel, Model } from "./model.ts";

export interface Blocked {
  readonly bot: string;
  readonly approval: ApprovalView;
}

export interface Running {
  readonly bot: string;
  readonly run: ActiveRunView;
}

export interface Recent {
  readonly bot: string;
  readonly entry: EntryView;
}

export interface Home {
  readonly headline: string;
  readonly sub: string;
  readonly allClear: boolean;
  readonly clearNote: string;
  /** Why the roster is not trustworthy yet: loading, unreachable, or a bot that
   *  answered with an error. `null` means every bot's status is in hand. */
  readonly notice: string | null;
  readonly blocked: readonly Blocked[];
  readonly running: readonly Running[];
  readonly recent: readonly Recent[];
}

const statusOf = (channel: Channel): Option.Option<BotView> => AsyncData.getData(channel.status);

/** Bots whose `/status` row never arrived, so the home can name them. */
const failedBotsOf = (channels: readonly (readonly [string, Channel])[]): readonly string[] =>
  channels.flatMap(([bot, channel]) => (AsyncData.hasError(channel.status) ? [bot] : []));

const blockedOf = (bot: string, status: BotView): readonly Blocked[] =>
  status.approvals
    .filter((approval) => approval.status === "pending")
    .map((approval) => ({ bot, approval }));

/** The newest settled answer, which is what "since you last looked" means until
 *  a route supplies the `seen` watermark that will make it exact. */
const latestOf = (bot: string, channel: Channel): readonly Recent[] =>
  Option.match(AsyncData.getData(channel.transcript), {
    onNone: () => [],
    onSome: (page) => {
      const settled = page.entries.filter(
        (entry) => entry.role === "assistant" && entry.at !== undefined,
      );
      const last = settled[settled.length - 1];
      return last === undefined ? [] : [{ bot, entry: last }];
    },
  });

const subOf = (bots: number, blocked: number, running: number): string =>
  `${bots} bots · ${blocked} blocked · ${running} running`;

const clearNoteOf = (running: readonly Running[]): string => {
  const first = running[0];
  if (first === undefined) return "All quiet. Every bot is idle.";
  return `${botName(first.bot)} is still working. I pull you back when something blocks.`;
};

const noticeOf = (roster: Model["roster"], failed: readonly string[]): string | null =>
  Option.match(AsyncData.getError(roster), {
    onSome: (error) => `Couldn't reach the fleet (${error}).`,
    onNone: () => {
      if (AsyncData.isIdle(roster) || AsyncData.isLoading(roster)) return "Checking on the fleet…";
      if (failed.length === 0) return null;
      return `No status from ${failed.map(botName).join(", ")}.`;
    },
  });

/** The triage home. It holds no state of its own: every line is a fold over the
 *  channels, so deciding an approval changes the home, the header count and the
 *  transcript together without any of them being updated. */
export const selectHome = (model: Model): Home => {
  const channels = Object.entries(model.channels);
  const statuses = channels.map(
    ([bot, channel]) => [bot, statusOf(channel)] as const,
  );
  const blocked = statuses.flatMap(([bot, status]) =>
    Option.match(status, { onNone: () => [], onSome: (view) => blockedOf(bot, view) }),
  );
  const running = statuses.flatMap(([bot, status]) =>
    Option.match(status, {
      onNone: () => [],
      onSome: (view) => (view.activeRun === undefined ? [] : [{ bot, run: view.activeRun }]),
    }),
  );
  const recent = channels
    .flatMap(([bot, channel]) => latestOf(bot, channel))
    .sort((left, right) => (right.entry.at ?? 0) - (left.entry.at ?? 0));
  const notice = noticeOf(model.roster, failedBotsOf(channels));

  return {
    headline: blocked.length === 0 ? "Nothing needs you" : "Needs you",
    sub: subOf(channels.length, blocked.length, running.length),
    allClear: blocked.length === 0 && notice === null,
    clearNote: clearNoteOf(running),
    notice,
    blocked: blocked.sort((left, right) => left.approval.requestedAt - right.approval.requestedAt),
    running: running.sort((left, right) => left.run.startedAt - right.run.startedAt),
    recent,
  };
};

/** The title line, from the same fold as the screen. */
export const homeTitle = (model: Model): string => {
  const home = selectHome(model);
  return `${home.headline} · mackbot`;
};

export const entryStampOf = (entry: EntryView): string =>
  entry.at === undefined ? "" : clockOf(entry.at);
