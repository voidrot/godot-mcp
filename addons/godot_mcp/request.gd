@tool
extends RefCounted

## One in-flight MCP request. The transport sets `cancelled` when it stops waiting for the handler
## (execution budget spent, or the client left). The transport keeps the FIFO until the handler returns,
## so a handler that awaits must do so through next_frame() and return as soon as that gives false (D37).

var cancelled := false
## Set by extend_budget; the transport applies it at its next poll and clears it.
var budget_ms := 0
## The JSON-RPC id this request was queued under, or null; owned by McpServer.
var rpc_id: Variant = null
## True once the handler has handed the FIFO back (extend_budget with release_queue).
var detached := false


## Asks the transport for `ms` of execution budget from now, instead of the default. A handler that
## touches only its own child process passes release_queue, so other requests run meanwhile (D37).
func extend_budget(ms: int, release_queue := false) -> void:
	budget_ms = ms
	detached = release_queue


# Waits one editor frame. Returns false when the request was cancelled in the meantime.
func next_frame() -> bool:
	await (Engine.get_main_loop() as SceneTree).process_frame
	return not cancelled
