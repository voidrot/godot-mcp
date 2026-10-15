@tool
extends RefCounted

## Errors and node lookup shared by the tools that read the edited scene.

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
