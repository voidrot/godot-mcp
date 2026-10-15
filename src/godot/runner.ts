import { z } from "zod";
import { runProc, Tail } from "../proc.ts";
import { resolveGodotBin } from "./binary.ts";
import { GodotOutputParser } from "./output-parser.ts";

const TAIL_BYTES = 64 * 1024;

export const diagSchema = z.object({
  severity: z.enum(["error", "warning"]),
  kind: z.string(),
  message: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
  code: z.string().optional(),
  stack: z.array(z.string()).optional(),
});

export const runResultSchema = z.object({
  ok: z.boolean(),
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number(),
  diagnostics: z.array(diagSchema),
  errorCount: z.number(),
  warningCount: z.number(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
  truncated: z.boolean(),
});

export type RunResult = z.infer<typeof runResultSchema>;

export interface PhaseOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  killGraceMs?: number;
}

// Runs Godot with `args` in the project directory. Stderr is parsed as it
// arrives, so the tails can drop early output without hiding an early error.
export async function runGodot(
  root: string,
  args: string[],
  opts: PhaseOptions,
): Promise<RunResult> {
  const parser = new GodotOutputParser();
  const stdout = new Tail(TAIL_BYTES);
  const stderr = new Tail(TAIL_BYTES);
  const result = await runProc([resolveGodotBin(), ...args], {
    cwd: root,
    ...opts,
    onStdout: (chunk) => stdout.push(chunk),
    onStderr: (chunk) => {
      stderr.push(chunk);
      parser.push(chunk);
    },
  });
  parser.end();
  return {
    // Godot exits 0 after script errors, so the exit code alone proves nothing.
    ok: result.exitCode === 0 && !result.timedOut && parser.errorCount === 0,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    diagnostics: parser.diagnostics,
    errorCount: parser.errorCount,
    warningCount: parser.warningCount,
    stdoutTail: stdout.toString(),
    stderrTail: stderr.toString(),
    truncated:
      stdout.truncated || stderr.truncated || parser.droppedDiagnostics,
  };
}
