#!/bin/sh
# Install a Git ref with the real Pi binary in a clean, isolated agent dir and load it.
# This is the user's install path (embedded Bun or npm, as that Pi chooses), not ours.
# Usage: scripts/pi-install-smoke.sh [git-source] [ref]   (requires `pi` or $PI_BIN)
set -eu
SOURCE=${1:-git:github.com/xz-dev/pi-continue-watchdog}
REF=${2:-master}
PI_BIN=${PI_BIN:-$(command -v pi)}
ROOT=$(mktemp -d /var/tmp/pi-install-smoke-XXXXXX)
mkdir -p "$ROOT/agent" "$ROOT/project" "$ROOT/bin"
# Only git and sh: no node, npm or bun leaks in from the developer machine.
for tool in git sh; do ln -s "$(command -v "$tool")" "$ROOT/bin/$tool"; done
run() { (cd "$ROOT/project" && env -i HOME="$HOME" PATH="$ROOT/bin" PI_CODING_AGENT_DIR="$ROOT/agent" "$PI_BIN" "$@"); }

run install "$SOURCE@$REF" >"$ROOT/install.log" 2>&1 || { cat "$ROOT/install.log"; exit 1; }
if grep -qiE "blocked .*postinstall|EALLOWGIT|install-scripts" "$ROOT/install.log"; then
	cat "$ROOT/install.log"; echo "FAIL: dependency install scripts were blocked"; exit 1
fi
# Print mode loads every configured extension before it needs a model. With no
# credentials in the clean agent dir it then stops at "No API key", which is a pass.
run -p "smoke" >"$ROOT/load.log" 2>&1 || true
if grep -qiE "failed to load extension|cannot find module" "$ROOT/load.log"; then
	cat "$ROOT/load.log"; echo "FAIL: extension did not load"; exit 1
fi
grep -q "No API key" "$ROOT/load.log" || { cat "$ROOT/load.log"; echo "FAIL: unexpected startup output"; exit 1; }
echo "PASS: $SOURCE@$REF installed and loaded ($ROOT)"
