@tool
extends RefCounted

## Property values as {type, value} (D35). Primitives, String, StringName and NodePath are native;
## a Resource is its path plus class; containers with primitive leaves are JSON; the rest is var_to_str.
## Output only; value_decoder.gd parses input.

const MAX_DEPTH := 16


# `declared` is the property's declared type, used to name a null.
static func encode(value: Variant, declared := TYPE_NIL) -> Dictionary:
	var type := typeof(value)
	# A null Object property still has type OBJECT, so test the value, not the type.
	if value == null:
		var out := {"type": type_string(declared) if declared != TYPE_NIL else "Nil", "value": null}
		if declared == TYPE_OBJECT:
			out["class"] = null
		return out
	match type:
		TYPE_BOOL, TYPE_INT, TYPE_STRING:
			return {"type": type_string(type), "value": value}
		TYPE_FLOAT:
			if is_finite(value):
				return {"type": "float", "value": value}
		TYPE_STRING_NAME, TYPE_NODE_PATH:
			return {"type": type_string(type), "value": str(value)}
		TYPE_OBJECT:
			return _object(value)
		TYPE_ARRAY, TYPE_DICTIONARY:
			if _is_plain(value, 0):
				return {"type": type_string(type), "value": value}
			return {"type": type_string(type), "value": _references(value, 0)}
	return {"type": type_string(type), "value": var_to_str(value)}


static func _object(value: Object) -> Dictionary:
	if value is Resource and value.resource_path != "":
		return {"type": "Object", "value": value.resource_path, "class": value.get_class()}
	return {"type": "Object", "value": null, "class": value.get_class()}


# A container with non-primitive leaves: Objects become {class, path} references, never their contents,
# and other leaves become their var_to_str text.
static func _references(value: Variant, depth: int) -> Variant:
	if depth > MAX_DEPTH:
		return null
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_STRING:
			return value
		TYPE_FLOAT:
			return value if is_finite(value) else var_to_str(value)
		TYPE_OBJECT:
			return _object(value) if value != null else null
		TYPE_ARRAY:
			return value.map(func(item: Variant) -> Variant: return _references(item, depth + 1))
		TYPE_DICTIONARY:
			var out := {}
			for key: Variant in value:
				out[key if key is String else var_to_str(key)] = _references(value[key], depth + 1)
			return out
	return var_to_str(value)


static func _is_plain(value: Variant, depth: int) -> bool:
	if depth > MAX_DEPTH:
		return false
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_STRING:
			return true
		TYPE_FLOAT:
			return is_finite(value)
		TYPE_ARRAY:
			for item: Variant in value:
				if not _is_plain(item, depth + 1):
					return false
			return true
		TYPE_DICTIONARY:
			for key: Variant in value:
				if not key is String or not _is_plain(value[key], depth + 1):
					return false
			return true
	return false
