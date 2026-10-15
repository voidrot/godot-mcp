import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const repo = join(import.meta.dir, "..");
const server = join(repo, "src", "server.ts");
const fixture = join(repo, "fixtures", "gd");

describe("stdio server", () => {
  test("lists tools and calls godot_project_info on the GDScript fixture", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [server],
      cwd: repo,
    });
    const errors: Error[] = [];
    transport.onerror = (err: Error) => errors.push(err);
    const client = new Client({ name: "godot-mcp-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("godot_project_info");

      const result = await client.callTool({
        name: "godot_project_info",
        arguments: { projectPath: fixture },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        name: "GD Fixture",
        mainScene: "res://main.tscn",
        features: ["4.7", "Forward Plus"],
        autoloads: { GameState: "*res://game_state.gd" },
        dotnet: null,
        godot: {
          path: expect.any(String),
          version: expect.stringContaining("4.7"),
        },
      });
    } finally {
      await client.close();
    }
    expect(errors).toEqual([]);
  });

  test("a bad projectPath returns an error result and the server survives", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [server],
      cwd: repo,
    });
    const client = new Client({ name: "godot-mcp-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      for (const projectPath of ["relative/path", "/nonexistent/project"]) {
        const result = await client.callTool({
          name: "godot_project_info",
          arguments: { projectPath },
        });
        expect(result.isError).toBe(true);
      }
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("godot_project_info");
    } finally {
      await client.close();
    }
  });

  test("stdout carries only JSON-RPC frames", async () => {
    const proc = Bun.spawn([process.execPath, server], {
      cwd: repo,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    try {
      proc.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "raw", version: "0" },
          },
        })}\n`,
      );
      proc.stdin.flush();
      const lines = await readLinesUntilId(proc.stdout, 1);
      for (const line of lines) {
        expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
      }
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 20_000);
});

// Returns complete stdout lines up to and including the response with the given id.
async function readLinesUntilId(
  stream: ReadableStream<Uint8Array>,
  id: number,
): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buffered = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error("server stdout closed before the response");
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      if (line === "") continue;
      lines.push(line);
      if (JSON.parse(line).id === id) {
        reader.releaseLock();
        return lines;
      }
    }
  }
}
