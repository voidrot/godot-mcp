@tool
extends RefCounted

## A tool failure (D36): returned from a handler, reported as isError.


static func fail(code: String, message: String) -> Dictionary:
	return {"error": {"code": code, "message": message}}
