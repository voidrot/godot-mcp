@tool
extends RefCounted

## Makes the nodes add_node and create_scene put into a scene, after checking what may be created.

const ResPaths := preload("res_paths.gd")
const ToolError := preload("tool_error.gd")


# Returns {node} with a fresh, unparented node, or a tool failure. Only native, concrete, non-editor
# Node classes qualify, so no script class runs on creation.
static func make(type: String) -> Dictionary:
	if not ClassDB.class_exists(type):
		return ToolError.fail("INVALID_TYPE", "Unknown class: " + type)
	if not ClassDB.is_parent_class(type, "Node"):
		return ToolError.fail("INVALID_TYPE", "%s is not a Node" % type)
	if not ClassDB.can_instantiate(type):
		return ToolError.fail("INVALID_TYPE", "%s is abstract and cannot be instantiated" % type)
	if ClassDB.class_get_api_type(type) in [ClassDB.API_EDITOR, ClassDB.API_EDITOR_EXTENSION]:
		return ToolError.fail("INVALID_TYPE", "%s is an editor-only class" % type)
	return {"node": ClassDB.instantiate(type)}


# Returns {node}, an instance of the scene at `path` in editor state (saved as an ExtResource), or a
# tool failure. Refuses a scene that is, or contains, the edited scene.
static func instance(path: String, edited: Node) -> Dictionary:
	var problem := ResPaths.check_file(path, ["tscn", "scn"])
	if not problem.is_empty():
		return problem
	var packed := ResourceLoader.load(path, "PackedScene") as PackedScene
	if packed == null:
		return ToolError.fail("LOAD_FAILED", "Could not load " + path)
	var node := packed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE)
	if node == null:
		return ToolError.fail("LOAD_FAILED", "Could not instantiate " + path)
	var all: Array[Node] = [node]
	all.append_array(node.find_children("*", "", true, false))
	for candidate in all:
		if edited.scene_file_path != "" and candidate.scene_file_path == edited.scene_file_path:
			node.free()
			return ToolError.fail("SCENE_CYCLE", "%s would contain the edited scene" % path)
	return {"node": node}
