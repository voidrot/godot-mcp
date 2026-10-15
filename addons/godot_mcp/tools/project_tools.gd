@tool
extends RefCounted

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
	]


func get_project_info(_arguments: Dictionary) -> Dictionary:
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
