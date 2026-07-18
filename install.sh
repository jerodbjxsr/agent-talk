#!/usr/bin/env bash
# ============================================================
#  Frenemy installer (Mac / Linux), created by Zakariya Syed
#
#  Run it with:   bash install.sh
#  (No sudo needed. It only touches files in your home folder.)
#
#  What it does, in plain words:
#   1. Checks that node, claude, and codex are installed.
#   2. Tells Codex where to find the relay (writes a small block
#      into ~/.codex/config.toml).
#   3. Teaches Claude how to call Codex (appends one section
#      to ~/.claude/CLAUDE.md).
#   4. Asks if you also want the optional image script.
#
#  Safe to run twice, it skips anything already installed.
# ============================================================
set -euo pipefail

# The folder this script lives in. The relay must stay here,
# because Codex's config will point at this exact location.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() { echo "❌ $1"; exit 1; }
note() { echo "   $1"; }

# A folder path with control characters (newline, tab, ...) could break out
# of the quoted string we write into Codex's TOML config. No normal path has
# them, refuse to install from one that does.
if printf '%s' "$DIR" | LC_ALL=C grep -q '[[:cntrl:]]'; then
  fail "This folder's path contains control characters. Move the folder to a normal path and re-run."
fi

echo "Frenemy installer"
echo "Installing from: $DIR"
echo

# --- 1. Check the three prerequisites -----------------------
NODE_BIN="$(command -v node)"  || fail "node not found. Install Node.js first: https://nodejs.org"
command -v claude >/dev/null || fail "claude not found. Install Claude Code first: https://claude.ai/install.sh"
command -v codex >/dev/null || fail "codex not found. Install Codex CLI first: https://chatgpt.com/codex/install.sh"
# Pin the exact Node binary found now, so a PATH trick can't swap in a fake
# "node" later. (Also refuse a relative/oddball location.)
[[ "$NODE_BIN" == /* ]] || fail "node resolved to a relative path ($NODE_BIN), fix your PATH and re-run."
if printf '%s' "$NODE_BIN" | LC_ALL=C grep -q '[[:cntrl:]]'; then
  fail "The node path contains control characters, fix your PATH and re-run."
fi
echo "✅ node, claude, and codex are all installed."

# The relay needs Node 18 or newer (modern JavaScript).
NODE_MAJOR="$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1 || true)"
if [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] && (( NODE_MAJOR < 18 )); then
  echo "⚠️  Your Node.js is $(node --version). The relay needs Node 18 or newer."
  echo "   Update it first: https://nodejs.org"
fi

# Frenemy is tested with Codex 0.144+. Much older CLIs are missing features
# it relies on (per-tool approval_mode, the image script's --ephemeral flag).
CODEX_VER="$(codex --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
if [[ -n "$CODEX_VER" ]]; then
  CODEX_MAJOR="${CODEX_VER%%.*}"
  CODEX_MINOR="${CODEX_VER#*.}"; CODEX_MINOR="${CODEX_MINOR%%.*}"
  if (( 10#$CODEX_MAJOR == 0 && 10#$CODEX_MINOR < 140 )); then
    echo "⚠️  Your Codex CLI is $CODEX_VER. Frenemy is tested with 0.144 and newer."
    echo "   Update it first:  npm install -g @openai/codex@latest   (or: brew upgrade codex)"
    echo "   Then restart Codex and re-run this installer."
  fi
fi

[[ -f "$DIR/ask-claude-mcp.mjs" ]] || fail "ask-claude-mcp.mjs is missing from $DIR, run this script from inside the frenemy folder."
[[ -f "$DIR/CLAUDE-codex-section.md" ]] || fail "CLAUDE-codex-section.md is missing from $DIR, the folder is incomplete."

# TOML strings can't contain raw " or \. Escape them (rare, but a
# folder name could have them).
DIR_TOML="${DIR//\\/\\\\}"
DIR_TOML="${DIR_TOML//\"/\\\"}"
NODE_TOML="${NODE_BIN//\\/\\\\}"
NODE_TOML="${NODE_TOML//\"/\\\"}"

# --- 2. Point Codex at the relay -----------------------------
CODEX_CONFIG="$HOME/.codex/config.toml"
mkdir -p "$HOME/.codex"
touch "$CODEX_CONFIG"

# A pinned model in Codex's config is a common landmine: model names get
# retired, the pin goes stale, and every codex exec run fails with
# "model rejected" even though interactive Codex still works.
PINNED_MODEL="$(awk '/^[ \t]*\[/{exit} /^[ \t]*model[ \t]*=/{print; exit}' "$CODEX_CONFIG")"
if [[ -n "$PINNED_MODEL" ]]; then
  echo "⚠️  Your Codex config pins a model:  $PINNED_MODEL"
  echo "   If codex exec or image generation ever fails with a 'model rejected'"
  echo "   error, delete that line from ~/.codex/config.toml and restart Codex."
  echo "   Codex then uses its current default model, which your account supports."
fi

if grep -q '^[[:space:]]*\[mcp_servers\.claude\]' "$CODEX_CONFIG"; then
  note "Codex config already has an [mcp_servers.claude] entry, leaving it alone."
  APPROVAL_OK="$(awk '/^[ \t]*\[mcp_servers\.claude\.tools\.ask_claude\]/{f=1; next}
                      f && /^[ \t]*\[/{exit}
                      f && /^[ \t]*approval_mode[ \t]*=[ \t]*"approve"/{print "ok"; exit}' "$CODEX_CONFIG")"
  if [[ "$APPROVAL_OK" != "ok" ]]; then
    echo "⚠️  But that entry is missing the critical approval setting, so headless Codex"
    echo "   runs will auto-deny the relay. Make sure $CODEX_CONFIG has these two lines:"
    echo
    echo "   [mcp_servers.claude.tools.ask_claude]"
    echo "   approval_mode = \"approve\""
  fi
else
  cat >> "$CODEX_CONFIG" <<EOF

[mcp_servers.claude]
command = "$NODE_TOML"
args = ["$DIR_TOML/ask-claude-mcp.mjs"]
tool_timeout_sec = 600

[mcp_servers.claude.tools.ask_claude]
approval_mode = "approve"
EOF
  echo "✅ Codex now knows about the relay ($CODEX_CONFIG)."
fi

# --- 3. Teach Claude how to call Codex -----------------------
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
mkdir -p "$HOME/.claude"
touch "$CLAUDE_MD"

if grep -q '^# Codex is always available' "$CLAUDE_MD"; then
  note "Claude's CLAUDE.md already has the Codex section, leaving it alone."
else
  { echo; cat "$DIR/CLAUDE-codex-section.md"; } >> "$CLAUDE_MD"
  echo "✅ Claude now knows how to call Codex ($CLAUDE_MD)."
fi

# --- 4. Optional image script --------------------------------
if [[ -f "$HOME/.claude/scripts/genimg.sh" ]]; then
  note "Image script already installed, skipping."
else
  printf "Also install the optional image-generation script? [y/N] "
  read -r REPLY || REPLY=n
  if [[ "$REPLY" == [yY]* ]]; then
    [[ -f "$DIR/genimg.sh" ]] || fail "genimg.sh is missing from $DIR, the folder is incomplete."
    mkdir -p "$HOME/.claude/scripts"
    cp "$DIR/genimg.sh" "$HOME/.claude/scripts/genimg.sh"
    chmod +x "$HOME/.claude/scripts/genimg.sh"
    echo "✅ Image script installed to ~/.claude/scripts/genimg.sh"
  else
    note "Skipped the image script. Run this installer again if you change your mind."
  fi
fi

echo
echo "🎉 Done. Last things:"
echo "   • Restart Codex (close and reopen it) so it picks up the new config."
echo "   • Keep this folder where it is; Codex's config points here."
echo "   • Not signed in yet? Run codex once and claude once and log in."
