import { relative } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { runGodot, runResultSchema } from "../godot/runner.ts";
import { withProjectLock } from "../lock.ts";
import { resolveProjectDir, resolveResPath } from "../paths.ts";
import { importArgs } from "./import.ts";
import { dotnetInfo } from "./project.ts";
import { structured } from "./result.ts";

const inputSchema = z.object({
  projectPath: z
    .string()
    .describe("Absolute path to the Godot project directory"),
  scene: z
    .string()
    .optional()
    .describe("Scene to run (res:// or project-relative). Excludes `script`."),
  script: z
    .string()
    .optional()
    .describe(
      "Script to run with -s, normally extending SceneTree. Excludes `scene`.",
    ),
  frames: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Quit after this many iterations. Omit to run until the script quits or the timeout hits.",
    ),
  build: z
    .boolean()
    .optional()
    .describe(
      "Build C# first. Defaults to true when the project has a csproj.",
    ),
  import: z
    .boolean()
    .default(true)
    .describe("Import assets first. Cheap when nothing changed."),
  userArgs: z
    .array(z.string())
    .optional()
    .describe("Passed to the game after `--`."),
  timeoutSec: z.number().int().min(1).default(60).describe("Per phase."),
});

const outputSchema = runResultSchema.extend({
  phases: z.object({
    build: runResultSchema.optional(),
    import: runResultSchema.optional(),
  }),
});

type Phases = z.infer<typeof outputSchema>["phases"];

export function registerRun(server: McpServer): void {
  server.registerTool(
    "godot_run",
    {
      title: "Run a Godot scene or script",
      description:
        "Run [build] → [import] → the project headless, with captured output and parsed errors. A failed phase stops the run and its result is returned. Godot exits 0 after script errors, so check `ok`.",
      inputSchema,
      outputSchema,
    },
    async (input, ctx) => {
      if (input.scene !== undefined && input.script !== undefined)
        throw new Error("scene and script are mutually exclusive");
      const root = await resolveProjectDir(input.projectPath);
      const hasCsproj = (await dotnetInfo(root, null)) !== null;
      const build = input.build ?? hasCsproj;
      if (build && hasCsproj)
        throw new Error(
          "building C# is not available until godot_build lands (slice 3); pass build: false to run without it",
        );
      if (build)
        throw new Error("build requested but the project has no *.csproj");

      const args = ["--headless", "--path", root];
      if (input.scene !== undefined)
        args.push(await resPath(root, input.scene));
      if (input.script !== undefined)
        args.push("-s", await resPath(root, input.script));
      if (input.frames !== undefined)
        args.push("--quit-after", String(input.frames));
      if (input.userArgs?.length) args.push("--", ...input.userArgs);

      const timeoutMs = input.timeoutSec * 1000;
      const phase = { timeoutMs, signal: ctx.mcpReq.signal };
      const phases: Phases = {};
      const result = await withProjectLock(root, timeoutMs, async () => {
        if (input.import) {
          phases.import = await runGodot(root, importArgs(root), phase);
          if (!phases.import.ok) return phases.import;
        }
        return runGodot(root, args, phase);
      });
      return structured({ ...result, phases });
    },
  );
}

async function resPath(root: string, path: string): Promise<string> {
  return `res://${relative(root, await resolveResPath(root, path))}`;
}
