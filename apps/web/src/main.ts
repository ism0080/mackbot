import { Dialog } from "@foldkit/ui";
import { AsyncData, Update } from "foldkit";
import type { Url } from "foldkit/url";

import { Status } from "./api.ts";
import { EMPTY_DRAFT, Screen } from "./model.ts";
import type { Model } from "./model.ts";
import { enterScreen } from "./request-fold.ts";
import { screenOfPath } from "./route.ts";
import { TOAST_ID, Toast } from "./toast.ts";

export const init = (url?: Url) => {
  const screen = url === undefined ? Screen.Home() : screenOfPath(url.pathname);
  const model: Model = {
    screen,
    now: 0,
    roster: AsyncData.Idle(),
    toast: Toast.init({ id: TOAST_ID }),
    dialog: Dialog.init({ id: "approval-draft" }),
    reviewing: null,
    expanded: {},
    // A transcript opens at its newest entry, so the button that returns there
    // starts hidden.
    atBottom: true,
    channels: {},
    polling: true,
    statusStale: false,
    visible: true,
    registry: AsyncData.Idle(),
    catalog: AsyncData.Idle(),
    draft: EMPTY_DRAFT,
    newBotId: "",
  };

  // A deep link asks for what its screen shows, the same as arriving by a
  // click would: `/bots` reads the roster, `/chat/:bot` its transcript.
  return Update.combine(model, [
    (current) => ({ model: current, commands: [Status()] }),
    enterScreen(screen),
  ]);
};

export { Model } from "./model.ts";
export { Message } from "./message.ts";
export { subscriptions } from "./subscriptions.ts";
export { update } from "./update.ts";
export { view } from "./view.ts";
