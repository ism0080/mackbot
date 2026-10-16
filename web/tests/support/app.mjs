/*
 * Boot the built bundle in a DOM against a stub origin, and expose the handful
 * of assertions the render tests share.
 *
 * The bundle is what `bun run build` produced. Its API base defaults to
 * same-origin, so pointing the DOM's URL at the stub is what makes the app's
 * requests land on the stub over real HTTP.
 */
import { readdirSync, readFileSync } from "node:fs";
import { Window } from "happy-dom";

const ASSETS = new URL("../../dist/assets/", import.meta.url);
const files = readdirSync(ASSETS);
const bundle = new URL(files.find((name) => name.endsWith(".js")), ASSETS);
const css = readFileSync(
  new URL(files.find((name) => name.endsWith(".css")), ASSETS),
  "utf8",
);

export const boot = async (origin) => {
  const window = new Window({ url: `${origin}/` });
  const globals = globalThis;
  globals.window = window;
  globals.self = window;
  globals.document = window.document;
  for (const key of [
    "navigator",
    "location",
    "history",
    "MutationObserver",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "matchMedia",
    "getComputedStyle",
    "CSSStyleSheet",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "CustomEvent",
    "EventTarget",
    "MouseEvent",
    "DocumentFragment",
    "Text",
    "Comment",
    "SVGElement",
    "XMLSerializer",
    "DOMParser",
    "performance",
  ]) {
    const value = window[key];
    if (value !== undefined) globals[key] = value;
  }

  window.document.body.innerHTML = '<div id="root"></div>';
  window.document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);

  const pageErrors = [];
  window.addEventListener("error", (event) => pageErrors.push(event.message));
  window.addEventListener("unhandledrejection", (event) => pageErrors.push(String(event.reason)));

  await import(bundle.href);

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const query = (selector) => window.document.querySelector(selector);
  const all = (selector) => [...window.document.querySelectorAll(selector)];
  const text = (selector) => query(selector)?.textContent?.trim() ?? "";
  const display = (selector) => {
    const element = query(selector);
    return element === null ? "missing" : window.getComputedStyle(element).display;
  };

  /** Poll until `predicate` holds, so a test never races a real fetch. */
  const waitFor = async (predicate, label, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await settle();
    }
    console.log(`FAIL waitFor: ${label}`);
    return false;
  };

  return {
    window,
    pageErrors,
    settle,
    query,
    all,
    text,
    display,
    waitFor,
    click: (node) => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
  };
};

export const makeChecker = () => {
  const failures = [];
  const check = (label, condition, detail) => {
    if (condition) {
      console.log(`ok   ${label}`);
      return;
    }
    failures.push(label);
    console.log(`FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  };
  const finish = () => {
    console.log(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} failed`);
    process.exit(failures.length === 0 ? 0 : 1);
  };
  return { check, finish, failures };
};
