@tool
extends "output_parser.gd"

## Parses `dotnet build` output (D44). MSBuild's canonical diagnostic is
## `origin(line,col): [subcategory ]error|warning [CODE]: text`, where the origin can be anything: a
## source file, `MSBUILD`, or `x.csproj` (NuGet restore errors). Line splitting, the diagnostic cap and
## the text budget come from OutputParser. A diagnostic that repeats an earlier one is dropped and not
## counted, because MSBuild prints each again in its summary. Limit: only the first line of a message
## that spans several lines is kept, since the continuation lines carry no prefix to recognise; the
## rest is in outputTail.

# Past this many distinct diagnostics, duplicates are no longer detected, so memory stays bounded.
const MAX_SEEN := 10000

# Output is untrusted and Godot's PCRE2 has no JIT, so the whitespace runs are possessive and the
# lookbehinds keep the lazy origin from overlapping them: a line of spaces and colons would otherwise
# backtrack for tens of milliseconds, and a frame reads up to 64 KB of lines.
static var _DIAGNOSTIC := RegEx.create_from_string("^(.*?)(?:\\((\\d{1,9})(?:,(\\d{1,9}))?(?:,\\d{1,9},\\d{1,9})?\\))?(?<!\\s)\\s*+:\\s++(?:[^:\\s][^:]*?(?<=\\s))?(error|warning)(?:\\s+([A-Za-z]{1,16}\\d{1,8}))?\\s*:\\s*(.*)$")
# MSBuild appends the project that reported a compiler diagnostic: ` [/path/Game.csproj]`, or
# ` [/path/Game.csproj::TargetFramework=net8.0]` for a multi-targeted one. A diagnostic that the csproj
# itself reports in a multi-targeted build gets a bare ` [TargetFramework=net8.0]`.
static var _PROJECT_SUFFIX := RegEx.create_from_string("\\s++\\[(?:[^\\[\\]]*proj(?:::[^\\[\\]]*)?|TargetFramework=[^\\[\\]]*)\\]\\s*+$")

var _root: String
var _seen := {}


## `root` is the project directory; files under it are reported as res:// paths.
func _init(root: String) -> void:
	_root = root


## A build that exited nonzero without printing an error (a missing SDK, a host failure) would look
## clean, so it gets a BUILD_FAILED diagnostic; the output tail has the details. `env` exits 127 when
## it can't find dotnet, which is the one cause worth naming.
func note_failed_exit(exit_code: int) -> void:
	if error_count > 0:
		return
	var cause := "dotnet build exited with code %d and reported no error" % exit_code
	if exit_code == 127:
		cause = "dotnet was not found on the editor's PATH (exit 127); install the .NET SDK"
	_start("ERROR", cause + "; see outputTail")
	if _kept and _spend("BUILD_FAILED".length()):
		_current["code"] = "BUILD_FAILED"


func _line(bytes: PackedByteArray) -> void:
	if not bytes.is_empty() and bytes[bytes.size() - 1] == 13:
		bytes = bytes.slice(0, bytes.size() - 1)
	var found := _DIAGNOSTIC.search(decode(bytes).left(MAX_LINE_CHARS))
	if found == null:
		return
	var origin := found.get_string(1).strip_edges()
	var line := found.get_string(2)
	var column := found.get_string(3)
	var severity := found.get_string(4)
	var code := found.get_string(5)
	var message := _PROJECT_SUFFIX.sub(found.get_string(6), "").strip_edges()
	# `MSBUILD` and `CSC` name a tool; a location or a path-like origin names a file.
	var file := ""
	if line != "" or origin.contains("/") or origin.contains("."):
		file = _display_path(origin)
	var key := "\n".join([severity, code, file, line, column, message])
	if _seen.has(key):
		return
	if _seen.size() < MAX_SEEN:
		_seen[key] = true
	_start(severity.to_upper(), message)
	if _kept and _spend(file.length() + code.length()):
		if code != "":
			_current["code"] = code
		if file != "":
			_current["file"] = file
		if line != "":
			_current["line"] = int(line)
		if column != "":
			_current["column"] = int(column)


func _display_path(path: String) -> String:
	if path.begins_with(_root + "/"):
		return "res://" + path.trim_prefix(_root + "/")
	return path
