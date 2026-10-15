extends SceneTree


# Fails early, then prints far more than the 64 KB output tail keeps.
func _init() -> void:
	push_error("early failure")
	var line := "x".repeat(1023)
	for i in 300:
		print(line)
	quit()
