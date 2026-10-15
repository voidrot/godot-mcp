@tool
extends RefCounted

## Parses a Godot process's stderr as it arrives (D45; a port of v0's output-parser.ts). Every
## diagnostic is counted, but only the first MAX_DIAGNOSTICS are kept, so a flood of output can't hide
## a failure. Lines are split on bytes before decoding, so a multibyte character split across chunks
## stays whole.

const MAX_DIAGNOSTICS := 200
# Bounds memory and the reply size (4 MB): a longer line is cut, and a stack keeps its first frames.
const MAX_LINE_CHARS := 1000
const MAX_LINE_BYTES := 64 * 1024
const MAX_STACK_FRAMES := 10
# All kept diagnostic text (messages, files, stack frames) together. The reply carries it twice
# (structured and as text) at up to 13 bytes per character once escaped, beside two 64 KB tails, and
# must stay under 4 MB; the text past this is dropped, though still counted.
const MAX_DIAGNOSTIC_CHARS := 120000

# Line numbers have at most 9 digits: int() of a longer run logs an engine error per line.
static var _HEADER := RegEx.create_from_string("^(USER SCRIPT ERROR|USER ERROR|USER WARNING|SCRIPT ERROR|SCRIPT WARNING|ERROR|WARNING): (.*)$")
static var _LOCATION := RegEx.create_from_string("^\\s+at: .+? \\((.+):(\\d{1,9})\\)\\s*$")
static var _BACKTRACE_HEADER := RegEx.create_from_string("^\\s+GDScript backtrace \\(most recent call first\\):\\s*$")
static var _BACKTRACE_FRAME := RegEx.create_from_string("^\\s+\\[\\d+\\] (.+?) \\((.+):(\\d{1,9})\\)\\s*$")
static var _DOTNET_FRAME := RegEx.create_from_string("^\\s+at (\\S.*\\(.*)$")

## {severity, kind, message, file?, line?, stack?}
var diagnostics: Array[Dictionary] = []
var error_count := 0
var warning_count := 0

var _pending := PackedByteArray()
var _current := {}
var _in_backtrace := false
# False once the current diagnostic was left out of `diagnostics`.
var _kept := false
var _chars_left := MAX_DIAGNOSTIC_CHARS
var _clipped := false
# After an over-long line was cut, the rest of it is skipped up to its newline.
var _skipping := false


## True when diagnostics or their text were dropped.
func dropped() -> bool:
	return _clipped or error_count + warning_count > diagnostics.size()


## Chunks may split a line anywhere.
func push(chunk: PackedByteArray) -> void:
	if _skipping:
		var newline := chunk.find(10)
		if newline == -1:
			return
		chunk = chunk.slice(newline + 1)
		_skipping = false
	_pending.append_array(chunk)
	var start := 0
	var newline := _pending.find(10, start)
	while newline != -1:
		_line(_pending.slice(start, newline))
		start = newline + 1
		newline = _pending.find(10, start)
	_pending = _pending.slice(start)
	# Binary output may never contain a newline; the first 64 KB count as one line and the rest of it is skipped.
	if _pending.size() > MAX_LINE_BYTES:
		_line(_pending)
		_pending = PackedByteArray()
		_skipping = true


## Flushes a final line that had no newline.
func end() -> void:
	if not _pending.is_empty():
		_line(_pending)
	_pending = PackedByteArray()
	_current = {}


## Decodes bytes as UTF-8, replacing every invalid byte with "?". String.utf8 would log one engine
## error per invalid byte, which a child's output could use to flood the editor log.
static func decode(bytes: PackedByteArray) -> String:
	var clean := bytes.duplicate()
	var i := 0
	var size := bytes.size()
	while i < size:
		var lead := bytes[i]
		if lead < 0x80:
			if lead == 0:
				clean[i] = 0x3F
			i += 1
			continue
		var length := 0
		var low := 0x80
		var high := 0xBF
		if lead >= 0xC2 and lead <= 0xDF:
			length = 2
		elif lead >= 0xE0 and lead <= 0xEF:
			length = 3
			if lead == 0xE0:
				low = 0xA0
			elif lead == 0xED:
				high = 0x9F
		elif lead >= 0xF0 and lead <= 0xF4:
			length = 4
			if lead == 0xF0:
				low = 0x90
			elif lead == 0xF4:
				high = 0x8F
		var valid := length > 0 and i + length <= size
		if valid:
			for j in range(1, length):
				var next := bytes[i + j]
				if next < (low if j == 1 else 0x80) or next > (high if j == 1 else 0xBF):
					valid = false
					break
		if valid:
			i += length
		else:
			clean[i] = 0x3F
			i += 1
	return clean.get_string_from_utf8()


func _line(bytes: PackedByteArray) -> void:
	if not bytes.is_empty() and bytes[bytes.size() - 1] == 13:
		bytes = bytes.slice(0, bytes.size() - 1)
	var line := decode(bytes).left(MAX_LINE_CHARS)
	var header := _HEADER.search(line)
	if header != null:
		_start(header.get_string(1), header.get_string(2))
		return
	if _current.is_empty():
		return
	if _BACKTRACE_HEADER.search(line) != null:
		_in_backtrace = true
		return
	var frame := _BACKTRACE_FRAME.search(line) if _in_backtrace else null
	if frame != null:
		var text := "%s (%s:%s)" % [frame.get_string(1), frame.get_string(2), frame.get_string(3)]
		var first := not _current.has("stack")
		# The first frame is the script location; the `at:` line of push_error only names the engine's C++ source.
		# Its file is stored a second time, so it is charged again.
		if _add_frame(text) and first and _spend(frame.get_string(2).length()):
			_current["file"] = frame.get_string(2)
			_current["line"] = int(frame.get_string(3))
		return
	var location := _LOCATION.search(line)
	if location != null:
		if _spend(location.get_string(1).length()):
			_current["file"] = location.get_string(1)
			_current["line"] = int(location.get_string(2))
		return
	var dotnet := _DOTNET_FRAME.search(line)
	if dotnet != null:
		_add_frame(dotnet.get_string(1).strip_edges())
		return
	# Anything else is ordinary output and ends the diagnostic.
	_current = {}
	_in_backtrace = false


func _start(kind: String, message: String) -> void:
	var severity := "warning" if kind.ends_with("WARNING") else "error"
	if severity == "error":
		error_count += 1
	else:
		warning_count += 1
	_current = {"severity": severity, "kind": kind, "message": message}
	_kept = diagnostics.size() < MAX_DIAGNOSTICS
	_kept = _kept and _spend(message.length())
	if _kept:
		diagnostics.append(_current)
	_in_backtrace = false


# Appends a stack frame unless the current diagnostic was dropped, has MAX_STACK_FRAMES, or the text
# budget is spent. Returns whether it was added.
func _add_frame(text: String) -> bool:
	var stack: Array = _current.get("stack", [])
	if stack.size() >= MAX_STACK_FRAMES or not _spend(text.length()):
		return false
	stack.append(text)
	_current["stack"] = stack
	return true


# Takes `chars` from the text budget for the current diagnostic. False when it was dropped or the
# budget is short, which also marks the output clipped.
func _spend(chars: int) -> bool:
	if not _kept:
		return false
	if chars > _chars_left:
		_clipped = true
		return false
	_chars_left -= chars
	return true
