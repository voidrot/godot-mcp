@tool
extends RefCounted

## Installs the agent skill and builds the .mcp.json entry (D40). The Project > Tools menu and the
## install_agent_skill tool both call install(), so the two can't disagree. POSIX only (D29): the
## headersHelper is a POSIX shell command, so Windows is refused.

const ToolError := preload("tool_error.gd")

const SERVER_NAME := "godot-editor"
const TIMEOUT_MS := 600000
const TOKEN_PATH := "res://.godot/godot_mcp/headers.json"
const SKILL_DIR := ".claude/skills/godot-mcp"
# Every path a write could pass through. The .tmp is last: a link there is a link too.
const LINKED_PATHS: Array[String] = [".claude", ".claude/skills", SKILL_DIR, SKILL_DIR + "/SKILL.md", SKILL_DIR + "/SKILL.md.tmp"]
# D40's marker: godot_mcp: "true" indented under a top-level metadata: key, in the frontmatter.
static var MARKER := RegEx.create_from_string("(?m)^metadata:[ \\t]*\\n(?:[ \\t][^\\n]*\\n)*?[ \\t]+godot_mcp:[ \\t]*\"true\"[ \\t]*$")

# The port the server listens on, or 0 when it is not listening.
var _port: int


func _init(port: int) -> void:
	_port = port


# Writes the addon's SKILL.md unless it already matches. Returns {skillPath, changed, mcpJson}, or a
# tool failure. A failure carries mcpJson whenever the entry could be built, so the user can still
# connect. Never writes .mcp.json or project settings.
func install(overwrite: bool) -> Dictionary:
	var failure := platform_failure(OS.get_name())
	if failure.is_empty() and _port == 0:
		failure = ToolError.fail("NOT_LISTENING", "The MCP server is not listening, so there is no port to point at.")
	if not failure.is_empty():
		return failure
	var entry := _mcp_entry()
	if entry.has("error"):
		return entry
	var result := _write_skill(overwrite)
	result["mcpJson"] = entry["mcpJson"]
	return result


static func platform_failure(os_name: String) -> Dictionary:
	if os_name == "Windows":
		return ToolError.fail("UNSUPPORTED_PLATFORM", "Setup does not support Windows: the headersHelper is a POSIX shell command.")
	return {}


# Project > Tools entry: installs the skill and shows the .mcp.json entry to copy. The entry shows
# even when the skill can't be written; only a refusal that leaves no entry hides it.
func show_dialog(parent: Control) -> void:
	var result := install(false)
	var dialog := AcceptDialog.new()
	dialog.title = "Godot MCP"
	var box := VBoxContainer.new()
	var status := Label.new()
	status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	if result.has("error"):
		status.text = result["error"]["message"]
	else:
		status.text = "%s %s" % [result["skillPath"], "written." if result["changed"] else "already up to date."]
	box.add_child(status)
	dialog.add_child(box)
	if result.has("mcpJson"):
		var json := JSON.stringify(result["mcpJson"], "  ")
		var entry := TextEdit.new()
		entry.text = json
		entry.editable = false
		entry.custom_minimum_size = Vector2(560, 220)
		box.add_child(entry)
		dialog.add_button("Copy", false, "copy")
		var copy := func(action: StringName) -> void:
			if action == &"copy":
				DisplayServer.clipboard_set(json)
		dialog.custom_action.connect(copy)
	dialog.confirmed.connect(dialog.queue_free)
	dialog.canceled.connect(dialog.queue_free)
	parent.add_child(dialog)
	dialog.popup_centered(Vector2i(600, 340))


# The .mcp.json entry (D40). Claude Code expands ${...} in headersHelper before a shell runs it, and a
# control character can't be carried in the entry, so a project path with either is refused.
func _mcp_entry() -> Dictionary:
	var token := ProjectSettings.globalize_path(TOKEN_PATH)
	if token.contains("${") or _has_control(token):
		return ToolError.fail("UNSAFE_PATH", "The project path contains ${ or a control character, which the .mcp.json headersHelper cannot carry.")
	var entry := {
		"type": "http",
		"url": "http://127.0.0.1:%d/mcp" % _port,
		"headersHelper": "cat " + _shell_quote(token),
		"timeout": TIMEOUT_MS,
	}
	return {"mcpJson": {"mcpServers": {SERVER_NAME: entry}}}


func _write_skill(overwrite: bool) -> Dictionary:
	var source := (get_script() as Script).resource_path.get_base_dir().path_join("SKILL.md")
	if not FileAccess.file_exists(source):
		return ToolError.fail("MISSING_SKILL", "The addon has no SKILL.md at " + source)
	var root := ProjectSettings.globalize_path("res://").rstrip("/")
	var skill_dir := root.path_join(SKILL_DIR)
	var skill_path := skill_dir.path_join("SKILL.md")
	var refusal := _link_refusal(root, LINKED_PATHS)
	if not refusal.is_empty():
		return refusal
	var bytes := FileAccess.get_file_as_bytes(source)
	if FileAccess.file_exists(skill_path):
		var current := FileAccess.get_file_as_bytes(skill_path)
		if current == bytes:
			return {"skillPath": skill_path, "changed": false}
		if not overwrite and not _has_marker(current):
			return ToolError.fail("FOREIGN_SKILL", "%s exists without the godot_mcp marker, so it was left alone. Delete it and run this again, or have the agent call install_agent_skill with overwrite set." % skill_path)
	var written := _write(root, skill_dir, skill_path, bytes)
	if written.has("error"):
		return written
	return {"skillPath": skill_path, "changed": true}


# POSIX single quotes keep everything literal except the quote itself, which closes, escapes and reopens.
static func _shell_quote(text: String) -> String:
	return "'" + text.replace("'", "'\\''") + "'"


static func _has_control(text: String) -> bool:
	for i in text.length():
		var code := text.unicode_at(i)
		if code < 32 or code == 127:
			return true
	return false


# The skill counts as ours when its frontmatter, the block between the first two --- lines, has MARKER.
static func _has_marker(bytes: PackedByteArray) -> bool:
	var text := bytes.get_string_from_utf8()
	if not text.begins_with("---\n"):
		return false
	var end := text.find("\n---", 3)
	return end != -1 and MARKER.search(text.substr(0, end)) != null


# Refuses when any path (relative to root) is a link. lstat semantics: a dangling link counts too.
static func _link_refusal(root: String, relative: Array[String]) -> Dictionary:
	var access := DirAccess.open(root)
	if access == null:
		return ToolError.fail("WRITE_FAILED", "Cannot open %s (%s)" % [root, error_string(DirAccess.get_open_error())])
	for path in relative:
		if access.is_link(root.path_join(path)):
			return ToolError.fail("IS_LINK", "%s is a symbolic link; refusing to write through it." % path)
	return {}


# Stages the bytes in path.tmp and renames it over path. The links are checked again just before the
# rename, so a link that appears after the first check stops the rename; a link swapped in at path.tmp
# before staging is still followed by the editor's safe-save (needs a concurrent local writer).
static func _write(root: String, dir: String, path: String, bytes: PackedByteArray) -> Dictionary:
	var tmp := path + ".tmp"
	var err := _stage(dir, tmp, bytes)
	if err == OK:
		var refusal := _link_refusal(root, LINKED_PATHS)
		if not refusal.is_empty():
			_discard(root, tmp)
			return refusal
		err = DirAccess.rename_absolute(tmp, path)
	if err != OK:
		_discard(root, tmp)
		return ToolError.fail("WRITE_FAILED", "Could not write %s (%s)" % [path, error_string(err)])
	return {}


# Writes tmp and reads it back, since Godot buffers small writes until close and close ignores a failed flush.
static func _stage(dir: String, tmp: String, bytes: PackedByteArray) -> Error:
	var err := DirAccess.make_dir_recursive_absolute(dir)
	if err != OK:
		return err
	var file := FileAccess.open(tmp, FileAccess.WRITE)
	if file == null:
		return FileAccess.get_open_error()
	var stored := file.store_buffer(bytes)
	err = file.get_error()
	file.close()
	if err != OK:
		return err
	if not stored:
		return ERR_FILE_CANT_WRITE
	return OK if FileAccess.get_file_as_bytes(tmp) == bytes else ERR_FILE_CORRUPT


# Removes a stale .tmp, but never a link: unlinking one the user placed is not ours to do.
static func _discard(root: String, tmp: String) -> void:
	var access := DirAccess.open(root)
	if access != null and not access.is_link(tmp):
		DirAccess.remove_absolute(tmp)
