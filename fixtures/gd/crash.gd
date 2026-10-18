extends SceneTree


# Dies from SIGKILL, as a crashing game would.
func _init() -> void:
	OS.kill(OS.get_process_id())
