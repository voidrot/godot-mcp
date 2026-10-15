@tool
extends RefCounted

## import_assets and run_headless (D44, D46). One job at a time per editor: while one runs, the next
## gets PROJECT_BUSY at once. run_headless hands the FIFO back once validated, since it touches only
## its own child process (D37); import_assets keeps the FIFO, since it drives the editor's own importer.

const JobRunner := preload("../job_runner.gd")
const LogBuffer := preload("../log_buffer.gd")
const OutputParser := preload("../output_parser.gd")
const Request := preload("../request.gd")
const ResPaths := preload("../res_paths.gd")
const ToolError := preload("../tool_error.gd")

# The transport's budget is the job's timeout plus this (D37).
const BUDGET_SLACK_MS := 10000
const SCAN_RETRIES := 5
const MAX_USER_ARGS := 64
const MAX_USER_ARG_CHARS := 1024

enum Wait { DONE, TIMED_OUT, CANCELLED }

# Held here because handler Callables don't keep it alive.
var _log: LogBuffer
var _runner := JobRunner.new()
var _busy := false


func _init(log: LogBuffer) -> void:
	_log = log


func tools() -> Array[Dictionary]:
	return [
		{
			"name": "import_assets",
			"description": "Make the editor import new or changed asset files (images, models, audio) now, by rescanning the project, and report the errors and warnings it logged. Call this after adding or changing assets, before run_headless or play_scene. `timedOut` is true when the import was still running at the deadline; it carries on in the editor, as it does when the request is cancelled. `truncated` is true when the editor log or the diagnostics limit dropped entries (the counts stay exact). Other editor tools queue behind it and fail after 30 s. Only one job runs at a time (PROJECT_BUSY).",
			"inputSchema": {
				"type": "object",
				"properties": {"timeoutSec": {"type": "integer", "minimum": 1, "maximum": 540, "description": "Default 120."}},
				"additionalProperties": false,
			},
			"handler": import_assets,
		},
		{
			"name": "run_headless",
			"description": "Run the project in a separate headless Godot process and return its captured output and parsed errors. Give `scene` (a .tscn or .scn) or `script` (a .gd run with -s, normally extending SceneTree), or neither for the main scene. Godot exits 0 after script errors, so check `ok`. `frames` quits after that many frames; without it the run lasts until the game quits or `timeoutSec`, when the process group is killed (`timedOut`, exitCode null). A game killed by signal N reports exitCode N, which Godot cannot tell from exit(N). A game that reads stdin waits for the timeout. The run uses the files on disk, so save first: `unsavedScenes` lists what the editor holds unsaved. It waits for a running import first. This runs the project's code (autoloads, scene and script code). Only one job runs at a time (PROJECT_BUSY); other tools keep working meanwhile.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"scene": {"type": "string", "description": "res:// path of a .tscn or .scn. Excludes `script`."},
					"script": {"type": "string", "description": "res:// path of a .gd. Excludes `scene`."},
					"frames": {"type": "integer", "minimum": 1, "description": "Quit after this many frames."},
					"userArgs": {"type": "array", "items": {"type": "string"}, "description": "Passed to the game after `--`; at most 64, each at most 1,024 characters."},
					"timeoutSec": {"type": "integer", "minimum": 1, "maximum": 540, "description": "Default 60."},
				},
				"additionalProperties": false,
			},
			"handler": run_headless,
		},
	]


## True while a job runs, for get_project_info.
func job_active() -> bool:
	return _busy


## Kills the running job's child; called when the plugin unloads.
func shutdown() -> void:
	_runner.kill()


func import_assets(arguments: Dictionary, request: Request) -> Variant:
	if _busy:
		return _busy_error()
	var timeout_ms := int(arguments.get("timeoutSec", 120)) * 1000
	_busy = true
	request.extend_budget(timeout_ms + BUDGET_SLACK_MS)
	var result: Variant = await _import(timeout_ms, request)
	_busy = false
	return result


func run_headless(arguments: Dictionary, request: Request) -> Variant:
	var launch := _launch_args(arguments)
	if launch.has("error"):
		return launch
	if _busy:
		return _busy_error()
	var timeout_ms := int(arguments.get("timeoutSec", 60)) * 1000
	_busy = true
	request.extend_budget(timeout_ms + BUDGET_SLACK_MS, true)
	var result: Variant = await _run(launch["args"], timeout_ms, request)
	_busy = false
	return result


# {args} or a tool failure. User arguments follow `--`, so the engine never reads them as its own flags.
func _launch_args(arguments: Dictionary) -> Dictionary:
	if arguments.has("scene") and arguments.has("script"):
		return ToolError.fail("INVALID_ARGUMENT", "scene and script are mutually exclusive")
	var args := PackedStringArray(["--headless", "--path", ProjectSettings.globalize_path("res://").rstrip("/")])
	if arguments.has("scene"):
		var scene: String = arguments["scene"]
		var problem := ResPaths.check_file(scene, ["tscn", "scn"])
		if not problem.is_empty():
			return problem
		args.append(scene)
	if arguments.has("script"):
		var script: String = arguments["script"]
		var problem := ResPaths.check_file(script, ["gd"])
		if not problem.is_empty():
			return problem
		args.append_array(["-s", script])
	if arguments.has("frames"):
		args.append_array(["--quit-after", str(int(arguments["frames"]))])
	var user_args: Array = arguments.get("userArgs", [])
	if user_args.size() > MAX_USER_ARGS:
		return ToolError.fail("INVALID_ARGUMENT", "userArgs has more than %d entries" % MAX_USER_ARGS)
	for user_arg: String in user_args:
		if user_arg.length() > MAX_USER_ARG_CHARS:
			return ToolError.fail("INVALID_ARGUMENT", "A userArgs entry is longer than %d characters" % MAX_USER_ARG_CHARS)
	if not user_args.is_empty():
		args.append("--")
		args.append_array(PackedStringArray(user_args))
	return {"args": args}


func _run(args: PackedStringArray, timeout_ms: int, request: Request) -> Variant:
	var started := Time.get_ticks_msec()
	var files := EditorInterface.get_resource_filesystem()
	var waited := await _wait(func() -> bool: return not _filesystem_busy(files), started, timeout_ms, request)
	if waited == Wait.TIMED_OUT:
		return ToolError.fail("IMPORT_IN_PROGRESS", "The editor was still importing after %d s; retry, or call import_assets" % (timeout_ms / 1000))
	if waited == Wait.CANCELLED:
		return ToolError.fail("CANCELLED", "The request was cancelled")
	var unsaved := Array(EditorInterface.get_unsaved_scenes())
	var result := await _runner.run(args, timeout_ms - (Time.get_ticks_msec() - started), request)
	if not result.has("error"):
		result["unsavedScenes"] = unsaved
	return result


# is_scanning() turns false when the scan thread ends, before the editor has applied the results and
# reimported the changed files (A14, refined), so the import is done at the next filesystem_changed.
func _import(timeout_ms: int, request: Request) -> Variant:
	var started := Time.get_ticks_msec()
	var files := EditorInterface.get_resource_filesystem()
	var cursor := _log.seq()
	var before := _log.totals()
	# scan() does nothing while a scan is running, and that scan may predate the new files, so let a
	# running one finish first.
	var waited := await _wait(func() -> bool: return not _filesystem_busy(files), started, timeout_ms, request)
	if waited == Wait.DONE:
		var changed := [false]
		var on_changed := func() -> void: changed[0] = true
		files.filesystem_changed.connect(on_changed)
		# scan() also does nothing while the previous scan's thread is still being collected, and that
		# scan's own filesystem_changed must not count, so judge each call only by its own effect.
		var retries := 0
		while true:
			changed[0] = false
			files.scan()
			if changed[0] or _filesystem_busy(files) or retries >= SCAN_RETRIES:
				break
			retries += 1
			if not await request.next_frame():
				waited = Wait.CANCELLED
				break
		if waited == Wait.DONE:
			waited = await _wait(func() -> bool: return changed[0] and not _filesystem_busy(files), started, timeout_ms, request)
		files.filesystem_changed.disconnect(on_changed)
	# A cancelled import stops waiting; the scan itself carries on in the editor.
	if waited == Wait.CANCELLED:
		return ToolError.fail("CANCELLED", "The request was cancelled; the editor's scan carries on")
	var diagnostics: Array[Dictionary] = []
	var chars := 0
	# The counts come from the log's running totals, which its ring can't forget; the entries may be fewer.
	var after := _log.totals()
	var truncated := _log.evicted_since(cursor)
	for entry in _log.errors_since(cursor, true):
		var message := String(entry["message"]).left(OutputParser.MAX_LINE_CHARS)
		chars += message.length() + String(entry.get("file", "")).length()
		if diagnostics.size() >= OutputParser.MAX_DIAGNOSTICS or chars > OutputParser.MAX_DIAGNOSTIC_CHARS:
			truncated = true
			break
		var is_error: bool = entry["level"] == "error"
		var item := {"severity": entry["level"], "kind": "ERROR" if is_error else "WARNING", "message": message}
		if entry.get("file", "") != "":
			item["file"] = entry["file"]
			item["line"] = entry["line"]
		diagnostics.append(item)
	var error_count: int = after["errors"] - before["errors"]
	return {
		"ok": waited == Wait.DONE and error_count == 0,
		"durationMs": Time.get_ticks_msec() - started,
		"timedOut": waited == Wait.TIMED_OUT,
		"diagnostics": diagnostics,
		"errorCount": error_count,
		"warningCount": after["warnings"] - before["warnings"],
		"truncated": truncated,
	}


# is_scanning() is false while the editor still reimports what the scan found (is_importing).
static func _filesystem_busy(files: EditorFileSystem) -> bool:
	return files.is_scanning() or files.is_importing()


# Waits frame by frame until `done` returns true, `timeout_ms` after `started`, or the request is cancelled.
func _wait(done: Callable, started: int, timeout_ms: int, request: Request) -> Wait:
	while not done.call():
		if Time.get_ticks_msec() - started >= timeout_ms:
			return Wait.TIMED_OUT
		if not await request.next_frame():
			return Wait.CANCELLED
	return Wait.DONE


func _busy_error() -> Dictionary:
	return ToolError.fail("PROJECT_BUSY", "Another job (run_headless or import_assets) is running; retry when get_project_info reports jobActive false")
