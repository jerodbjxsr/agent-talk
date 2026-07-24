#!/usr/bin/env bash
# ============================================================
#  agent-talk installer (Mac / Linux)
#  Evolved from the Frenemy installer by Zakariya Syed (MIT).
#
#  Run it with:     bash install.sh
#  Preview only:    bash install.sh --dry-run   (prints diffs, writes nothing)
#  (No sudo needed. It only touches files in your home folder.)
#
#  What it does, in plain words:
#   1. Checks that node, claude, and codex are installed.
#   2. Tells Codex where to find the relay (a managed block in
#      ~/.codex/config.toml).
#   3. Teaches Claude how to call Codex (a managed section in
#      ~/.claude/CLAUDE.md).
#   4. Asks if you also want the optional image script.
#
#  Idempotent by reconciliation: everything this installer owns lives
#  between agent-talk markers, and re-running replaces that region with
#  the current content. Nothing outside the markers is ever touched,
#  and every changed file gets a .agent-talk-backup copy first.
#
#  Windows: use install.ps1 (still the Frenemy-era flow; it wires the
#  compatibility entry point, which keeps working).
# ============================================================
set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; fi

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

echo "agent-talk installer"
echo "Installing from: $DIR"
if [[ "$DRY_RUN" == 1 ]]; then echo "(dry run: showing changes, writing nothing)"; fi
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

# agent-talk is tested with Codex 0.144+. Much older CLIs are missing features
# it relies on (per-tool approval_mode, the image script's --ephemeral flag).
CODEX_VER="$(codex --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
if [[ -n "$CODEX_VER" ]]; then
  CODEX_MAJOR="${CODEX_VER%%.*}"
  CODEX_MINOR="${CODEX_VER#*.}"; CODEX_MINOR="${CODEX_MINOR%%.*}"
  if (( 10#$CODEX_MAJOR == 0 && 10#$CODEX_MINOR < 140 )); then
    echo "⚠️  Your Codex CLI is $CODEX_VER. agent-talk is tested with 0.144 and newer."
    echo "   Update it first:  npm install -g @openai/codex@latest   (or: brew upgrade codex)"
    echo "   Then restart Codex and re-run this installer."
  fi
fi

[[ -f "$DIR/agent-talk-mcp.mjs" ]] || fail "agent-talk-mcp.mjs is missing from $DIR, run this script from inside the agent-talk folder."
[[ -f "$DIR/CLAUDE-agents-section.md" ]] || fail "CLAUDE-agents-section.md is missing from $DIR, the folder is incomplete."

# TOML strings can't contain raw " or \. Escape them (rare, but a
# folder name could have them).
DIR_TOML="${DIR//\\/\\\\}"
DIR_TOML="${DIR_TOML//\"/\\\"}"
NODE_TOML="${NODE_BIN//\\/\\\\}"
NODE_TOML="${NODE_TOML//\"/\\\"}"

# --- The managed-region editor -------------------------------
# replace_region FILE OPEN-MARKER CLOSE-MARKER CONTENT-FILE
# Node computes the new file text (replace the marked region, or append one);
# bash decides what to do with it: diff in a dry run, atomic backup+rename
# otherwise. Markers are compared as whole lines. One marker without its pair
# is an error — never guess at a half-broken region.
replace_region() {
  local file="$1" open="$2" close="$3" content="$4"
  local candidate
  candidate="$(mktemp)"
  file="$file" open="$open" close="$close" content="$content" out="$candidate" node - <<'NODE_EOF'
const fs = require("fs");
const { file, open, close, content, out } = process.env;
const body = fs.readFileSync(content, "utf8").replace(/\n$/, "");
const region = `${open}\n${body}\n${close}`;
const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const lines = text.split("\n");
const i = lines.indexOf(open);
const j = lines.indexOf(close);
let next;
if (i !== -1 && j > i) {
  lines.splice(i, j - i + 1, ...region.split("\n"));
  next = lines.join("\n");
} else if (i !== -1 || j !== -1) {
  console.error(`❌ ${file}: found one agent-talk marker but not its pair; fix the file by hand.`);
  process.exit(2);
} else {
  next = text === "" ? region + "\n" : text.replace(/\n*$/, "") + "\n\n" + region + "\n";
}
fs.writeFileSync(out, next);
NODE_EOF
  apply_candidate "$file" "$candidate"
}

# apply_candidate FILE CANDIDATE-FILE — shared endgame for every config edit:
# no-op if identical, diff in a dry run, atomic backup+rename otherwise.
apply_candidate() {
  local file="$1" candidate="$2"
  if cmp -s "$file" "$candidate" 2>/dev/null; then
    note "unchanged: $file"
    rm -f "$candidate"
  elif [[ "$DRY_RUN" == 1 ]]; then
    echo "   would update: $file"
    local diff_base="$file"
    [[ -f "$file" ]] || diff_base=/dev/null
    diff -u "$diff_base" "$candidate" | sed 's/^/     /' || true
    rm -f "$candidate"
  else
    mkdir -p "$(dirname "$file")"
    if [[ -f "$file" ]]; then cp "$file" "$file.agent-talk-backup"; fi
    mv "$candidate" "$file"
    echo "✅ updated: $file  (backup: $file.agent-talk-backup)"
  fi
}

# set_json_key FILE DOT-PATH JSON-VALUE — reconcile one key we own inside a
# JSON config (strict JSON has no comments, so ownership is the key itself).
# Everything else in the file is preserved; invalid existing JSON aborts.
set_json_key() {
  local file="$1" keypath="$2" value="$3"
  local candidate
  candidate="$(mktemp)"
  file="$file" keypath="$keypath" value="$value" out="$candidate" node - <<'NODE_EOF'
const fs = require("fs");
const { file, keypath, value, out } = process.env;
let root = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, "utf8");
  if (raw.trim() !== "") {
    try {
      root = JSON.parse(raw);
    } catch {
      console.error(`❌ ${file} is not valid JSON; fix it by hand and re-run.`);
      process.exit(2);
    }
  }
}
const keys = keypath.split(".");
let node = root;
for (const k of keys.slice(0, -1)) {
  if (typeof node[k] !== "object" || node[k] === null) node[k] = {};
  node = node[k];
}
node[keys[keys.length - 1]] = JSON.parse(value);
fs.writeFileSync(out, JSON.stringify(root, null, 2) + "\n");
NODE_EOF
  apply_candidate "$file" "$candidate"
}

# --- 2. Point Codex at the relay -----------------------------
CODEX_CONFIG="$HOME/.codex/config.toml"

# A pinned model in Codex's config is a common landmine: model names get
# retired, the pin goes stale, and every codex exec run fails with
# "model rejected" even though interactive Codex still works.
if [[ -f "$CODEX_CONFIG" ]]; then
  PINNED_MODEL="$(awk '/^[ \t]*\[/{exit} /^[ \t]*model[ \t]*=/{print; exit}' "$CODEX_CONFIG")"
  if [[ -n "$PINNED_MODEL" ]]; then
    echo "⚠️  Your Codex config pins a model:  $PINNED_MODEL"
    echo "   If codex exec or image generation ever fails with a 'model rejected'"
    echo "   error, delete that line from ~/.codex/config.toml and restart Codex."
    echo "   Codex then uses its current default model, which your account supports."
  fi
fi

# A legacy Frenemy block still works (the old filename is a compatibility
# wrapper), but two mounts means duplicate tools. Never delete it silently.
if [[ -f "$CODEX_CONFIG" ]] \
   && grep -q '^[[:space:]]*\[mcp_servers\.claude\]' "$CODEX_CONFIG" \
   && grep -q 'ask-claude-mcp\.mjs' "$CODEX_CONFIG"; then
  echo "⚠️  Found a legacy Frenemy [mcp_servers.claude] block in $CODEX_CONFIG."
  echo "   It still works, but you now have two mounts. After verifying the new"
  echo "   one, delete the [mcp_servers.claude] block (and its tools block) by hand."
fi

CODEX_REGION="$(mktemp)"
cat > "$CODEX_REGION" <<EOF
[mcp_servers.agent_talk]
command = "$NODE_TOML"
args = ["$DIR_TOML/agent-talk-mcp.mjs", "--host", "codex"]
tool_timeout_sec = 600

# Headless codex auto-denies MCP calls unless each tool gets a per-tool
# approval_mode (the global approval settings do NOT work; see README,
# "The critical config line"). Read-only tools only: the write tool stays
# unapproved on purpose, so interactive Codex prompts before any edit.
[mcp_servers.agent_talk.tools.ask_claude]
approval_mode = "approve"
EOF

echo
echo "Codex mount:"
replace_region "$CODEX_CONFIG" \
  "# >>> agent-talk >>> managed by install.sh; edits inside are overwritten" \
  "# <<< agent-talk <<<" \
  "$CODEX_REGION"
rm -f "$CODEX_REGION"

# --- 3. Teach Claude how to call Codex -----------------------
CLAUDE_MD="$HOME/.claude/CLAUDE.md"

# Legacy unmanaged section from a Frenemy install? Our managed section
# replaces it functionally; warn, don't touch it.
if [[ -f "$CLAUDE_MD" ]] \
   && grep -q '^# Codex is always available' "$CLAUDE_MD" \
   && ! grep -q 'agent-talk >>>' "$CLAUDE_MD"; then
  echo "⚠️  Found the legacy Frenemy section ('# Codex is always available') in"
  echo "   $CLAUDE_MD. The managed section being added replaces it;"
  echo "   delete the legacy one by hand to avoid duplicate instructions."
fi

echo
echo "Claude guidance section:"
replace_region "$CLAUDE_MD" \
  "<!-- >>> agent-talk >>> managed by install.sh; edits inside are overwritten -->" \
  "<!-- <<< agent-talk <<< -->" \
  "$DIR/CLAUDE-agents-section.md"

# --- 3b. Mount the relay in Claude Code (user scope) ---------
# `claude mcp add` is the supported interface for Claude's MCP config, so we
# drive it rather than editing the file underneath it. Reconcile = remove
# our server (ignoring "not found") and re-add with current paths.
echo
echo "Claude mount:"
if [[ "$DRY_RUN" == 1 ]]; then
  echo "   would run: claude mcp add -s user agent_talk -- \"$NODE_BIN\" \"$DIR/agent-talk-mcp.mjs\" --host claude"
else
  claude mcp remove -s user agent_talk >/dev/null 2>&1 || true
  claude mcp add -s user agent_talk -- "$NODE_BIN" "$DIR/agent-talk-mcp.mjs" --host claude >/dev/null
  echo "✅ Claude mounts the relay (user scope): ask_codex is available in every Claude session."
fi

# --- 3c. Mount the relay in OpenCode / Gemini, if installed ---
# Both get read-only tools only (their MCP approval is per-server, not
# per-tool — see docs/DESIGN.md). Skipped cleanly when the CLI is absent.
if command -v opencode >/dev/null; then
  echo
  echo "OpenCode mount (~/.config/opencode/opencode.json):"
  set_json_key "$HOME/.config/opencode/opencode.json" "mcp.agent_talk" \
    "{\"type\":\"local\",\"command\":[\"$NODE_TOML\",\"$DIR_TOML/agent-talk-mcp.mjs\",\"--host\",\"opencode\"],\"enabled\":true,\"timeout\":600000}"
else
  note "opencode not installed; skipping its mount. Re-run after installing it."
fi

if command -v gemini >/dev/null; then
  echo
  echo "Gemini mount (~/.gemini/settings.json):"
  # trust:true is per-server (Gemini's finest grain) and is exactly why this
  # host is only ever offered read-only tools by the relay.
  set_json_key "$HOME/.gemini/settings.json" "mcpServers.agent_talk" \
    "{\"command\":\"$NODE_TOML\",\"args\":[\"$DIR_TOML/agent-talk-mcp.mjs\",\"--host\",\"gemini\"],\"timeout\":600000,\"trust\":true}"
else
  note "gemini not installed; skipping its mount. Re-run after installing it."
fi

# --- 4. Optional image script --------------------------------
if [[ -f "$HOME/.claude/scripts/genimg.sh" ]]; then
  note "Image script already installed, skipping."
elif [[ "$DRY_RUN" == 1 ]]; then
  note "(dry run: skipping the optional image-script prompt)"
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
