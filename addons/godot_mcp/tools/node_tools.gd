@tool
extends RefCounted

const Request := preload("../request.gd")
const SceneAccess := preload("../scene_access.gd")
const ToolError := preload("../tool_error.gd")
const ValueCodec := preload("../value_codec.gd")

const HIDDEN_USAGE := PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP | PROPERTY_USAGE_CATEGORY


func tools() -> Array[Dictionary]:
	return [
		{
			"name": "get_node_properties",
			"description": "Read the editor-visible properties of a node in the edited scene as {type, value}. A Resource is its res:// path plus class; a math type is a Godot literal such as \"Vector2(1, 2)\".",
			"inputSchema": {
				"type": "object",
				"properties": {
					"path": {"type": "string", "description": "Node path relative to the scene root; \".\" is the root."},
					"names": {"type": "array", "items": {"type": "string"}, "description": "Only these properties; default is all."},
				},
				"required": ["path"],
				"additionalProperties": false,
			},
			"annotations": {"readOnlyHint": true},
			"handler": get_node_properties,
		},
	]


func get_node_properties(arguments: Dictionary, _request: Request) -> Variant:
	var scene := EditorInterface.get_edited_scene_root()
	if scene == null:
		return SceneAccess.no_scene()
	var path: String = arguments["path"]
	var node := SceneAccess.resolve(scene, path)
	if node == null:
		return SceneAccess.not_found(path)
	var wanted: Array = arguments.get("names", [])
	var properties := {}
	for property in node.get_property_list():
		var name: String = property["name"]
		if property["usage"] & PROPERTY_USAGE_EDITOR == 0 or property["usage"] & HIDDEN_USAGE != 0:
			continue
		if wanted.is_empty() or name in wanted:
			properties[name] = ValueCodec.encode(node.get(name), property["type"])
	var missing := wanted.filter(func(name: String) -> bool: return not properties.has(name))
	if not missing.is_empty():
		return ToolError.fail("PROPERTY_NOT_FOUND", "%s has no editor property named: %s" % [node.get_class(), ", ".join(missing)])
	return {"properties": properties}
