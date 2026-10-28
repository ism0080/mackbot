import { Dialog } from "@foldkit/ui";
import { AsyncData } from "foldkit";
import type { Url } from "foldkit/url";

import { Status } from "./api.ts";
import { EMPTY_DRAFT, Screen } from "./model.ts";
import { screenOfPath } from "./route.ts";
import { TOAST_ID, Toast } from "./toast.ts";
export const init = (url?: Url) => ({
  model: {
    screen: url === undefined ? Screen.Home() : screenOfPath(url.pathname),
    now: 0,
    roster: AsyncData.Idle(),
    toast: Toast.init({ id: TOAST_ID }),
    dialog: Dialog.init({ id: "approval-draft" }),
    reviewing: null,
    expanded: {},
    channels: {},
    polling: true,
    registry: AsyncData.Idle(),
    catalog: AsyncData.Idle(),
    draft: EMPTY_DRAFT,
    newBotId: "",
  },
  commands: [Status()],
});

export { Model } from "./model.ts";
export { Message } from "./message.ts";
export { subscriptions } from "./subscriptions.ts";
export { update } from "./update.ts";
export { view } from "./view.ts";
