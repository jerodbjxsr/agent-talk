# agent-talk — design decisions and status

Diverged fork of [Frenemy](https://github.com/noblehacks) (Zakariya Syed, MIT). Upstream
scope: bidirectional Claude Code ↔ Codex relay on subscription auth. This fork broadens
it to a mesh of agentic coding CLIs.

**Status:** v1 core complete; phase-2 OS sandbox shipped (2026-07-24). Working
today: **Claude ↔ Codex both directions**, live-verified. Antigravity and
OpenCode are mounted as **hosts**; neither is a callee — the sandbox works, but
each fails the gate for a CLI-specific reason recorded below.

Shipped: docs foundation; relay registry refactor (byte-parity, tested);
reconciling managed-marker installer; mesh core (codex callee, credential
scrubbing, --bare surfacing); host mounts for all four CLIs; H-series
hostile-repo gate (H3 codex + H4 claude PASS live); mesh README (honesty-
corrected against Codex review). 39 hermetic tests green; live A-series and
H3/H4 green.

**Update 2026-07-24 (later):** Bryan installed **Antigravity CLI (`agy` 1.1.7,
Google's successor to Gemini CLI)** and authed it, and authed **OpenCode to
OpenAI (OAuth)**. Both are now wired and verified as **hosts** — the relay's
`ask_claude`/`ask_codex` tools load and are visible inside each (confirmed live:
`agy -p` lists them; OpenCode `run` lists them). Completing a call is
interactive-approve; headless auto-approval needs a per-CLI skip flag we
deliberately don't hardcode. The `gemini` adapter was replaced by `antigravity`
(Bryan is moving off Gemini CLI).

**Update 2026-07-24 (phase 2): the relay-owned OS sandbox shipped. No new
callee was unlocked by it, and that is the honest result.** The mechanism works
and is tested; both candidate callees fail for reasons the sandbox cannot
reach. Neither is a sandbox defect, and both are now precisely characterized
rather than guessed at.

- **OpenCode — the sandbox holds, but it is not sufficient.** Under the profile
  it runs, answers correctly (live read test, 2026-07-24), cannot write, and
  cannot start the hostile fixture's *local* MCP server because no shell is
  executable. **But OpenCode supports remote MCP servers**, and a hostile
  repo's `opencode.json` is a later config layer than anything we supply. A
  URL is not a process, so the exec allowlist is irrelevant to it.
  **Demonstrated live 2026-07-24**: a sandboxed OpenCode completed a full MCP
  `initialize` handshake against a local listener configured purely by the
  repo. That defeats both "no MCP injection" and any exfiltration claim, so
  `calleeEnabled` stays `false`. Encoded as a characterization test (H2
  blocker) that will fail — deliberately — if upstream ever fixes it.
  Both counters were tested and both fail: denying reads of the project config
  makes OpenCode exit 1 (unreadable is fatal, not absent), and Seatbelt cannot
  filter egress by hostname. **The upstream ask is an ignore-project-config
  mode.**
- **Antigravity — still host-only, new blocker.** The sandbox itself *works* on
  `agy` (it authenticates and answers under the profile). The blocker is now
  agy's own headless mode, which auto-denies every tool needing approval —
  including `read_file` ("a tool required the read_file permission that
  headless mode cannot prompt for, so it was auto-denied", live 2026-07-24). A
  callee that cannot read the repo is useless. The only ways past are
  `--dangerously-skip-permissions` (this repo deliberately does not hardcode
  such flags) or writing allow-rules into the user's global
  `~/.gemini/settings.json`, which would change their interactive agy too.
  **Open question for Bryan — see "Open decision" below.** Its earlier
  blockers stand and are unfixable by a sandbox: no JSON output, and an
  argv-only prompt (process-list exposure).

Phase 2 remaining (tracked, not scheduled): Kimi Code CLI adapter (needs a paid
membership — Bryan's spend decision — plus its own H-probe under the sandbox).
Note Kimi shares OpenCode's shape of problem (project config overrides, no
settings isolation), so check the remote-MCP vector there before assuming the
sandbox unlocks it.

## The relay-owned OS sandbox (shipped 2026-07-24)

Verified on macOS 26.5.2, opencode 1.16.2, agy 1.1.7. `sandbox-exec` is
deprecated but present and functional [seen: `/usr/bin/sandbox-exec`].

**What it enforces**, kernel-level, regardless of what the callee's config says.
Proven by `test/sandbox.test.mjs`, which runs hostile commands under the real
generated profile with no model in the loop:
- **No file writes** outside the CLI's own state dirs and the temp dir. The
  workspace is read-only.
- **No process execution** outside a per-callee allowlist. No shell is on any
  allowlist, and no JS runtime — so a callee cannot start a *local* MCP server
  even when one is configured. Note the word local: this does nothing about a
  **remote** MCP server, which is just a URL. That gap is what sank OpenCode.
- **No reads** of a curated credential set (ssh/aws/gnupg, and the other
  agents' OAuth stores).

**What it deliberately does not enforce, stated plainly:**
- **Outbound network is allowed.** These are cloud CLIs; with no network a
  callee cannot answer at all. Seatbelt filters by address/port, never by
  hostname, so "allow the vendor's API, deny everything else" is not
  expressible. Containment is that only allowlisted binaries can open sockets.
  Whatever the callee reads is still seen by its own provider — exactly as is
  already true for Claude and Codex.
- **The callee may write its own state dir** (session DB, logs, refreshed
  tokens), because it cannot run otherwise. Its install directory and its own
  MCP config are denied by rule; the config the relay hands it is regenerated
  on every call, so an edit made by one run is never inherited by the next.

**Platform:** macOS only. Linux (bwrap/Landlock) is NOT implemented: the relay
*refuses* to run a sandboxed callee off macOS rather than silently running it
unconfined. Shipping an untested Linux profile would mean making a security
claim with no evidence behind it, which this repo's rules forbid.

**Two findings worth remembering** (both cost real debugging time):
- Seatbelt matches **realpath**. Homebrew's `rg` is a symlink into `../Cellar`;
  allowlisting the symlink matches nothing, and the failure surfaces as the
  callee *hanging*, not erroring. Every path in a profile is realpath-resolved.
- A denied exec makes OpenCode fail obscurely ("Session not found") or hang
  rather than report a permission error. It needs `rg` (glob/grep) and `git`
  (session snapshots); the relay treats a missing helper as "callee
  unavailable" instead of shipping something that stalls.

## Decision 13 — Antigravity stays host-only (Bryan, 2026-07-24). SETTLED.

Ruled: leave `agy` host-only. Do **not** pass `--dangerously-skip-permissions`
inside the sandbox, and do **not** have the installer write allow-rules into
`~/.gemini/settings.json`. Closed — do not re-raise.

What that costs, so nobody has to re-derive it:

- **No Gemini-family model answers into the mesh.** The callee pool stays
  Claude + Codex, so a "second opinion" is always one of those two. The
  direction that matters most in practice — Claude → Antigravity — is exactly
  the one that does not work.
- **The loss is narrower than it looks:** `agy -p` answers fine from prompt
  text (verified live). What it cannot do headless is *read the repo itself*.
  So a Gemini opinion is still reachable by inlining the material into the
  prompt via Bash (`agy -p "<question + pasted content>"`) — the caller brokers
  the context instead of the callee fetching it. Costs: prompt goes in argv
  (process-list exposure, ARG_MAX ceiling) and output is prose, not JSON.
- **Unaffected:** Claude ↔ Codex both directions, and agy as a host calling
  Claude/Codex (interactive-approve, which is fine in a session he is sitting in).

Reopen only if Antigravity ships a headless mode with per-tool allow-rules that
do not require a blanket skip flag.

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
