// Live A-series checks: real CLIs, real subscriptions, no stubs. Excluded
// from the default suite (they spend quota and take ~a minute); run with:
//   AGENT_TALK_LIVE=1 node --test test/live.test.mjs
// Results belong in the PR body of any change touching adapters.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIVE = process.env.AGENT_TALK_LIVE === "1";
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "agent-talk-mcp.mjs");

function startServer(args) {
  const child = spawn(process.execPath, [SERVER, ...args], {
    cwd: join(HERE, ".."),
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdout.setEncoding("utf8");
  let buf = "";
  const waiters = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const w = waiters.get(msg.id);
      if (w) {
        waiters.delete(msg.id);
        w(msg);
      }
    }
  });
  let nextId = 1;
  return {
    call(method, params) {
      const id = nextId++;
      const p = new Promise((res) => waiters.set(id, res));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return p;
    },
    stop() {
      child.kill("SIGKILL");
    },
  };
}

test("A: claude host → real codex callee", { skip: !LIVE, timeout: 300000 }, async () => {
  const s = startServer(["--host", "claude"]);
  try {
    const r = await s.call("tools/call", {
      name: "ask_codex",
      arguments: { prompt: "Reply with exactly the word: alive" },
    });
    assert.equal(r.result.isError, false, r.result.content?.[0]?.text);
    assert.equal(r.result.content[0].text.trim(), "alive");
  } finally {
    s.stop();
  }
});

// Kept, skipped, as the record of a result that WAS obtained: on 2026-07-24
// this passed live — a sandboxed OpenCode read LICENSE through the relay and
// answered "MIT", proving the sandbox does not break reads. It is skipped
// because ask_opencode is no longer offered: OpenCode failed the H2 gate on a
// vector the sandbox cannot reach (project-supplied remote MCP). Re-enable it
// together with `calleeEnabled` if that blocker is ever cleared upstream.
test("A: claude host → real opencode callee still reads the repo", { skip: true, timeout: 300000 }, async () => {
  const s = startServer(["--host", "claude"]);
  try {
    const r = await s.call("tools/call", {
      name: "ask_opencode",
      arguments: {
        prompt:
          "Read the LICENSE file in this repo and reply with exactly the name of the " +
          "license it grants, and nothing else.",
      },
    });
    assert.equal(r.result.isError, false, r.result.content?.[0]?.text);
    assert.match(r.result.content[0].text, /MIT/i);
  } finally {
    s.stop();
  }
});

test("A: codex host (default) → real claude callee", { skip: !LIVE, timeout: 300000 }, async () => {
  const s = startServer([]);
  try {
    const r = await s.call("tools/call", {
      name: "ask_claude",
      arguments: { prompt: "Reply with exactly the word: alive" },
    });
    assert.equal(r.result.isError, false, r.result.content?.[0]?.text);
    assert.equal(r.result.content[0].text.trim(), "alive");
  } finally {
    s.stop();
  }
});
