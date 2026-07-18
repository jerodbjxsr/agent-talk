# Codex is always available

The `codex` CLI (ChatGPT subscription, no API key) is installed and on `PATH` (verify:
`which codex`). **Available in every folder and every session.** Never say you lack access
to Codex/ChatGPT.

When the user asks you to send something to Codex / ChatGPT / GPT (audit, review, second opinion,
image generation), delegate with:

```bash
codex exec --sandbox read-only --skip-git-repo-check - <<'FRENEMY_PROMPT'
<one self-contained prompt>
FRENEMY_PROMPT
```

Rules:
- **Pass the prompt with `-` and a single-quoted heredoc, exactly as above.** The heredoc
  feeds the prompt through stdin and ends it at the delimiter, so Codex gets a clean
  end-of-input and cannot hang waiting on stdin. The quoted delimiter stops the shell from
  expanding anything inside the prompt, and the prompt stays out of the process list. Pick
  a delimiter that never appears on its own line in the prompt.
- **Never let it hang unbounded.** `codex exec` has no built-in timeout or max-turns flag, and can
  stall on network, rate limits, or a long agent loop. macOS does not ship GNU `timeout`/`gtimeout`
  by default. So the caller must bound it. Pick one:
  - **Short job** (review, second opinion, 1 or 2 images): run in the foreground with the Bash-tool
    `timeout` at the 600000ms (10 min) max. Never guess a smaller number.
  - **Long job** (batch of images, big refactor, anything likely >10 min): run it in the
    background. No time limit, and it cannot freeze the chat. Add `-o /path/to/answer.md`
    so the final answer lands in a file you can read when it finishes.
- Codex starts **blank**: it cannot see this conversation. Put everything it needs in the prompt.
- Default to `--sandbox read-only` (reviews, audits, second opinions). Use `workspace-write` only
  when Codex must write files (e.g. generating images straight into the project).
- Codex generates images with gpt-image-2 on the subscription. Tell it the exact output path.
- Report Codex's answer back in the chat. The user should never have to switch panes.

## Image generation (optional): use the script, not a hand-composed prompt

Only applies if you installed `genimg.sh` (see the frenemy README). For any single-image
request, run:

```bash
~/.claude/scripts/genimg.sh "<image prompt>" /absolute/path/out.png
```

Foreground, Bash-tool `timeout` 600000ms. It handles quoting and sandboxing (Codex works in a
throwaway temp folder; the script moves the finished image to the output path). Pass the user's
image prompt verbatim. Do not expand or embellish it.

If the user names a model or an effort level, pass them as environment variables, e.g.
`CODEX_MODEL="gpt-5.6-sol" CODEX_EFFORT="high" ~/.claude/scripts/genimg.sh ...`
(effort: minimal, low, medium, high, xhigh, or ultra; "extra high" means xhigh). If the
user names neither, set neither: the script
then uses the account's default model at medium effort. Never edit the script itself.
