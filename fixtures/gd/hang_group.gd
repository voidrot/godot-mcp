extends SceneTree


# Starts a background `sleep` in this process's group (OS.execute does not setsid), then never quits.
# A group kill must take the sleep down with it.
func _init() -> void:
	OS.execute("/bin/sh", ["-c", "sleep 31337 >/dev/null 2>&1 </dev/null &"])
	print("hang-group-start")
