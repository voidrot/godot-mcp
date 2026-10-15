import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import {
  freePort,
  godotBin,
  prepareProject,
  removeProjects,
} from "./harness.ts";

// Runs probes/parser_probe.gd, which feeds the addon's OutputParser the cases of v0's unit tests
// (tests/unit/output-parser.test.ts) plus the byte-level ones: split multibyte characters, invalid
// UTF-8, and the size caps.

const expected = [
  "captured diag.gd stderr",
  "one byte per chunk",
  "a chunk split inside a prefix",
  "a last line without a newline is flushed",
  "CRLF line endings",
  "every prefix is recognised",
  "an at: location without a backtrace",
  ".NET stack frames",
  "ordinary output ends a diagnostic",
  "every diagnostic is counted, only 200 kept",
  "a multibyte character split across chunks",
  "invalid UTF-8 becomes ? per byte",
  "valid UTF-8 survives decode",
  "a stack keeps its first 10 frames and the first sets the location",
  "a line is cut at 1000 characters",
  "a line without a newline is flushed at 64 KB",
  "the rest of a cut line is skipped to its newline",
  "a 25-digit line number is not a location",
  "diagnostic text is budgeted but every diagnostic is counted",
];

const results = new Map<string, { ok: boolean; detail: string }>();
let exitCode = -1;
let output = "";

beforeAll(async () => {
  const dir = await prepareProject(await freePort());
  await copyFile(
    join(import.meta.dir, "probes", "parser_probe.gd"),
    join(dir, "parser_probe.gd"),
  );
  const captured = join(import.meta.dir, "..", "fixtures", "diag.stderr.txt");
  const child = Bun.spawn(
    [
      godotBin(),
      "--headless",
      "--path",
      dir,
      "-s",
      "res://parser_probe.gd",
      "--",
      captured,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  exitCode = await child.exited;
  output = out + err;
  for (const line of out.split("\n")) {
    if (!line.startsWith("PROBE ")) continue;
    const parsed = JSON.parse(line.slice("PROBE ".length));
    results.set(parsed.name, parsed);
  }
}, 120_000);

afterAll(removeProjects);

describe("output parser probe", () => {
  for (const name of expected) {
    test(name, () => {
      const result = results.get(name);
      if (result === undefined)
        throw new Error(`the probe did not report this check:\n${output}`);
      expect(result.ok, result.detail).toBe(true);
    });
  }

  test("decoding invalid UTF-8 logs no engine error", () => {
    expect(output).not.toContain("Unicode parsing error");
  });

  test("an oversized line number logs no engine error", () => {
    expect(output).not.toContain("Cannot represent");
  });

  test("the probe exits 0", () => {
    expect(exitCode, output).toBe(0);
  });
});
