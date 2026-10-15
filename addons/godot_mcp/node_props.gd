@tool
extends RefCounted

## Which node properties the tools may write, and the decoded value for one (D35).

const ToolError := preload("tool_error.gd")
const ValueDecoder := preload("value_decoder.gd")

const BLOCKED_USAGE := PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP | PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_READ_ONLY


# Returns {value, type} or a tool failure. Only editor-visible, writable properties qualify, plus
# `name`, which has no editor usage but is how a node is renamed.
static func decode(node: Node, property: String, raw: Variant) -> Dictionary:
	var info := {}
	for candidate in node.get_property_list():
		if candidate["name"] == property:
			info = candidate
			break
	var editable: bool = not info.is_empty() and info["usage"] & PROPERTY_USAGE_EDITOR != 0 and info["usage"] & BLOCKED_USAGE == 0
	if not editable and property != "name":
		return ToolError.fail("PROPERTY_NOT_FOUND", "%s has no writable editor property named: %s" % [node.get_class(), property])
	var decoded := ValueDecoder.decode(raw, info)
	if decoded.has("error"):
		return decoded
	if property == "name":
		var text := String(decoded["value"])
		if text == "" or text.validate_node_name() != text:
			return ToolError.fail("INVALID_VALUE", "name must be non-empty and contain none of: . : @ / \" %")
	if property == "script" and decoded["value"] != null:
		var base := String(decoded["value"].get_instance_base_type())
		if base == "" or not node.is_class(base):
			return ToolError.fail("INVALID_VALUE", "The script extends %s, which %s is not" % [base if base != "" else "nothing valid", node.get_class()])
	decoded["type"] = info["type"]
	return decoded
