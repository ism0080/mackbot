import { FIXTURE_CHANNELS } from "./fixture.ts";
import { Screen } from "./model.ts";

export const init = () => ({
  model: { screen: Screen.Home(), channels: FIXTURE_CHANNELS },
});

export { Model } from "./model.ts";
export { Message } from "./message.ts";
export { update } from "./update.ts";
export { view } from "./view.ts";
