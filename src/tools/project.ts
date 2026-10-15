import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { godotVersion, resolveGodotBin } from "../godot/binary.ts";
import { type ProjectValue, parseProjectFile } from "../godot/project-file.ts";
import { resolveProjectDir } from "../paths.ts";
import { structured } from "./result.ts";

const inputSchema = z.object({
  projectPath: z
    .string()
    .describe(
      "Absolute path to the Godot project directory (contains project.godot)",
    ),
});

const outputSchema = z.object({
  name: z.string().nullable(),
  mainScene: z.string().nullable(),
  features: z.array(z.string()),
  autoloads: z.record(z.string(), z.string()),
  dotnet: z.object({ assemblyName: z.string(), csproj: z.string() }).nullable(),
  godot: z.object({ path: z.string(), version: z.string() }),
});

export type ProjectInfo = z.infer<typeof outputSchema>;

export async function projectInfo(projectPath: string): Promise<ProjectInfo> {
  const root = await resolveProjectDir(projectPath);
  const file = parseProjectFile(
    await readFile(join(root, "project.godot"), "utf8"),
  );
  const application = file.application ?? {};
  const dotnetSection = file.dotnet ?? {};

  const bin = resolveGodotBin();
  return {
    name: asString(application["config/name"], "config/name"),
    mainScene: asString(application["run/main_scene"], "run/main_scene"),
    features: asStringArray(application["config/features"], "config/features"),
    autoloads: asStringRecord(file.autoload ?? {}),
    dotnet: await dotnetInfo(
      root,
      asString(dotnetSection["project/assembly_name"], "project/assembly_name"),
    ),
    godot: { path: bin, version: await godotVersion(bin) },
  };
}

export async function dotnetInfo(
  root: string,
  assemblyName: string | null,
): Promise<ProjectInfo["dotnet"]> {
  const csprojs = (await readdir(root)).filter((f) => f.endsWith(".csproj"));
  if (csprojs.length === 0) return null;
  if (csprojs.length > 1) {
    throw new Error(
      `expected one *.csproj at the project root, found ${csprojs.length}`,
    );
  }
  const csproj = csprojs[0] ?? "";
  return {
    assemblyName: assemblyName ?? csproj.slice(0, -".csproj".length),
    csproj,
  };
}

function asString(value: ProjectValue | undefined, key: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string")
    throw new Error(`project.godot ${key} is not a string`);
  return value;
}

function asStringArray(value: ProjectValue | undefined, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error(`project.godot ${key} is not a PackedStringArray`);
  return value;
}

function asStringRecord(
  section: Record<string, ProjectValue>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(section)) {
    if (typeof value !== "string")
      throw new Error(`project.godot autoload ${name} is not a string`);
    out[name] = value;
  }
  return out;
}

export function registerProjectInfo(server: McpServer): void {
  server.registerTool(
    "godot_project_info",
    {
      title: "Godot project info",
      description:
        "Read a Godot project's name, main scene, features, autoloads, .NET assembly and the godot binary in use.",
      inputSchema,
      outputSchema,
    },
    async ({ projectPath }) => {
      return structured(await projectInfo(projectPath));
    },
  );
}
