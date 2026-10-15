@tool
extends RefCounted

## One in-flight MCP request. The transport sets `cancelled` when it stops waiting for the handler
## (execution budget spent, or the client left). The transport keeps the FIFO until the handler returns,
## so a handler that awaits must do so through next_frame() and return as soon as that gives false (D37).

var cancelled := false


# Waits one editor frame. Returns false when the request was cancelled in the meantime.
func next_frame() -> bool:
	await (Engine.get_main_loop() as SceneTree).process_frame
	return not cancelled
