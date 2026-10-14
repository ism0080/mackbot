/**
 * sandbox — additive seam for the deferred "own computer" capability.
 *
 * This module defines the shape of a bot-facing workspace (a root path plus
 * read/write/list/search/run helpers) and a factory that produces one, so later
 * sandbox providers (in-memory, Dynamic Worker isolates, containers, remote
 * homelab `ExecutionEnv`s) can be plugged in without changing call sites. It is
 * deliberately *not* wired into `src/index.ts` or `src/bots.ts`: the sandbox
 * phase is deferred, and this seam exists so it can graduate later without
 * touching the bot registry or the front door.
 *
 * Public API:
 *
 *   import { createSandbox, inMemorySandbox, sandboxProtocol } from "./sandbox.ts";
 *   const workspace = createSandbox({ rootPath: "/workspace" });
 *   // workspace.read / write / list / search / run ...
 *
 * The in-memory implementation is ephemeral and process-local; it is a stand-in
 * for a real provider and exists so the seam can be exercised and tested without
 * any external dependency. `run` is not supported there.
 */

import { section } from "@earendil-works/pi-durable";
import type { PromptSection } from "@earendil-works/pi-durable";

/** A single entry returned by {@link WorkspaceHandle.list}. */
export interface WorkspaceEntry {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly size?: number;
}

/** The result of running a command in a workspace. */
export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** One match returned by {@link WorkspaceHandle.search}. */
export interface SearchMatch {
  readonly path: string;
  readonly line?: number;
  readonly text?: string;
}

/** Configuration for {@link createSandbox} and the built-in providers. */
export interface SandboxConfig {
  /** Root path of the workspace. Defaults to `/workspace` for in-memory. */
  readonly rootPath?: string;
  /** Optional human-readable label (for logs / audit, not behaviour). */
  readonly label?: string;
  /** Whether the workspace is read-only. Advisory; enforced by providers. */
  readonly readOnly?: boolean;
}

/**
 * A handle onto one bot-visible workspace. All paths are interpreted relative
 * to {@link WorkspaceHandle.path} unless they are absolute, in which case they
 * must still resolve inside it.
 */
export interface WorkspaceHandle {
  /** The workspace's root path. */
  readonly path: string;
  read(filePath: string): Promise<string>;
  write(filePath: string, content: string): Promise<void>;
  list(directoryPath?: string): Promise<readonly WorkspaceEntry[]>;
  search(
    query: string,
    options?: { readonly path?: string; readonly limit?: number },
  ): Promise<readonly SearchMatch[]>;
  run(
    command: string,
    options?: { readonly cwd?: string; readonly timeoutMs?: number },
  ): Promise<RunResult>;
}

/** A function that builds a {@link WorkspaceHandle} from a config. */
export type SandboxFactory = (
  config: SandboxConfig,
) => WorkspaceHandle | Promise<WorkspaceHandle>;

const DEFAULT_ROOT = "/workspace";

const normalizePath = (input: string): string => {
  const parts = input.split(/[\\/]+/u).filter((part) => part.length > 0 && part !== ".");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return `/${stack.join("/")}`;
};

const resolvePath = (input: string): string =>
  normalizePath(input.startsWith("/") ? input : `/${input}`);

const childPath = (base: string, head: string): string => {
  if (base === "/") return `/${head}`;
  return `${base}/${head}`;
};

/** In-memory, ephemeral workspace. Process-local; nothing persists across evictions. */
class InMemoryWorkspace implements WorkspaceHandle {
  readonly path: string;
  readonly #files = new Map<string, string>();
  readonly #readOnly: boolean;

  constructor(config: SandboxConfig) {
    this.path = config.rootPath !== undefined && config.rootPath.trim().length > 0
      ? normalizePath(config.rootPath)
      : DEFAULT_ROOT;
    this.#readOnly = config.readOnly === true;
  }

  async read(filePath: string): Promise<string> {
    const resolved = resolvePath(filePath);
    const content = this.#files.get(resolved);
    if (content === undefined) {
      throw new Error(`sandbox: no such file: ${resolved}`);
    }
    return content;
  }

  async write(filePath: string, content: string): Promise<void> {
    if (this.#readOnly) {
      throw new Error("sandbox: workspace is read-only");
    }
    const resolved = resolvePath(filePath);
    if (resolved === "/") {
      throw new Error("sandbox: cannot write the workspace root");
    }
    this.#files.set(resolved, content);
  }

  async list(directoryPath?: string): Promise<readonly WorkspaceEntry[]> {
    const base = directoryPath === undefined ? "/" : resolvePath(directoryPath);
    const prefix = base === "/" ? "/" : `${base}/`;
    const entries = new Map<string, WorkspaceEntry>();
    for (const [filePath, content] of this.#files) {
      if (base !== "/" && filePath !== base && !filePath.startsWith(prefix)) {
        continue;
      }
      const relative = base === "/" ? filePath.slice(1) : filePath.slice(prefix.length);
      if (relative.length === 0) continue;
      const [head] = relative.split("/");
      const fullPath = childPath(base, head);
      if (entries.has(fullPath)) continue;
      const isFile = !relative.includes("/");
      entries.set(fullPath, {
        path: fullPath,
        type: isFile ? "file" : "directory",
        size: isFile ? content.length : undefined,
      });
    }
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async search(
    query: string,
    options?: { readonly path?: string; readonly limit?: number },
  ): Promise<readonly SearchMatch[]> {
    const base = options?.path === undefined ? "/" : resolvePath(options.path);
    const limit = options?.limit !== undefined && options.limit > 0 ? options.limit : 100;
    const prefix = base === "/" ? "/" : `${base}/`;
    const matches: SearchMatch[] = [];
    for (const [filePath, content] of this.#files) {
      if (base !== "/" && filePath !== base && !filePath.startsWith(prefix)) continue;
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.includes(query)) continue;
        matches.push({ path: filePath, line: index + 1, text: line });
        if (matches.length >= limit) return matches;
      }
    }
    return matches;
  }

  async run(): Promise<RunResult> {
    throw new Error("sandbox: command execution is not available in the in-memory workspace");
  }
}

/** Build a process-local, in-memory workspace (ephemeral, no shell). */
export const inMemorySandbox: SandboxFactory = (config: SandboxConfig) =>
  new InMemoryWorkspace(config);

/** Alias used by callers that want an explicitly named factory. */
export const noopSandboxFactory: SandboxFactory = (config: SandboxConfig) =>
  inMemorySandbox(config);

/** Create a workspace handle from `config`, defaulting to the in-memory provider. */
export function createSandbox(config: SandboxConfig = {}): WorkspaceHandle {
  return new InMemoryWorkspace(config);
}

/** Prompt-friendly description of the sandbox seam. */
export function sandboxProtocol(): string {
  return [
    "Sandbox / own-computer seam (deferred).",
    "A workspace handle exposes one root path plus read, write, list, search, and run helpers.",
    "Treat the workspace as the working directory for artifacts this session produces.",
    "In-memory workspaces are ephemeral and do not survive eviction; containers or remote workspaces provide a real shell.",
    "Route real integrations through Executor rather than assuming local filesystem access.",
  ].join("\n");
}

/** The `sandbox-protocol` prompt section, ready to hand to the harness. */
export const sandboxProtocolSection: PromptSection = section(
  "sandbox-protocol",
  () => sandboxProtocol(),
);
