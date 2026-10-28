/**
 * route — the URL is the screen.
 *
 * A transcript is a place, not a transient view: reloading while one is open
 * has to land back on that chat, and the browser's back button has to work.
 * Foldkit owns the URL listeners through `routing` in `entry.ts`; this module
 * owns the mapping between a pathname and the Model's `Screen`, plus the one
 * Command that pushes a new URL for an in-app navigation.
 */
import * as Schema from "effect/Schema";
import { Effect } from "effect";
import { Command } from "foldkit";
import { pushUrl } from "foldkit/navigation";

import { Message } from "./message.ts";
import { Screen } from "./model.ts";
import type { Screen as ScreenType } from "./model.ts";

const CHAT_PATH = /^\/chat\/([^/]+)\/?$/u;

/** The pathname a screen is served at. */
export const pathOf = (screen: ScreenType): string =>
  Screen.match(screen, {
    Home: () => "/",
    Transcript: ({ bot }) => `/chat/${encodeURIComponent(bot)}`,
    NewChat: () => "/new",
    Bots: () => "/bots",
  });

/** The screen a pathname names. An unknown path is the home, not a crash. */
export const screenOfPath = (pathname: string): ScreenType => {
  const chat = CHAT_PATH.exec(pathname);
  if (chat !== null) {
    try {
      return Screen.Transcript({ bot: decodeURIComponent(chat[1]!) });
    } catch {
      return Screen.Home();
    }
  }
  if (pathname === "/new") return Screen.NewChat();
  if (pathname === "/bots") return Screen.Bots();
  return Screen.Home();
};

/**
 * Push the screen's URL. The update has already chosen the screen; this only
 * makes the address bar agree, so a reload or a shared link lands there too.
 */
export const Navigate = Command.define("Navigate", {
  args: { path: Schema.String },
  messages: [Message.Navigated],
  execute: ({ path }) => pushUrl(path).pipe(Effect.as(Message.Navigated())),
});
