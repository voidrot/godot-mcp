import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { waitFor } from "../helpers.ts";
import {
  buildRequest,
  type Editor,
  headersPath,
  launch,
  prepareProject,
  rawRequest,
  readAuth,
  rpc,
  startEditor,
  waitForServer,
} from "./harness.ts";

// Raw HTTP against the editor's endpoint: guards (D28), JSON-RPC handling (D25), framing
// and limits (D27), and the token and port files (D29, D30).

let editor: Editor;

beforeAll(async () => {
  editor = await startEditor();
}, 120_000);

afterAll(async () => {
  await editor?.stop();
});

type RequestOptions = Parameters<typeof buildRequest>[1];

const send = (opts: RequestOptions) =>
  rawRequest(editor.port, [buildRequest(editor, opts)]);

const ping = rpc("ping");

function rpcError(body: string): { id: unknown; code: number; data?: unknown } {
  const parsed = JSON.parse(body);
  return { id: parsed.id, code: parsed.error?.code, data: parsed.error?.data };
}

describe("guards", () => {
  test("a bad Origin gets 403", async () => {
    const res = await send({
      headers: { Origin: "http://evil.example" },
      body: ping,
    });
    expect(res.status).toBe(403);
  });

  test("no Origin, or a loopback Origin, succeeds", async () => {
    expect((await send({ body: ping })).status).toBe(200);
    const res = await send({
      headers: { Origin: `http://localhost:${editor.port}` },
      body: ping,
    });
    expect(res.status).toBe(200);
  });

  test("a bad Host gets 403", async () => {
    const res = await send({
      headers: { Host: `evil.example:${editor.port}` },
      body: ping,
    });
    expect(res.status).toBe(403);
  });

  test("a missing token gets 401 with WWW-Authenticate", async () => {
    const res = await send({ headers: { Authorization: null }, body: ping });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
  });

  test("a wrong token gets 401", async () => {
    const res = await send({
      headers: { Authorization: `Bearer ${"0".repeat(64)}` },
      body: ping,
    });
    expect(res.status).toBe(401);
  });

  test("a 2 MB body gets 413", async () => {
    const res = await send({ body: "x".repeat(2 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  test("headers over 16 KB get 431", async () => {
    const res = await send({
      headers: { "X-Pad": "a".repeat(17 * 1024) },
      body: ping,
    });
    expect(res.status).toBe(431);
  });

  test("no Content-Length gets 411", async () => {
    const res = await send({ headers: { "Content-Length": null } });
    expect(res.status).toBe(411);
  });

  test("a chunked body gets 411", async () => {
    const res = await send({
      headers: { "Content-Length": null, "Transfer-Encoding": "chunked" },
      body: `${ping.length.toString(16)}\r\n${ping}\r\n0\r\n\r\n`,
    });
    expect(res.status).toBe(411);
  });

  test("text/plain gets 415", async () => {
    const res = await send({
      headers: { "Content-Type": "text/plain" },
      body: ping,
    });
    expect(res.status).toBe(415);
  });

  test("GET and DELETE get 405 with Allow: POST", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await send({ method, headers: { Authorization: null } });
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe("POST");
    }
  });

  test("/other gets 404", async () => {
    expect((await send({ path: "/other", body: ping })).status).toBe(404);
  });
});

describe("JSON-RPC", () => {
  test("bad JSON gets -32700", async () => {
    const res = await send({ body: "{nope" });
    expect(res.status).toBe(400);
    expect(rpcError(res.body).code).toBe(-32700);
  });

  test("an array gets -32600", async () => {
    const res = await send({ body: `[${ping}]` });
    expect(res.status).toBe(400);
    expect(rpcError(res.body).code).toBe(-32600);
  });

  test("a missing jsonrpc gets -32600", async () => {
    const res = await send({ body: JSON.stringify({ id: 1, method: "ping" }) });
    expect(res.status).toBe(400);
    expect(rpcError(res.body).code).toBe(-32600);
  });

  test("an unknown method gets 200 with -32601", async () => {
    const res = await send({ body: rpc("nope/nope") });
    expect(res.status).toBe(200);
    expect(rpcError(res.body)).toMatchObject({ id: 1, code: -32601 });
  });

  test("server/discover with a legacy header gets -32601", async () => {
    const res = await send({
      headers: { "MCP-Protocol-Version": "2025-11-25" },
      body: rpc("server/discover"),
    });
    expect(res.status).toBe(200);
    expect(rpcError(res.body).code).toBe(-32601);
  });

  test("the auto probe gets 400 with the supported versions", async () => {
    const res = await send({
      headers: { "MCP-Protocol-Version": "2026-07-28" },
      body: rpc(
        "server/discover",
        { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
        7,
      ),
    });
    expect(res.status).toBe(400);
    expect(rpcError(res.body)).toEqual({
      id: 7,
      code: -32600,
      data: {
        supported: ["2025-11-25", "2025-06-18", "2025-03-26"],
        requested: "2026-07-28",
      },
    });
  });

  test("a bad version header gets 400; no header succeeds", async () => {
    const bad = await send({
      headers: { "MCP-Protocol-Version": "1999-01-01" },
      body: ping,
    });
    expect(bad.status).toBe(400);
    const none = await send({ body: ping });
    expect(none.status).toBe(200);
    expect(JSON.parse(none.body)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
  });

  test("a whole-number id is echoed as an integer", async () => {
    const res = await send({ body: ping });
    expect(res.body).toContain('"id":1,');
    expect(res.body).not.toContain("1.0");
  });

  test("a non-string tool name gets a prompt -32602 and frees its slot", async () => {
    // More requests than there are peer slots, so a stranded peer would lock the endpoint.
    for (let i = 0; i < 5; i++) {
      const res = await send({
        body: rpc("tools/call", { name: [], arguments: {} }),
      });
      expect(res.status).toBe(200);
      expect(rpcError(res.body).code).toBe(-32602);
    }
    const ok = await send({
      body: rpc("tools/call", { name: "get_project_info", arguments: {} }),
    });
    expect(JSON.parse(ok.body).result.isError).toBe(false);
  });

  test("header bytes outside printable ASCII get 400 before any decoding", async () => {
    const request = Buffer.concat([
      Buffer.from(
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${editor.port}\r\nX-Bad: `,
      ),
      Buffer.alloc(64, 0xff),
      Buffer.from("\r\nContent-Length: 0\r\n\r\n"),
    ]);
    const res = await rawRequest(editor.port, [request]);
    expect(res.status).toBe(400);
    await Bun.sleep(200);
    expect(editor.output()).not.toMatch(/unicode/i);
  });

  test("a notification and a client response get 202 with an empty body", async () => {
    for (const body of [
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 5, result: {} }),
    ]) {
      const res = await send({ body });
      expect(res.status).toBe(202);
      expect(res.body).toBe("");
      expect(res.headers["content-length"]).toBe("0");
    }
  });

  test("tool arguments outside the schema get -32602", async () => {
    const res = await send({
      body: rpc("tools/call", {
        name: "get_project_info",
        arguments: { bogus: 1 },
      }),
    });
    expect(rpcError(res.body).code).toBe(-32602);
    const unknown = await send({
      body: rpc("tools/call", { name: "no_such_tool", arguments: {} }),
    });
    expect(rpcError(unknown.body).code).toBe(-32602);
  });
});

describe("framing and peers", () => {
  test("a body split across writes is served", async () => {
    const request = buildRequest(editor, { body: ping });
    const cut = request.length - 4;
    const res = await rawRequest(
      editor.port,
      [request.slice(0, cut), request.slice(cut)],
      300,
    );
    expect(res.status).toBe(200);
  });

  test("dribbled headers are served", async () => {
    const request = buildRequest(editor, { body: ping });
    const chunks = request.match(/[\s\S]{1,8}/g) ?? [];
    const res = await rawRequest(editor.port, chunks, 5);
    expect(res.status).toBe(200);
  });

  test("a stalled request gets 408 at 5 s", async () => {
    const started = Date.now();
    const res = await rawRequest(editor.port, [
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${editor.port}\r\n`,
    ]);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(408);
    expect(elapsed).toBeGreaterThanOrEqual(4900);
    expect(elapsed).toBeLessThan(7000);
  }, 15_000);

  test("a fifth peer is closed", async () => {
    const open = (): Promise<Socket> =>
      new Promise((resolve, reject) => {
        const socket = connect(editor.port, "127.0.0.1", () => resolve(socket));
        socket.on("error", reject);
      });
    await Bun.sleep(500); // let peers from earlier tests close
    const held = [await open(), await open(), await open(), await open()];
    try {
      await Bun.sleep(200); // let the editor accept all four
      expect(held.every((socket) => socket.readyState === "open")).toBe(true);
      const fifth = await open();
      let data = "";
      fifth.on("data", (chunk) => {
        data += chunk;
      });
      await new Promise((resolve) => fifth.on("close", resolve));
      expect(data).toBe("");
    } finally {
      for (const socket of held) socket.destroy();
    }
    // The slots free up once the editor sees the held peers disconnect; until then a probe is a fifth peer too.
    await waitFor(async () => {
      const res = await send({ body: ping }).catch(() => undefined);
      return res?.status === 200 ? true : undefined;
    });
  }, 15_000);
});

describe("token and port files", () => {
  test("headers.json is 0600, holds a 64-hex token, and leaves no .tmp", async () => {
    const file = headersPath(editor.dir);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
    expect(editor.auth).toMatch(/^Bearer [0-9a-f]{64}$/);
    const names = await readdir(dirname(file));
    expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test(".godot/godot_mcp/.gitignore ignores everything", async () => {
    const text = await readFile(
      join(editor.dir, ".godot", "godot_mcp", ".gitignore"),
      "utf8",
    );
    expect(text).toBe("*\n");
  });

  test("a second editor on the same port leaves the token unchanged", async () => {
    const second = launch(editor.dir);
    try {
      await waitFor(
        () =>
          second.output().includes(`cannot listen on 127.0.0.1:${editor.port}`)
            ? true
            : undefined,
        90_000,
      );
      expect(await readAuth(editor.dir)).toBe(editor.auth);
      expect((await send({ body: ping })).status).toBe(200);
      expect(second.output()).not.toContain("SCRIPT ERROR");
    } finally {
      await second.stop();
    }
  }, 120_000);

  test("with the port setting missing, the plugin picks and saves one in 6550-6649", async () => {
    const dir = await prepareProject(null);
    const launched = launch(dir);
    try {
      const port = await waitFor(async () => {
        const text = await readFile(join(dir, "project.godot"), "utf8");
        const match = text.match(/^server\/port=(\d+)$/m);
        return match ? Number(match[1]) : undefined;
      }, 90_000);
      expect(port).toBeGreaterThanOrEqual(6550);
      expect(port).toBeLessThanOrEqual(6649);
      await waitForServer(port, launched);
      const auth = await readAuth(dir);
      const res = await rawRequest(port, [
        buildRequest({ port, auth }, { body: ping }),
      ]);
      expect(res.status).toBe(200);
      expect(launched.output()).not.toContain("SCRIPT ERROR");
    } finally {
      await launched.stop();
    }
  }, 120_000);

  test("the token changes on restart", async () => {
    const before = editor.auth;
    await editor.stop();
    expect(editor.output()).not.toContain("SCRIPT ERROR");
    editor = await startEditor({ dir: editor.dir, port: editor.port });
    expect(editor.auth).toMatch(/^Bearer [0-9a-f]{64}$/);
    expect(editor.auth).not.toBe(before);
    const names = await readdir(dirname(headersPath(editor.dir)));
    expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
  }, 120_000);

  test("the editor printed no SCRIPT ERROR", () => {
    expect(editor.output()).not.toContain("SCRIPT ERROR");
  });
});
