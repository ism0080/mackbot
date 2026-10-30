/**
 * feedback-fold — the toast stack and the draft dialog, as the app's update
 * sees them: each submodel's messages folded into the Model, and the helpers
 * the rest of the update uses to say something or to close what it was showing.
 */
import { Dialog } from "@foldkit/ui";
import { Option } from "effect";
import { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { Message } from "./message.ts";
import type { Model } from "./model.ts";
import { Toast } from "./toast.ts";

/** The vocabulary a toast is filed under, kept next to the fold that uses it. */
export type ToastVariant = "Info" | "Success" | "Warning" | "Error";

const readToast = (model: Model) => Option.some(model.toast);

const writeToast = (model: Model, next: Model["toast"]): Model =>
  modifyFields(model, { toast: () => next });

const toGotToastMessage = (message: typeof Toast.Message.Type): Message =>
  Message.GotToastMessage({ message });

// Nothing outside the stack depends on a toast being gone: the fold's own
// write is the whole change, so the OutMessage retires quietly.
const foldToastOutMessage = Toast.OutMessage.match<Update.Step<Model, Message>>({
  DismissedToast: () => (model) => ({ model }),
});

/**
 * The toast stack's own update. `update` delegates every one of the stack's
 * messages here; the fold writes the next stack back into the Model, lifts the
 * submodel's Commands into this app's — the enter animation, and the timer
 * that retires a non-sticky entry — and hands the OutMessage on.
 */
export const foldToast = Update.foldChild({
  update: Toast.update,
  read: readToast,
  write: writeToast,
  toParentMessage: toGotToastMessage,
  foldOutMessage: foldToastOutMessage,
});

/**
 * One answer restated as a toast. The stack owns the entry's id, its timer and
 * its animation, so a second answer stacks under the first instead of
 * replacing it, and neither needs dismissing by hand.
 */
const showToast = Update.foldChild({
  update: Toast.show,
  read: readToast,
  write: writeToast,
  toParentMessage: toGotToastMessage,
  foldOutMessage: foldToastOutMessage,
});

export const withToast = (model: Model, variant: ToastVariant, text: string) =>
  showToast(model, { variant, payload: { text } });

const readDialog = (model: Model) => Option.some(model.dialog);

const writeDialog = (model: Model, next: Dialog.Model): Model =>
  modifyFields(model, { dialog: () => next });

const toGotDialogMessage = (message: Dialog.Message): Message =>
  Message.GotDialogMessage({ message });

/**
 * What a dialog closing means here: whatever draft it was showing is no longer
 * under review, so the Model stops naming it. The dialog's own open flag is the
 * dialog's to hold; this is the parent's half of the same fact.
 */
const foldDialogOutMessage = Dialog.OutMessage.match<Update.Step<Model, Message>>({
  Opened: () => (model) => ({ model }),
  Closed: () => (model) => ({ model: modifyFields(model, { reviewing: () => null }) }),
});

export const foldDialog = Update.foldChild({
  update: Dialog.update,
  read: readDialog,
  write: writeDialog,
  toParentMessage: toGotDialogMessage,
  foldOutMessage: foldDialogOutMessage,
});

export const openDialog = Update.foldChildStep({
  update: Dialog.open,
  read: readDialog,
  write: writeDialog,
  toParentMessage: toGotDialogMessage,
  foldOutMessage: foldDialogOutMessage,
});

export const closeDialog = Update.foldChildStep({
  update: Dialog.close,
  read: readDialog,
  write: writeDialog,
  toParentMessage: toGotDialogMessage,
  foldOutMessage: foldDialogOutMessage,
});
