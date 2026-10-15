@tool
extends RefCounted

## Validates caller-supplied res:// paths (D38). Strict, because Godot normalizes a path (backslash
## becomes a separator) after any check on the raw text, so only an already-normal path is accepted.

const ToolError := preload("tool_error.gd")

const MAX_PATH_CHARS := 4096


# Returns {} when `path` names an existing file with one of `extensions` (lowercase, no dot),
# otherwise a tool failure. Rejects `..`, backslashes, colons, control characters, anything under
# res://.godot/ (any case), and link components.
static func check_file(path: String, extensions: Array[String]) -> Dictionary:
	if path.length() > MAX_PATH_CHARS:
		return ToolError.fail("INVALID_PATH", "path is longer than %d characters" % MAX_PATH_CHARS)
	if not path.begins_with("res://"):
		return ToolError.fail("INVALID_PATH", "path must start with res://")
	var rest := path.trim_prefix("res://")
	if rest.contains("\\") or rest.contains(":"):
		return ToolError.fail("INVALID_PATH", "path must not contain backslashes or colons")
	for i in rest.length():
		if rest.unicode_at(i) < 32:
			return ToolError.fail("INVALID_PATH", "path must not contain control characters")
	if path.simplify_path() != path:
		return ToolError.fail("INVALID_PATH", "path must be normalized: no empty, . or .. segments, no trailing slash")
	var parts := rest.split("/")
	# simplify_path keeps a leading .. (nothing above the root to cancel it), so check segments too.
	if ".." in parts:
		return ToolError.fail("INVALID_PATH", "path must not contain .. segments")
	if parts[0].to_lower() == ".godot":
		return ToolError.fail("INVALID_PATH", "path must not be under res://.godot/")
	if path.get_extension().to_lower() not in extensions:
		return ToolError.fail("INVALID_PATH", "path must end in one of: " + ", ".join(extensions))
	var access := DirAccess.open("res://")
	var current := ProjectSettings.globalize_path("res://").rstrip("/")
	for part in parts:
		current = current.path_join(part)
		if access.is_link(current):
			return ToolError.fail("INVALID_PATH", "path must not pass through a symbolic link: " + part)
		if not access.file_exists(current) and not access.dir_exists(current):
			break
	if not FileAccess.file_exists(path):
		return ToolError.fail("FILE_NOT_FOUND", "No such file: " + path)
	return {}
