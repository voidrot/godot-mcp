#!/bin/sh
# Stand-in for the godot binary, selected through GODOT_BIN. Behaviour comes from
# FAKE_GODOT_MODE. FAKE_GODOT_ARGSFILE, if set, receives argv and the cwd.

if [ "$1" = "--version" ]; then
  echo "4.7.2.fake"
  exit 0
fi

if [ -n "$FAKE_GODOT_ARGSFILE" ]; then
  { pwd; printf '%s\n' "$@"; } > "$FAKE_GODOT_ARGSFILE"
fi

case "$FAKE_GODOT_MODE" in
  hang)
    # A grandchild that ignores SIGTERM and records its pid.
    sh -c 'trap "" TERM; echo $$ > "$FAKE_GODOT_PIDFILE"; while :; do sleep 1; done' &
    echo "fake-hang"
    sleep 300
    ;;
  flood)
    echo "ERROR: early failure" >&2
    head -c 300000 /dev/zero | tr '\0' 'x'
    echo
    ;;
  *)
    echo "fake-ok"
    ;;
esac
