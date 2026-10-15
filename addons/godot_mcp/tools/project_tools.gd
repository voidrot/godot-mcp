@tool
extends RefCounted

const Request := preload("../request.gd")
const ToolError := preload("../tool_error.gd")
const ResPaths := preload("../res_paths.gd")
const ValueCodec := preload("../value_codec.gd")
const ValueDecoder := preload("../value_decoder.gd")

const PROTECTED_PREFIXES: Array[String] = ["editor/", "editor_plugins/", "godot_mcp/"]

static var NAME_PATTERN := RegEx.create_from_string("^[A-Za-z0-9_]+(?:/[A-Za-z0-9_]+)+\\z")

var _addon_version: String
# func() -> bool: whether a job (run_headless, import_assets) is running.
var _job_active: Callable


func _init(addon_version: String, job_active: Callable) -> void:
	_addon_version = addon_version
	_job_active = job_active


func tools() -> Array[Dictionary]:
	return [
		{
			"name": "get_project_info",
			"description": "Read the project's name, main scene, features and autoloads, the Godot version and binary, and the editor's open, unsaved, edited and playing scenes. Call this first.",
			"inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
			"annotations": {"readOnlyHint": true},
			"handler": get_project_info,
		},
		{
			"name": "get_project_settings",
			"description": "Read project settings as {type, value}, defaults included, sorted by name. `truncated` is true when more than `limit` settings match.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"prefix": {"type": "string", "description": "Only settings whose name starts with this, e.g. \"physics/2d/\"."},
					"limit": {"type": "integer", "minimum": 1, "maximum": 5000, "description": "Default 500."},
				},
				"additionalProperties": false,
			},
			"annotations": {"readOnlyHint": true},
			"handler": get_project_settings,
		},
		{
			"name": "set_project_setting",
			"description": "Set one project setting and write project.godot, e.g. application/run/main_scene or an autoload. The value is parsed by the setting's declared type, as in update_property; a new setting takes bool, number, string, array or object. Settings under `editor/`, `editor_plugins/` and `godot_mcp/` are refused. `application/run/main_scene` and `autoload/*` must name an existing scene or script by res:// path or uid:// (a uid is resolved and its path checked), and a string value must not contain control characters. Some settings, autoloads included, apply only after the editor restarts.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"name": {"type": "string", "description": "Setting path such as \"display/window/size/viewport_width\"."},
					"value": {"description": "The new value."},
				},
				"required": ["name", "value"],
				"additionalProperties": false,
			},
			"handler": set_project_setting,
		},
	]


# Handlers return Variant, not Dictionary: a script error in a typed function yields an empty
# Dictionary, which the server could not tell from a legitimately empty result.
func get_project_info(_arguments: Dictionary, _request: Request) -> Variant:
	var autoloads := {}
	for property in ProjectSettings.get_property_list():
		var key: String = property["name"]
		if key.begins_with("autoload/"):
			autoloads[key.trim_prefix("autoload/")] = ProjectSettings.get_setting(key)
	var main_scene: String = ProjectSettings.get_setting("application/run/main_scene", "")
	var edited := EditorInterface.get_edited_scene_root()
	var playing := EditorInterface.get_playing_scene()
	return {
		"name": ProjectSettings.get_setting("application/config/name", ""),
		"godotVersion": Engine.get_version_info()["string"],
		"godotPath": OS.get_executable_path(),
		"addonVersion": _addon_version,
		"mainScene": main_scene if main_scene != "" else null,
		"features": Array(ProjectSettings.get_setting("application/config/features", PackedStringArray())),
		"autoloads": autoloads,
		"editedScene": edited.scene_file_path if edited != null else null,
		"openScenes": Array(EditorInterface.get_open_scenes()),
		"unsavedScenes": Array(EditorInterface.get_unsaved_scenes()),
		"playingScene": playing if playing != "" else null,
		"scanning": EditorInterface.get_resource_filesystem().is_scanning() or EditorInterface.get_resource_filesystem().is_importing(),
		"jobActive": _job_active.call(),
	}


func get_project_settings(arguments: Dictionary, _request: Request) -> Variant:
	var prefix: String = arguments.get("prefix", "")
	var limit := int(arguments.get("limit", 500))
	var names: Array[String] = []
	for property in ProjectSettings.get_property_list():
		var name: String = property["name"]
		if name.contains("/") and name.begins_with(prefix):
			names.append(name)
	names.sort()
	var settings := {}
	for name in names.slice(0, limit):
		settings[name] = ValueCodec.encode(ProjectSettings.get_setting(name))
	return {"settings": settings, "truncated": names.size() > limit}


func set_project_setting(arguments: Dictionary, _request: Request) -> Variant:
	var name: String = arguments["name"]
	if NAME_PATTERN.search(name) == null:
		return ToolError.fail("INVALID_NAME", "name must be segments of letters, digits and _ joined by /, such as application/run/main_scene")
	var lower := name.to_lower()
	# editor/ holds the play-mode command line (main_run_args), which can write outside the project.
	for prefix in PROTECTED_PREFIXES:
		if lower.begins_with(prefix):
			return ToolError.fail("PROTECTED_SETTING", name + " cannot be changed through this tool")
	var raw: Variant = arguments["value"]
	var problem := _path_problem(name, raw)
	if not problem.is_empty():
		return problem
	if _has_control_character(raw):
		return ToolError.fail("INVALID_VALUE", "value must not contain control characters")
	var info := {"name": name, "type": _json_type(raw)}
	var known := ProjectSettings.has_setting(name)
	if known:
		for property in ProjectSettings.get_property_list():
			if property["name"] == name:
				info = property
				break
	var decoded := ValueDecoder.decode(raw, info)
	if decoded.has("error"):
		return decoded
	var previous: Variant = ProjectSettings.get_setting(name) if known else null
	ProjectSettings.set_setting(name, decoded["value"])
	var err := ProjectSettings.save()
	if err != OK:
		ProjectSettings.set_setting(name, previous)
		return ToolError.fail("SAVE_FAILED", "Could not write project.godot (%s)" % error_string(err))
	return {
		"name": name,
		"previous": ValueCodec.encode(previous) if known else null,
		"value": ValueCodec.encode(ProjectSettings.get_setting(name)),
	}


# The declared type of a setting that does not exist yet: whatever the JSON value is.
func _json_type(raw: Variant) -> int:
	if raw is float:
		return TYPE_INT if raw == floorf(raw) and absf(raw) < ValueDecoder.MAX_SAFE_INT else TYPE_FLOAT
	return typeof(raw)


# Settings that name a scene or script run it when the game starts, so their paths get the usual checks.
func _path_problem(name: String, raw: Variant) -> Dictionary:
	if not raw is String:
		return {}
	if name == "application/run/main_scene" and raw != "":
		return _checked_target(raw, ["tscn", "scn"])
	if name.begins_with("autoload/"):
		return _checked_target(raw.trim_prefix("*"), ["tscn", "scn", "gd", "cs"])
	return {}


# The editor stores these as res:// paths or uid:// references; a uid is resolved and its path checked.
func _checked_target(target: String, extensions: Array[String]) -> Dictionary:
	if target.begins_with("uid://"):
		var id := ResourceUID.text_to_id(target)
		if id == ResourceUID.INVALID_ID or not ResourceUID.has_id(id):
			return ToolError.fail("INVALID_VALUE", "No resource has the id " + target.left(80))
		target = ResourceUID.get_id_path(id)
	return ResPaths.check_file(target, extensions)


func _has_control_character(value: Variant) -> bool:
	if value is String:
		for i in value.length():
			if value.unicode_at(i) < 32:
				return true
	elif value is Array:
		return value.any(_has_control_character)
	elif value is Dictionary:
		for key: Variant in value:
			if _has_control_character(key) or _has_control_character(value[key]):
				return true
	return false
