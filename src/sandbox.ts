/**
 * sandbox — additive seam ...
 */

import { section } from "@earendil-works/pi-durable";
import type { PromptSection } from "@earendil-works/pi-durable";
import { Schema } from "effect";

export const WorkspaceEntrySchema = Schema.Struct({
  path: Schema.String,
  type: Schema.Union([Schema.Literal("file"), Schema.Literal("directory")]),
  size: Schema.optional(Schema.Number),
});
export type WorkspaceEntry = Schema.Schema.Type<typeof WorkspaceEntrySchema>;

export const RunResultSchema = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Number,
});
export type RunResult = Schema.Schema.Type<typeof RunResultSchema>;

export const SearchMatchSchema = Schema.Struct({
  path: Schema.String,
  line: Schema.optional(Schema.Number),
  text: Schema.optional(Schema.String),
});
export type SearchMatch = Schema.Schema.Type<typeof SearchMatchSchema>;

export const SandboxConfigSchema = Schema.Struct({
  rootPath: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  readOnly: Schema.optional(Schema.Boolean),
});
export type SandboxConfig = Schema.Schema.Type<typeof SandboxConfigSchema>;

export interface WorkspaceHandle {
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

export type SandboxFactory = (
  config: SandboxConfig,
) => WorkspaceHandle | Promise<WorkspaceHandle>;

// rest same...
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

class InMemoryWorkspace implements WorkspaceHandle {
  readonly path: string;
  readonly #files = new Map<string, string>();
  readonly #readOnly: boolean;

  constructor(config: SandboxConfig) {
    const parsed = Schema.decodeUnknownSync(SandboxConfigSchema)(config ?? {});
    this.path = parsed.rootPath !== undefined && parsed.rootPath.trim().length > 0
      ? normalizePath(parsed.rootPath)
      : DEFAULT_ROOT;
    this.#readOnly = parsed.readOnly === true;
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

export const inMemorySandbox: SandboxFactory = (config: SandboxConfig) =>
  new InMemoryWorkspace(Schema.decodeUnknownSync(SandboxConfigSchema)(config ?? {}));

export const noopSandboxFactory: SandboxFactory = (config: SandboxConfig) =>
  inMemorySandbox(config);

export function createSandbox(config: SandboxConfig = {}): WorkspaceHandle {
  return new InMemoryWorkspace(Schema.decodeUnknownSync(SandboxConfigSchema)(config ?? {}));
}

export function sandboxProtocol(): string {
  return [
    "Sandbox / own-computer seam (deferred).",
    "A workspace handle exposes one root path plus read, write, list, search, and run helpers.",
    "Treat the workspace as the working directory for artifacts this session produces.",
    "In-memory workspaces are ephemeral and do not survive eviction; containers or remote workspaces provide a real shell.",
    "Route real integrations through Executor rather than assuming local filesystem access.",
  ].join("\n");
}

export const sandboxProtocolSection: PromptSection = section(
  "sandbox-protocol",
  () => sandboxProtocol(),
);