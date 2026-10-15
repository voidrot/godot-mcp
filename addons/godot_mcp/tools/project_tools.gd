@tool
extends RefCounted

const Request := preload("../request.gd")
const ValueCodec := preload("../value_codec.gd")

var _addon_version: String


func _init(addon_version: String) -> void:
	_addon_version = addon_version


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
		"scanning": EditorInterface.get_resource_filesystem().is_scanning(),
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
