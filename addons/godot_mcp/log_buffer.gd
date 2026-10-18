@tool
extends Logger

## A ring of the editor's log lines, filled through OS.add_logger. Logger virtuals can run on any
## thread, so every access holds the mutex. Lines logged before the plugin loads are missing.

const MAX_ENTRIES := 1000
const LEVELS: Array[String] = ["info", "warning", "error"]

var _mutex := Mutex.new()
var _entries: Array[Dictionary] = []
# Sequence number of the newest entry; entries are numbered from 1.
var _seq := 0
# Entries ever logged at each level, which the ring's eviction can't lower.
var _errors := 0
var _warnings := 0


func _log_message(message: String, error: bool) -> void:
	_append({"level": "error" if error else "info", "message": message.strip_edges(false, true)})


func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, _script_backtraces: Array) -> void:
	_append({
		"level": "warning" if error_type == ERROR_TYPE_WARNING else "error",
		"message": rationale if rationale != "" else code,
		"file": file,
		"line": line,
		"function": function,
	})


func _append(entry: Dictionary) -> void:
	_mutex.lock()
	_seq += 1
	if entry["level"] == "error":
		_errors += 1
	elif entry["level"] == "warning":
		_warnings += 1
	entry["seq"] = _seq
	_entries.append(entry)
	if _entries.size() > MAX_ENTRIES:
		_entries.pop_front()
	_mutex.unlock()


# Sequence number of the newest entry, a cursor for errors_since.
func seq() -> int:
	_mutex.lock()
	var newest := _seq
	_mutex.unlock()
	return newest


# {errors, warnings}: how many entries were ever logged, for counting a span by difference.
func totals() -> Dictionary:
	_mutex.lock()
	var out := {"errors": _errors, "warnings": _warnings}
	_mutex.unlock()
	return out


# True when the ring has dropped entries logged after `cursor`, so errors_since may be missing some.
func evicted_since(cursor: int) -> bool:
	_mutex.lock()
	var oldest: int = _entries[0]["seq"] if not _entries.is_empty() else _seq + 1
	_mutex.unlock()
	return oldest > cursor + 1


# Error-level entries (and warnings, if asked) logged after `cursor` (from seq()) that are still in the ring.
func errors_since(cursor: int, with_warnings := false) -> Array[Dictionary]:
	_mutex.lock()
	var out: Array[Dictionary] = []
	for entry in _entries:
		if entry["seq"] > cursor and (entry["level"] == "error" or (with_warnings and entry["level"] == "warning")):
			out.append(entry.duplicate())
	_mutex.unlock()
	return out


# Entries after `since` at `level` or above, oldest first, at most `limit`. nextSince is the cursor
# for the next call; dropped counts entries the ring lost before they were read. A cursor ahead of the
# newest entry (kept from before a plugin reload) reads from the start, and `reset` says so.
func read(since: int, level: String, limit: int) -> Dictionary:
	var minimum := LEVELS.find(level)
	_mutex.lock()
	var reset := since > _seq
	if reset:
		since = 0
	var oldest: int = _entries[0]["seq"] if not _entries.is_empty() else _seq + 1
	var out: Array[Dictionary] = []
	var next := maxi(since, oldest - 1)
	for entry in _entries:
		if entry["seq"] <= since:
			continue
		if out.size() == limit:
			break
		next = entry["seq"]
		if LEVELS.find(entry["level"]) >= minimum:
			out.append(entry.duplicate())
	if out.size() < limit:
		next = maxi(next, _seq)
	var dropped := maxi(0, oldest - 1 - since)
	_mutex.unlock()
	return {"entries": out, "nextSince": next, "dropped": dropped, "reset": reset}
