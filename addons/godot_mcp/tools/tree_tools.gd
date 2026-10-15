@tool
extends RefCounted

## add_node, delete_node and move_node. Each is one undo action (D34). Structural edits touch only nodes the
## scene root owns, and record every descendant's owner first, since remove_child clears owners and an undo
## or redo must restore them.

const NodeFactory := preload("../node_factory.gd")
const NodeProps := preload("../node_props.gd")
const Request := preload("../request.gd")
const SceneAccess := preload("../scene_access.gd")
const ToolError := preload("../tool_error.gd")


func tools() -> Array[Dictionary]:
	return [
		{
			"name": "add_node",
			"description": "Add a node to the edited scene, either a new node of class `type` or an instance of the scene `scene`. `properties` maps property names to values, parsed by each property's declared type (see update_property). The edit is one undoable action; call save_scene to write it to disk.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"parentPath": {"type": "string", "description": "Node path of the parent, relative to the scene root; \".\" is the root."},
					"type": {"type": "string", "description": "A concrete Node class such as Sprite2D. Give this or `scene`."},
					"scene": {"type": "string", "description": "res:// path of a .tscn or .scn to instance. Give this or `type`."},
					"name": {"type": "string", "description": "Default is the class or scene name, made unique among siblings."},
					"properties": {"type": "object", "description": "Property values to set; `name` is not allowed here."},
				},
				"required": ["parentPath"],
				"additionalProperties": false,
			},
			"handler": add_node,
		},
		{
			"name": "delete_node",
			"description": "Delete a node and its descendants from the edited scene. The root cannot be deleted. One undoable action.",
			"inputSchema": {
				"type": "object",
				"properties": {"path": {"type": "string", "description": "Node path relative to the scene root."}},
				"required": ["path"],
				"additionalProperties": false,
			},
			"handler": delete_node,
		},
		{
			"name": "move_node",
			"description": "Move a node, with its descendants, under a new parent in the edited scene, or reorder it within its parent. It cannot move into itself or a descendant, and the root cannot move. One undoable action. NodePath properties and signal connections that point at the moved nodes are not updated.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"path": {"type": "string", "description": "Node path relative to the scene root."},
					"newParentPath": {"type": "string", "description": "Node path of the new parent."},
					"index": {"type": "integer", "minimum": 0, "description": "Position among the new parent's children; default is last."},
				},
				"required": ["path", "newParentPath"],
				"additionalProperties": false,
			},
			"handler": move_node,
		},
	]


func add_node(arguments: Dictionary, _request: Request) -> Variant:
	var scene := EditorInterface.get_edited_scene_root()
	if scene == null:
		return SceneAccess.no_scene()
	var parent_path: String = arguments["parentPath"]
	var parent := SceneAccess.resolve(scene, parent_path)
	if parent == null:
		return SceneAccess.not_found(parent_path)
	if arguments.has("type") == arguments.has("scene"):
		return ToolError.fail("INVALID_ARGUMENT", "Give exactly one of `type` and `scene`")
	var properties: Dictionary = arguments.get("properties", {})
	if properties.has("name"):
		return ToolError.fail("INVALID_ARGUMENT", "Use the `name` argument, not properties.name")
	var made := NodeFactory.make(arguments["type"]) if arguments.has("type") else NodeFactory.instance(arguments["scene"], scene)
	if made.has("error"):
		return made
	var node: Node = made["node"]
	var name: String = arguments.get("name", "")
	if name != "":
		if name.validate_node_name() != name:
			node.free()
			return ToolError.fail("INVALID_VALUE", "name must contain none of: . : @ / \" %")
		if parent.get_node_or_null(NodePath(name)) != null:
			node.free()
			return ToolError.fail("DUPLICATE_NAME", "%s already has a child named %s" % [parent.name, name])
		node.name = name
	else:
		# Dedupe here rather than in add_child, so the undo label carries the final name.
		var base := String(arguments["type"]) if node.name == &"" else String(node.name)
		var candidate := base
		var suffix := 2
		while parent.get_node_or_null(NodePath(candidate)) != null:
			candidate = base + str(suffix)
			suffix += 1
		node.name = candidate
	for property: String in properties:
		var decoded := NodeProps.decode(node, property, properties[property])
		if decoded.has("error"):
			node.free()
			return decoded
		node.set(property, decoded["value"])
	var label := "MCP: add %s" % node.name
	var undo_redo := SceneAccess.begin_action(label, scene)
	undo_redo.add_do_method(parent, "add_child", node, true)
	undo_redo.add_do_method(node, "set_owner", scene)
	undo_redo.add_do_reference(node)
	undo_redo.add_undo_method(parent, "remove_child", node)
	undo_redo.commit_action()
	return {"path": str(scene.get_path_to(node)), "type": node.get_class(), "undoAction": label}


func delete_node(arguments: Dictionary, _request: Request) -> Variant:
	var scene := EditorInterface.get_edited_scene_root()
	if scene == null:
		return SceneAccess.no_scene()
	var path: String = arguments["path"]
	var node := SceneAccess.resolve(scene, path)
	if node == null:
		return SceneAccess.not_found(path)
	if node == scene:
		return ToolError.fail("INVALID_OPERATION", "The scene root cannot be deleted")
	var parent := node.get_parent()
	var label := "MCP: delete %s" % node.name
	var undo_redo := SceneAccess.begin_action(label, scene)
	undo_redo.add_do_method(parent, "remove_child", node)
	undo_redo.add_undo_method(parent, "add_child", node)
	undo_redo.add_undo_method(parent, "move_child", node, node.get_index())
	_restore_owners(undo_redo, false, _owners(node))
	undo_redo.add_undo_reference(node)
	undo_redo.commit_action()
	return {"path": path, "undoAction": label}


func move_node(arguments: Dictionary, _request: Request) -> Variant:
	var scene := EditorInterface.get_edited_scene_root()
	if scene == null:
		return SceneAccess.no_scene()
	var path: String = arguments["path"]
	var node := SceneAccess.resolve(scene, path)
	if node == null:
		return SceneAccess.not_found(path)
	if node == scene:
		return ToolError.fail("INVALID_OPERATION", "The scene root cannot be moved")
	var new_path: String = arguments["newParentPath"]
	var new_parent := SceneAccess.resolve(scene, new_path)
	if new_parent == null:
		return SceneAccess.not_found(new_path)
	if new_parent == node or node.is_ancestor_of(new_parent):
		return ToolError.fail("INVALID_MOVE", "A node cannot move into itself or its descendant")
	var old_parent := node.get_parent()
	if new_parent != old_parent and new_parent.get_node_or_null(NodePath(str(node.name))) != null:
		return ToolError.fail("DUPLICATE_NAME", "%s already has a child named %s" % [new_parent.name, node.name])
	var siblings := new_parent.get_child_count() - (1 if new_parent == old_parent else 0)
	var index := int(arguments.get("index", siblings))
	if index > siblings:
		return ToolError.fail("INVALID_ARGUMENT", "index must be at most %d" % siblings)
	var owners := _owners(node)
	var label := "MCP: move %s" % node.name
	var undo_redo := SceneAccess.begin_action(label, scene)
	undo_redo.add_do_method(old_parent, "remove_child", node)
	undo_redo.add_do_method(new_parent, "add_child", node)
	undo_redo.add_do_method(new_parent, "move_child", node, index)
	_restore_owners(undo_redo, true, owners)
	undo_redo.add_undo_method(new_parent, "remove_child", node)
	undo_redo.add_undo_method(old_parent, "add_child", node)
	undo_redo.add_undo_method(old_parent, "move_child", node, node.get_index())
	_restore_owners(undo_redo, false, owners)
	undo_redo.commit_action()
	return {"path": str(scene.get_path_to(node)), "undoAction": label}


# [node, owner] for `node` and every descendant, parents first.
func _owners(node: Node) -> Array:
	var out := [[node, node.owner]]
	for descendant in node.find_children("*", "", true, false):
		out.append([descendant, descendant.owner])
	return out


func _restore_owners(undo_redo: EditorUndoRedoManager, forward: bool, owners: Array) -> void:
	for pair: Array in owners:
		if pair[1] == null:
			continue
		if forward:
			undo_redo.add_do_method(pair[0], "set_owner", pair[1])
		else:
			undo_redo.add_undo_method(pair[0], "set_owner", pair[1])
