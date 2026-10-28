/**
 * route — the URL is the screen.
 *
 * A transcript is a place, not a transient view: reloading while one is open
 * has to land back on that chat, and the browser's back button has to work.
 * Foldkit owns the URL listeners through `routing` in `entry.ts`; this module
 * owns the mapping between a pathname and the Model's `Screen`, plus the
 * Commands that push a URL for an in-app navigation and that open one that
 * leaves the app.
 */
import * as Schema from "effect/Schema";
import { Effect } from "effect";
import { Command } from "foldkit";
import { openUrl, pushUrl } from "foldkit/navigation";

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

/**
 * Open a URL that leaves the app. Foldkit intercepts every anchor click and
 * asks the app what it means rather than letting the browser follow the href,
 * so an external link only opens if the app opens it — and it opens in a new
 * browsing context, leaving the transcript the reader was on in place.
 */
export const OpenLink = Command.define("OpenLink", {
  args: { href: Schema.String },
  messages: [Message.LinkOpened],
  execute: ({ href }) => openUrl(href).pipe(Effect.as(Message.LinkOpened({ href }))),
});
