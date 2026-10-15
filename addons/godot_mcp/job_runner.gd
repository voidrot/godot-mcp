@tool
extends RefCounted

## Runs one Godot child process to completion without blocking the editor (D44). It reads both pipes a
## few KB per frame, parses stderr as it arrives, and on a timeout or a cancelled request kills the
## child's whole process group. The child runs under coreutils `timeout`, which also ends it if the
## editor dies first. Limits: no graceful stop; a descendant that calls setsid escapes the group kill;
## the child's stdin is a pipe nobody closes, so a game that reads stdin waits for the timeout;
## Linux only (macOS has no `timeout`).

const OutputParser := preload("output_parser.gd")
const Request := preload("request.gd")
const ToolError := preload("tool_error.gd")

const TAIL_BYTES := 64 * 1024
# Read at most this much from each pipe per frame, so a chatty child can't stall the editor.
const FRAME_READ_BYTES := 64 * 1024
# After the child exits, the pipes hold at most their kernel buffer (64 KB) each.
const DRAIN_ROUNDS := 4
# timeout's own limit is the job's plus this, then SIGKILL after ORPHAN_KILL_SEC more.
const ORPHAN_GRACE_SEC := 60
const ORPHAN_KILL_SEC := 5

var _pid := 0
var _timeout_found: Variant = null


## The last bytes of a stream, capped at TAIL_BYTES.
class Tail:
	var bytes := PackedByteArray()
	var truncated := false

	func push(chunk: PackedByteArray) -> void:
		bytes.append_array(chunk)
		if bytes.size() > TAIL_BYTES:
			bytes = bytes.slice(bytes.size() - TAIL_BYTES)
			truncated = true


## Runs this editor's own binary with `args`, for at most `timeout_ms`. A coroutine. Returns the
## RunResult dictionary, or a tool failure when the child can't start or the request is cancelled.
func run(args: PackedStringArray, timeout_ms: int, request: Request) -> Dictionary:
	if not _have_timeout():
		return ToolError.fail("SPAWN_FAILED", "The `timeout` command (GNU coreutils) is not on PATH; jobs run under it so that an orphaned child ends if the editor dies")
	var started := Time.get_ticks_msec()
	# timeout leads the child's group (execute_with_pipe calls setsid), so -pid still names the whole
	# group. It is the backstop that ends the child if the editor is killed before it can: SIGTERM and
	# SIGINT stop the editor without running _exit_tree.
	var limit_sec := ceili(timeout_ms / 1000.0) + ORPHAN_GRACE_SEC
	var wrapped := PackedStringArray(["-k", str(ORPHAN_KILL_SEC), str(limit_sec), OS.get_executable_path()]) + args
	var spawned := OS.execute_with_pipe("timeout", wrapped, false)
	if spawned.is_empty():
		return ToolError.fail("SPAWN_FAILED", "Could not start " + OS.get_executable_path())
	var pid: int = spawned["pid"]
	_pid = pid
	var stdout := Tail.new()
	var stderr := Tail.new()
	var parser := OutputParser.new()
	var timed_out := false
	while true:
		_drain(spawned["stdio"], stdout, null, FRAME_READ_BYTES)
		_drain(spawned["stderr"], stderr, parser, FRAME_READ_BYTES)
		if not OS.is_process_running(pid):
			break
		if Time.get_ticks_msec() - started >= timeout_ms:
			timed_out = true
			break
		var alive := await request.next_frame()
		if _pid != pid:
			# kill() ran meanwhile (the plugin is unloading).
			return ToolError.fail("CANCELLED", "The job was stopped")
		if not alive:
			kill()
			return ToolError.fail("CANCELLED", "The request was cancelled; the job was killed")
	var exit_code: Variant = null
	if timed_out:
		kill()
	else:
		# For a child that died from signal N, Godot reports N: it can't tell that from exit(N).
		exit_code = OS.get_process_exit_code(pid)
		# The child is reaped; kill what it left in its group (an empty group is a harmless ESRCH).
		kill()
		# The deadline passing without a kill means the editor stalled; the run still timed out.
		timed_out = Time.get_ticks_msec() - started >= timeout_ms
	for _round in DRAIN_ROUNDS:
		_drain(spawned["stdio"], stdout, null, TAIL_BYTES)
		_drain(spawned["stderr"], stderr, parser, TAIL_BYTES)
	parser.end()
	return {
		# Godot exits 0 after script errors, so the exit code alone proves nothing.
		"ok": exit_code == 0 and not timed_out and parser.error_count == 0,
		"exitCode": exit_code,
		"timedOut": timed_out,
		"durationMs": Time.get_ticks_msec() - started,
		"diagnostics": parser.diagnostics,
		"errorCount": parser.error_count,
		"warningCount": parser.warning_count,
		"stdoutTail": OutputParser.decode(stdout.bytes),
		"stderrTail": OutputParser.decode(stderr.bytes),
		"truncated": stdout.truncated or stderr.truncated or parser.dropped(),
	}


# Whether `timeout` can run; asked once, since PATH doesn't change under a running editor.
func _have_timeout() -> bool:
	if _timeout_found == null:
		_timeout_found = OS.execute("timeout", ["--version"]) == 0
	return _timeout_found


## SIGKILLs the running child's process group (the child leads its own group, so -pid names it). Never
## asks about the pid afterwards: OS.kill reaps it, and is_process_running would then log ECHILD.
func kill() -> void:
	if _pid != 0:
		OS.kill(-_pid)
		_pid = 0


# Reads what is ready on `pipe`, at most `limit` bytes, into the tail and the parser.
func _drain(pipe: FileAccess, tail: Tail, parser: OutputParser, limit: int) -> void:
	var left := limit
	while left > 0:
		var ready := mini(pipe.get_length(), left)
		if ready <= 0:
			return
		var chunk := pipe.get_buffer(ready)
		tail.push(chunk)
		if parser != null:
			parser.push(chunk)
		left -= ready
