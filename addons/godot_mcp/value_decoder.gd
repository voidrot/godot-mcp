@tool
extends RefCounted

## Property values from JSON, parsed by the property's declared type (D35). str_to_var instantiates
## Objects from unchecked text, so it runs only on a math or packed numeric literal that matches a
## whitelist pattern in full, and the resulting type is checked afterwards. JSON object keys are always
## strings, so a Dictionary value never merges keys.

const ResPaths := preload("res_paths.gd")
const ToolError := preload("tool_error.gd")

const MAX_LITERAL_CHARS := 4096
# JSON numbers arrive as floats; beyond 2^53 they no longer name one integer.
const MAX_SAFE_INT := 9007199254740992.0
const RESOURCE_EXTENSIONS: Array[String] = [
	"tres", "res", "tscn", "scn", "gd", "cs", "gdshader", "gdshaderinc", "png", "jpg", "jpeg", "webp",
	"svg", "bmp", "tga", "exr", "hdr", "wav", "ogg", "mp3", "ttf", "otf", "woff", "woff2", "fnt",
	"obj", "gltf", "glb", "fbx", "blend", "dae",
]

const FLOAT_ELEMENT := "-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?"
const INT_ELEMENT := "-?\\d+"
# Literal types by declared type; the value says whether the elements are integers.
const LITERAL_TYPES := {
	TYPE_VECTOR2: false, TYPE_VECTOR2I: true, TYPE_RECT2: false, TYPE_RECT2I: true,
	TYPE_VECTOR3: false, TYPE_VECTOR3I: true, TYPE_TRANSFORM2D: false, TYPE_VECTOR4: false,
	TYPE_VECTOR4I: true, TYPE_PLANE: false, TYPE_QUATERNION: false, TYPE_AABB: false,
	TYPE_BASIS: false, TYPE_TRANSFORM3D: false, TYPE_PROJECTION: false, TYPE_COLOR: false,
	TYPE_PACKED_BYTE_ARRAY: true, TYPE_PACKED_INT32_ARRAY: true, TYPE_PACKED_INT64_ARRAY: true,
	TYPE_PACKED_FLOAT32_ARRAY: false, TYPE_PACKED_FLOAT64_ARRAY: false,
	TYPE_PACKED_VECTOR2_ARRAY: false, TYPE_PACKED_VECTOR3_ARRAY: false,
	TYPE_PACKED_COLOR_ARRAY: false, TYPE_PACKED_VECTOR4_ARRAY: false,
}

const PACKED_STRIDE := {
	TYPE_PACKED_VECTOR2_ARRAY: 2, TYPE_PACKED_VECTOR3_ARRAY: 3,
	TYPE_PACKED_COLOR_ARRAY: 4, TYPE_PACKED_VECTOR4_ARRAY: 4,
}

static var _HEX_COLOR := RegEx.create_from_string("^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\\z")


# `info` is a property-list entry (name, type, hint, hint_string). Returns {value} or a tool failure.
static func decode(raw: Variant, info: Dictionary) -> Dictionary:
	var type: int = info["type"]
	var label: String = info["name"]
	match type:
		TYPE_BOOL:
			if raw is bool:
				return {"value": raw}
		TYPE_INT:
			if (raw is int) or (raw is float and is_finite(raw) and raw == floorf(raw) and absf(raw) < MAX_SAFE_INT):
				return {"value": int(raw)}
		TYPE_FLOAT:
			if raw is int or raw is float:
				return {"value": float(raw)}
		TYPE_STRING:
			if raw is String:
				return {"value": raw}
		TYPE_STRING_NAME:
			if raw is String:
				return {"value": StringName(raw)}
		TYPE_NODE_PATH:
			if raw is String:
				return {"value": NodePath(raw)}
		TYPE_PACKED_STRING_ARRAY:
			if raw is Array and raw.all(func(item: Variant) -> bool: return item is String):
				return {"value": PackedStringArray(raw)}
		TYPE_ARRAY, TYPE_DICTIONARY:
			if info.get("hint_string", "") != "":
				return ToolError.fail("UNSUPPORTED_TYPE", "%s is a typed %s, which is not supported" % [label, type_string(type)])
			if (type == TYPE_ARRAY and raw is Array) or (type == TYPE_DICTIONARY and raw is Dictionary):
				return {"value": raw}
		TYPE_OBJECT:
			return _resource(raw, info)
		_:
			if LITERAL_TYPES.has(type):
				return _literal(raw, info)
			return ToolError.fail("UNSUPPORTED_TYPE", "%s has type %s, which is not supported" % [label, type_string(type)])
	return _invalid(label, type, raw)


static func _invalid(label: String, type: int, raw: Variant) -> Dictionary:
	var hint := ""
	if LITERAL_TYPES.has(type):
		hint = "; give a literal string such as \"%s(...)\"" % type_string(type)
	elif type == TYPE_OBJECT:
		hint = "; give a res:// path or null"
	return ToolError.fail("INVALID_VALUE", "%s expects %s, got %s%s" % [label, type_string(type), _describe(raw), hint])


static func _describe(raw: Variant) -> String:
	if raw is String:
		return "the string " + JSON.stringify(raw.left(60))
	return type_string(typeof(raw))


static func _literal(raw: Variant, info: Dictionary) -> Dictionary:
	var type: int = info["type"]
	if not raw is String or raw.length() > MAX_LITERAL_CHARS:
		return _invalid(info["name"], type, raw)
	if type == TYPE_COLOR and _HEX_COLOR.search(raw) != null:
		return {"value": Color.html(raw)}
	var element := INT_ELEMENT if LITERAL_TYPES[type] else FLOAT_ELEMENT
	var pattern := "^%s\\(\\s*(?:%s(?:\\s*,\\s*%s)*)?\\s*\\)\\z" % [type_string(type), element, element]
	if RegEx.create_from_string(pattern).search(raw) == null:
		return _invalid(info["name"], type, raw)
	# The parser wraps integer elements and overflows floats, so bound every element first.
	var is_int: bool = LITERAL_TYPES[type]
	var low := -2147483648.0
	var high := 2147483647.0
	if type == TYPE_PACKED_BYTE_ARRAY:
		low = 0.0
		high = 255.0
	elif type == TYPE_PACKED_INT64_ARRAY:
		low = -MAX_SAFE_INT
		high = MAX_SAFE_INT
	var found_all := RegEx.create_from_string(element).search_all(raw.substr(raw.find("(")))
	if found_all.size() % PACKED_STRIDE.get(type, 1) != 0:
		return _invalid(info["name"], type, raw)
	for found in found_all:
		var number := found.get_string().to_float()
		if not is_finite(number) or (is_int and (number < low or number > high)):
			return ToolError.fail("INVALID_VALUE", "%s has an element out of range: %s" % [info["name"], found.get_string()])
	var parsed: Variant = str_to_var(raw)
	if typeof(parsed) != type:
		return _invalid(info["name"], type, raw)
	return {"value": parsed}


# An Object property takes null or the res:// path of a resource of the hinted class.
static func _resource(raw: Variant, info: Dictionary) -> Dictionary:
	var label: String = info["name"]
	if info.get("hint", PROPERTY_HINT_NONE) != PROPERTY_HINT_RESOURCE_TYPE:
		return ToolError.fail("UNSUPPORTED_TYPE", "%s is an Object that is not a Resource, which is not supported" % label)
	if raw == null:
		return {"value": null}
	if not raw is String:
		return _invalid(label, TYPE_OBJECT, raw)
	var problem := ResPaths.check_file(raw, RESOURCE_EXTENSIONS)
	if not problem.is_empty():
		return problem
	# Loading can run script code, so the type comes from the editor's file index and is checked first.
	var file_type := EditorInterface.get_resource_filesystem().get_file_type(raw)
	if file_type == "":
		return ToolError.fail("INVALID_VALUE", "%s is not in the editor's file index; wait for scanning to finish or call import_assets" % raw)
	var expected := false
	for hinted in String(info["hint_string"]).split(","):
		expected = expected or file_type == hinted or ClassDB.is_parent_class(file_type, hinted)
	if not expected:
		return ToolError.fail("INVALID_VALUE", "%s expects %s, but %s is a %s" % [label, info["hint_string"], raw, file_type])
	var resource := ResourceLoader.load(raw)
	if resource == null:
		return ToolError.fail("LOAD_FAILED", "Could not load " + raw)
	return {"value": resource}
