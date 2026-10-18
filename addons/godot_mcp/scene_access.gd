@tool
extends RefCounted

## Errors and node lookup shared by the tools that read the edited scene.

const ResPaths := preload("res_paths.gd")
const ToolError := preload("tool_error.gd")


static func no_scene() -> Dictionary:
	return ToolError.fail("NO_SCENE", "No scene is open. Call open_scene first.")


static func not_found(path: String) -> Dictionary:
	return ToolError.fail("NODE_NOT_FOUND", "No node at '%s' in the edited scene" % path)


# Resolves a path relative to the scene root ("" or "." is the root). Only nodes the root owns
# resolve, so instance internals, editor nodes and absolute or .. paths give null.
static func resolve(root: Node, path: String) -> Node:
	if path in ["", "."]:
		return root
	var node_path := NodePath(path)
	if node_path.is_absolute() or node_path.get_subname_count() > 0:
		return null
	for i in node_path.get_name_count():
		if node_path.get_name(i) == &"..":
			return null
	var node := root.get_node_or_null(node_path)
	return node if node != null and node.owner == root else null


# {} when the scene file at `path` may be written, otherwise a SAVE_FAILED failure. The editor saves
# through a temp file and a rename, which would replace a read-only file or follow a .remap.
static func save_problem(path: String) -> Dictionary:
	var problem := ResPaths.check_file(path, ["tscn", "scn"])
	if not problem.is_empty():
		return ToolError.fail("SAVE_FAILED", "Refusing to write %s: %s" % [path, problem["error"]["message"]])
	if FileAccess.get_unix_permissions(path) & FileAccess.UNIX_WRITE_OWNER == 0:
		return ToolError.fail("SAVE_FAILED", "%s is read-only" % path)
	return {}


# Starts an undo action in the edited scene's history. The caller adds operations and commits.
static func begin_action(label: String, root: Node) -> EditorUndoRedoManager:
	var undo_redo := EditorInterface.get_editor_undo_redo()
	undo_redo.create_action(label, UndoRedo.MERGE_DISABLE, root)
	return undo_redo
