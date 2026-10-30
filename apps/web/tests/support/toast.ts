/**
 * Draining the toast stack.
 *
 * Showing a toast schedules the entry's enter animation, and — unless it is
 * sticky — the timer that retires it. A Story or Scene test fails on any
 * Command it never resolved, so every test whose action says something out
 * loud has to retire those Commands too.
 *
 * The pairs below are the ones `@foldkit/ui` documents for
 * `Toast.test.drainEntry`. They are rebuilt here against `foldkit/story` and
 * `foldkit/scene` separately because each harness brands its own step, and
 * because most tests want the entry to stay on screen: the timer is retired
 * with a stale version, which is what a timer that fired against an already
 * dismissed entry looks like.
 */
import * as Animation from "@foldkit/ui/animation";
import { WaitBeforeDismissal } from "@foldkit/ui/toast";
import { Command as SceneCommand } from "foldkit/scene";
import { Command as StoryCommand } from "foldkit/story";

import { TOAST_ID, Toast } from "../../src/toast.ts";

/** The generation the entry's enter animation runs under. */
const ENTER = 1;
/** The generation its leave animation runs under. */
const LEAVE = 2;
/** A version no entry carries, so the timer resolves without dismissing it. */
const STALE = 999;

/** The id the stack gives its entry number `index`, counting from zero. */
export const toastEntry = (index = 0): string => `${TOAST_ID}-entry-${index}`;

/** The words of the newest toast on the stack, or none when it is empty. */
export const toastText = (model: {
  readonly toast: typeof Toast.Model.Type;
}): string | undefined => {
  const newest = model.toast.entries[model.toast.entries.length - 1];
  return newest === undefined ? undefined : newest.payload.text;
};

/** The enter animation, which leaves the entry on screen when it finishes. */
const enter = (entryId: string) =>
  [
    [
      Animation.WaitForPaint({ generation: ENTER }),
      Animation.Message.CompletedWaitForPaint({ generation: ENTER }),
    ],
    [
      Animation.WaitForAnimationSettled({ id: entryId, generation: ENTER }),
      Animation.Message.EndedAnimation({ generation: ENTER }),
    ],
  ] as const;

/** The auto-dismiss timer, retired with the version it was scheduled under. */
const timer = (entryId: string, version: number) =>
  [WaitBeforeDismissal, Toast.Message.CompletedWaitBeforeDismissal({ entryId, version })] as const;

/** The leave animation, after which the entry is gone from the stack. */
const leave = (entryId: string) =>
  [
    [
      Animation.WaitForPaint({ generation: LEAVE }),
      Animation.Message.CompletedWaitForPaint({ generation: LEAVE }),
    ],
    [
      Animation.WaitForAnimationSettled({ id: entryId, generation: LEAVE }),
      Animation.Message.EndedAnimation({ generation: LEAVE }),
    ],
  ] as const;

/**
 * Retires a shown toast's Commands while keeping it on screen: the enter
 * animation finishes, and the dismissal timer resolves against an entry that
 * is no longer waiting for it.
 */
export const settleToastScene = (entryId = toastEntry()) =>
  SceneCommand.resolveAll(...enter(entryId), timer(entryId, STALE));

/** The Story counterpart of {@link settleToastScene}. */
export const settleToast = (entryId = toastEntry()) =>
  StoryCommand.resolveAll(...enter(entryId), timer(entryId, STALE));

/**
 * Runs a shown toast all the way out: the enter animation, the timer it was
 * scheduled under, and the leave animation that removes the entry.
 */
export const drainToastScene = (entryId = toastEntry(), version = 0) =>
  SceneCommand.resolveAll(...enter(entryId), timer(entryId, version), ...leave(entryId));

/** The Story counterpart of {@link drainToastScene}. */
export const drainToast = (entryId = toastEntry(), version = 0) =>
  StoryCommand.resolveAll(...enter(entryId), timer(entryId, version), ...leave(entryId));
