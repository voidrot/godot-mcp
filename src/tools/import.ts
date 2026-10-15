import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { runGodot, runResultSchema } from "../godot/runner.ts";
import { withProjectLock } from "../lock.ts";
import { resolveProjectDir } from "../paths.ts";
import { structured } from "./result.ts";

const inputSchema = z.object({
  projectPath: z
    .string()
    .describe("Absolute path to the Godot project directory"),
  timeoutSec: z.number().int().min(1).default(120),
});

export const importArgs = (root: string) => [
  "--headless",
  "--path",
  root,
  "--import",
];

export function registerImport(server: McpServer): void {
  server.registerTool(
    "godot_import",
    {
      title: "Import Godot assets",
      description:
        "Run `godot --headless --import` on the project, so imported assets are current. Parses engine errors into diagnostics.",
      inputSchema,
      outputSchema: runResultSchema,
    },
    async ({ projectPath, timeoutSec }, ctx) => {
      const root = await resolveProjectDir(projectPath);
      const timeoutMs = timeoutSec * 1000;
      const result = await withProjectLock(root, timeoutMs, () =>
        runGodot(root, importArgs(root), {
          timeoutMs,
          signal: ctx.mcpReq.signal,
        }),
      );
      return structured(result);
    },
  );
}
