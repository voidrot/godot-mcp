@tool
extends RefCounted

## Checks tool arguments against the JSON Schema subset tool definitions use:
## type, properties, required, additionalProperties: false, and items.


# Returns "" when value matches schema, otherwise a message naming the offending path.
static func validate(value: Variant, schema: Dictionary, path := "arguments") -> String:
	match schema.get("type"):
		"object":
			if not value is Dictionary:
				return "%s must be an object" % path
			var properties: Dictionary = schema.get("properties", {})
			for key: String in schema.get("required", []):
				if not value.has(key):
					return "%s.%s is required" % [path, key]
			for key: String in value:
				if not properties.has(key):
					if schema.get("additionalProperties", true) == false:
						return "%s.%s is not allowed" % [path, key]
					continue
				var problem := validate(value[key], properties[key], "%s.%s" % [path, key])
				if problem != "":
					return problem
		"array":
			if not value is Array:
				return "%s must be an array" % path
			if schema.has("items"):
				for i in value.size():
					var problem := validate(value[i], schema["items"], "%s[%d]" % [path, i])
					if problem != "":
						return problem
		"string":
			if not value is String:
				return "%s must be a string" % path
		"boolean":
			if not value is bool:
				return "%s must be a boolean" % path
		"number":
			if not (value is float or value is int):
				return "%s must be a number" % path
		"integer":
			# JSON numbers arrive as floats.
			if not ((value is float and is_finite(value) and value == floorf(value)) or value is int):
				return "%s must be an integer" % path
	return ""
