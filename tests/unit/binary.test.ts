import { describe, expect, test } from "bun:test";
import {
  GodotNotFoundError,
  godotVersion,
  resolveGodotBin,
} from "../../src/godot/binary.ts";
import { fakeGodot } from "../helpers.ts";

describe("resolveGodotBin", () => {
  test("throws GodotNotFoundError for a missing GODOT_BIN", () => {
    expect(() => resolveGodotBin({ GODOT_BIN: "/nope" })).toThrow(
      GodotNotFoundError,
    );
  });

  test("resolves GODOT_BIN to its path", () => {
    expect(resolveGodotBin({ GODOT_BIN: fakeGodot })).toBe(fakeGodot);
  });
});

describe("godotVersion", () => {
  test("reads the version through the process runner", async () => {
    expect(await godotVersion(fakeGodot)).toBe("4.7.2.fake");
  });

  test("fails on a non-zero exit", async () => {
    await expect(godotVersion("/usr/bin/false")).rejects.toThrow(
      "exited with code 1",
    );
  });
});
