extends SceneTree


# Emits one of each diagnostic the parser must recognise, then quits.
func _init() -> void:
	call_deferred("quit")
	print("diag-start")
	push_error("pushed error")
	push_warning("pushed warning")
	var a: Array = []
	print(a[5])
