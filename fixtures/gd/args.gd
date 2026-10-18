extends SceneTree


# Prints the user arguments (those after `--`) as JSON, then quits.
func _init() -> void:
	print("ARGS:", JSON.stringify(OS.get_cmdline_user_args()))
	quit()
