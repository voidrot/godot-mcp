@tool
extends RefCounted

const LogBuffer := preload("../log_buffer.gd")
const NodeFactory := preload("../node_factory.gd")
const Request := preload("../request.gd")
const ResPaths := preload("../res_paths.gd")
const SceneAccess := preload("../scene_access.gd")
const ToolError := preload("../tool_error.gd")

# How long open_scene waits for the editor to finish switching.
const SWITCH_TIMEOUT_MS := 10000

# Held here because handler Callables don't keep it alive.
var _log: LogBuffer


func tools() -> Array[Dictionary]:
	return [
		{
			"name": "get_scene_tree",
			"description": "Read the edited scene's node tree, breadth first. Each node has name and type; an instanced scene shows its `instance` path and is not expanded. A node whose children are not all listed has `childCount`. `truncated` is true when maxDepth or maxNodes cut the tree.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"rootPath": {"type": "string", "description": "Node path relative to the scene root; default is the root."},
					"maxDepth": {"type": "integer", "minimum": 0, "maximum": 64, "description": "Default 8."},
					"maxNodes": {"type": "integer", "minimum": 1, "maximum": 10000, "description": "Default 2000."},
				},
				"additionalProperties": false,
			},
			"annotations": {"readOnlyHint": true},
			"handler": get_scene_tree,
		},
		{
			"name": "open_scene",
			"description": "Open a .tscn or .scn file in the editor and make it the edited scene. Returns once the switch has finished.",
			"inputSchema": {
				"type": "object",
				"properties": {"path": {"type": "string", "description": "res:// path of the scene."}},
				"required": ["path"],
				"additionalProperties": false,
			},
			"handler": open_scene,
		},
		{
			"name": "create_scene",
			"description": "Create a new .tscn whose root is a node of class `rootType`, then open it as the edited scene. Refuses a path that already exists. The directory must exist.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"path": {"type": "string", "description": "res:// path ending in .tscn."},
					"rootType": {"type": "string", "description": "A concrete Node class such as Node2D."},
					"rootName": {"type": "string", "description": "Default is the file name in PascalCase."},
				},
				"required": ["path", "rootType"],
				"additionalProperties": false,
			},
			"handler": create_scene,
		},
		{
			"name": "save_scene",
			"description": "Save the edited scene to its file. Fails with SAVE_FAILED when the file could not be written. Edits made by other tools exist only in the editor until this runs.",
			"inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
			"handler": save_scene,
		},
	]


func _init(log: LogBuffer) -> void:
	_log = log


func get_scene_tree(arguments: Dictionary, _request: Request) -> Variant:
	var scene := EditorInterface.get_edited_scene_root()
	if scene == null:
		return SceneAccess.no_scene()
	var root_path: String = arguments.get("rootPath", "")
	var start := SceneAccess.resolve(scene, root_path)
	if start == null:
		return SceneAccess.not_found(root_path)
	var max_depth := int(arguments.get("maxDepth", 8))
	var max_nodes := int(arguments.get("maxNodes", 2000))
	var truncated := false
	var count := 1
	var root := _entry(start, scene)
	# Breadth first, so a cut drops the deepest nodes first. Each item is [node, entry, depth].
	var queue := [[start, root, 0]]
	var head := 0
	while head < queue.size():
		var item: Array = queue[head]
		head += 1
		var node: Node = item[0]
		var entry: Dictionary = item[1]
		if node != scene and node.scene_file_path != "":
			continue
		var owned: Array[Node] = []
		for child in node.get_children():
			if child.owner == scene:
				owned.append(child)
		var children := []
		if item[2] < max_depth:
			for child in owned:
				if count >= max_nodes:
					break
				count += 1
				var child_entry := _entry(child, scene)
				children.append(child_entry)
				queue.append([child, child_entry, item[2] + 1])
		if not children.is_empty():
			entry["children"] = children
		if children.size() < owned.size():
			entry["childCount"] = owned.size()
			truncated = true
	return {"scenePath": scene.scene_file_path, "truncated": truncated, "root": root}


func _entry(node: Node, scene: Node) -> Dictionary:
	var entry := {"name": str(node.name), "type": node.get_class()}
	if node != scene and node.scene_file_path != "":
		entry["instance"] = node.scene_file_path
	return entry


func open_scene(arguments: Dictionary, request: Request) -> Variant:
	var path: String = arguments["path"]
	var problem := ResPaths.check_file(path, ["tscn", "scn"])
	if not problem.is_empty():
		return problem
	var current := EditorInterface.get_edited_scene_root()
	if current != null and current.scene_file_path == path:
		return {"editedScene": path}
	EditorInterface.open_scene_from_path(path)
	# The switch is asynchronous (A11 notes); an immediate read would still see the old scene.
	var deadline := Time.get_ticks_msec() + SWITCH_TIMEOUT_MS
	while Time.get_ticks_msec() < deadline:
		if not await request.next_frame():
			return ToolError.fail("CANCELLED", "The request was cancelled")
		var edited := EditorInterface.get_edited_scene_root()
		if edited != null and edited.scene_file_path == path:
			return {"editedScene": path}
	return ToolError.fail("SCENE_SWITCH_TIMEOUT", "The editor did not switch to %s within %d ms; see get_editor_log" % [path, SWITCH_TIMEOUT_MS])


func create_scene(arguments: Dictionary, request: Request) -> Variant:
	var path: String = arguments["path"]
	var problem := ResPaths.check_new_file(path, ["tscn"])
	if not problem.is_empty():
		return problem
	var made := NodeFactory.make(arguments["rootType"])
	if made.has("error"):
		return made
	var root: Node = made["node"]
	var name: String = arguments.get("rootName", path.get_file().get_basename().to_pascal_case())
	if name == "" or name.validate_node_name() != name:
		root.free()
		return ToolError.fail("INVALID_VALUE", "rootName must be non-empty and contain none of: . : @ / \" %")
	root.name = name
	var packed := PackedScene.new()
	var err := packed.pack(root)
	root.free()
	if err == OK:
		err = ResourceSaver.save(packed, path)
	if err != OK:
		return ToolError.fail("SAVE_FAILED", "Could not write %s (%s)" % [path, error_string(err)])
	EditorInterface.get_resource_filesystem().update_file(path)
	var opened: Variant = await open_scene({"path": path}, request)
	if opened is Dictionary and opened.has("error"):
		return opened
	return {"path": path}


func save_scene(_arguments: Dictionary, _request: Request) -> Variant:
	var scene := EditorInterface.get_edited_scene_root()
	if scene == null:
		return SceneAccess.no_scene()
	var path := scene.scene_file_path
	if path == "":
		return ToolError.fail("SAVE_FAILED", "The edited scene has no file yet")
	var problem := SceneAccess.save_problem(path)
	if not problem.is_empty():
		return problem
	var cursor := _log.seq()
	var err := EditorInterface.save_scene()
	# save_scene returns OK even when the write failed, so the unsaved list and the log decide too.
	var errors := _log.errors_since(cursor).filter(func(entry: Dictionary) -> bool: return not _is_thumbnail_noise(entry))
	var overflowed := _log.evicted_since(cursor)
	if err != OK or path in EditorInterface.get_unsaved_scenes() or not errors.is_empty() or overflowed:
		var detail: String = "the editor log overflowed during the save; see get_editor_log" if overflowed else (errors[0]["message"] if not errors.is_empty() else error_string(err))
		return ToolError.fail("SAVE_FAILED", "Could not save %s: %s" % [path, detail])
	return {"path": path}


# The headless editor's dummy renderer fails the thumbnail step of every scene save.
func _is_thumbnail_noise(entry: Dictionary) -> bool:
	return entry.get("function") == "texture_2d_get" and str(entry["message"]).begins_with("Parameter \"t\" is null")
