/*
 * Headless render check for the built app.
 *
 * The desktop browser is the real verification; this exists so the same four
 * interactions can be re-run without one. It boots the production bundle (which
 * is what `bun run build` produced) in a DOM and drives it by clicking.
 */
import { readdirSync, readFileSync } from "node:fs";
import { Window } from "happy-dom";

const ASSETS = new URL("../dist/assets/", import.meta.url);
const files = readdirSync(ASSETS);
const bundle = new URL(files.find((name) => name.endsWith(".js")), ASSETS);
const css = readFileSync(
  new URL(files.find((name) => name.endsWith(".css")), ASSETS),
  "utf8",
);

const window = new Window({ url: "http://localhost:5273/" });
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

const failures = [];
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`ok   ${label}`);
    return;
  }
  failures.push(label);
  console.log(`FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
};

const errors = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) =>
  errors.push(String(event.reason)),
);

await import(bundle.href);
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
await settle();

const query = (selector) => window.document.querySelector(selector);
const all = (selector) => [...window.document.querySelectorAll(selector)];
const text = (selector) => query(selector)?.textContent?.trim() ?? "";
const display = (selector) => {
  const element = query(selector);
  return element === null ? "missing" : window.getComputedStyle(element).display;
};

// 1 — the triage home renders all three sections with the fixture data.
check("home has the tall header", text(".hdr.tall h1") === "Needs you");
check("header count matches the fixture", text(".hdr.tall .hdr-sub") === "2 bots · 1 blocked · 1 running");
check(
  "blocked section is shown and the all-clear is not",
  display('[data-group="blocked"]') !== "none" &&
    display('[data-group="empty"]') === "none",
);
check("running section is shown", display('[data-group="running"]') !== "none");
check("recent section is shown", display('[data-group="recent"]') !== "none");
check("one approval card", all("[data-approval]").length === 1);
check("approval names the tool", text(".ap-tool") === "botmail.send");
check("running row is derived from activeRun", text(".runit .rt") === "Reconciling March invoices");
check(
  "since-you-last-looked lists one entry per bot",
  all(".doneitem").length === 2 &&
    all(".doneitem .rt").map((node) => node.textContent.trim()).join("|") ===
      "Calendar hold moved to Thursday 10:00.|Q3 kickoff notes, 4 decisions",
);

// 2 — the draft preview expands on click.
const draft = query("details.ap-draft");
check("draft is closed", draft.open === false);
check("draft body is in the DOM", query(".ap-draft pre").textContent.includes("Hi Dana,"));
query(".ap-draft summary").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await settle();
check("draft expands", draft.open === true);

// 3 — the transcript is reachable from an item.
const scribeRow = all(".doneitem").find(
  (node) => node.querySelector(".rmeta").textContent.startsWith("Scribe"),
);
scribeRow.click();
await settle();
check("transcript opens", text(".hdr h1") === "Scribe");
check("transcript renders the model label", text(".hdr .hdr-sub") === "longcat-2.5-preview-free");
check("transcript renders session entries", all("[data-entry]").length === 3);
check(
  "transcript shows no approval reference for scribe",
  all(".ap-ref").length === 0,
);
query(".icon").click();
await settle();
check("back returns to the home", text(".hdr.tall h1") === "Needs you");

// 4 — the approval is reachable from the home and the transcript shows it too.
query(".ap-review").click();
await settle();
check("review opens the owning bot's transcript", text(".hdr h1") === "Hermes");
check("transcript references the pending approval", all(".ap-ref").length === 1);
check("transcript shows the in-flight run", text(".live").includes("Reconciling March invoices"));
query(".icon").click();
await settle();

// 5 — Allow retires the approval everywhere at once.
query(".btn.primary").click();
await settle();
check("headline goes all-clear", text(".hdr.tall h1") === "Nothing needs you");
check("header count drops the blocked one", text(".hdr.tall .hdr-sub") === "2 bots · 0 blocked · 1 running");
check("blocked section collapses", display('[data-group="blocked"]') === "none");
check("all-clear section appears", display('[data-group="empty"]') !== "none");
check("all-clear note names the busy bot", text(".empty p").includes("Hermes"));
check("no approval card remains", all("[data-approval]").length === 0);
check("running section survives", text(".runit .rt") === "Reconciling March invoices");

query(".doneitem").click();
await settle();
check("transcript for the approved bot opens", text(".hdr h1") === "Hermes");
check("approval reference is gone from the transcript", all(".ap-ref").length === 0);

check("no console errors", errors.length === 0, errors.join("; "));

console.log(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
