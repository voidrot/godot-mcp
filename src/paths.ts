import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

export type PathErrorCode =
  | "NOT_ABSOLUTE"
  | "NOT_A_PROJECT"
  | "INVALID_RES_PATH"
  | "NOT_FOUND"
  | "OUTSIDE_PROJECT";

export class PathError extends Error {
  override name = "PathError";

  constructor(
    readonly code: PathErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// Returns the real path of a project directory, which later checks compare against.
export async function resolveProjectDir(projectPath: string): Promise<string> {
  if (!isAbsolute(projectPath)) {
    throw new PathError(
      "NOT_ABSOLUTE",
      `projectPath must be absolute: ${projectPath}`,
    );
  }
  const root = await realpath(projectPath).catch(() => {
    throw new PathError("NOT_A_PROJECT", `no such directory: ${projectPath}`);
  });
  const isFile = await stat(join(root, "project.godot")).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!isFile)
    throw new PathError("NOT_A_PROJECT", `no project.godot in ${root}`);
  return root;
}

// `root` must come from resolveProjectDir. The target must exist, so a
// dangling symlink fails here instead of pointing outside later.
export async function resolveResPath(
  root: string,
  resPath: string,
): Promise<string> {
  const rel = resPath.startsWith("res://")
    ? resPath.slice("res://".length)
    : resPath;
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
    throw new PathError(
      "INVALID_RES_PATH",
      `not a path inside the project: ${resPath}`,
    );
  }
  const real = await realpath(join(root, rel)).catch(() => {
    throw new PathError("NOT_FOUND", `no such file in project: ${resPath}`);
  });
  if (real !== root && !real.startsWith(root + sep)) {
    throw new PathError(
      "OUTSIDE_PROJECT",
      `resolves outside the project: ${resPath}`,
    );
  }
  return real;
}
