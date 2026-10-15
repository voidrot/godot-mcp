extends SceneTree

# Runs the addon's setup logic outside the editor, in a temp project (setup.test.ts). Prints one
# PROBE line of JSON. With "dialog" after --, it also writes a foreign SKILL.md and reports what the
# menu dialog shows.

var _ran := false


func _process(_delta: float) -> bool:
	if _ran:
		return false
	_ran = true
	var setup = load("res://addons/godot_mcp/setup.gd")
	var report := {}
	var skill_dir := ProjectSettings.globalize_path("res://.claude")
	report["notListening"] = setup.new(0).install(false)
	report["claudeAfterNotListening"] = DirAccess.dir_exists_absolute(skill_dir)
	report["windows"] = setup.new(6550).platform_failure("Windows")
	report["linux"] = setup.new(6550).platform_failure("Linux")
	report["install"] = setup.new(6550).install(false)
	if OS.get_cmdline_user_args().has("dialog"):
		var skill := ProjectSettings.globalize_path("res://.claude/skills/godot-mcp/SKILL.md")
		DirAccess.make_dir_recursive_absolute(skill.get_base_dir())
		var foreign := FileAccess.open(skill, FileAccess.WRITE)
		foreign.store_string("# foreign\n")
		foreign.close()
		var parent := Control.new()
		root.add_child(parent)
		setup.new(6550).show_dialog(parent)
		var dialog: AcceptDialog = parent.get_child(0)
		var labels := []
		for label in dialog.find_children("*", "Label", true, false):
			labels.append(label.text)
		report["dialogLabels"] = labels
		var entries := dialog.find_children("*", "TextEdit", true, false)
		report["dialogEntry"] = entries[0].text if entries.size() > 0 else null
	print("PROBE " + JSON.stringify(report))
	quit(0)
	return false
