#!/bin/bash
# Prepares Claude Code cloud sessions for the v2 workspace: Node 26, pnpm 12 and all dependencies,
# so lint, typecheck, tests and Playwright run without manual setup (brief §11).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# The v2 workspace only exists on the v2 branches; legacy checkouts need nothing from this hook.
if [ ! -f pnpm-workspace.yaml ]; then
  exit 0
fi

NODE_VERSION="26.12.0"
NODE_DIR="/opt/node26"
PNPM_VERSION="$(sed -n 's/.*"packageManager": "pnpm@\([0-9.]*\)".*/\1/p' package.json)"

if [ "$("$NODE_DIR/bin/node" --version 2>/dev/null)" != "v$NODE_VERSION" ]; then
  work="$(mktemp -d)"
  tarball="node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -sSfL -o "$work/$tarball" "https://nodejs.org/dist/v$NODE_VERSION/$tarball"
  curl -sSfL -o "$work/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$work" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c --quiet -)
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xJf "$work/$tarball" -C "$NODE_DIR" --strip-components=1
  rm -rf "$work"
fi

export PATH="$NODE_DIR/bin:$PATH"

# Install pnpm next to this Node so a corepack shim elsewhere on PATH cannot pick another version.
if [ "$("$NODE_DIR/bin/pnpm" --version 2>/dev/null)" != "$PNPM_VERSION" ]; then
  "$NODE_DIR/bin/npm" install --global --prefix "$NODE_DIR" --ignore-scripts "pnpm@$PNPM_VERSION"
fi

"$NODE_DIR/bin/pnpm" install --prefer-offline

# Later shell commands in the session read their environment from CLAUDE_ENV_FILE.
if [ -z "${CLAUDE_ENV_FILE:-}" ]; then
  exit 0
fi
{
  echo "export PATH=\"$NODE_DIR/bin:\$PATH\""
  # Playwright uses the Chromium that ships with the cloud image instead of downloading one.
  if [ -x /opt/pw-browsers/chromium ]; then
    echo "export PW_CHROMIUM_PATH=/opt/pw-browsers/chromium"
  fi
} >> "$CLAUDE_ENV_FILE"
