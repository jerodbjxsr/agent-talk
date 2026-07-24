# Other coding agents are always available (agent-talk)

Codex (ChatGPT subscription, no API key) is reachable two ways. Pick by job size;
never say you lack access to Codex/ChatGPT.

**Standard asks — reviews, second opinions, quick questions (likely under 10
minutes): use the `ask_codex` MCP tool** (user-scope `agent_talk` server). It runs
Codex in a read-only OS sandbox with the callee's MCP disabled, and relays the
answer. Codex starts blank: it cannot see this conversation, so put everything it
needs in the prompt.

**Long jobs — image batches, big refactors, anything likely over 10 minutes: use
Bash instead**, because the MCP call blocks with no progress output and is killed
at 10 minutes:

```bash
codex exec --sandbox read-only --skip-git-repo-check -c 'mcp_servers={}' - <<'AGENT_TALK_PROMPT'
<one self-contained prompt>
AGENT_TALK_PROMPT
```

Rules for the Bash path:
- **Always include `-c 'mcp_servers={}'`.** It stops the callee from seeing the
  agent-talk relay and re-entering the mesh (loop protection). Do not drop it.
- **Pass the prompt with `-` and a single-quoted heredoc, exactly as above.** The
  heredoc feeds the prompt through stdin and ends it at the delimiter, so Codex
  gets a clean end-of-input and cannot hang waiting on stdin. The quoted delimiter
  stops the shell from expanding anything inside the prompt, and the prompt stays
  out of the process list. Pick a delimiter that never appears on its own line in
  the prompt.
- **Never let it hang unbounded.** `codex exec` has no built-in timeout and can
  stall on network, rate limits, or a long agent loop. Foreground: Bash-tool
  `timeout` at the 600000ms (10 min) max. Anything likely longer: run it in the
  background and add `-o /path/to/answer.md` so the final answer lands in a file
  you can read when it finishes.
- Default to `--sandbox read-only`. Use `workspace-write` only when Codex must
  write files (e.g. generating images straight into the project).
- Codex generates images with gpt-image-2 on the subscription. Tell it the exact
  output path.
- Report Codex's answer back in the chat. The user should never have to switch panes.

## Image generation (optional): use the script, not a hand-composed prompt

Only applies if you installed `genimg.sh` (see the agent-talk README). For any
single-image request, run:

```bash
~/.claude/scripts/genimg.sh "<image prompt>" /absolute/path/out.png
```

Foreground, Bash-tool `timeout` 600000ms. It handles quoting and sandboxing (Codex
works in a throwaway temp folder; the script moves the finished image to the output
path). Pass the user's image prompt verbatim. Do not expand or embellish it.

If the user names a model or an effort level, pass them as environment variables, e.g.
`CODEX_MODEL="gpt-5.6-sol" CODEX_EFFORT="high" ~/.claude/scripts/genimg.sh ...`
(effort: minimal, low, medium, high, xhigh, or ultra; "extra high" means xhigh). If the
user names neither, set neither: the script then uses the account's default model at
medium effort. Never edit the script itself.
