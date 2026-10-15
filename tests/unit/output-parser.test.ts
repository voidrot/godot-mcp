import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type Diag,
  GodotOutputParser,
  MAX_DIAGNOSTICS,
} from "../../src/godot/output-parser.ts";

// Captured from godot-mono 4.7.2 running fixtures/gd/diag.gd.
const captured = await Bun.file(
  join(import.meta.dir, "..", "fixtures", "diag.stderr.txt"),
).text();

const expected: Diag[] = [
  {
    severity: "error",
    kind: "ERROR",
    message: "pushed error",
    file: "res://diag.gd",
    line: 8,
    stack: ["_init (res://diag.gd:8)"],
  },
  {
    severity: "warning",
    kind: "WARNING",
    message: "pushed warning",
    file: "res://diag.gd",
    line: 9,
    stack: ["_init (res://diag.gd:9)"],
  },
  {
    severity: "error",
    kind: "SCRIPT ERROR",
    message: "Out of bounds get index '5' (on base: 'Array')",
    file: "res://diag.gd",
    line: 11,
    stack: ["_init (res://diag.gd:11)"],
  },
];

function parse(chunks: Iterable<string>): GodotOutputParser {
  const parser = new GodotOutputParser();
  for (const chunk of chunks) parser.push(chunk);
  parser.end();
  return parser;
}

describe("GodotOutputParser", () => {
  test("parses the captured diag.gd stderr (pins A4: backtrace follows the header)", () => {
    const parser = parse([captured]);
    expect(parser.diagnostics).toEqual(expected);
    expect(parser.errorCount).toBe(2);
    expect(parser.warningCount).toBe(1);
  });

  test("gives the same result when every character is its own chunk", () => {
    expect(parse(captured).diagnostics).toEqual(expected);
  });

  test("gives the same result when chunks split inside a prefix", () => {
    const cut = captured.indexOf("SCRIPT ERROR") + 4;
    const parser = parse([captured.slice(0, cut), captured.slice(cut)]);
    expect(parser.diagnostics).toEqual(expected);
  });

  test("flushes a last line that has no newline", () => {
    const parser = parse(["ERROR: no newline"]);
    expect(parser.diagnostics).toEqual([
      { severity: "error", kind: "ERROR", message: "no newline" },
    ]);
  });

  test("handles CRLF line endings", () => {
    const parser = parse(["WARNING: w\r\n   at: f (a.cpp:3)\r\n"]);
    expect(parser.diagnostics).toEqual([
      {
        severity: "warning",
        kind: "WARNING",
        message: "w",
        file: "a.cpp",
        line: 3,
      },
    ]);
  });

  test.each<[string, Diag["severity"]]>([
    ["ERROR", "error"],
    ["WARNING", "warning"],
    ["SCRIPT ERROR", "error"],
    ["SCRIPT WARNING", "warning"],
    ["USER ERROR", "error"],
    ["USER WARNING", "warning"],
    ["USER SCRIPT ERROR", "error"],
  ])("recognises the %s prefix", (kind, severity) => {
    const parser = parse([`${kind}: boom\n`]);
    expect(parser.diagnostics).toEqual([{ severity, kind, message: "boom" }]);
  });

  test("keeps the `at:` location when there is no backtrace", () => {
    const parser = parse(["ERROR: native\n   at: fn (core/os/os.cpp:42)\n"]);
    expect(parser.diagnostics[0]).toMatchObject({
      file: "core/os/os.cpp",
      line: 42,
    });
    expect(parser.diagnostics[0]?.stack).toBeUndefined();
  });

  test("collects .NET stack frames, which have no colon after `at`", () => {
    const parser = parse([
      "ERROR: System.Exception: bad\n",
      "   at: void Godot.GD.PushError(string) (modules/mono/glue.cpp:10)\n",
      "   at Game.Main._Ready() in /p/Main.cs:line 7\n",
      "   at Godot.Node.Call(StringName& method) in /x/Node.cs:line 1\n",
    ]);
    expect(parser.diagnostics).toEqual([
      {
        severity: "error",
        kind: "ERROR",
        message: "System.Exception: bad",
        file: "modules/mono/glue.cpp",
        line: 10,
        stack: [
          "Game.Main._Ready() in /p/Main.cs:line 7",
          "Godot.Node.Call(StringName& method) in /x/Node.cs:line 1",
        ],
      },
    ]);
  });

  test("ordinary output ends a diagnostic, so later `at:` lines don't attach", () => {
    const parser = parse([
      "ERROR: first\n",
      "just a print\n",
      "   at: stray (x.gd:1)\n",
    ]);
    expect(parser.diagnostics).toEqual([
      { severity: "error", kind: "ERROR", message: "first" },
    ]);
  });

  test("counts every diagnostic but stores only the first MAX_DIAGNOSTICS", () => {
    const total = MAX_DIAGNOSTICS + 50;
    const parser = parse(
      Array.from({ length: total }, (_, i) => `ERROR: e${i}\n`),
    );
    expect(parser.errorCount).toBe(total);
    expect(parser.diagnostics).toHaveLength(MAX_DIAGNOSTICS);
    expect(parser.droppedDiagnostics).toBe(true);
  });
});
