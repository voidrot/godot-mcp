extends SceneTree


# 200 errors whose message, file and ten stack frames are all control characters. Escaped twice in the
# reply, that is far more than the 4 MB cap unless the parser budgets its text.
func _init() -> void:
	var junk := char(1).repeat(400)
	for i in 200:
		printerr("ERROR: " + junk)
		printerr("   at: fn (" + junk + ":1)")
		printerr("   GDScript backtrace (most recent call first):")
		for frame in 10:
			printerr("       [%d] %s (%s:1)" % [frame, junk, junk])
	quit()
