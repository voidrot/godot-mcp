@tool
extends RefCounted

const LogBuffer := preload("../log_buffer.gd")
const Request := preload("../request.gd")
const ResPaths := preload("../res_paths.gd")
const SceneAccess := preload("../scene_access.gd")
const ToolError := preload("../tool_error.gd")

# How long play_scene and stop_scene wait for the editor to start or stop the game.
const WAIT_MS := 10000

# Held here because handler Callables don't keep it alive.
var _log: LogBuffer


func _init(log: LogBuffer) -> void:
	_log = log


func tools() -> Array[Dictionary]:
	return [
		{
			"name": "get_editor_log",
			"description": "Read the editor's log (errors, warnings and printed output) since the plugin loaded. Pass the previous call's nextSince as `since` to read only newer entries. `dropped` counts entries the 1,000-entry ring lost before you read them; `reset` is true when `since` was ahead of the log (the plugin reloaded) and the read started over.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"since": {"type": "integer", "minimum": 0, "description": "Cursor; default 0 reads from the oldest entry."},
					"level": {"type": "string", "enum": ["info", "warning", "error"], "description": "Lowest level to return; default info."},
					"limit": {"type": "integer", "minimum": 1, "maximum": 1000, "description": "Default 200."},
				},
				"additionalProperties": false,
			},
			"annotations": {"readOnlyHint": true},
			"handler": get_editor_log,
		},
		{
			"name": "play_scene",
			"description": "Run a scene in the editor's own play mode, as a human would with F5/F6/F7. The editor saves its modified scenes first (its run setting). The game's output is not captured; use run_headless for that. Returns once the game has started.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"mode": {"type": "string", "enum": ["main", "current", "custom"], "description": "main runs the project's main scene, current the edited scene, custom the scene at `path`."},
					"path": {"type": "string", "description": "res:// path of the scene; required for custom."},
				},
				"required": ["mode"],
				"additionalProperties": false,
			},
			"handler": play_scene,
		},
		{
			"name": "stop_scene",
			"description": "Stop the scene started by play_scene, or one a person started in the editor. `stopped` is false when nothing was playing.",
			"inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
			"handler": stop_scene,
		},
	]


func get_editor_log(arguments: Dictionary, _request: Request) -> Variant:
	return _log.read(int(arguments.get("since", 0)), arguments.get("level", "info"), int(arguments.get("limit", 200)))


func play_scene(arguments: Dictionary, request: Request) -> Variant:
	var mode: String = arguments["mode"]
	# Running makes the editor save every modified scene, bypassing save_scene's checks.
	for unsaved in EditorInterface.get_unsaved_scenes():
		var unsafe := SceneAccess.save_problem(unsaved)
		if not unsafe.is_empty():
			return ToolError.fail("UNSAFE_AUTOSAVE", "Running would auto-save %s, which cannot be saved safely: %s" % [unsaved, unsafe["error"]["message"]])
	if mode == "custom":
		if not arguments.has("path"):
			return ToolError.fail("INVALID_ARGUMENT", "mode custom needs path")
		var path: String = arguments["path"]
		var problem := ResPaths.check_file(path, ["tscn", "scn"])
		if not problem.is_empty():
			return problem
		EditorInterface.play_custom_scene(path)
	elif arguments.has("path"):
		return ToolError.fail("INVALID_ARGUMENT", "path is only for mode custom")
	elif mode == "current":
		if EditorInterface.get_edited_scene_root() == null:
			return SceneAccess.no_scene()
		EditorInterface.play_current_scene()
	else:
		EditorInterface.play_main_scene()
	if not await _wait_until(request, true):
		return ToolError.fail("PLAY_FAILED", "The game did not start within %d ms; see get_editor_log" % WAIT_MS)
	return {"playingScene": EditorInterface.get_playing_scene()}


func stop_scene(_arguments: Dictionary, request: Request) -> Variant:
	var was_playing := EditorInterface.is_playing_scene()
	EditorInterface.stop_playing_scene()
	if not await _wait_until(request, false):
		return ToolError.fail("STOP_FAILED", "The game did not stop within %d ms; see get_editor_log" % WAIT_MS)
	return {"stopped": was_playing}


# Waits for is_playing_scene() to become `playing`. False on timeout or cancellation.
func _wait_until(request: Request, playing: bool) -> bool:
	var deadline := Time.get_ticks_msec() + WAIT_MS
	while EditorInterface.is_playing_scene() != playing:
		if Time.get_ticks_msec() >= deadline or not await request.next_frame():
			return false
	return true
