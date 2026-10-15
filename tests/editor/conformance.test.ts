import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  Client,
  type FetchLike,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { waitFor } from "../helpers.ts";
import { type Editor, removeProjects, startEditor } from "./harness.ts";

// The SDK client against the real editor, in its default (legacy) mode and in `auto` mode (plan D25).

let editor: Editor;

beforeAll(async () => {
  editor = await startEditor();
}, 120_000);

afterAll(async () => {
  await editor?.stop();
  await removeProjects();
});

interface Exchange {
  method: string;
  status: number;
  rpc?: string;
}

const modes = [
  ["default", undefined],
  ["auto", { versionNegotiation: { mode: "auto" as const } }],
] as const;

describe("SDK client conformance", () => {
  for (const [label, options] of modes) {
    test(`${label} mode: connect, list tools, call get_project_info`, async () => {
      const log: Exchange[] = [];
      const logged: FetchLike = async (url, init) => {
        const res = await fetch(url, init);
        let rpc: string | undefined;
        if (typeof init?.body === "string") rpc = JSON.parse(init.body).method;
        log.push({ method: init?.method ?? "GET", status: res.status, rpc });
        return res;
      };
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${editor.port}/mcp`),
        {
          requestInit: { headers: { Authorization: editor.auth } },
          fetch: logged,
        },
      );
      const client = new Client(
        { name: "godot-mcp-conformance", version: "0.0.0" },
        options,
      );
      const errors: unknown[] = [];
      client.onerror = (error) => errors.push(error);
      try {
        await client.connect(transport);
        expect(client.getServerVersion()?.name).toBe("godot-mcp");
        const instructions = client.getInstructions() ?? "";
        expect(instructions.length).toBeGreaterThan(0);
        expect(instructions.length).toBeLessThanOrEqual(2000);

        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toContain("get_project_info");

        const result = await client.callTool({
          name: "get_project_info",
          arguments: {},
        });
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({
          name: "GD Fixture",
          godotVersion: expect.stringMatching(/^4\.7\./),
          addonVersion: "0.1.0",
          mainScene: "res://main.tscn",
          features: ["4.7", "Forward Plus"],
          autoloads: { GameState: "*res://game_state.gd" },
          openScenes: expect.any(Array),
          unsavedScenes: [],
          playingScene: null,
          scanning: expect.any(Boolean),
        });
        expect(
          JSON.parse((result.content as { text: string }[])[0]?.text ?? ""),
        ).toEqual(result.structuredContent);

        // The client opens its GET only after the initialized notification gets 202.
        await waitFor(() =>
          log.some((e) => e.method === "GET") ? true : undefined,
        );
        expect(log).toContainEqual({
          method: "POST",
          status: 202,
          rpc: "notifications/initialized",
        });
        expect(log).toContainEqual({ method: "GET", status: 405 });
        if (label === "auto")
          expect(log[0]).toEqual({
            method: "POST",
            status: 400,
            rpc: "server/discover",
          });
        else expect(log[0]?.rpc).toBe("initialize");
      } finally {
        await client.close();
      }
      expect(errors).toEqual([]);
    }, 30_000);
  }

  test("the editor printed no SCRIPT ERROR", () => {
    expect(editor.output()).not.toContain("SCRIPT ERROR");
  });
});
