import { AsyncData } from "foldkit";

import { Status } from "./api.ts";
import { Screen } from "./model.ts";

export const init = () => ({
  model: {
    screen: Screen.Home(),
    now: 0,
    roster: AsyncData.Idle(),
    toast: null,
    channels: {},
    polling: true,
  },
  commands: [Status()],
});

export { Model } from "./model.ts";
export { Message } from "./message.ts";
export { subscriptions } from "./subscriptions.ts";
export { update } from "./update.ts";
export { view } from "./view.ts";
