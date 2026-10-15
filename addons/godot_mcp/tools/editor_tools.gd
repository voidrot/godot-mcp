@tool
extends RefCounted

const LogBuffer := preload("../log_buffer.gd")
const Request := preload("../request.gd")

# Held here because handler Callables don't keep it alive.
var _log: LogBuffer


func _init(log: LogBuffer) -> void:
	_log = log


func tools() -> Array[Dictionary]:
	return [
		{
			"name": "get_editor_log",
			"description": "Read the editor's log (errors, warnings and printed output) since the plugin loaded. Pass the previous call's nextSince as `since` to read only newer entries. `dropped` counts entries the 1,000-entry ring lost before you read them; `reset` is true when `since` was ahead of the log (the plugin reloaded) and the read started over.",
			"inputSchema": {
				"type": "object",
				"properties": {
					"since": {"type": "integer", "minimum": 0, "description": "Cursor; default 0 reads from the oldest entry."},
					"level": {"type": "string", "enum": ["info", "warning", "error"], "description": "Lowest level to return; default info."},
					"limit": {"type": "integer", "minimum": 1, "maximum": 1000, "description": "Default 200."},
				},
				"additionalProperties": false,
			},
			"annotations": {"readOnlyHint": true},
			"handler": get_editor_log,
		},
	]


func get_editor_log(arguments: Dictionary, _request: Request) -> Variant:
	return _log.read(int(arguments.get("since", 0)), arguments.get("level", "info"), int(arguments.get("limit", 200)))
