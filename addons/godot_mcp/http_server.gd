@tool
extends RefCounted

## The HTTP/1.1 subset the MCP endpoint needs (D27, D28), polled from the plugin's _process.
## Content-Length framing only, Connection: close on every response, non-blocking writes.
## Requests run one at a time from a FIFO (D37).

const Request := preload("request.gd")

const MAX_PEERS := 4
const MAX_HEADER_BYTES := 16 * 1024
const MAX_BODY_BYTES := 1024 * 1024
const INGRESS_MS := 5000
const WRITE_MS := 10000
# Bounds a request from the moment it is queued until it is answered, waiting included.
const EXECUTION_MS := 30000
const CHUNK_BYTES := 64 * 1024

enum State { HEAD, BODY, QUEUED, WRITING, DRAINING }

const REASONS := {
	202: "Accepted", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
	405: "Method Not Allowed", 408: "Request Timeout", 411: "Length Required", 413: "Content Too Large",
	415: "Unsupported Media Type", 431: "Request Header Fields Too Large", 500: "Internal Server Error",
}


class Peer:
	var tcp: StreamPeerTCP
	var state: int
	var deadline: int
	var inbound := PackedByteArray()
	var scanned := 0
	var body_start := 0
	var body_length := 0
	var headers := {}
	# Created when the body is complete.
	var request: Request = null
	var outbound := PackedByteArray()
	var sent := 0
	# True while request bytes may still be unread, so closing now could reset the connection.
	var unread := true


var _tcp: TCPServer
var _port: int
var _token: PackedByteArray
# func(body: PackedByteArray, headers: Dictionary, request: Request) -> [status: int, body: String];
# may be a coroutine, which must return soon after request.cancelled is set.
var _handler: Callable
# Optional. func(body: PackedByteArray, request: Request) runs when a body is complete, before the
# request waits for the FIFO; func(request: Request) runs when the request leaves, answered or dropped.
var _ingress: Callable
var _done: Callable
var _peers: Array[Peer] = []
var _queue: Array[Peer] = []
var _active: Peer = null


func _init(tcp: TCPServer, port: int, token: String, handler: Callable, ingress := Callable(), done := Callable()) -> void:
	_ingress = ingress
	_done = done
	_tcp = tcp
	_port = port
	_token = token.to_utf8_buffer()
	_handler = handler


func stop() -> void:
	for peer in _peers:
		_cancel(peer)
		peer.tcp.disconnect_from_host()
	_peers.clear()
	_queue.clear()
	_tcp.stop()


func poll() -> void:
	while _tcp.is_connection_available():
		var tcp := _tcp.take_connection()
		if _peers.size() >= MAX_PEERS:
			tcp.disconnect_from_host()
			continue
		var peer := Peer.new()
		peer.tcp = tcp
		peer.state = State.HEAD
		peer.deadline = Time.get_ticks_msec() + INGRESS_MS
		_peers.append(peer)
	# _process re-enters while a handler blocks, so iterate a copy and start no dispatch while one is active.
	for peer in _peers.duplicate():
		_poll_peer(peer)
	_apply_budget()
	while _active == null and not _queue.is_empty():
		_run(_queue.pop_front())
		_apply_budget()


# Applies what the running handler asked of its Request: a longer execution budget, and handing the
# FIFO to the next request (a job that touches only its own child, D37). A released handler is still
# bounded by its deadline and cancelled when its peer goes.
func _apply_budget() -> void:
	if _active == null:
		return
	var request := _active.request
	if request.budget_ms > 0:
		_active.deadline = Time.get_ticks_msec() + request.budget_ms
		request.budget_ms = 0
	if request.detached:
		_active = null


func _poll_peer(peer: Peer) -> void:
	peer.tcp.poll()
	if peer.tcp.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		_close(peer)
		return
	var now := Time.get_ticks_msec()
	match peer.state:
		State.HEAD, State.BODY:
			if not _read(peer):
				return
			if peer.state == State.HEAD:
				_parse_head(peer)
			if peer.state == State.BODY and peer.inbound.size() >= peer.body_start + peer.body_length:
				peer.unread = false
				peer.state = State.QUEUED
				peer.deadline = now + EXECUTION_MS
				peer.request = Request.new()
				if _ingress.is_valid():
					_ingress.call(peer.inbound.slice(peer.body_start, peer.body_start + peer.body_length), peer.request)
				_queue.append(peer)
			elif peer.state in [State.HEAD, State.BODY] and now > peer.deadline:
				_reject(peer, 408, "Request not received within %d ms" % INGRESS_MS)
		State.QUEUED:
			if now > peer.deadline:
				# A running handler keeps the FIFO until it sees the cancel at its next resume and returns,
				# so two handlers never overlap; its result is dropped because the peer is answered.
				_queue.erase(peer)
				_cancel(peer)
				_reject(peer, 500, "Request exceeded the %d ms execution budget" % EXECUTION_MS, -32603)
		State.WRITING:
			if now > peer.deadline:
				_close(peer)
			else:
				_flush(peer)
		State.DRAINING:
			if now > peer.deadline:
				_close(peer)
			else:
				_discard(peer)


# Appends what is available, never past the current limit. Returns false if the peer was closed.
func _read(peer: Peer) -> bool:
	var limit := MAX_HEADER_BYTES + 4 if peer.state == State.HEAD else peer.body_start + peer.body_length
	var wanted := mini(peer.tcp.get_available_bytes(), limit - peer.inbound.size())
	if wanted <= 0:
		return true
	var got: Array = peer.tcp.get_partial_data(wanted)
	if got[0] != OK:
		_close(peer)
		return false
	peer.inbound.append_array(got[1])
	return true


func _discard(peer: Peer) -> void:
	var available := peer.tcp.get_available_bytes()
	if available > 0:
		peer.tcp.get_partial_data(mini(available, CHUNK_BYTES))


func _parse_head(peer: Peer) -> void:
	var end := _find_blank_line(peer.inbound, peer.scanned)
	if end == -1:
		peer.scanned = maxi(0, peer.inbound.size() - 3)
		if peer.inbound.size() > MAX_HEADER_BYTES:
			_reject(peer, 431, "Header block exceeds %d bytes" % MAX_HEADER_BYTES)
		return
	if end > MAX_HEADER_BYTES:
		_reject(peer, 431, "Header block exceeds %d bytes" % MAX_HEADER_BYTES)
		return
	# Check the bytes before decoding: Godot logs one error per invalid UTF-8 byte, which a client could flood.
	for i in end:
		var byte := peer.inbound[i]
		if byte >= 0x80 or (byte < 0x20 and byte != 9 and byte != 10 and byte != 13):
			_reject(peer, 400, "Header bytes must be printable ASCII")
			return
	var lines := peer.inbound.slice(0, end).get_string_from_ascii().split("\r\n")
	var request_line := lines[0].split(" ")
	if request_line.size() != 3 or not request_line[2].begins_with("HTTP/1."):
		_reject(peer, 400, "Malformed request line")
		return
	for i in range(1, lines.size()):
		var colon := lines[i].find(":")
		if colon <= 0:
			_reject(peer, 400, "Malformed header line")
			return
		var name := lines[i].left(colon).strip_edges().to_lower()
		if peer.headers.has(name):
			_reject(peer, 400, "Duplicate header: " + name)
			return
		peer.headers[name] = lines[i].substr(colon + 1).strip_edges()
	peer.body_start = end + 4
	_check(peer, request_line[0], request_line[1])


# The D28 guards, in order. On success the peer moves on to reading its body.
func _check(peer: Peer, method: String, target: String) -> void:
	var headers := peer.headers
	if headers.get("host", "") not in ["127.0.0.1:%d" % _port, "localhost:%d" % _port]:
		_reject(peer, 403, "Host not allowed")
		return
	if headers.has("origin") and headers["origin"] not in ["http://127.0.0.1:%d" % _port, "http://localhost:%d" % _port]:
		_reject(peer, 403, "Origin not allowed")
		return
	if target != "/mcp":
		_reject(peer, 404, "Not found")
		return
	if method != "POST":
		_reject(peer, 405, "Method not allowed", -32000, "Allow: POST\r\n")
		return
	var auth: String = headers.get("authorization", "")
	var presented := auth.substr(7).to_utf8_buffer() if auth.begins_with("Bearer ") else PackedByteArray()
	if presented.size() != _token.size() or not Crypto.new().constant_time_compare(_token, presented):
		_reject(peer, 401, "Missing or invalid bearer token", -32000, "WWW-Authenticate: Bearer\r\n")
		return
	var content_type: String = headers.get("content-type", "")
	if content_type.get_slice(";", 0).strip_edges().to_lower() != "application/json":
		_reject(peer, 415, "Content-Type must be application/json")
		return
	var length: String = headers.get("content-length", "")
	if headers.has("transfer-encoding") or length == "":
		_reject(peer, 411, "Content-Length is required; chunked bodies are not supported")
		return
	if not length.is_valid_int() or length.lstrip("0123456789") != "":
		_reject(peer, 400, "Malformed Content-Length")
		return
	if length.length() > 9 or length.to_int() > MAX_BODY_BYTES:
		_reject(peer, 413, "Body exceeds %d bytes" % MAX_BODY_BYTES)
		return
	peer.body_length = length.to_int()
	peer.state = State.BODY


func _run(peer: Peer) -> void:
	_active = peer
	var body := peer.inbound.slice(peer.body_start, peer.body_start + peer.body_length)
	var response: Variant = await _handler.call(body, peer.headers, peer.request)
	if _active == peer:
		_active = null
	_finish(peer)
	# Answered already if the execution budget ran out, or gone if the client left.
	if not _peers.has(peer) or peer.state != State.QUEUED:
		return
	# A script error in the handler returns its type's default ([] or null) instead of [status, body].
	if response is Array and response.size() == 2 and response[0] is int and response[1] is String:
		_respond(peer, response[0], response[1])
	else:
		_reject(peer, 500, "Internal error", -32603)


func _reject(peer: Peer, status: int, message: String, code := -32000, extra_headers := "") -> void:
	var body := JSON.stringify({"jsonrpc": "2.0", "id": null, "error": {"code": code, "message": message}})
	_respond(peer, status, body, extra_headers)


func _respond(peer: Peer, status: int, body: String, extra_headers := "") -> void:
	var payload := body.to_utf8_buffer()
	var head := "HTTP/1.1 %d %s\r\nConnection: close\r\nContent-Length: %d\r\n" % [status, REASONS.get(status, "OK"), payload.size()]
	if not payload.is_empty():
		head += "Content-Type: application/json\r\n"
	peer.outbound = (head + extra_headers + "\r\n").to_utf8_buffer() + payload
	peer.state = State.WRITING
	peer.deadline = Time.get_ticks_msec() + WRITE_MS
	_flush(peer)


func _flush(peer: Peer) -> void:
	while peer.sent < peer.outbound.size():
		var put: Array = peer.tcp.put_partial_data(peer.outbound.slice(peer.sent, peer.sent + CHUNK_BYTES))
		if put[0] != OK:
			_close(peer)
			return
		if put[1] == 0:
			return
		peer.sent += put[1]
	if peer.unread:
		# Keep reading until the client closes, so unread request bytes don't reset the connection before it reads the response.
		peer.state = State.DRAINING
	else:
		_close(peer)


func _cancel(peer: Peer) -> void:
	if peer.request != null:
		peer.request.cancelled = true


func _finish(peer: Peer) -> void:
	if peer.request != null and _done.is_valid():
		_done.call(peer.request)


func _close(peer: Peer) -> void:
	_cancel(peer)
	_finish(peer)
	peer.tcp.disconnect_from_host()
	_peers.erase(peer)
	_queue.erase(peer)


# Index of the CRLFCRLF that ends the header block, or -1.
static func _find_blank_line(bytes: PackedByteArray, from: int) -> int:
	var i := bytes.find(13, from)
	while i != -1 and i + 3 < bytes.size():
		if bytes[i + 1] == 10 and bytes[i + 2] == 13 and bytes[i + 3] == 10:
			return i
		i = bytes.find(13, i + 1)
	return -1
