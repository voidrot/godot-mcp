# 003: rotation_degrees and other non-editor properties are refused

- **Project:** orbital-runtime (Godot 4.7.2 mono, .NET 10)
- **Status:** fixed (`fix(addon): let rotation_degrees through the editor-property check`)

## Goal

Add a `DirectionalLight3D` angled at -45° pitch and 30° yaw with `add_node` `properties: {"rotation_degrees": "Vector3(-45, 30, 0)"}`.

## Gap

The call failed with `PROPERTY_NOT_FOUND: DirectionalLight3D has no writable editor property named: rotation_degrees`. Property writes require `PROPERTY_USAGE_EDITOR` (`addons/godot_mcp/node_props.gd:20`). In Godot 4, `Node3D.rotation_degrees` is a script-facing helper without that flag, although the inspector shows the rotation in degrees. Agents reach for `rotation_degrees` first, so they hit this often.

## Workaround

Passed `rotation` in radians: `"Vector3(-0.785, 0.524, 0)"`.

## Proposed change

Pick one:

- **Allow a short list of known helper properties** (`rotation_degrees`, `global_position`, `global_rotation_degrees`) as aliases that resolve to the stored property. Explicit, and keeps the editor-only rule for everything else.
- **Name the stored property in the error**, e.g. "use `rotation` (radians)". This adds no new write surface.

At minimum, do the second. The two options combine well.
