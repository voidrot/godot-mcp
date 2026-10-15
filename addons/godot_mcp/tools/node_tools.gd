@tool
extends RefCounted

const NodeProps := preload("../node_props.gd")
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
		{
			"name": "update_property",
			"description": "Set one editor-visible property of a node in the edited scene, as one undoable action. The value is parsed by the property's declared type. bool, int, float and String take JSON values (an int must be whole). A math type such as Vector2, Rect2 or Color, and a packed numeric array, take a Godot literal string such as \"Vector2(1, 2)\" or \"Color(1, 0, 0, 1)\"; a Color also takes \"#rrggbb\". An Array or Dictionary takes JSON. An Object property takes the res:// path of a resource or null; `script` attaches a script whose base class the node derives from, and `name` renames the node; NodePath properties that point at a renamed node are not updated. Anything else is refused.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"path": {"type": "string", "description": "Node path relative to the scene root; \".\" is the root."},
					"property": {"type": "string"},
					"value": {"description": "The new value."},
				},
				"required": ["path", "property", "value"],
				"additionalProperties": false,
			},
			"handler": update_property,
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


func update_property(arguments: Dictionary, _request: Request) -> Variant:
	var scene := EditorInterface.get_edited_scene_root()
	if scene == null:
		return SceneAccess.no_scene()
	var path: String = arguments["path"]
	var node := SceneAccess.resolve(scene, path)
	if node == null:
		return SceneAccess.not_found(path)
	var property: String = arguments["property"]
	var decoded := NodeProps.decode(node, property, arguments["value"])
	if decoded.has("error"):
		return decoded
	var parent := node.get_parent()
	if property == "name" and parent != null:
		var sibling := parent.get_node_or_null(NodePath(String(decoded["value"])))
		if sibling != null and sibling != node:
			return ToolError.fail("DUPLICATE_NAME", "%s already has a child named %s" % [parent.name, decoded["value"]])
	var previous: Variant = node.get(property)
	var label := "MCP: set %s.%s" % [node.name, property]
	var undo_redo := SceneAccess.begin_action(label, scene)
	undo_redo.add_do_property(node, property, decoded["value"])
	undo_redo.add_undo_property(node, property, previous)
	undo_redo.commit_action()
	return {
		"previous": ValueCodec.encode(previous, decoded["type"]),
		"value": ValueCodec.encode(node.get(property), decoded["type"]),
		"undoAction": label,
	}
