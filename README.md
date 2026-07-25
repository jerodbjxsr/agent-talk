# agent-talk: a mesh relay for coding agents

Let your terminal coding agents call each other, so you never copy/paste between
them. Ask Claude for a review from inside Codex; have Codex generate an image from
inside Claude. It runs on the **subscription/OAuth logins you already have** — the
relay strips API-key environment variables so a callee falls back to its own login
(it does not, and cannot, police every CLI's on-disk credential files).

One tiny, dependency-free file does the work. Read-only by default; file edits live
in a separate tool that is never auto-approved.

Diverged from **Frenemy** by **Zakariya Syed**
([GitHub](https://github.com/noblehacks) ·
[YouTube](https://youtube.com/@noblehacksacademy)), which relayed Claude ↔ Codex.
agent-talk generalizes that into a mesh over more agentic CLIs. MIT licensed
(see LICENSE); not affiliated with Anthropic, OpenAI, or Google.

## What works today

The relay is one MCP server that each CLI mounts. A CLI that mounts it (a **host**)
gets an `ask_<other>` tool for each agent that has passed the safety gate below (a
**callee**). Calls are bidirectional: any host can reach any enabled callee.

| From ↓ / To → | Claude | Codex | Antigravity | OpenCode |
|---|---|---|---|---|
| **Claude** (host) | — | ✅ `ask_codex` | ⏳ | ⏳ |
| **Codex** (host) | ✅ `ask_claude` | — | ⏳ | ⏳ |
| **Antigravity** (host) | ✅ `ask_claude` | ✅ `ask_codex` | — | ⏳ |
| **OpenCode** (host) | ✅ `ask_claude` | ✅ `ask_codex` | — | ⏳ |

✅ = usable now. ⏳ = Antigravity and OpenCode are **hosts** today (they can call
Claude and Codex), but are not yet **callees**: no one can call *them* yet, because
neither has a read-only mode that can be enforced against a hostile repo — the bar
Claude and Codex both cleared (see [Security](#security-what-is-locked-down)). The
specific blockers, per CLI, are recorded in `docs/DESIGN.md`. This staging is
deliberate: a callee is only offered once its read-only enforcement is provable,
never on a promise.

**Antigravity** is Google's `agy` CLI, the successor to Gemini CLI. **Excluded:**
Qwen Code (its free login was discontinued; all remaining auth is API-key-shaped,
and this project is subscription-only). Kimi Code CLI is a future candidate.
Rationale is in `docs/research/cli-adapter-feasibility.md`.

## How to use it

**In Claude**, use the `ask_codex` tool (Claude will reach for it when you ask):
> "Get Codex to generate a hero image and put it in the page."
> "Have Codex review this diff."

**In Codex**, use the `ask_claude` tool:
> "Ask Claude to review app.py."
> "Have Claude refactor this file." (uses `ask_claude_write`; see the approval note below.)

That's it — the answer comes back in the same chat.

**Prerequisites:** `node` 18+, and the CLIs you want to link, each installed, on
`PATH`, and signed in (run each once to log in). Claude Code and Codex are required;
Gemini CLI and OpenCode are optional and wired only if present.

## Install (one command)

Put this folder somewhere permanent, open a terminal inside it, and run:

```bash
bash install.sh            # do it
bash install.sh --dry-run  # preview every change first, write nothing
```

No sudo. It only writes to config files in your home folder. It checks prerequisites,
mounts the relay into every host CLI it finds (skipping absent ones), and offers the
optional image script. **Safe to run twice** — it *reconciles*, replacing the block
it owns rather than duplicating or skipping it, so re-running actually upgrades. Every
changed file gets a `.agent-talk-backup` copy first. When it finishes, restart your CLIs.

**Don't move or delete this folder afterwards.** The configs point at it.

### Migrating from Frenemy

Re-run `install.sh`. The old entry point (`ask-claude-mcp.mjs`) still works — it is now
a thin wrapper around the new relay — so existing installs keep working untouched. The
installer detects the legacy `[mcp_servers.claude]` block and the old CLAUDE.md section
and **warns** about them (it never deletes your files); once you've confirmed the new
`agent_talk` mount works, delete the two legacy blocks by hand to avoid duplicate tools.

## Smoke test

- **Codex → Claude:** in a Codex chat, "Ask Claude to review any file in this repo."
- **Claude → Codex:** in a Claude chat, "Ask Codex what the biggest risk in this file is."
  (The `ask_codex` tool is read-only. Image generation writes files, so it goes through
  the separate `genimg.sh` script or the Bash path — see the note on the long-job path below.)

## Security: what is locked down

The relay's whole reason for existing is to expose *one narrow, safe operation* per
agent instead of that agent's raw tools. Per callee:

| Callee | Read-only enforcement | How |
|---|---|---|
| **Claude** | Enforced | `--safe-mode` (all your customizations off) + the side-effect tools removed (`--disallowedTools`: edit, shell, web) + `--strict-mcp-config` (can't see or re-enter the mesh). |
| **Codex** | Enforced | `--sandbox read-only` (OS-level) + `-c 'mcp_servers={}'` wiping the callee's MCP table for that run. |

Both **passed a live hostile-repo probe** (2026-07-24): `test/h-series.test.mjs` points
each callee at a deliberately hostile repo (malicious project configs plus injected
`AGENTS.md`/`CLAUDE.md` demanding a file write, a shell command, and a secret
exfiltration) and confirms none of it happens — even when the repo sits in a trusted
project path. This is regression evidence, not a proof of safety: a passing probe means
"no side effect observed under this attack," and the probe deliberately hits several
vectors at once to make a false pass unlikely.

Other properties:

- **Prompts go in via stdin, not argv**, so they never appear in process lists.
- **Callee env is scrubbed** of common API-key-shaped variables (named keys plus anything
  matching `_API_KEY`/`_API_TOKEN`/`_AUTH_TOKEN`) so a callee falls back to its
  subscription login. This covers environment variables only, not on-disk credentials.
- **Recursion is contained**: callees are launched with their own mesh access disabled
  (the load-bearing guard), plus a hop-depth counter as defense-in-depth. The Bash
  fallback path (below) carries the same mesh-disable flag.
- **Write is separate.** `ask_claude_write` (the file-editing variant) is offered only to
  hosts that can gate it per-tool (today: Codex); hosts whose MCP trust is server-wide
  (Gemini, OpenCode) never see a write tool. The installer auto-approves **only** the
  read-only `ask_claude` and leaves `ask_claude_write` unapproved, so Codex prompts you
  before any edit — don't add an approval override for it unless you want unattended writes.
- A stuck callee is killed (whole process group) after 10 minutes; output is capped;
  at most 4 callees run at once (per host).

> ⚠️ **The long-job / image path is outside the relay's security boundary.** For jobs
> over ~10 minutes the installed Claude guidance uses Bash (`codex exec …`, and
> `genimg.sh` uses `--sandbox workspace-write` to write images). That path carries the
> mesh-disable flag but is **not** relay-enforced read-only — it relies on your host's
> normal Bash approval policy. Everything through the `ask_*` tools is; the Bash fallback
> is not.

<details>
<summary><b>The critical Codex config line (the installer adds it for you)</b></summary>

Headless `codex exec` auto-denies MCP tool calls unless you set a **per-tool** approval
mode; the *global* approval settings do not work. This is why the installer writes:

```toml
[mcp_servers.agent_talk.tools.ask_claude]
approval_mode = "approve"
```

Only the read-only `ask_claude` is auto-approved. The write variant is deliberately left
unapproved, so interactive Codex prompts you before any edit.

</details>

<details>
<summary><b>Watch item: Claude's <code>--bare</code> mode</b></summary>

Claude Code's docs say `--bare` will become the default for `-p` in a future release, and
bare mode skips OAuth/keychain (API-key auth only). If that flips, headless calls could
stop using your subscription. The relay annotates auth-looking failures with this
explanation so it fails loudly, not mysteriously; when an explicit opt-out flag ships,
it goes into the adapter.

</details>

<details>
<summary><b>Known limits</b></summary>

- **Calls are one-shot and blocking.** Each `ask_*` starts a fresh callee session with
  no memory of your conversation, no streaming, and no progress output; you get one
  final answer, and a stuck call is killed after 10 minutes.
- **Concurrency cap is per host**, not machine-wide: each host runs its own relay process.
- **Platform: macOS/Linux** for the new adapters. Claude ↔ Codex retains upstream's
  Windows support via the compatibility wrapper.
- **Shared rate limits.** Delegating a lot draws on the same subscription pools your
  normal usage does.
- **No video.** Codex generates images (gpt-image-2), not video.

</details>

## For contributors

- `docs/DESIGN.md` — settled decisions and the enforcement roadmap (read first).
- `docs/PLAN-v1.md` — the implementation plan (survived an independent adversarial review).
- `docs/research/cli-adapter-feasibility.md` — per-CLI facts (headless, auth, sandbox, MCP),
  every claim cited.
- Tests: `node --test 'test/*.test.mjs'` (hermetic; uses stub CLIs). Live and hostile-repo
  checks are opt-in: `AGENT_TALK_LIVE=1 node --test test/live.test.mjs test/h-series.test.mjs`.
