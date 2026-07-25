# Handoff — read this first

You are picking up **agent-talk**, a mesh relay that lets terminal coding agents
call each other on subscription/OAuth auth (no API keys). This file is the entry
point: read it, then the read-order below, then start the task at the bottom.

## Read order (all short)

1. **`CLAUDE.md`** (repo root) — the hard rules. Non-negotiable. In particular:
   subscription-auth only; **no security claim without recorded evidence**; the
   relay stays one dependency-free Node file; **merge policy is build → PR with
   evidence → self-merge** (Bryan pre-granted this — don't re-ask per PR); never
   commit to main.
2. **`docs/DESIGN.md`** — the 12 settled decisions (do **not** relitigate them),
   the current status block, the long-term enforcement ladder, and the per-CLI
   callee blockers. This is the source of truth for *why* things are the way
   they are.
3. **`docs/PLAN-v1.md`** — the implementation plan that shipped (it survived an
   independent Codex adversarial review; findings are folded in).
4. **`docs/research/cli-adapter-feasibility.md`** — cited per-CLI facts
   (headless invocation, auth, read-only, MCP) for Claude, Codex, Gemini/
   Antigravity, Qwen, Kimi, OpenCode.

Skim the code once: **`agent-talk-mcp.mjs`** is the whole relay (~450 lines,
one file). The adapter registry (`const AGENTS`) is where every per-CLI
decision lives.

## Where things stand (2026-07-24)

Merged PRs #1–#10, plus the phase-2 **relay-owned OS sandbox**. Working and
installed live on Bryan's machine:

- **Claude ↔ Codex** call each other both directions (live-verified).
- **The relay-owned OS sandbox is built, tested and wired** — but it unlocked
  **no new callee**, which is the honest result. It closes the write and
  local-exec vectors (proven in `test/sandbox.test.mjs`); it cannot close a
  project-supplied **remote** MCP server, which is what keeps OpenCode out.
- **Antigravity (`agy`) and OpenCode are hosts** — they can call Claude/Codex.
  Full invocation from a host is interactive-approve; **do not hardcode any
  `--dangerously-skip-permissions`-style flag** to force it headless.
- **Neither Antigravity nor OpenCode is a callee**, and in neither case is the
  sandbox at fault. Antigravity's headless mode auto-denies even `read_file`;
  OpenCode honours a hostile repo's remote MCP server (demonstrated live —
  see the H2 blocker test). Both are written up in `DESIGN.md`.

Tests: `node --test 'test/*.test.mjs'` → 54 pass, 6 skip (the skips are the
opt-in live/hostile-repo tests). Live + security gates:
`AGENT_TALK_LIVE=1 node --test test/live.test.mjs test/h-series.test.mjs`
(spends real subscription quota).

The sandbox has its own hermetic enforcement tests in `test/sandbox.test.mjs`:
they run hostile commands under the generated profile and assert the kernel
refuses them. Those exist because H-series alone cannot distinguish "the model
politely declined" from "the kernel refused" — only one of those is a security
property. If you touch the profile, that file is the gate.

## Your task: pick up from the sandbox

The OS sandbox below is **done and merged**; this section is kept as the record
of what it was meant to achieve. The live next steps are:

1. **Answer the Antigravity permission question** (DESIGN.md → "Open
   decision"). It is a one-line `calleeEnabled` flip plus a live H1 run once
   decided; the sandbox config for `agy` is already written and tested.
2. **File the OpenCode upstream ask**: an ignore-project-config / trusted-folder
   mode. That single flag would make `ask_opencode` shippable, since everything
   else about it already passes under the sandbox.
3. **Kimi Code CLI adapter** — needs a paid membership (Bryan's spend decision)
   and its own H-probe under the sandbox.
4. **Linux support for sandboxed callees** — today the relay refuses off macOS
   rather than running unconfined. Needs a bwrap/Landlock profile *and* the
   H-series run on real Linux; do not ship it on reasoning alone.

## Original task description: the relay-owned OS sandbox (phase 2)

**Goal.** Make *any* callee enforceably read-only from the relay's side, instead
of depending on each CLI's own flags. This is the single unlock that lets
Antigravity, OpenCode, and (later) Kimi become callees — none of them has a
read-only mode we can enforce against a hostile repo today (blockers are in
`DESIGN.md`).

**Why it's needed (don't skip this reasoning).** A callee must be able to *read*
the repo but never *write* it, run shell side effects, or reach the network to
exfiltrate. Claude and Codex give us that via their own flags (`--safe-mode` +
tool bans; `--sandbox read-only`). The others don't. So the relay must impose it
by launching the callee inside an OS sandbox it controls.

**Scope (macOS + Linux; this house is macOS-first).**
- macOS: `sandbox-exec` with a Seatbelt profile — allow read everywhere the repo
  needs, allow the callee's own binary/runtime, **deny file writes** (except a
  temp scratch it may need) and **deny outbound network**. Verify `sandbox-exec`
  is still available (deprecated but present); if it's gone on Bryan's OS
  version, say so and fall back to a per-callee approach.
- Linux: `bwrap` (bubblewrap) with a read-only bind of the workspace and no
  network, or Landlock if simpler. Pick one, justify it.
- Wire it as an optional wrapper in the adapter registry (e.g. a `sandbox: true`
  field + a `wrapSpawn` helper) so Claude/Codex keep their native enforcement
  and only the flag-less CLIs get the OS wrapper. Keep the relay one file, no
  deps.

**Acceptance bar — this is the whole point, so make it real.**
1. The existing **H-series** (`test/h-series.test.mjs`) is the gate. Add H1
   (Antigravity) and H2 (OpenCode) probes modeled exactly on the passing H3/H4:
   point the sandboxed callee at `test/fixtures/hostile-repo/` and prove **no**
   file write, **no** shell side effect, **no** MCP injection, **no** secret
   exfiltration — even though the fixture sits in a trusted project path.
2. Only after a callee's H-probe passes live do you flip its `calleeEnabled` to
   `true`. Record the live result in the PR body. If a callee can't be made to
   pass, it stays host-only — say so plainly; do not relax the probe.
3. Prove the callee can still *read* (a real question answered correctly through
   the relay) — a sandbox that blocks reads too is useless.

**Verification discipline (Bryan delegates this to you — there is no human diff
review).** Drive the real CLIs in Bryan's environment; a green stub test is not
proof for a security claim. Route the sandbox profile through a Codex adversarial
cross-review before merge (see the `codex-collab` skill / `ask_codex`), the same
way the plan and the relay refactor were reviewed.

**Prerequisites / spend.** The Kimi adapter additionally needs a paid Kimi
membership — that's a spend decision only Bryan makes; don't assume it. The
sandbox work itself needs nothing new.

## After the sandbox

- Kimi Code CLI adapter (needs membership + its own H-probe under the sandbox).
- Anything Bryan raises. Do **not** propose making the repo public — that's his
  call, gated on licensing, which he raises himself.
