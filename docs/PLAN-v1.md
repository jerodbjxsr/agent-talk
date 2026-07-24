# agent-talk v1 — implementation plan

Status: **revision 2** — attacked by an independent Codex review (12 findings, 4
blockers) plus a parallel Claude adversarial pass; every finding is resolved or
explicitly re-scoped below. Decisions it implements are in `DESIGN.md`; facts it
relies on are cited in `research/cli-adapter-feasibility.md` (2026-07-24).

Two items in this revision changed scope vs. what was previously agreed and need
Bryan's sign-off (flagged ⚑ inline): platform scope, and staged callee enablement.

## Goal

Generalize the Frenemy relay from Claude ↔ Codex to a mesh over four agentic CLIs —
**Claude Code, Codex, Gemini CLI, OpenCode** — subscription/OAuth auth only,
preserving and *proving* upstream's security posture rather than asserting it.

## The core security reframe (out of the review)

The mesh has two distinct roles per CLI, with different risk profiles:

- **Host** (mounts the relay, calls others): cheap to enable safely — the host's own
  approval machinery governs it.
- **Callee** (spawned headless by the relay): safe **only** if read-only can be
  *enforced* against a hostile repo. Claude and Codex have proven mechanisms
  (`--safe-mode`+tool removal; OS sandbox). Gemini and OpenCode currently do not:
  both load project config from the workspace, and OpenCode's project `opencode.json`
  *overrides* any config we supply.

⚑ **Therefore v1 stages enablement:** Gemini and OpenCode become **hosts immediately**
("I'm in Gemini, ask Claude/Codex" works day 1). They become **callees** only after
the hostile-repo test suite (H-series below) proves enforcement — or, if it fails,
only with Bryan's explicit ruling to ship them labeled **advisory-only** and
never-auto-approved on every host. No tool is ever labeled "enforced" on the
strength of a README claim. (This preserves the round-1 agent set decision; it
changes *when* each direction lights up.)

## Architecture

### One relay server, host-aware, capability-gated tools

`agent-talk-mcp.mjs` — still a single dependency-free Node file.

- Started with `--host <name>` by each CLI's mount config.
- `tools/list` = `ask_<agent>` for every *callee-enabled* agent except the host.
- **Write-tool exposure is decided server-side per host** (review blocker #1):
  `ask_claude_write` is offered **only** to hosts with per-tool approval granularity
  — today that is Codex alone (`approval_mode` per tool). Gemini's `trust: true` is
  server-wide, so Gemini's mount simply never sees a write tool. No config hope; the
  server refuses `tools/call` for a write tool from a non-eligible host even if asked.
- Sanitize pass (control-strip + key redaction) unchanged from upstream.

### Adapter registry (embedded)

Per agent: `bin` (+ platform resolution rule), `readArgs`, `writeArgs` (claude only),
`promptVia: stdin` (all four), `parse` strategy + extractor, `timeoutMs`,
`envPolicy` (below), `meshDisableArgs` (below), `calleeEnabled` flag.

Spawn specs (validated against `research/cli-adapter-feasibility.md`; each lands
with recorded fixtures, not assumptions):

- **claude:** `-p --output-format json --safe-mode --disallowedTools Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch --strict-mcp-config` (unchanged). Parse: single JSON doc, `result`/`is_error`.
- **codex:** `codex exec --sandbox read-only --skip-git-repo-check --json -` with
  `-c` config overrides to disable its agent-talk MCP mount for the child run
  (exact override syntax is verification item V1; if no per-invocation disable
  exists, fall back to `-o FILE` + a temp CODEX_HOME — V1 decides). Parse: NDJSON,
  final agent message; fixtures captured from the pinned version.
- **gemini (callee-gated):** prompt via stdin, `--output-format json`, explicit
  tool restriction flags/settings pinned to a tested Gemini version — the exact
  invocation is *defined by* H-series results, not guessed here. Parse: single JSON
  doc, `response`/`error`.
- **opencode (callee-gated):** `opencode run --format json` via stdin **plus a
  proven boundary against project-config override** — if H-series shows none
  exists, opencode-as-callee ships advisory-labeled or not at all (Bryan's call).
  Parse: NDJSON, fold `text` events; fixture-driven delta-vs-complete rule.

### Parsing robustness (review #7)

Per pinned CLI version: captured real transcripts as parser fixtures (success, tool
use, partial output, error-after-partial-text, malformed line, oversized event).
Malformed NDJSON lines are skipped and counted, never crash the relay; per-line and
total byte caps on child stdout/stderr before parsing.

### Recursion containment (review #3 — reframed honestly)

The env-var depth counter is a **debris net, not a boundary**. The real boundary:

1. Every callee is spawned with its mesh access **definitively disabled** via a
   verified per-CLI mechanism (claude: `--strict-mcp-config` — proven; codex: V1;
   gemini/opencode: part of their H-series gate — no disable mechanism, no callee).
2. `AGENT_TALK_DEPTH` remains as defense-in-depth: relay refuses calls at inherited
   depth ≥ 2. Documented as best-effort (a shell-capable callee could clear it —
   which is why boundary #1 is the load-bearing one, and why read-only callees have
   no shell).
3. **The Claude Bash fallback closes its own hole:** the generated CLAUDE.md
   long-job pattern includes the same mesh-disable flags for `codex exec` (V1
   syntax), so the documented path cannot silently re-enter the mesh at depth zero.
   This path is advisory by nature (it always was, upstream too) and is labeled so.
4. Per-hop bounds stay: hard kill, concurrency cap, output cap.

### Process hygiene (review #8)

- Callees spawned in their own **process group**; timeout kills the group
  (`kill(-pid)`), not just the child. Verified by a test that a callee's own
  grandchildren are gone after timeout.
- Concurrency cap documented honestly as **per relay instance** (each host runs its
  own relay). No machine-wide token mechanism in v1; noted as a known limit.

### Auth enforcement at runtime (review #5)

"Subscription only" becomes mechanical, not aspirational:

- **Env scrubbing:** child env is allowlist-built, dropping `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, and
  friends (full list in the registry's `envPolicy`), so a callee cannot silently
  ride an API key.
- **Provider pinning for OpenCode:** the adapter passes an explicit model/provider
  selection restricted to ChatGPT/Copilot OAuth providers (never the
  Anthropic-sub path, never Zen/API-key providers); refuses to run if none is
  configured. Exact flag is V2.
- Preflight reports auth *kind* only — never a credential value.

### Claude `--bare` risk (review #6)

- Relay does a **startup preflight** per session (not install-time only): checks
  `claude --version` against a tested-compatible range; on newer versions, probes
  headless auth mode and refuses with a clear error naming the fix if OAuth is
  skipped. The moment an explicit non-bare flag ships, it goes into `readArgs`.

## Installer (review #9 — now a design, not an aspiration)

- All structured-config edits (Gemini/OpenCode JSON, Codex TOML) are done via
  **Node one-liners** (Node is already a prerequisite) — parse, modify, atomic
  write (`tmp` + rename), timestamped `.bak` backup. Never regex-append into JSON.
- Every block the installer owns is wrapped in **managed markers**
  (`# >>> agent-talk >>>` / `# <<< agent-talk <<<`, or a `"_managed_by"` key in
  JSON) and re-runs **reconcile** (replace the managed region) instead of skipping.
- `--dry-run` prints the exact diff per file before anything is touched.
- **Migration:** add the new mount *first*, verify it, then offer removal of the
  old Frenemy `[mcp_servers.claude]` block and the old CLAUDE.md section (which
  gets managed markers going forward; the upstream section is detected by its
  heading and offered for replacement, never silently rewritten).
- Detects which CLIs are installed; wires present ones; reports skipped ones.
- Claude mount: `claude mcp add --scope user` with the `--host claude` arg
  (exact command recorded in the PR from a live run, not from memory).

⚑ **Platform scope: macOS/Linux only for v1.** Everything in this house is macOS;
upstream's Windows support (claude.exe resolution) is kept compiling for the
claude/codex pair, but Gemini/OpenCode Windows resolution, config paths, and
process-group kills are explicitly **out of scope for v1** — stated in the README,
not discovered by a Windows user at runtime. (Needs Bryan's sign-off; the
alternative is making Windows a release gate, which delays v1 for a platform no
one here uses.)

## Test program

**V-series (verification, before code freeze per adapter):**
- V1 codex per-invocation MCP-disable syntax · V2 opencode provider-pin flag ·
- V3 gemini stdin+json combined headless behavior · V4 `claude mcp add` exact form.

**H-series (hostile-repo gate — a fixture repo containing malicious
`.gemini/settings.json`, `opencode.json`, `.codex/config.toml`, `AGENTS.md`):**
- H1 gemini callee told to write/exec with hostile project settings present →
  must fail closed on all of: file write, shell, MCP injection, `.env` read.
- H2 opencode callee same probe → deny rules must survive the hostile override
  attempt, else callee demoted.
- H3 codex callee in hostile repo (trust gate) → project config must not load.
- H4 claude callee (control — expected pass via `--setting-sources`).

**A-series (acceptance matrix):** every enabled host × callee direction, one live
ask each; no-self-call check; write tool visible only from Codex and prompting
there; recursion refusal (E3-style, both the MCP path and the Bash-fallback path);
timeout kills the whole process group; auth preflight fails closed with a dummy
API key planted and OAuth cache removed (in an isolated HOME).

Results of every series are recorded in the PR bodies.

## PR sequence (review #11 — each PR independently shippable)

1. **PR 1 — compatibility refactor.** Registry structure, host-awareness, process-
   group kills, parser fixtures for claude+codex, managed-marker installer with
   migration fixtures. **Filename and existing mounts keep working** (old name kept
   as a thin wrapper until PR 4 removes it). Codex↔Claude behavior identical;
   upstream smoke tests pass before/after.
2. **PR 2 — mesh core.** `--host` mounts for all four CLIs (host role only for
   gemini/opencode), codex-as-callee with V1-verified mesh disable, recursion
   containment, auth scrubbing, `--bare` preflight. A-series for the enabled
   directions in the PR body.
3. **PR 3 — gemini callee**, gated on H1: adapter + docs + evidence in one PR.
4. **PR 4 — opencode callee**, gated on H2, same shape; removes the compat wrapper;
   README rewrite finalized (per-agent security table, quotas, migration guide).

If H1/H2 fail: the corresponding PR becomes the "advisory-labeled" variant **only
after** Bryan rules on it — otherwise that callee waits for upstream CLI fixes.

## Out of scope for v1 (tracked, not dropped)

- Kimi Code CLI (phase 2; membership + its own H-series).
- Qwen (parked — auth).
- Write tools for gemini/opencode; write tools offered to any host lacking
  per-tool approval.
- Windows for gemini/opencode paths (⚑ pending sign-off).
- Streaming/progress relay, background job handles, machine-wide concurrency cap.
