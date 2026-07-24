# agent-talk — design decisions and status

Diverged fork of [Frenemy](https://github.com/noblehacks) (Zakariya Syed, MIT). Upstream
scope: bidirectional Claude Code ↔ Codex relay on subscription auth. This fork broadens
it to a mesh of agentic coding CLIs.

**Status:** v1 core complete (2026-07-24). PRs #1–#8 merged and installed live
on this machine. Working today: **Claude ↔ Codex both directions**, live-verified
through the installed relay (Codex→Claude and Claude→Codex). Gemini and OpenCode
are mounted as **hosts** (they can call Claude/Codex once logged in).

Shipped: docs foundation; relay registry refactor (byte-parity, tested);
reconciling managed-marker installer; mesh core (codex callee, credential
scrubbing, --bare surfacing); host mounts for all four CLIs; H-series
hostile-repo gate (H3 codex + H4 claude PASS live); mesh README (honesty-
corrected against Codex review). 39 hermetic tests green; live A-series and
H3/H4 green.

**Remaining — all blocked on Bryan's interactive OAuth (can't be done headless):**
1. `gemini` login (`gemini` → `/auth`, Google account) → run H1
   (`AGENT_TALK_LIVE=1 node --test test/h-series.test.mjs`) → if it passes, flip
   `gemini.calleeEnabled = true`.
2. `opencode auth login` (ChatGPT or Copilot — **not** the Anthropic-sub path,
   ToS-prohibited) → run H2 → flip `opencode.calleeEnabled = true`.
Each is a ~5-line change (registry flag + the H test un-skipped) once its probe
passes. Gemini CLI is installed (0.52.0, symlinked into ~/.local/bin); OpenCode
is installed but has 0 credentials.

Phase 2 (tracked, not scheduled): Kimi Code CLI adapter; relay-owned OS sandbox
as the universal enforcement end-state (also the Kimi unlock).

## Settled decisions (Bryan, 2026-07-24)

1. **Unit of extension: agentic CLIs only.** Every backend is a coding agent that sees
   the repo on disk and runs on subscription/OAuth auth. No API keys, no chat-completion
   routers. A model with no viable subscription CLI is out of scope until one exists.
2. **Topology: full mesh, no hub.** Any agent can call any other. Bidirectionality is
   the core feature, not a convenience — e.g. working inside Codex and calling Claude,
   or inside Claude and having Codex generate an image. (Reference workflow: upstream
   author's demo, https://www.youtube.com/watch?v=GNHqMyc95OM)
3. **Fork intent: diverge as own project.** Keep MIT attribution to Zakariya; rename,
   restructure, and redesign freely. No obligation to stay upstream-mergeable.
4. **Name: `agent-talk`.** Update MCP serverInfo, README, and installer text to match.
5. **Round-1 adapter set: Gemini CLI + OpenCode** (plus the existing Claude/Codex pair).
   Both verified viable with enforceable security stories — see
   `research/cli-adapter-feasibility.md`. OpenCode must use its ChatGPT/Copilot OAuth;
   its Claude-subscription OAuth path is Anthropic-ToS-prohibited per OpenCode's docs.
6. **Qwen: excluded** (its free OAuth was discontinued 2026-04-15; all remaining auth
   is API-key-shaped, including the paid Coding Plan's `sk-sp-…` key). PARKED, not
   dead: re-surface if a login-based auth path returns.
7. **Kimi Code CLI: phase 2.** Subscription OAuth exists, but headless `-p` auto-approves
   tools with no combinable read-only mode. Gated on (a) buying a Kimi membership and
   (b) empirically proving `[[permission.rules]]` deny survives headless auto-approve.

## Architecture sketch (pending research validation)

Full mesh without N² cost:

- **One generic relay server**, evolved from `ask-claude-mcp.mjs`, driven by a per-agent
  adapter registry: how to invoke each CLI headless, how to parse its output, how to
  enforce read-only, timeout.
- **Every CLI mounts the same server** in its MCP config, told who its host is; it
  exposes `ask_<agent>` (and `ask_<agent>_write` where safe) for every agent *except*
  the host. Adding agent N+1 = one adapter + re-run installer.
- **Recursion guard becomes mandatory:** a hop-depth env var (e.g. `AGENT_TALK_DEPTH`)
  threaded through spawned children, replacing upstream's advisory "don't let them
  play ping-pong." Full mesh makes loops easy to create by accident.
- Preserve upstream's security posture per agent where the CLI allows it: enforced
  read-only default tool, write variant never auto-approved, settings isolation so a
  cloned repo's own hooks/MCP can't join the relay, stdin prompts (not argv), output
  caps, concurrency caps, kill timeouts.

## Research (done 2026-07-24)

`research/cli-adapter-feasibility.md` — 7 dimensions per CLI, every claim cited.
Design-relevant findings baked into the sketch above, plus three watch items:

- **`--bare` risk:** Claude docs say `--bare` will become the default for `-p`; bare
  mode skips OAuth/keychain (API-key only). The adapter must pin/guard against this
  or a routine Claude update silently breaks subscription auth for the whole mesh.
- **Parser is per-adapter:** single JSON doc (Claude, Gemini) vs NDJSON events
  (Codex, OpenCode) — the registry carries a parse strategy per agent.
- **OpenCode hang history:** external SIGKILL timeout is mandatory; never trust the
  child to exit.

## Settled decisions, continued (Bryan, 2026-07-24)

8. **Claude's caller path: both, by job size.** Claude mounts the relay for standard
   asks; an installer-generated CLAUDE.md section covers long/background jobs
   (image batches, big refactors) via Bash with the same mesh-disable flags.
9. **Read-only first.** New adapters ship without write tools; `ask_claude_write`
   is exposed only to hosts with per-tool approval granularity (today: Codex).
10. **Staged callee enablement.** Gemini/OpenCode are hosts on day 1; they become
    callees per-direction only when the hostile-repo (H-series) tests prove
    read-only enforcement. Accepted "for now" — long-term ladder below.
11. **Platform scope v1: macOS/Linux.** Upstream's Windows support stays working
    for Claude/Codex; Gemini/OpenCode Windows paths are out of scope, stated in
    the README.
12. **Merge policy: PR + self-merge (standing grant).** Claude opens each PR with
    recorded test evidence and merges it when the checks pass. Recorded in the
    repo CLAUDE.md.

## Long-term enforcement ladder (the stage after staging)

Staging (decision 10) is scaffolding. For any callee that can't prove enforcement
via its own flags:

1. **Upstream fix:** file issues (Gemini folder-trust hardening, OpenCode
   ignore-project-config flag); re-run H-series on every CLI update.
2. **Relay-owned OS sandbox (end state):** Seatbelt (macOS) / Landlock or
   bubblewrap (Linux) wrapper makes any callee enforceably read-only regardless
   of its flags — also the unlock for Kimi (phase 2) despite its fail-open
   headless mode. Ephemeral-worktree spawning is the lighter fallback.
3. **Advisory label:** only by Bryan's explicit ruling, never by default.

## Implementation plan

`PLAN-v1.md` — revision 2, survived an independent Codex adversarial review
(12 findings, 4 blockers) plus a parallel Claude pass; all findings resolved or
re-scoped with Bryan's sign-off. PR sequence: docs foundation → compatibility
refactor → mesh core → gemini callee (H1-gated) → opencode callee (H2-gated).

## Working agreement for this repo

- Branch → commit → push → PR → stop. Never commit to main. Merge only on Bryan's word.
  (Merge policy not yet settled for this repo — settle at implementation kickoff.)
