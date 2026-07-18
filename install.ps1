# ============================================================
#  Frenemy installer (Windows), created by Zakariya Syed
#
#  Run it in PowerShell with:   .\install.ps1
#  (If Windows blocks it:  powershell -ExecutionPolicy Bypass -File install.ps1)
#  No admin rights needed. It only touches files in your user folder.
#
#  What it does, in plain words:
#   1. Checks that node, claude, and codex are installed.
#   2. Tells Codex where to find the relay (writes a small block
#      into ~\.codex\config.toml).
#   3. Teaches Claude how to call Codex (appends one section
#      to ~\.claude\CLAUDE.md).
#
#  Safe to run twice; it skips anything already installed.
#  (The optional image script is Mac/Linux only, so it's not offered here.)
# ============================================================
$ErrorActionPreference = "Stop"

# All file writes go through this: UTF-8 without BOM, so config
# files stay clean regardless of Windows' default text encoding.
$Utf8 = New-Object System.Text.UTF8Encoding $false
function Append-Utf8([string]$Path, [string]$Text) {
  [System.IO.File]::AppendAllText($Path, $Text, $Utf8)
}

# The folder this script lives in. The relay must stay here,
# because Codex's config will point at this exact location.
$Dir = $PSScriptRoot
if (-not $Dir) {
  Write-Host "X Please run this as a file (.\install.ps1) from inside the frenemy folder, not by pasting it into the console."
  exit 1
}

Write-Host "Frenemy installer"
Write-Host "Installing from: $Dir"
Write-Host ""

# --- 1. Check the three prerequisites -----------------------
foreach ($tool in @(
  @{ name = "node";   hint = "Install Node.js first: https://nodejs.org" },
  @{ name = "claude"; hint = "Install Claude Code first: irm https://claude.ai/install.ps1 | iex" },
  @{ name = "codex";  hint = "Install Codex CLI first: irm https://chatgpt.com/codex/install.ps1 | iex" }
)) {
  if (-not (Get-Command $tool.name -ErrorAction SilentlyContinue)) {
    Write-Host "X $($tool.name) not found. $($tool.hint)"
    exit 1
  }
}

# The relay only launches a real claude.exe. An npm claude.cmd shim is
# refused on purpose (see the README), so make sure claude.exe exists.
$ClaudeExe = $null
foreach ($p in ($env:Path -split ';')) {
  $p = $p.Trim().Trim('"')
  if (-not $p) { continue }
  if (-not [System.IO.Path]::IsPathRooted($p)) { continue }
  $c = Join-Path $p "claude.exe"
  if (Test-Path -LiteralPath $c -PathType Leaf) { $ClaudeExe = $c; break }
}
if (-not $ClaudeExe) {
  Write-Host "X claude.exe was not found on PATH. Your Claude is probably the npm version,"
  Write-Host "  which the relay refuses for security reasons. Install the native version:"
  Write-Host "  irm https://claude.ai/install.ps1 | iex"
  exit 1
}
Write-Host "OK: node, claude, and codex are all installed."

# Pin the exact Node binary found now, so a PATH trick can't swap in a
# fake "node" later.
$NodeBin = (Get-Command node).Source
# TOML needs forward slashes on Windows (backslashes break it).
$NodeToml = $NodeBin -replace '\\', '/'

# The relay needs Node 18 or newer (modern JavaScript).
try {
  $NodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
  if ($NodeMajor -lt 18) {
    Write-Host "! Your Node.js is $(& node --version). The relay needs Node 18 or newer."
    Write-Host "  Update it first: https://nodejs.org"
  }
} catch {}

# Frenemy is tested with Codex 0.144+. Much older CLIs are missing features
# it relies on (per-tool approval_mode, the image script's --ephemeral flag).
try {
  $CodexVerMatch = & codex --version 2>$null | Select-String -Pattern '\d+\.\d+\.\d+' | Select-Object -First 1
  if ($CodexVerMatch) {
    $CodexVer = $CodexVerMatch.Matches[0].Value
    $Parts = $CodexVer.Split('.')
    if ([int]$Parts[0] -eq 0 -and [int]$Parts[1] -lt 140) {
      Write-Host "! Your Codex CLI is $CodexVer. Frenemy is tested with 0.144 and newer."
      Write-Host "  Update it first:  npm install -g @openai/codex@latest"
      Write-Host "  Then restart Codex and re-run this installer."
    }
  }
} catch {}

$Mjs     = Join-Path $Dir "ask-claude-mcp.mjs"
$Section = Join-Path $Dir "CLAUDE-codex-section.md"
foreach ($f in @($Mjs, $Section)) {
  if (-not (Test-Path $f)) {
    Write-Host "X $(Split-Path $f -Leaf) is missing from $Dir - the folder is incomplete."
    exit 1
  }
}
$MjsToml = $Mjs -replace '\\', '/'

# --- 2. Point Codex at the relay -----------------------------
$CodexDir    = Join-Path $env:USERPROFILE ".codex"
$CodexConfig = Join-Path $CodexDir "config.toml"
New-Item -ItemType Directory -Force -Path $CodexDir | Out-Null
if (-not (Test-Path $CodexConfig)) { New-Item -ItemType File -Path $CodexConfig | Out-Null }

# A pinned model in Codex's config is a common landmine: model names get
# retired, the pin goes stale, and every codex exec run fails with
# "model rejected" even though interactive Codex still works.
$PinnedModel = ""
foreach ($line in @(Get-Content $CodexConfig)) {
  if ($line -match '^\s*\[') { break }
  if ($line -match '^\s*model\s*=') { $PinnedModel = $line.Trim(); break }
}
if ($PinnedModel) {
  Write-Host "! Your Codex config pins a model:  $PinnedModel"
  Write-Host "  If codex exec or image generation ever fails with a 'model rejected'"
  Write-Host "  error, delete that line from ~\.codex\config.toml and restart Codex."
  Write-Host "  Codex then uses its current default model, which your account supports."
}

if (Select-String -Path $CodexConfig -Pattern '^\s*\[mcp_servers\.claude\]' -Quiet) {
  Write-Host "   Codex config already has an [mcp_servers.claude] entry - leaving it alone."
  $ApprovalOk = $false
  $InTable = $false
  foreach ($line in @(Get-Content $CodexConfig)) {
    if ($line -match '^\s*\[mcp_servers\.claude\.tools\.ask_claude\]') { $InTable = $true; continue }
    if ($InTable -and $line -match '^\s*\[') { break }
    if ($InTable -and $line -match '^\s*approval_mode\s*=\s*"approve"') { $ApprovalOk = $true; break }
  }
  if (-not $ApprovalOk) {
    Write-Host "! But that entry is missing the critical approval setting, so headless Codex"
    Write-Host "  runs will auto-deny the relay. Make sure ~\.codex\config.toml has these two lines:"
    Write-Host ""
    Write-Host "  [mcp_servers.claude.tools.ask_claude]"
    Write-Host '  approval_mode = "approve"'
  }
} else {
  $block = @"

[mcp_servers.claude]
command = "$NodeToml"
args = ["$MjsToml"]
tool_timeout_sec = 600

[mcp_servers.claude.tools.ask_claude]
approval_mode = "approve"
"@
  Append-Utf8 $CodexConfig ($block + "`n")
  Write-Host "OK: Codex now knows about the relay ($CodexConfig)."
}

# --- 3. Teach Claude how to call Codex -----------------------
$ClaudeDir = Join-Path $env:USERPROFILE ".claude"
$ClaudeMd  = Join-Path $ClaudeDir "CLAUDE.md"
New-Item -ItemType Directory -Force -Path $ClaudeDir | Out-Null
if (-not (Test-Path $ClaudeMd)) { New-Item -ItemType File -Path $ClaudeMd | Out-Null }

if (Select-String -Path $ClaudeMd -Pattern '^# Codex is always available' -Quiet) {
  Write-Host "   Claude's CLAUDE.md already has the Codex section - leaving it alone."
} else {
  $sectionText = [System.IO.File]::ReadAllText($Section, $Utf8)
  Append-Utf8 $ClaudeMd ("`n" + $sectionText)
  Write-Host "OK: Claude now knows how to call Codex ($ClaudeMd)."
}

Write-Host ""
Write-Host "Done. Last things:"
Write-Host "  - Restart Codex (close and reopen VS Code) so it picks up the new config."
Write-Host "  - Keep this folder where it is - Codex's config points here."
Write-Host "  - Not signed in yet? Run codex once and claude once and log in."
