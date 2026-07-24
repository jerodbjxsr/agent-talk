#!/usr/bin/env node
// ============================================================
//  agent-talk — a mesh relay for agentic coding CLIs.
//  Evolved from Frenemy by Zakariya Syed (MIT; see LICENSE).
//
//  One MCP server, mounted by a host CLI (--host <name>).
//  It exposes ask_<agent> tools for the OTHER agents in the
//  registry below; each call spawns that agent's CLI headless
//  (subscription/OAuth auth only — never an API key) and
//  relays the answer back.
// ============================================================

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---- Who mounted us. Every CLI's mount config passes --host <its-own-name>;
// with no flag we assume Codex, which is what every pre-mesh install was.
const HOST = (() => {
  const i = process.argv.indexOf("--host");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : "codex";
})();

// ---- Recursion debris net. The load-bearing loop protection is that callees
// are spawned with their own mesh access disabled (see each adapter's args);
// this depth counter is defense-in-depth on top, not a security boundary —
// a shell-capable process could clear it, which is exactly why read-only
// callees get no shell.
const DEPTH = Number.parseInt(process.env.AGENT_TALK_DEPTH ?? "0", 10) || 0;
const MAX_DEPTH = 2;

// Safety caps (env overrides exist for the test suite; defaults are the contract).
const TIMEOUT_MS =
  Number.parseInt(process.env.AGENT_TALK_TIMEOUT_MS ?? "", 10) || 10 * 60 * 1000;
const MAX_OUTPUT_CHARS =
  Number.parseInt(process.env.AGENT_TALK_MAX_OUTPUT ?? "", 10) || 2 * 1024 * 1024;
const MAX_CONCURRENT = 4; // max parallel callees, all agents combined
const MAX_LINE_CHARS = 8 * 1024 * 1024; // max protocol line size
let running = 0;

// Every callee runs in the folder this server started in (the host's workspace).
const SERVER_CWD = process.cwd();

// "Subscription auth only" is enforced mechanically, not by hoping: callee
// env is the parent env minus anything key-shaped, so a callee CLI can never
// silently ride an API key instead of its OAuth login. A denylist (not an
// allowlist) on purpose — an allowlist would break legitimate unknown vars
// (proxies, locales, CLI homes), and the threat model here is specifically
// credential-shaped variables.
const ENV_DENY_EXACT = new Set([
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY", "OPENROUTER_API_KEY",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
  "MOONSHOT_API_KEY", "DASHSCOPE_API_KEY",
]);
const ENV_DENY_PATTERN = /_API_KEY$|_API_TOKEN$|_AUTH_TOKEN$/;
export function buildChildEnv(base = process.env, depth = DEPTH) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (ENV_DENY_EXACT.has(k) || ENV_DENY_PATTERN.test(k)) continue;
    env[k] = v;
  }
  env.AGENT_TALK_DEPTH = String(depth + 1);
  return env;
}

// Windows searches the current folder before PATH, so a repo could plant a
// fake <agent>.exe. We resolve the real one from PATH once, at startup.
function resolveOnWindowsPath(exeName) {
  for (const raw of (process.env.PATH ?? "").split(delimiter)) {
    const dir = raw.replace(/"/g, ""); // PATH entries may be quoted on Windows
    if (!dir || !isAbsolute(dir)) continue; // relative entries are the same trap
    const candidate = join(dir, exeName);
    if (existsSync(candidate)) return candidate;
  }
  return null; // reported as an error when a tool is called
}
function resolveBin(posixName, winExeName) {
  return process.platform === "win32" ? resolveOnWindowsPath(winExeName) : posixName;
}

// ---- Output parsers. One strategy per CLI output style, all fixture-tested
// (test/fixtures/) against pinned CLI versions — never guessed from docs.

// Style A: the whole stdout is one JSON document (claude, gemini).
// `map` says where the answer text and the error indicator live.
export function parseJsonDoc(out, exitCode, errText, map) {
  try {
    const parsed = JSON.parse(out);
    if (parsed[map.errorFlag]) {
      return { ok: false, text: parsed[map.text] || map.errorFallback };
    }
    return { ok: true, text: parsed[map.text] ?? "" };
  } catch {
    return {
      ok: false,
      text: `${map.name} exited ${exitCode} and returned no usable JSON.\n${errText || out}`.trim(),
    };
  }
}

// Style B: stdout is newline-delimited JSON events (codex, opencode).
// Malformed lines are skipped and counted, never fatal; `extract` turns the
// event list into an answer.
export function parseNdjson(out, exitCode, errText, extract) {
  const events = [];
  let malformed = 0;
  for (const line of String(out).split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      const v = JSON.parse(l);
      // Valid JSON that isn't an object (null, a bare number, …) is just as
      // unusable as a syntax error; count it, don't crash on it.
      if (v && typeof v === "object") events.push(v);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return extract(events, exitCode, errText, malformed);
}

// Codex event schema (captured live, codex 0.144.1 — see
// test/fixtures/codex-exec-*.jsonl): the answer is the last
// item.completed event whose item.type is "agent_message"; failures
// surface as error / turn.failed events and a non-zero exit.
export function codexExtract(events, exitCode, errText) {
  const answers = events.filter(
    (e) => e.type === "item.completed" && e.item?.type === "agent_message"
  );
  const failure =
    events.findLast?.((e) => e.type === "turn.failed" || e.type === "error") ??
    [...events].reverse().find((e) => e.type === "turn.failed" || e.type === "error");
  if (exitCode === 0 && answers.length > 0 && !failure) {
    return { ok: true, text: answers[answers.length - 1].item.text ?? "" };
  }
  const reason =
    failure?.error?.message ?? failure?.message ?? errText ?? "no answer event";
  return { ok: false, text: `codex exited ${exitCode}: ${reason}`.trim() };
}

// Claude's docs say --bare will become the default for -p in a future
// release, and bare mode skips OAuth/keychain (API-key auth only). If that
// flips under us, headless calls start failing with auth errors even though
// interactive claude works. We can't preflight it cheaply, but we can make
// the failure self-explanatory the moment it happens.
export function withClaudeAuthHint(result) {
  if (!result.ok && /api key|authenticat|logged? in|credential/i.test(result.text)) {
    return {
      ok: false,
      text:
        result.text +
        "\n(agent-talk: this looks like an auth failure. If interactive claude " +
        "works but headless calls fail after a Claude Code update, -p may now " +
        "default to --bare mode, which skips subscription auth — see the README " +
        "and pin or flag the non-bare mode.)",
    };
  }
  return result;
}

// Tool text is generated from two name forms so the claude tools stay
// byte-identical to upstream Frenemy: `title` in the tool's opening sentence
// ("Claude Code"), `short` everywhere else ("Claude").

// ---- The agent registry. calleeEnabled gates whether ask_<name> exists at all:
// an agent earns it only when its read-only enforcement story is proven
// (docs/PLAN-v1.md, H-series). Host entries record approval granularity —
// write tools are only offered to hosts that can gate them per-tool.
const AGENTS = {
  claude: {
    title: "Claude Code",
    short: "Claude",
    bin: resolveBin("claude", "claude.exe"),
    calleeEnabled: true,
    promptVia: "stdin",
    // Read mode, enforced: safe mode (all user customizations off) + the
    // side-effect tools removed + no MCP servers, so a callee Claude cannot
    // see or re-enter the mesh. Subagents stay available, inherit the bans.
    readArgs: [
      "-p", "--output-format", "json",
      "--safe-mode",
      "--disallowedTools",
      "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch",
      "--strict-mcp-config",
    ],
    // Write mode: edits auto-accepted; only user-level settings load, so a
    // cloned repo's own hooks/plugins can't join the run. Never auto-approved
    // anywhere; only offered to hosts with per-tool approval.
    writeArgs: [
      "-p", "--output-format", "json",
      "--permission-mode", "acceptEdits",
      "--setting-sources", "user",
    ],
    parse: (out, code, err) =>
      withClaudeAuthHint(
        parseJsonDoc(out, code, err, {
          name: "claude",
          text: "result",
          errorFlag: "is_error",
          errorFallback: "Claude reported an error.",
        })
      ),
    hostCaps: { perToolApproval: true },
  },
  codex: {
    title: "Codex",
    short: "Codex",
    bin: resolveBin("codex", "codex.exe"),
    calleeEnabled: true,
    promptVia: "stdin",
    // Read-only OS sandbox, and the whole MCP table wiped for this invocation
    // (-c mcp_servers={}) so a callee Codex cannot see or re-enter the mesh —
    // codex's equivalent of claude's --strict-mcp-config. Live-verified on
    // codex 0.144.1 (docs/PLAN-v1.md, V1); the per-server enabled=false form
    // errors when the server isn't in config, so don't "simplify" to it.
    readArgs: [
      "exec", "--sandbox", "read-only", "--skip-git-repo-check",
      "--json", "-c", "mcp_servers={}", "-",
    ],
    writeArgs: null,
    parse: (out, code, err) => parseNdjson(out, code, err, codexExtract),
    hostCaps: { perToolApproval: true },
  },
  // Host-only for now: both load project config from the workspace, so their
  // read-only story is unproven against a hostile repo (H1/H2 in the plan).
  // They mount this server and call others; nobody calls them yet.
  gemini: {
    title: "Gemini",
    short: "Gemini",
    bin: resolveBin("gemini", "gemini.exe"),
    calleeEnabled: false,
    hostCaps: { perToolApproval: false }, // MCP trust is per-server only
  },
  opencode: {
    title: "OpenCode",
    short: "OpenCode",
    bin: resolveBin("opencode", "opencode.exe"),
    calleeEnabled: false,
    hostCaps: { perToolApproval: false },
  },
};

// ---- Build the tool list for this host: every callee-enabled agent except
// the host itself; the write variant only where the host can gate it per-tool.
function buildTools() {
  const tools = [];
  const hostCanGateWrites = AGENTS[HOST]?.hostCaps?.perToolApproval === true;
  for (const [name, a] of Object.entries(AGENTS)) {
    if (name === HOST || !a.calleeEnabled) continue;
    tools.push({
      name: `ask_${name}`,
      description:
        `Ask ${a.title} a question about this repo and return its answer. File-editing ` +
        `tools and the shell are disabled for this call. Use for code review, second ` +
        `opinions, and explanations. ${a.short} sees the repo on disk, so refer to ` +
        `files by path. Send one self-contained instruction. ${a.short} has no memory ` +
        `of your conversation.`,
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: `A complete, self-contained instruction for ${a.short}.`,
          },
        },
        required: ["prompt"],
      },
    });
    if (a.writeArgs && hostCanGateWrites) {
      tools.push({
        name: `ask_${name}_write`,
        description:
          `Ask ${a.title} to make changes in this repo (refactors, fixes, new code). ` +
          `${a.short} MAY edit files. ${a.short} sees the repo on disk, so refer to ` +
          `files by path. Send one self-contained instruction. ${a.short} has no ` +
          `memory of your conversation.`,
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: `A complete, self-contained instruction for ${a.short}.`,
            },
          },
          required: ["prompt"],
        },
      });
    }
  }
  return tools;
}
const TOOLS = buildTools();

// Start an agent CLI, send the prompt, return the answer.
function runAgent(agentName, { prompt }, write) {
  const agent = AGENTS[agentName];
  return new Promise((resolve) => {
    if (running >= MAX_CONCURRENT) {
      return resolve({
        ok: false,
        text: `Too many ${agent.short} calls at once (limit ${MAX_CONCURRENT}). Try again in a moment.`,
      });
    }
    if (!agent.bin) {
      return resolve({
        ok: false,
        text: `${agentName}.exe was not found on PATH. Install ${agent.title} with the native Windows installer.`,
      });
    }
    running++;

    const args = write ? agent.writeArgs : agent.readArgs;

    // Never launched through a shell; prompt goes in via stdin, so it never
    // shows in the process list. detached puts the callee in its own process
    // group so the timeout can kill its whole tree, not just the top process.
    const child = spawn(agent.bin, args, {
      cwd: SERVER_CWD,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: buildChildEnv(),
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let out = "";
    let err = "";
    let done = false;

    const killTree = () => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch {}
      }
    };

    // Report back exactly once, whatever happens.
    const finish = (result) => {
      if (done) return;
      done = true;
      running--;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killTree();
      finish({
        ok: false,
        text: `${agentName} timed out after ${TIMEOUT_MS / 60000} minutes.`,
      });
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > MAX_OUTPUT_CHARS) {
        killTree();
        finish({
          ok: false,
          text: `${agentName} produced more output than the ~${Math.round(MAX_OUTPUT_CHARS / 1048576)} MB cap; aborted.`,
        });
      }
    });
    child.stderr.on("data", (d) => {
      if (err.length < MAX_OUTPUT_CHARS) err += d;
    });

    child.on("error", (e) =>
      finish({ ok: false, text: `Failed to launch ${agentName}: ${e.message}` })
    );

    child.on("close", (code) => finish(agent.parse(out, code, err)));

    // If the callee exits before reading the prompt, don't crash the relay.
    child.stdin.on("error", () => {});
    child.stdin.write(String(prompt ?? ""));
    child.stdin.end();
  });
}

// Strip terminal control sequences (keep newline and tab) and redact private
// key blocks before a callee's output enters the host's context. The key
// redaction is best effort only; do not rely on it to prevent secret leakage.
export function sanitize(text) {
  let t = String(text);
  t = t.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, ""); // OSC sequences
  t = t.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, ""); // CSI sequences
  t = t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""); // stray controls, incl. lone ESC
  t = t.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[agent-talk: private key block redacted]"
  );
  return t;
}

// --- MCP plumbing: JSON messages over stdin/stdout, one per line.

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

async function handle(msg) {
  const { id, method, params } = msg;

  // No id means notification. Never reply to those.
  if (id === undefined) return;

  if (method === "ping") {
    return reply(id, {});
  }

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "agent-talk", version: "2.0.0" },
    });
  }

  if (method === "tools/list") {
    return reply(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) {
      return reply(id, {
        content: [{ type: "text", text: `Unknown tool: ${params?.name}` }],
        isError: true,
      });
    }
    if (DEPTH >= MAX_DEPTH) {
      return reply(id, {
        content: [{
          type: "text",
          text: `agent-talk recursion guard: this call is already ${DEPTH} hops deep; refusing to go deeper.`,
        }],
        isError: true,
      });
    }
    const write = tool.name.endsWith("_write");
    const agentName = tool.name.replace(/^ask_/, "").replace(/_write$/, "");
    const { ok, text } = await runAgent(agentName, params.arguments ?? {}, write);
    return reply(id, { content: [{ type: "text", text: sanitize(text) }], isError: !ok });
  }

  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
}

// Read messages line by line; overlong lines get dropped, not buffered forever.
export function main() {
  let buffer = "";
  let discarding = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const rawLine = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (discarding) {
        discarding = false; // this newline ends the dropped line
        continue;
      }
      if (rawLine.length > MAX_LINE_CHARS) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Input line too long; discarded." } });
        continue;
      }
      const line = rawLine.trim();
      if (!line) continue;
      try {
        handle(JSON.parse(line)).catch(() => {}); // one bad call must not kill the relay
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
    }
    if (discarding) {
      buffer = "";
    } else if (buffer.length > MAX_LINE_CHARS) {
      buffer = "";
      discarding = true;
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Input line too long; discarded." } });
    }
  });
}

// Autostart when run directly (any path/symlink form); the compatibility
// wrapper (ask-claude-mcp.mjs) imports { main } and calls it instead.
const isMain = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) main();
