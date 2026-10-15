import { expect } from "bun:test";
import { appendFile, cp, readFile, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { copyFixture, repo, waitFor } from "../helpers.ts";

// Drives a real `godot-mono --headless --editor` with the addon enabled (plan D41).

export interface Editor {
  dir: string;
  port: number;
  // The full Authorization header value from headers.json.
  auth: string;
  pid: number;
  output(): string;
  stop(): Promise<void>;
}

export function godotBin(): string {
  const bin = process.env.GODOT_BIN || "godot-mono";
  const found = Bun.which(bin);
  if (found === null)
    throw new Error(`Godot binary "${bin}" not found; set GODOT_BIN`);
  return found;
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string")
    throw new Error("no port");
  return address.port;
}

const projects: string[] = [];
const running = new Set<Launched>();

// Every test file calls this from afterAll (bun test shares this module across files, so a hook
// registered here would run only once). It stops any editor a failed test left running, so it cannot
// write into a directory being removed, then deletes the projects prepareProject made.
export async function removeProjects(): Promise<void> {
  await Promise.all([...running].map((launched) => launched.stop()));
  await Promise.all(
    projects.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

// A temp copy of fixtures/gd with the addon enabled; call removeProjects in afterAll. port: null
// leaves the port setting unset. prefix names the temp directory, for paths that need odd characters.
export async function prepareProject(
  port: number | null,
  prefix?: string,
): Promise<string> {
  const dir = await copyFixture("gd", prefix);
  projects.push(dir);
  await cp(
    join(repo, "addons", "godot_mcp"),
    join(dir, "addons", "godot_mcp"),
    {
      recursive: true,
    },
  );
  let settings = [
    "",
    "[editor]",
    "",
    'run/main_run_args="--headless"',
    "",
    "[editor_plugins]",
    "",
    'enabled=PackedStringArray("res://addons/godot_mcp/plugin.cfg")',
    "",
  ].join("\n");
  if (port !== null) settings += `\n[godot_mcp]\n\nserver/port=${port}\n`;
  await appendFile(join(dir, "project.godot"), settings);
  return dir;
}

export function headersPath(dir: string): string {
  return join(dir, ".godot", "godot_mcp", "headers.json");
}

export async function readAuth(dir: string): Promise<string> {
  const parsed = JSON.parse(await readFile(headersPath(dir), "utf8"));
  return parsed.Authorization as string;
}

export interface Launched {
  pid: number;
  exited: Promise<number>;
  output(): string;
  stop(): Promise<void>;
}

// Spawns the editor in its own process group and captures both streams.
export function launch(dir: string): Launched {
  const child = Bun.spawn(
    [godotBin(), "--headless", "--editor", "--path", dir],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true },
  );
  let output = "";
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const bytes of stream)
      output += decoder.decode(bytes, { stream: true });
  };
  void pump(child.stdout);
  void pump(child.stderr);
  const launched: Launched = {
    pid: child.pid,
    exited: child.exited,
    output: () => output,
    stop: async () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
      await child.exited;
      running.delete(launched);
    },
  };
  running.add(launched);
  return launched;
}

// Resolves once an unauthenticated POST gets 401, which proves the whole guard chain is up.
export async function waitForServer(
  port: number,
  launched: Launched,
): Promise<void> {
  let exited = false;
  void launched.exited.then(() => {
    exited = true;
  });
  await waitFor(async () => {
    if (exited)
      throw new Error(`editor exited before serving:\n${launched.output()}`);
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
    }).catch(() => undefined);
    return res?.status === 401 ? true : undefined;
  }, 90_000);
}

export async function startEditor(
  opts: { dir?: string; port?: number } = {},
): Promise<Editor> {
  const port = opts.port ?? (await freePort());
  const dir = opts.dir ?? (await prepareProject(port));
  const launched = launch(dir);
  try {
    await waitForServer(port, launched);
  } catch (err) {
    await launched.stop();
    throw new Error(`${err}\neditor output:\n${launched.output()}`);
  }
  return {
    dir,
    port,
    auth: await readAuth(dir),
    pid: launched.pid,
    output: launched.output,
    stop: launched.stop,
  };
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// Sends raw bytes in chunks, `gapMs` apart, and resolves with the response once it is
// complete or the server closes. Write errors after the server answers are expected.
export function rawRequest(
  port: number,
  chunks: (string | Uint8Array)[],
  gapMs = 0,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = () => {
      if (settled) return;
      const parsed = parseResponse(received);
      if (parsed === undefined)
        reject(new Error(`incomplete response: ${received.toString()}`));
      else resolve(parsed);
      settled = true;
      socket.destroy();
    };
    socket.on("data", (data: Buffer) => {
      received = Buffer.concat([received, data]);
      if (parseResponse(received) !== undefined) finish();
    });
    socket.on("close", finish);
    // EPIPE or ECONNRESET once the server has answered early; "close" follows and finish() judges the response.
    socket.on("error", (err) => void err);
    socket.on("connect", async () => {
      for (const chunk of chunks) {
        if (settled || socket.destroyed) return;
        socket.write(chunk);
        if (gapMs > 0) await Bun.sleep(gapMs);
      }
    });
  });
}

function parseResponse(bytes: Buffer): RawResponse | undefined {
  const end = bytes.indexOf("\r\n\r\n");
  if (end === -1) return undefined;
  const [statusLine = "", ...lines] = bytes
    .subarray(0, end)
    .toString()
    .split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  const body = bytes.subarray(end + 4);
  if (body.length < Number(headers["content-length"] ?? 0)) return undefined;
  return {
    status: Number(statusLine.split(" ")[1]),
    headers,
    body: body.toString(),
  };
}

// A request with the headers a well-behaved client sends; pass a header as null to omit it.
export function buildRequest(
  editor: Pick<Editor, "port" | "auth">,
  opts: {
    method?: string;
    path?: string;
    headers?: Record<string, string | null>;
    body?: string;
  } = {},
): string {
  const body = opts.body ?? "";
  const headers: Record<string, string | null> = {
    Host: `127.0.0.1:${editor.port}`,
    Authorization: editor.auth,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "Content-Length": String(Buffer.byteLength(body)),
    ...opts.headers,
  };
  const lines = [`${opts.method ?? "POST"} ${opts.path ?? "/mcp"} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers))
    if (value !== null) lines.push(`${name}: ${value}`);
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

export function rpc(method: string, params: unknown = {}, id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

export interface ToolResult {
  isError: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: tool outputs are checked field by field in each test
  structuredContent: any;
}

// One tools/call over fetch; the JSON-RPC layer must succeed, a tool failure comes back as isError.
export async function callTool(
  editor: Pick<Editor, "port" | "auth">,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const res = await fetch(`http://127.0.0.1:${editor.port}/mcp`, {
    method: "POST",
    headers: {
      Authorization: editor.auth,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: rpc("tools/call", { name, arguments: args }),
  });
  const parsed = await res.json();
  if (parsed.error !== undefined)
    throw new Error(`${name}: JSON-RPC error ${JSON.stringify(parsed.error)}`);
  return parsed.result as ToolResult;
}

// A tool call that must succeed; returns its structured content.
export async function ok(
  editor: Pick<Editor, "port" | "auth">,
  name: string,
  args: Record<string, unknown> = {},
  // biome-ignore lint/suspicious/noExplicitAny: tool outputs are checked field by field in each test
): Promise<any> {
  const result = await callTool(editor, name, args);
  expect(result.structuredContent.error).toBeUndefined();
  expect(result.isError).toBe(false);
  return result.structuredContent;
}

// The error code of a call that must fail as a tool error.
export async function failure(
  editor: Pick<Editor, "port" | "auth">,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = await callTool(editor, name, args);
  expect(result.isError).toBe(true);
  return result.structuredContent.error.code;
}

let sceneCounter = 0;

// A new empty scene (root "Root", a Node2D) as the edited scene; returns its res:// path.
export async function freshScene(editor: Editor): Promise<string> {
  const path = `res://t${++sceneCounter}.tscn`;
  await ok(editor, "create_scene", {
    path,
    rootType: "Node2D",
    rootName: "Root",
  });
  return path;
}

// Saves the edited scene and returns the file's text.
export async function saved(editor: Editor, path: string): Promise<string> {
  await ok(editor, "save_scene");
  return await readFile(join(editor.dir, path.replace("res://", "")), "utf8");
}
