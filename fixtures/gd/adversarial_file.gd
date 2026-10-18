extends SceneTree


# 200 errors whose only large text is the file of the first backtrace frame, which the parser stores
# twice (in the frame and as the diagnostic's file). Uncharged, that overflows the 4 MB reply.
func _init() -> void:
	var junk := char(1).repeat(980)
	for i in 200:
		printerr("ERROR: a")
		printerr("   GDScript backtrace (most recent call first):")
		printerr("       [0] F (%s:1)" % junk)
	for i in 70:
		print(junk)
	quit()
