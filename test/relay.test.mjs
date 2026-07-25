// Tests for the agent-talk relay. Run: node --test 'test/*.test.mjs'
// Unit tests hit the exported parsers directly; integration tests speak real
// MCP over stdio to a spawned server, with a stub `claude` on PATH so no
// subscription quota is spent and no real agent runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import {
  parseJsonDoc,
  parseNdjson,
  codexExtract,
  sanitize,
  buildChildEnv,
  withClaudeAuthHint,
} from "../agent-talk-mcp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "agent-talk-mcp.mjs");
const WRAPPER = join(HERE, "..", "ask-claude-mcp.mjs");
const STUBS = join(HERE, "stubs");
const FIXTURES = join(HERE, "fixtures");

const CLAUDE_MAP = {
  name: "claude",
  text: "result",
  errorFlag: "is_error",
  errorFallback: "Claude reported an error.",
};

// ---------- parser units ----------

test("parseJsonDoc: claude success doc", () => {
  const r = parseJsonDoc('{"result":"hi","is_error":false}', 0, "", CLAUDE_MAP);
  assert.deepEqual(r, { ok: true, text: "hi" });
});

test("parseJsonDoc: claude error doc", () => {
  const r = parseJsonDoc('{"result":"boom","is_error":true}', 0, "", CLAUDE_MAP);
  assert.equal(r.ok, false);
  assert.equal(r.text, "boom");
});

test("parseJsonDoc: garbage output reports exit code and stderr", () => {
  const r = parseJsonDoc("not json", 7, "stderr text", CLAUDE_MAP);
  assert.equal(r.ok, false);
  assert.match(r.text, /exited 7/);
  assert.match(r.text, /stderr text/);
});

test("codexExtract: live-captured success fixture (codex 0.144.1)", () => {
  const out = readFileSync(join(FIXTURES, "codex-exec-success.jsonl"), "utf8");
  const r = parseNdjson(out, 0, "", codexExtract);
  assert.deepEqual(r, { ok: true, text: "hello" });
});

test("codexExtract: live-captured error fixture (bogus model)", () => {
  const out = readFileSync(join(FIXTURES, "codex-exec-error.jsonl"), "utf8");
  const r = parseNdjson(out, 1, "", codexExtract);
  assert.equal(r.ok, false);
  assert.match(r.text, /not supported|exited 1/);
});

test("parseNdjson: malformed lines are skipped, not fatal", () => {
  const out =
    'garbage not json\n' +
    '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n' +
    "{broken\n";
  const r = parseNdjson(out, 0, "", codexExtract);
  assert.deepEqual(r, { ok: true, text: "ok" });
});

test("parseNdjson: valid-JSON non-object lines (null, numbers) are skipped, not fatal", () => {
  const out =
    "null\n" +
    "42\n" +
    '"a bare string"\n' +
    '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n';
  const r = parseNdjson(out, 0, "", codexExtract);
  assert.deepEqual(r, { ok: true, text: "ok" });
});

test("parseJsonDoc: live-captured claude success fixture", () => {
  const out = readFileSync(join(FIXTURES, "claude-print-success.json"), "utf8");
  const r = parseJsonDoc(out, 0, "", CLAUDE_MAP);
  assert.deepEqual(r, { ok: true, text: "hello" });
});

test("parseJsonDoc: live-captured claude error fixture (bogus model)", () => {
  const out = readFileSync(join(FIXTURES, "claude-print-error.json"), "utf8");
  const r = parseJsonDoc(out, 1, "", CLAUDE_MAP);
  assert.equal(r.ok, false);
  assert.match(r.text, /bogus-model-xyz/);
});

test("codexExtract: zero exit but no answer event is an error", () => {
  const r = parseNdjson('{"type":"turn.started"}\n', 0, "", codexExtract);
  assert.equal(r.ok, false);
});

// ---------- child env scrubbing (unit) ----------

test("buildChildEnv drops key-shaped vars, keeps the rest, increments depth", () => {
  const env = buildChildEnv(
    {
      PATH: "/usr/bin",
      HOME: "/home/u",
      ANTHROPIC_API_KEY: "leak",
      WEIRD_SERVICE_API_TOKEN: "leak",
      HTTP_PROXY: "http://proxy:3128",
    },
    0
  );
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HTTP_PROXY, "http://proxy:3128");
  assert.equal(env.AGENT_TALK_DEPTH, "1");
  assert.ok(!("ANTHROPIC_API_KEY" in env));
  assert.ok(!("WEIRD_SERVICE_API_TOKEN" in env));
});

// ---------- claude auth hint ----------

test("withClaudeAuthHint annotates auth-looking failures only", () => {
  const authFail = withClaudeAuthHint({ ok: false, text: "Invalid API key · Fix external API key" });
  assert.match(authFail.text, /--bare/);
  const otherFail = withClaudeAuthHint({ ok: false, text: "file not found" });
  assert.doesNotMatch(otherFail.text, /--bare/);
  const success = withClaudeAuthHint({ ok: true, text: "API keys are configured like this…" });
  assert.equal(success.text, "API keys are configured like this…");
});

// ---------- sanitize ----------

test("sanitize strips OSC/CSI and stray controls, keeps newline/tab", () => {
  const dirty = "\u001b]0;title\u0007red\u001b[31mtext\u001b[0m\nline2\tend\u007f";
  const clean = sanitize(dirty);
  assert.equal(clean, "redtext\nline2\tend");
});

test("sanitize redacts private key blocks", () => {
  const t = sanitize(
    "before\n-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\nafter"
  );
  assert.match(t, /private key block redacted/);
  assert.doesNotMatch(t, /AAAA/);
});

// ---------- MCP integration against a spawned server ----------

// Minimal MCP-over-stdio client: send JSON lines, await replies by id.
function startServer({ args = [], env = {}, entry = SERVER } = {}) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: join(HERE, ".."),
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${STUBS}:${process.env.PATH}`,
      ...env,
    },
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
    child,
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

test("initialize reports agent-talk", async () => {
  const s = startServer();
  try {
    const r = await s.call("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(r.result.serverInfo.name, "agent-talk");
  } finally {
    s.stop();
  }
});

test("default host (codex, no --host flag) sees the upstream tool surface, byte-identical", async () => {
  // Frenemy v1.4.0's exact tool metadata; the compatibility contract for
  // every existing install. Copied verbatim from upstream ask-claude-mcp.mjs.
  const UPSTREAM_COMMON =
    "Claude sees the repo on disk, so refer to files by path. Send one self-contained " +
    "instruction. Claude has no memory of your conversation.";
  const UPSTREAM_TOOLS = [
    {
      name: "ask_claude",
      description:
        "Ask Claude Code a question about this repo and return its answer. File-editing " +
        "tools and the shell are disabled for this call. Use for code review, second " +
        "opinions, and explanations. " + UPSTREAM_COMMON,
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "A complete, self-contained instruction for Claude.",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "ask_claude_write",
      description:
        "Ask Claude Code to make changes in this repo (refactors, fixes, new code). " +
        "Claude MAY edit files. " + UPSTREAM_COMMON,
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "A complete, self-contained instruction for Claude.",
          },
        },
        required: ["prompt"],
      },
    },
  ];
  const s = startServer();
  try {
    const r = await s.call("tools/list");
    assert.deepEqual(r.result.tools, UPSTREAM_TOOLS);
  } finally {
    s.stop();
  }
});

test("antigravity host gets read-only tools only (no per-tool approval granularity)", async () => {
  const s = startServer({ args: ["--host", "antigravity"] });
  try {
    const r = await s.call("tools/list");
    assert.deepEqual(r.result.tools.map((t) => t.name), ["ask_claude", "ask_codex"]);
  } finally {
    s.stop();
  }
});

test("opencode host gets read-only tools only (no write tool)", async () => {
  const s = startServer({ args: ["--host", "opencode"] });
  try {
    const r = await s.call("tools/list");
    assert.deepEqual(r.result.tools.map((t) => t.name), ["ask_claude", "ask_codex"]);
  } finally {
    s.stop();
  }
});

test("claude host sees ask_codex and not itself", async () => {
  const s = startServer({ args: ["--host", "claude"] });
  try {
    const r = await s.call("tools/list");
    assert.deepEqual(r.result.tools.map((t) => t.name), ["ask_codex"]);
  } finally {
    s.stop();
  }
});

test("ask_codex relays the stub answer and spawns sandboxed with the mesh disabled", async () => {
  const argvFile = join(mkdtempSync(join(tmpdir(), "agenttalk-")), "argv");
  const s = startServer({
    args: ["--host", "claude"],
    env: { STUB_ARGV_FILE: argvFile },
  });
  try {
    const r = await s.call("tools/call", {
      name: "ask_codex",
      arguments: { prompt: "hi" },
    });
    assert.equal(r.result.isError, false);
    assert.equal(r.result.content[0].text, "stub codex answer");
    const argv = readFileSync(argvFile, "utf8").replace(/\n$/, "").split("\n");
    assert.deepEqual(argv, [
      "exec", "--sandbox", "read-only", "--skip-git-repo-check",
      "--json", "-c", "mcp_servers={}", "-",
    ]);
  } finally {
    s.stop();
    rmSync(dirname(argvFile), { recursive: true, force: true });
  }
});

test("callee env is scrubbed of key-shaped credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenttalk-"));
  const envFile = join(dir, "env");
  const s = startServer({
    args: ["--host", "claude"],
    env: {
      STUB_ENV_FILE: envFile,
      ANTHROPIC_API_KEY: "sk-test-leak",
      OPENAI_API_KEY: "sk-test-leak",
      SOMETHING_CUSTOM_API_KEY: "sk-test-leak",
      MY_SERVICE_AUTH_TOKEN: "tok-test-leak",
    },
  });
  try {
    const r = await s.call("tools/call", {
      name: "ask_codex",
      arguments: { prompt: "hi" },
    });
    assert.equal(r.result.isError, false);
    const env = readFileSync(envFile, "utf8");
    assert.doesNotMatch(env, /sk-test-leak|tok-test-leak/);
    assert.match(env, /^AGENT_TALK_DEPTH=1$/m);
    assert.match(env, /^PATH=/m);
    assert.match(env, /^HOME=/m);
  } finally {
    s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask_claude relays the stub answer and spawns with enforced read-only args", async () => {
  const argvFile = join(mkdtempSync(join(tmpdir(), "agenttalk-")), "argv");
  const s = startServer({ env: { STUB_ARGV_FILE: argvFile } });
  try {
    const r = await s.call("tools/call", {
      name: "ask_claude",
      arguments: { prompt: "hi" },
    });
    assert.equal(r.result.isError, false);
    assert.equal(r.result.content[0].text, "stub answer");
    // Exact argv, not just flag presence: a relaxed tool ban must fail here.
    const argv = readFileSync(argvFile, "utf8").replace(/\n$/, "").split("\n");
    assert.deepEqual(argv, [
      "-p", "--output-format", "json",
      "--safe-mode",
      "--disallowedTools",
      "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch",
      "--strict-mcp-config",
    ]);
  } finally {
    s.stop();
    rmSync(dirname(argvFile), { recursive: true, force: true });
  }
});

test("ask_claude_write spawns with acceptEdits and user-only settings", async () => {
  const argvFile = join(mkdtempSync(join(tmpdir(), "agenttalk-")), "argv");
  const s = startServer({ env: { STUB_ARGV_FILE: argvFile } });
  try {
    const r = await s.call("tools/call", {
      name: "ask_claude_write",
      arguments: { prompt: "hi" },
    });
    assert.equal(r.result.isError, false);
    const argv = readFileSync(argvFile, "utf8").replace(/\n$/, "").split("\n");
    assert.deepEqual(argv, [
      "-p", "--output-format", "json",
      "--permission-mode", "acceptEdits",
      "--setting-sources", "user",
    ]);
  } finally {
    s.stop();
    rmSync(dirname(argvFile), { recursive: true, force: true });
  }
});

test("callee error JSON comes back as isError", async () => {
  const s = startServer({ env: { STUB_ERROR: "1" } });
  try {
    const r = await s.call("tools/call", {
      name: "ask_claude",
      arguments: { prompt: "hi" },
    });
    assert.equal(r.result.isError, true);
    assert.equal(r.result.content[0].text, "stub failure text");
  } finally {
    s.stop();
  }
});

test("recursion guard refuses calls at depth 2", async () => {
  const s = startServer({ env: { AGENT_TALK_DEPTH: "2" } });
  try {
    const r = await s.call("tools/call", {
      name: "ask_claude",
      arguments: { prompt: "hi" },
    });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /recursion guard/);
  } finally {
    s.stop();
  }
});

test("child env carries incremented depth", async () => {
  // Server at depth 1 (allowed) → the spawned callee must see depth 2.
  const dir = mkdtempSync(join(tmpdir(), "agenttalk-"));
  const depthFile = join(dir, "depth");
  const s = startServer({
    env: { AGENT_TALK_DEPTH: "1", STUB_DEPTH_FILE: depthFile },
  });
  try {
    const r = await s.call("tools/call", {
      name: "ask_claude",
      arguments: { prompt: "hi" },
    });
    assert.equal(r.result.isError, false);
    assert.equal(readFileSync(depthFile, "utf8"), "2");
  } finally {
    s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown tool is refused", async () => {
  const s = startServer();
  try {
    const r = await s.call("tools/call", { name: "ask_nobody", arguments: {} });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /Unknown tool/);
  } finally {
    s.stop();
  }
});

test("timeout kills the whole callee process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agenttalk-"));
  const marker = join(dir, "survivor");
  const s = startServer({
    env: {
      AGENT_TALK_TIMEOUT_MS: "500",
      STUB_SLEEP: "30",
      STUB_MARKER: marker,
    },
  });
  try {
    const r = await s.call("tools/call", {
      name: "ask_claude",
      arguments: { prompt: "hi" },
    });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /timed out/);
    // The stub's backgrounded grandchild would touch the marker at t=2s if it
    // survived the group kill at t=0.5s. Give it until t=3s to prove it's dead.
    await sleep(3000);
    assert.equal(existsSync(marker), false, "grandchild survived the group kill");
  } finally {
    s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compatibility wrapper (old filename) serves the same tools", async () => {
  const s = startServer({ entry: WRAPPER });
  try {
    const init = await s.call("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.result.serverInfo.name, "agent-talk");
    const r = await s.call("tools/list");
    assert.deepEqual(
      r.result.tools.map((t) => t.name),
      ["ask_claude", "ask_claude_write"]
    );
  } finally {
    s.stop();
  }
});
