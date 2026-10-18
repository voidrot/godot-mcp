extends SceneTree

## Drives the addon's OutputParser in-process (the unit cases of v0's output-parser.test.ts, plus the
## byte-level ones). The first user argument is the captured stderr of diag.gd. Prints one
## "PROBE {json}" line per check and exits 0 when all pass.

const OutputParser := preload("res://addons/godot_mcp/output_parser.gd")

var _failed := false


func _initialize() -> void:
	var captured := FileAccess.get_file_as_bytes(OS.get_cmdline_user_args()[0])
	var diag_expected: Array = [
		{"severity": "error", "kind": "ERROR", "message": "pushed error", "file": "res://diag.gd", "line": 8, "stack": ["_init (res://diag.gd:8)"]},
		{"severity": "warning", "kind": "WARNING", "message": "pushed warning", "file": "res://diag.gd", "line": 9, "stack": ["_init (res://diag.gd:9)"]},
		{"severity": "error", "kind": "SCRIPT ERROR", "message": "Out of bounds get index '5' (on base: 'Array')", "file": "res://diag.gd", "line": 11, "stack": ["_init (res://diag.gd:11)"]},
	]

	var whole := _parse([captured])
	_check("captured diag.gd stderr", Array(whole.diagnostics) == diag_expected and whole.error_count == 2 and whole.warning_count == 1, JSON.stringify(whole.diagnostics))

	var single: Array = []
	for byte in captured:
		single.append(PackedByteArray([byte]))
	_check("one byte per chunk", Array(_parse(single).diagnostics) == diag_expected)

	var cut := captured.get_string_from_utf8().find("SCRIPT ERROR") + 4
	_check("a chunk split inside a prefix", Array(_parse([captured.slice(0, cut), captured.slice(cut)]).diagnostics) == diag_expected)

	_check("a last line without a newline is flushed", Array(_parse([_b("ERROR: no newline")]).diagnostics) == [{"severity": "error", "kind": "ERROR", "message": "no newline"}])

	_check("CRLF line endings", Array(_parse([_b("WARNING: w\r\n   at: f (a.cpp:3)\r\n")]).diagnostics) == [{"severity": "warning", "kind": "WARNING", "message": "w", "file": "a.cpp", "line": 3}])

	var prefixes_ok := true
	for kind: String in ["ERROR", "WARNING", "SCRIPT ERROR", "SCRIPT WARNING", "USER ERROR", "USER WARNING", "USER SCRIPT ERROR"]:
		var severity := "warning" if kind.ends_with("WARNING") else "error"
		prefixes_ok = prefixes_ok and Array(_parse([_b(kind + ": boom\n")]).diagnostics) == [{"severity": severity, "kind": kind, "message": "boom"}]
	_check("every prefix is recognised", prefixes_ok)

	var native := _parse([_b("ERROR: native\n   at: fn (core/os/os.cpp:42)\n")])
	_check("an at: location without a backtrace", native.diagnostics[0]["file"] == "core/os/os.cpp" and native.diagnostics[0]["line"] == 42 and not native.diagnostics[0].has("stack"))

	var dotnet := _parse([_b("ERROR: System.Exception: bad\n   at: void Godot.GD.PushError(string) (modules/mono/glue.cpp:10)\n   at Game.Main._Ready() in /p/Main.cs:line 7\n   at Godot.Node.Call(StringName& method) in /x/Node.cs:line 1\n")])
	_check(".NET stack frames", Array(dotnet.diagnostics) == [{"severity": "error", "kind": "ERROR", "message": "System.Exception: bad", "file": "modules/mono/glue.cpp", "line": 10, "stack": ["Game.Main._Ready() in /p/Main.cs:line 7", "Godot.Node.Call(StringName& method) in /x/Node.cs:line 1"]}], JSON.stringify(dotnet.diagnostics))

	_check("ordinary output ends a diagnostic", Array(_parse([_b("ERROR: first\njust a print\n   at: stray (x.gd:1)\n")]).diagnostics) == [{"severity": "error", "kind": "ERROR", "message": "first"}])

	var many := OutputParser.new()
	for i in OutputParser.MAX_DIAGNOSTICS + 50:
		many.push(_b("ERROR: e%d\n" % i))
	many.end()
	_check("every diagnostic is counted, only 200 kept", many.error_count == OutputParser.MAX_DIAGNOSTICS + 50 and many.diagnostics.size() == OutputParser.MAX_DIAGNOSTICS and many.dropped())

	# "é" is C3 A9; the second chunk starts inside it.
	var accent := _b("ERROR: caf")
	accent.append(0xC3)
	_check("a multibyte character split across chunks", _parse([accent, PackedByteArray([0xA9, 0x0A])]).diagnostics[0]["message"] == "café")

	var invalid := PackedByteArray([0x61, 0xFF, 0xC3, 0x28, 0xED, 0xA0, 0x80, 0xF4, 0x90, 0x80, 0x80, 0x00, 0x62])
	_check("invalid UTF-8 becomes ? per byte", OutputParser.decode(invalid) == "a??(???????" + "?b", OutputParser.decode(invalid))
	_check("valid UTF-8 survives decode", OutputParser.decode("é€😀".to_utf8_buffer()) == "é€😀")

	var deep := "ERROR: deep\n   GDScript backtrace (most recent call first):\n"
	for i in 15:
		deep += "       [%d] f%d (res://a.gd:%d)\n" % [i, i, i + 1]
	var deep_diag: Dictionary = _parse([_b(deep)]).diagnostics[0]
	_check("a stack keeps its first 10 frames and the first sets the location", deep_diag["stack"].size() == OutputParser.MAX_STACK_FRAMES and deep_diag["file"] == "res://a.gd" and deep_diag["line"] == 1)

	_check("a line is cut at 1000 characters", _parse([_b("ERROR: " + "x".repeat(2000) + "\n")]).diagnostics[0]["message"].length() == OutputParser.MAX_LINE_CHARS - 7)

	var binary := PackedByteArray()
	binary.resize(OutputParser.MAX_LINE_BYTES + 10)
	binary.fill(0x61)
	var flushed := _parse([binary, _b("\nERROR: after\n")])
	_check("a line without a newline is flushed at 64 KB", flushed.error_count == 1 and flushed.diagnostics[0]["message"] == "after")

	var cut_line := PackedByteArray()
	cut_line.resize(OutputParser.MAX_LINE_BYTES + 1)
	cut_line.fill(0x78)
	var skipped := _parse([cut_line, _b("ERROR: text\n"), _b("ERROR: ok\n")])
	_check("the rest of a cut line is skipped to its newline", skipped.error_count == 1 and skipped.diagnostics[0]["message"] == "ok")

	var overflow := _parse([_b("ERROR: x\n   at: f (a.gd:" + "9".repeat(25) + ")\n")])
	_check("a 25-digit line number is not a location", overflow.diagnostics[0]["message"] == "x" and not overflow.diagnostics[0].has("file"))

	var budgeted := OutputParser.new()
	for i in 200:
		budgeted.push(_b("ERROR: " + "m".repeat(900) + "\n"))
	budgeted.end()
	var kept_chars := 0
	for item in budgeted.diagnostics:
		kept_chars += item["message"].length()
	_check("diagnostic text is budgeted but every diagnostic is counted", budgeted.error_count == 200 and kept_chars <= OutputParser.MAX_DIAGNOSTIC_CHARS and budgeted.diagnostics.size() < 200 and budgeted.dropped())

	quit(1 if _failed else 0)


func _b(text: String) -> PackedByteArray:
	return text.to_utf8_buffer()


func _parse(chunks: Array) -> OutputParser:
	var parser := OutputParser.new()
	for chunk: PackedByteArray in chunks:
		parser.push(chunk)
	parser.end()
	return parser


func _check(name: String, ok: bool, detail := "") -> void:
	_failed = _failed or not ok
	print("PROBE ", JSON.stringify({"name": name, "ok": ok, "detail": detail}))
