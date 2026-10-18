extends SceneTree


# Writes two error lines to stderr in pieces 300 ms apart: the first splits inside the "ERROR" prefix,
# the second inside the UTF-8 encoding of "é". A child shell writes them, since it inherits our stderr.
func _init() -> void:
	var script := "printf 'ERR' >&2; sleep 0.3; printf 'OR: x\\nERROR: caf\\303' >&2; sleep 0.3; printf '\\251\\n' >&2"
	var pid := OS.create_process("/bin/sh", ["-c", script])
	while OS.is_process_running(pid):
		OS.delay_msec(20)
	quit()
