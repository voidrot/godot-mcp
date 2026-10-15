#!/bin/sh
# Stand-in for `dotnet`, found through PATH. The build configuration (-c) selects the behaviour, so one
# editor can play every case. FAKE_DOTNET_ARGSFILE, if set, receives the cwd, the three build
# variables and then argv. FAKE_DOTNET_ROOT, if set, is the cwd the build must run in.

if [ "$1" = "--version" ]; then
  echo "0.0.0-fake"
  exit 0
fi

root=$(pwd -P)

if [ -n "$FAKE_DOTNET_ARGSFILE" ]; then
  { echo "$root"; echo "$DOTNET_NOLOGO $DOTNET_CLI_TELEMETRY_OPTOUT $MSBUILDDISABLENODEREUSE"; printf '%s\n' "$@"; } > "$FAKE_DOTNET_ARGSFILE"
fi

if [ -n "$FAKE_DOTNET_ROOT" ] && [ "$root" != "$FAKE_DOTNET_ROOT" ]; then
  echo "MSBUILD : error FAKE001: cwd is $root, expected $FAKE_DOTNET_ROOT"
  exit 99
fi

mode=ok
while [ $# -gt 0 ]; do
  [ "$1" = "-c" ] && mode=$2
  shift
done

# MSBuild prints each diagnostic where it happens and again in its summary, so the cases repeat them.
case "$mode" in
  errors)
    lines="$root/Main.cs(8,25): error CS1002: ; expected [$root/FixtureGame.csproj]
$root/Main.cs(12,5): warning CS0168: The variable 'x' is declared but never used [$root/FixtureGame.csproj]
/elsewhere/Lib.cs(3,1,3,9): error CS0103: The name 'y' does not exist in the current context [/elsewhere/Lib.csproj]"
    echo "$lines"
    printf '\nBuild FAILED.\n\n'
    echo "$lines"
    printf '    1 Warning(s)\n    2 Error(s)\n'
    exit 1
    ;;
  warnings)
    echo "$root/Main.cs(12,5): warning CS0168: The variable 'x' is declared but never used [$root/FixtureGame.csproj]"
    echo "Build succeeded."
    exit 0
    ;;
  nu1301)
    echo "$root/FixtureGame.csproj : error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json."
    exit 1
    ;;
  msb1009)
    echo "MSBUILD : error MSB1009: Project file does not exist."
    echo "Switch: nope.csproj"
    exit 1
    ;;
  nocode)
    echo "$root/Main.cs(3,4): error : custom task failed"
    echo "MSBUILD : warning : something looks off"
    exit 1
    ;;
  silent)
    echo "You must install or update .NET to run this application." >&2
    exit 3
    ;;
  crlf)
    # CRLF endings and the project suffix of a multi-targeted project, printed twice.
    for _ in 1 2; do
      printf '%s/Main.cs(8,25): error CS1002: ; expected [%s/FixtureGame.csproj::TargetFramework=net8.0]\r\n' "$root" "$root"
      printf '%s/Main.cs(12,5): warning CS0168: unused [%s/FixtureGame.csproj::TargetFramework=net8.0]\r\n' "$root" "$root"
      printf '%s/FixtureGame.csproj : warning XY0001: line one [TargetFramework=net8.0]\r\n' "$root"
    done
    exit 1
    ;;
  hostile)
    # Lines that sent a naive diagnostic regex into tens of milliseconds of backtracking each.
    spaces490=$(printf '%490s' '')
    spaces480=$(printf '%480s' '')
    spaces100=$(printf '%100s' '')
    spaces900=$(printf '%900s' '')
    i=0
    while [ "$i" -lt 200 ]; do
      echo "${spaces490}: ${spaces480}warningX:"
      echo " :${spaces100} :${spaces100} :${spaces100} :${spaces100} :${spaces100} :${spaces100} :${spaces100} :${spaces100} :${spaces100}"
      echo "a.cs(1,2): error CS1: x${spaces900}"
      i=$((i + 1))
    done
    exit 1
    ;;
  split)
    # 40 KB on each stream: neither tail is cut, but together they exceed the 64 KB output tail.
    head -c 40000 /dev/zero | tr '\0' 'o'
    echo
    head -c 40000 /dev/zero | tr '\0' 'e' >&2
    echo >&2
    exit 0
    ;;
  hang)
    # A grandchild in the same process group, which the timeout's group kill must reach.
    sleep 31338 &
    echo "fake-hang"
    sleep 300
    ;;
  *)
    echo "Build succeeded."
    echo "    0 Warning(s)"
    ;;
esac
