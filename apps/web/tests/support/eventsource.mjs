/*
 * happy-dom ships no EventSource, while the app's transport is the browser's.
 * This is that transport for the test DOM: it fetches the stub's real
 * `text/event-stream`, parses the SSE wire format, and dispatches messages the
 * way EventSource would, including the `id:` line as `lastEventId`.
 *
 * It deliberately does not auto-reconnect. The app's Subscription owns
 * reconnection, so a test can observe the cursor the next connection carries.
 */
export class StubEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.lastEventId = "";
    this.onmessage = null;
    this.onerror = null;
    this.closed = false;
    this.listeners = new Map();
    this.controller = new AbortController();
    this.start();
  }

  addEventListener(type, listener) {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
    this.controller.abort();
  }

  emit(type, data) {
    const event = { type, lastEventId: this.lastEventId };
    if (data !== undefined) event.data = data;
    if (type === "message" && this.onmessage !== null) this.onmessage(event);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  fail() {
    this.readyState = 2;
    this.emit("error");
  }

  dispatch(block) {
    let type = "message";
    let data = "";
    let id;
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const name = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (name === "event") type = value;
      else if (name === "data") data = data === "" ? value : `${data}\n${value}`;
      else if (name === "id") id = value;
    }
    if (id !== undefined) this.lastEventId = id;
    this.emit(type, data);
  }

  async start() {
    try {
      const response = await fetch(this.url, {
        headers: { accept: "text/event-stream" },
        signal: this.controller.signal,
      });
      if (!response.ok || response.body === null) {
        if (!this.closed) this.fail();
        return;
      }
      this.readyState = 1;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          if (block.trim() !== "") this.dispatch(block);
        }
      }
      if (!this.closed) this.fail();
    } catch {
      if (!this.closed) this.fail();
    }
  }
}
