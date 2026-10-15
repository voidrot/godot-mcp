@tool
extends RefCounted

## JSON-RPC and MCP for the 2025-11-25 era, served statelessly with JSON responses only (D25, D36).

const Schema := preload("schema.gd")

const SUPPORTED_VERSIONS: Array[String] = ["2025-11-25", "2025-06-18", "2025-03-26"]
const MAX_RESPONSE_BYTES := 4 * 1024 * 1024

# shortcut: placeholder until slice 7 writes the real text (at most 2,000 characters, D39).
const INSTRUCTIONS := "This server is the open Godot editor. Call get_project_info first to see the project, the open scenes and the editor state."

var _version: String
# Each provider has tools() -> Array[Dictionary]; held here because handler Callables don't keep it alive.
var _providers: Array
# name -> {definition: Dictionary, handler: Callable}
var _tools := {}


func _init(version: String, providers: Array) -> void:
	_version = version
	_providers = providers
	for provider: Object in providers:
		_register(provider.tools())


func _register(tools: Array[Dictionary]) -> void:
	for tool in tools:
		var definition := tool.duplicate()
		definition.erase("handler")
		_tools[tool["name"]] = {"definition": definition, "handler": tool["handler"]}


# Answers one POST body. Returns [http_status, body]. A coroutine when a tool handler awaits.
func handle(body: PackedByteArray, headers: Dictionary) -> Array:
	var json := JSON.new()
	if json.parse(body.get_string_from_utf8()) != OK:
		return [400, _error(null, -32700, "Parse error: " + json.get_error_message())]
	if json.data is Array:
		return [400, _error(null, -32600, "Batch requests are not supported")]
	if not json.data is Dictionary:
		return [400, _error(null, -32600, "Invalid Request: expected an object")]
	var message: Dictionary = json.data
	var id: Variant = message.get("id")
	if message.has("id") and not (id is String or id is float):
		return [400, _error(null, -32600, "Invalid Request: id must be a string or a number")]
	# JSON numbers parse as floats; echo whole ids as ints so the reply carries "id":1, not 1.0.
	if id is float and absf(id) <= 9007199254740991.0 and id == floorf(id):
		id = int(id)
	if not message.get("jsonrpc") is String or message["jsonrpc"] != "2.0":
		return [400, _error(id, -32600, "Invalid Request: jsonrpc must be \"2.0\"")]
	var requested: String = headers.get("mcp-protocol-version", "")
	if requested != "" and requested not in SUPPORTED_VERSIONS:
		var data := {"supported": SUPPORTED_VERSIONS, "requested": requested}
		return [400, _error(id, -32600, "Unsupported MCP-Protocol-Version: " + requested, data)]
	if not message.has("method"):
		if message.has("id") and (message.has("result") or message.has("error")):
			return [202, ""]
		return [400, _error(id, -32600, "Invalid Request: no method")]
	if not message["method"] is String:
		return [400, _error(id, -32600, "Invalid Request: method must be a string")]
	if not message.has("id"):
		return [202, ""]
	var params: Variant = message.get("params", {})
	if not params is Dictionary:
		return [200, _error(id, -32602, "params must be an object")]
	var outcome: Dictionary = await _dispatch(message["method"], params)
	if outcome.has("error"):
		return [200, _error(id, outcome["error"]["code"], outcome["error"]["message"])]
	if not outcome.has("result"):
		# A script error during dispatch returns an empty Dictionary.
		return [200, _error(id, -32603, "Internal error")]
	var text := JSON.stringify({"jsonrpc": "2.0", "id": id, "result": outcome["result"]})
	if text.to_utf8_buffer().size() > MAX_RESPONSE_BYTES:
		return [200, _error(id, -32603, "Response exceeds %d bytes" % MAX_RESPONSE_BYTES)]
	return [200, text]


# Returns {result} or {error: {code, message}}.
func _dispatch(method: String, params: Dictionary) -> Dictionary:
	match method:
		"initialize":
			var requested: Variant = params.get("protocolVersion")
			return {"result": {
				"protocolVersion": requested if requested in SUPPORTED_VERSIONS else SUPPORTED_VERSIONS[0],
				"capabilities": {"tools": {"listChanged": false}},
				"serverInfo": {"name": "godot-mcp", "version": _version},
				"instructions": INSTRUCTIONS,
			}}
		"ping":
			return {"result": {}}
		"tools/list":
			var definitions := []
			for name: String in _tools:
				definitions.append(_tools[name]["definition"])
			return {"result": {"tools": definitions}}
		"tools/call":
			return await _call_tool(params)
	return {"error": {"code": -32601, "message": "Method not found: " + method}}


# A tool returns its structured result, or {error: {code, message}} for a tool failure (D36).
func _call_tool(params: Dictionary) -> Dictionary:
	var name: Variant = params.get("name")
	if not name is String:
		return {"error": {"code": -32602, "message": "params.name must be a string"}}
	if not _tools.has(name):
		return {"error": {"code": -32602, "message": "Unknown tool: %s" % [name]}}
	var arguments: Variant = params.get("arguments", {})
	var tool: Dictionary = _tools[name]
	var problem := Schema.validate(arguments, tool["definition"]["inputSchema"])
	if problem != "":
		return {"error": {"code": -32602, "message": "Invalid arguments for %s: %s" % [name, problem]}}
	var structured: Variant = await tool["handler"].call(arguments)
	# A handler that hits a script error returns null or {}; that is a tool failure, never a success.
	if not structured is Dictionary or structured.is_empty():
		structured = {"error": {"code": "INTERNAL", "message": "Tool %s failed with a script error" % name}}
	return {"result": {
		"content": [{"type": "text", "text": JSON.stringify(structured)}],
		"structuredContent": structured,
		"isError": structured.has("error"),
	}}


static func _error(id: Variant, code: int, message: String, data: Variant = null) -> String:
	var error := {"code": code, "message": message}
	if data != null:
		error["data"] = data
	return JSON.stringify({"jsonrpc": "2.0", "id": id, "error": error})
