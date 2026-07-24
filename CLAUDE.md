# agent-talk — project rules

Diverged fork of Frenemy (Zakariya Syed, MIT — keep attribution). A mesh relay that
lets agentic coding CLIs (Claude Code, Codex, Gemini CLI, OpenCode) call each other
headlessly on subscription/OAuth auth.

**Read first:** `docs/DESIGN.md` (settled decisions — do not relitigate),
`docs/PLAN-v1.md` (implementation plan, survived adversarial review),
`docs/research/cli-adapter-feasibility.md` (per-CLI facts, cited).

## Hard rules

- **Subscription/OAuth auth only. No API keys, ever** — not in code, config,
  examples, or tests (dummy keys in isolated test HOMEs are the one exception).
- **No security claim without recorded evidence.** "Enforced read-only" may only be
  said of a callee whose H-series hostile-repo test passed; results go in the PR
  body. Unproven paths are labeled advisory and are never auto-approved anywhere.
- **The relay stays a single dependency-free Node file** a stranger can audit
  end to end. The installer may use Node one-liners; it may not add dependencies.
- **Merge policy (standing grant from Bryan, 2026-07-24): build → PR with test
  evidence → self-merge when the recorded checks pass.** Branch always; never
  commit to main directly. PRs must survive a human reviewer, not just the grant.
- Platform scope v1: macOS/Linux. Windows only for the Claude/Codex pair
  (upstream parity).
