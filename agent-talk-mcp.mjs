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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  // Callees are spawned with cwd = SERVER_CWD, but an inherited PWD can point
  // somewhere else entirely, and at least one CLI (OpenCode) trusts PWD over
  // its real cwd — it will happily search a different repo and report that it
  // found nothing. Keep the two in agreement.
  env.PWD = SERVER_CWD;
  return env;
}

// ============================================================
//  Relay-owned OS sandbox
//
//  Claude and Codex enforce read-only themselves (--safe-mode plus tool bans;
//  --sandbox read-only) and their H-series probes pass on that basis. Every
//  other CLI here has no read-only mode that survives a hostile repo: the
//  repo's own config file outranks anything we pass in. So for those the relay
//  stops asking the CLI to behave and has the kernel enforce it instead.
//
//  What the profile below actually guarantees on macOS:
//   - No file writes except inside the callee CLI's own state directory and
//     the temp dir. The workspace is read-only, so a hostile repo's "write
//     this file" instruction cannot succeed even if the model decides to obey.
//   - No process execution outside a per-callee allowlist. No shell on that
//     list means no shell side effects, and no `node`/`bun` means the callee
//     cannot start MCP servers — which is how a callee is kept out of the mesh
//     without depending on a per-CLI "ignore my config" flag existing.
//   - No reads of a curated credential set (ssh/aws/gnupg keys, and the other
//     agents' OAuth stores), so a prompt-injected callee has less worth taking.
//
//  What it does NOT guarantee — stated plainly, because the difference is the
//  whole value of the claim:
//   - Outbound network is ALLOWED. These are cloud CLIs; a callee with no
//     network cannot answer at all, which would make the sandbox useless.
//     Seatbelt filters network by address and port, never by hostname, so
//     there is no way to permit "the vendor's API" and refuse everything else.
//     The containment is that only the allowlisted binaries can open sockets,
//     and those talk to their own provider. Whatever the callee reads is still
//     seen by that provider — exactly as it already is for Claude and Codex.
//   - The callee may write inside its own state directory, because it must
//     (session databases, logs, refreshed OAuth tokens). It may not write the
//     config files that would let it change its own behaviour next run; those
//     are denied explicitly.
//
//  Seatbelt matches REAL paths, so every path here is resolved through
//  realpathSync first. Missing that is not a cosmetic bug: Homebrew's `rg` is
//  a symlink into ../Cellar, and allowlisting the symlink silently fails to
//  match, which shows up as the callee hanging rather than as an error.
// ============================================================

const HOME = homedir();
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function realPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p; // may not exist yet; the profile can still name it
  }
}

// Resolve a helper binary (rg, security, …) from PATH to its real location.
function whichReal(name) {
  for (const raw of (process.env.PATH ?? "").split(delimiter)) {
    const dir = raw.replace(/"/g, "");
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return realPath(candidate);
  }
  return null;
}

// SBPL string literal. A path we cannot represent unambiguously is rejected
// rather than escaped into something that might match more than intended.
export function sbplString(p) {
  if (typeof p !== "string" || !isAbsolute(p)) {
    throw new Error(`sandbox: refusing non-absolute path in profile: ${p}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(p)) {
    throw new Error("sandbox: refusing path containing control characters");
  }
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Helpers a coding agent legitimately needs to read a repo: ripgrep for
// search, git for status/snapshots. Neither can run arbitrary commands once
// the shell is off the allowlist — git's escape hatches (hooks, aliases with
// a `!` prefix, core.pager, core.editor) all require exec'ing a shell, which
// is denied. On macOS /usr/bin/git is a shim that execs the real binary under
// the Command Line Tools or Xcode, so both hops must be named.
const REPO_READ_HELPERS = ["rg", "git"];
const MACOS_GIT_BACKING_PATHS = [
  "/Library/Developer/CommandLineTools/usr/bin/git",
  "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
];

// Character devices a normal process needs even when all writes are denied.
const SANDBOX_WRITABLE_DEVICES = [
  "/dev/null", "/dev/zero", "/dev/random", "/dev/urandom",
  "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/dtracehelper",
];

// Credential stores no callee has any business reading. Each agent's own
// store is removed from this list before it is applied to that agent — a
// callee obviously needs its own OAuth token to authenticate.
const AGENT_CREDENTIAL_PATHS = {
  claude: [join(HOME, ".claude", ".credentials.json")],
  codex: [join(HOME, ".codex", "auth.json")],
  opencode: [join(HOME, ".local", "share", "opencode", "auth.json")],
  // (kept literal: this list is about denying OTHER agents' stores, and the
  // path above is the documented default location for OpenCode's.)
  antigravity: [
    join(HOME, ".gemini", "oauth_creds.json"),
    join(HOME, ".gemini", "google_accounts.json"),
  ],
};
const GENERIC_SECRET_PATHS = [
  join(HOME, ".ssh"), join(HOME, ".aws"), join(HOME, ".gnupg"),
  join(HOME, ".netrc"), join(HOME, ".config", "gh"),
];

// SBPL is last-match-wins, so ordering is load-bearing: the blanket denies
// come first, the narrow allows re-open only what the CLI needs, and the
// targeted denies land last so they cannot be re-opened by an earlier allow.
export function buildSeatbeltProfile({
  writeSubpaths = [],
  denyWriteSubpaths = [],
  execPaths = [],
  denyReadPaths = [],
} = {}) {
  const lines = [
    "(version 1)",
    "; Generated by agent-talk. Reads are open by default; writes, execs and",
    "; the paths below are not. See agent-talk-mcp.mjs for the reasoning.",
    "(allow default)",
    "",
    "; ---- writes: deny everything, then re-open only the callee's own state",
    "(deny file-write*)",
  ];
  for (const p of writeSubpaths) lines.push(`(allow file-write* (subpath ${sbplString(p)}))`);
  for (const p of denyWriteSubpaths) lines.push(`(deny file-write* (subpath ${sbplString(p)}))`);
  const devices = SANDBOX_WRITABLE_DEVICES.map((p) => `(literal ${sbplString(p)})`).join(" ");
  lines.push(
    `(allow file-write-data ${devices})`,
    `(allow file-ioctl ${devices})`,
    "",
    "; ---- exec: an allowlist, so there is no shell and no MCP-server runtime",
    "(deny process-exec*)"
  );
  for (const p of execPaths) lines.push(`(allow process-exec (literal ${sbplString(p)}))`);
  if (denyReadPaths.length) {
    lines.push("", "; ---- reads: credentials, and config that would re-enter the mesh");
    for (const p of denyReadPaths) lines.push(`(deny file-read* (subpath ${sbplString(p)}))`);
  }
  return lines.join("\n") + "\n";
}

// Turn a spawn into a sandboxed spawn. Returns the command/args to run, or
// throws when this platform has no sandbox we have actually proven — a
// security wrapper that silently no-ops is worse than none at all.
export function sandboxCommand(bin, args, profile, platform = process.platform) {
  if (platform === "darwin") {
    if (!existsSync(SANDBOX_EXEC)) {
      throw new Error(
        `${SANDBOX_EXEC} is missing, so the relay cannot enforce read-only for this callee.`
      );
    }
    // -p keeps the profile in argv: no temp file to leak, race, or clean up.
    return { cmd: SANDBOX_EXEC, argv: ["-p", profile, bin, ...args] };
  }
  throw new Error(
    `the relay-owned sandbox is only proven on macOS; refusing to run a sandboxed ` +
      `callee on ${platform}. Use Claude or Codex as the callee there — they enforce ` +
      `read-only themselves.`
  );
}

// Build the per-agent profile inputs. Kept as one function so that every
// path a callee is allowed to touch is visible in a single place.
// On POSIX `bin` is a bare command name that execvp resolves through PATH. A
// sandboxed callee must be launched by the SAME resolved path the profile
// allowlists — otherwise the allowlist and the binary can disagree, which
// shows up as a denied exec (a hang or a confusing failure), and would also
// let a hijacked PATH point at something the profile never approved.
function sandboxOwnBin(agent) {
  const resolved = isAbsolute(agent.bin) ? realPath(agent.bin) : whichReal(agent.bin);
  if (!resolved) {
    throw new Error(`${agent.bin} was not found on PATH, so no sandbox profile could be built`);
  }
  return resolved;
}

function sandboxSpecFor(agentName, agent) {
  const s = agent.sandbox;
  const execPaths = [sandboxOwnBin(agent)];
  for (const lit of s.execLiterals ?? []) {
    if (existsSync(lit)) execPaths.push(realPath(lit));
  }
  for (const name of s.execFromPath ?? []) {
    const found = whichReal(name);
    if (found) execPaths.push(found);
  }

  const denyReadPaths = [...GENERIC_SECRET_PATHS];
  for (const [other, paths] of Object.entries(AGENT_CREDENTIAL_PATHS)) {
    if (other === agentName) continue; // its own login must stay readable
    denyReadPaths.push(...paths);
  }
  denyReadPaths.push(...(s.denyReadPaths ?? []));

  // Every path goes through realpath: Seatbelt matches the resolved file, so
  // a symlinked HOME, XDG dir or temp dir would otherwise produce a rule that
  // silently matches nothing — an allow that fails closed (callee breaks) or,
  // worse, a deny that fails open (protection quietly absent).
  // Deny rules are NEVER dropped for not existing yet. Filtering them by
  // existsSync (as an earlier version did) meant that if ~/.ssh or an OAuth
  // store was absent when the profile was built but created before the callee
  // read it, no deny rule existed and `(allow default)` let the read through —
  // a deny that fails open, which is the worst kind.
  const writeSubpaths = [tmpdir(), ...(s.writeSubpaths ?? [])].map(realPath);

  // A writable path that covers the workspace would silently undo the entire
  // point of the sandbox. tmpdir() in particular is attacker-influencable in
  // principle: Node honours $TMPDIR, so an environment with TMPDIR set to the
  // repo would otherwise hand back write access to it.
  for (const p of writeSubpaths) {
    if (SERVER_CWD === p || SERVER_CWD.startsWith(p.endsWith("/") ? p : p + "/")) {
      throw new Error(
        `refusing to build a sandbox that would make the workspace writable ` +
          `(${p} contains ${SERVER_CWD}); check $TMPDIR`
      );
    }
  }

  return {
    writeSubpaths,
    denyWriteSubpaths: (s.denyWriteSubpaths ?? []).map(realPath),
    execPaths: [...new Set(execPaths)],
    denyReadPaths: [...new Set(denyReadPaths.map(realPath))],
  };
}

// A sandboxed callee is only offered when the sandbox can actually be applied
// AND its helper binaries are present. Both failures are refusals, not
// degradations: a missing `rg` makes OpenCode's glob tool hang against a
// denied exec rather than fail, which would look like a broken relay.
function sandboxUnavailableReason(agent) {
  if (process.platform !== "darwin") {
    return `the relay-owned sandbox is proven only on macOS (this is ${process.platform})`;
  }
  if (!existsSync(SANDBOX_EXEC)) return `${SANDBOX_EXEC} is not present`;
  for (const name of agent.sandbox.requiresOnPath ?? []) {
    if (!whichReal(name)) {
      return `\`${name}\` was not found on PATH, and this callee needs it to search the repo`;
    }
  }
  return null;
}

// XDG base directories, honouring the user's overrides. OpenCode spreads its
// state across data (sessions, auth), cache and state (lock files) — miss one
// and it fails in a way that reads like a relay bug rather than a sandbox one.
function xdgDir(envVar, fallback) {
  const v = process.env[envVar];
  return v && isAbsolute(v) ? v : join(HOME, ...fallback);
}

// OpenCode's global config is where this relay is mounted as an MCP server, so
// a callee OpenCode would re-enter the mesh. We cannot simply make that file
// unreadable — OpenCode treats an unreadable config as a fatal error, not as
// an absent one — so instead we hand the callee a config of our own: the
// user's settings verbatim, minus the `mcp` block, plus deny permissions.
// XDG_CONFIG_HOME is honoured for config discovery (verified live on 1.16.2).
let openCodeConfigDir = null;
function openCodeConfigEnv() {
  if (!openCodeConfigDir) {
    openCodeConfigDir = mkdtempSync(join(realPath(tmpdir()), "agent-talk-opencode-"));
    mkdirSync(join(openCodeConfigDir, "opencode"), { recursive: true });
    // Cleaned up on the way out; best effort, since the relay is normally
    // killed rather than asked to exit politely.
    const dir = openCodeConfigDir;
    process.on("exit", () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    });
  }

  // Rewritten before EVERY call, not cached. The directory has to live in the
  // temp dir, which is the one place the callee can write (OpenCode insists on
  // writing a .gitignore beside its config), so a prompt-injected callee could
  // edit this file — including putting an `mcp` block back. Regenerating it
  // per call means any such edit dies with the run that made it instead of
  // being inherited by the next one.
  const userConfigHome = process.env.XDG_CONFIG_HOME || join(HOME, ".config");
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(join(userConfigHome, "opencode", "opencode.json"), "utf8"));
  } catch {
    cfg = {}; // no global config, or unreadable — a bare one is fine
  }
  delete cfg.mcp; // the point of the exercise: no MCP servers for a callee
  // Real for an ordinary repo, overridable by a hostile one — which is why
  // the OS sandbox, not this, is what the security claim rests on.
  cfg.permission = { ...(cfg.permission ?? {}), edit: "deny", bash: "deny", webfetch: "deny" };

  writeFileSync(
    join(openCodeConfigDir, "opencode", "opencode.json"),
    JSON.stringify(cfg, null, 2) + "\n"
  );
  return { XDG_CONFIG_HOME: openCodeConfigDir };
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
    (failure?.error?.message ?? failure?.message) || errText || "no answer event";
  return { ok: false, text: `codex exited ${exitCode}: ${reason}`.trim() };
}

// OpenCode event schema (captured live, opencode 1.16.2 — see
// test/fixtures/opencode-run-*.jsonl): the answer arrives as `text` events,
// one per message part, each carrying the full text of that part rather than
// a delta. We still key by part id and keep the LAST text seen for each,
// joined in first-appearance order: that is correct whether a part is emitted
// once (what the captured fixtures show) or re-emitted as it grows, and it
// cannot double-count either way.
export function opencodeExtract(events, exitCode, errText) {
  const byPart = new Map();
  for (const e of events) {
    if (e.type === "text" && typeof e.part?.text === "string") {
      byPart.set(e.part.id ?? byPart.size, e.part.text);
    }
  }
  const answer = [...byPart.values()].join("").trim();
  const failure = events.find((e) => e.type === "error");
  if (exitCode === 0 && answer && !failure) return { ok: true, text: answer };
  // Error events nest the human-readable text one level deeper than you would
  // guess (error.data.message; error.name is the class) — captured from a live
  // failure, see test/fixtures/opencode-run-error.jsonl.
  const reason =
    failure?.error?.data?.message ??
    failure?.error?.message ??
    failure?.error?.name ??
    errText ??
    "no text event";
  return { ok: false, text: `opencode exited ${exitCode}: ${reason}`.trim() };
}

// Antigravity has no machine-readable output mode at all (agy 1.1.7 prints
// prose), so "did it work" rests on the exit code plus a leading-Error check.
// That is weaker than the other adapters and is the reason its answers are
// relayed verbatim rather than extracted from a field.
export function parseText(out, exitCode, errText, name) {
  const text = String(out).trim();
  if (exitCode === 0 && text && !/^Error:/m.test(text)) return { ok: true, text };
  return {
    ok: false,
    text: `${name} exited ${exitCode}: ${errText || text || "no output"}`.trim(),
  };
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
  // Neither of these has a read-only mode of its own that survives a hostile
  // repo, so neither enforces anything itself: both are callees only because
  // the relay-owned OS sandbox above holds them read-only from outside. That
  // is why each carries a `sandbox` block and neither carries tool-ban args —
  // there are no flags here worth trusting. hostCaps.perToolApproval stays
  // false for both: their MCP trust is server-wide, so the relay never offers
  // them a write tool.
  antigravity: {
    // Antigravity CLI (`agy`), successor to Google's Gemini CLI; subscription
    // OAuth (Gemini models).
    //
    // Sandbox findings, live on agy 1.1.7 / macOS 26.5.2: the only helper it
    // needs is /usr/bin/security (Keychain) to read its own login — with exec
    // otherwise denied it still authenticates and answers. Denying exec is
    // also what keeps it out of the mesh: a host agy spawns
    // `node agent-talk-mcp.mjs --host antigravity` from its global
    // ~/.gemini/config/mcp_config.json, and with `node` off the allowlist that
    // child cannot start. We deny reading that config too, so it does not try.
    //
    // NOT a callee. The sandbox works on it — it authenticates and answers
    // under the profile below — but agy's own headless mode auto-denies every
    // tool that would need approval, including `read_file` (verified live
    // 2026-07-24: "a tool required the read_file permission that headless mode
    // cannot prompt for, so it was auto-denied"). A callee that cannot read
    // the repo is useless, and the only two ways past it are
    // --dangerously-skip-permissions (which DESIGN.md forbids hardcoding) or
    // writing allow-rules into the user's global ~/.gemini/settings.json,
    // which would change their interactive agy too. Both are Bryan's call.
    //
    // Two further residuals the sandbox does not fix: `agy -p` takes the
    // prompt as an argv positional and ignores stdin (verified: piping to
    // `agy -p` prints help), so upstream's "prompts never appear in process
    // lists" guarantee would not hold; and it has no JSON output mode, so
    // success detection is exit-code plus a leading-"Error:" check.
    //
    // The sandbox config is kept, tested and ready: if the permission question
    // is answered, this becomes a one-line flip plus a live H1 run.
    title: "Antigravity",
    short: "Antigravity",
    bin: resolveBin("agy", "agy.exe"),
    calleeEnabled: false,
    promptVia: "argv",
    readArgs: ["-p"],
    writeArgs: null,
    parse: (out, code, err) => parseText(out, code, err, "antigravity"),
    sandbox: {
      execLiterals: ["/usr/bin/security", ...MACOS_GIT_BACKING_PATHS],
      execFromPath: REPO_READ_HELPERS,
      writeSubpaths: [join(HOME, ".gemini")],
      // Deny the MCP config FILE, not the whole config directory: agy creates
      // ~/.gemini/config/projects on startup and dies if it cannot. Belt and
      // braces anyway — the exec allowlist has no JS runtime on it, so an MCP
      // server named in that file could not be launched even if it were read.
      denyWriteSubpaths: [join(HOME, ".gemini", "config", "mcp_config.json")],
      denyReadPaths: [join(HOME, ".gemini", "config", "mcp_config.json")],
    },
    hostCaps: { perToolApproval: false },
  },
  opencode: {
    // OpenCode's own permission block cannot be trusted here: a hostile repo's
    // opencode.json is a later config layer and overrides whatever we supply
    // (verified 2026-07-24 on 1.16.2). We still set deny permissions via the
    // relay-owned config below — it is real for an ordinary repo — but the
    // enforcement that holds against an attacker is the OS sandbox alone.
    //
    // NOT a callee — and this one is a genuine defeat, recorded so nobody
    // re-derives it. The sandbox does hold for writes and exec: OpenCode runs
    // under it, answers correctly, and the hostile fixture's local MCP server
    // (`/bin/sh -c touch …`) cannot start because no shell is executable.
    //
    // What breaks it is a vector the sandbox structurally cannot reach. A
    // hostile repo's opencode.json is a later config layer than anything we
    // supply, and OpenCode supports REMOTE MCP servers — `{"type":"remote",
    // "url":…}`. A URL is not a process, so denying exec does nothing: the
    // callee connects out and the attacker's tools are offered to the model.
    // Demonstrated live 2026-07-24 against a local listener, which received a
    // full MCP `initialize` handshake from inside the sandbox (see
    // test/h-series.test.mjs, "H2 blocker").
    //
    // The two obvious counters are both dead ends, each tested:
    //   - Deny reading the project config: OpenCode treats an unreadable
    //     config as a fatal error, not as absent, and exits 1.
    //   - Deny network: these are cloud CLIs, and Seatbelt cannot filter by
    //     hostname, so "provider yes, attacker no" is not expressible.
    // The real fix is upstream: an "ignore project config" mode. Until then
    // this stays host-only rather than shipping a false "enforced" label.
    title: "OpenCode",
    short: "OpenCode",
    bin: resolveBin("opencode", "opencode.exe"),
    calleeEnabled: false,
    promptVia: "stdin",
    // --pure keeps external plugins (arbitrary code) out of a callee run.
    readArgs: ["run", "--format", "json", "--pure"],
    writeArgs: null,
    parse: (out, code, err) => parseNdjson(out, code, err, opencodeExtract),
    sandbox: {
      execLiterals: MACOS_GIT_BACKING_PATHS,
      execFromPath: REPO_READ_HELPERS,
      // Both are load-bearing: OpenCode runs `rg` for glob/grep and `git`
      // while creating a session. A denied exec makes it fail with an
      // unhelpful "Session not found" rather than a permission error, so a
      // missing helper is caught here instead of at call time.
      requiresOnPath: REPO_READ_HELPERS,
      writeSubpaths: [
        join(xdgDir("XDG_DATA_HOME", [".local", "share"]), "opencode"),
        join(xdgDir("XDG_CACHE_HOME", [".cache"]), "opencode"),
        join(xdgDir("XDG_STATE_HOME", [".local", "state"]), "opencode"),
      ],
      // The install dir holds the binary; a callee must not rewrite it.
      denyWriteSubpaths: [join(HOME, ".opencode")],
      // Config is NOT denied by read: opencode treats an unreadable config as
      // a hard error rather than as absent (verified — it exits 1 on EPERM).
      // Its global MCP mount is dropped by pointing XDG_CONFIG_HOME at a
      // relay-owned config instead; see openCodeConfigEnv().
      env: openCodeConfigEnv,
    },
    hostCaps: { perToolApproval: false },
  },
};

// ---- Build the tool list for this host: every callee-enabled agent except
// the host itself; the write variant only where the host can gate it per-tool.
// A sandboxed callee is offered only where its sandbox can actually be
// applied. When it cannot, the tool is withheld and the reason goes to stderr
// (which every MCP host surfaces in its logs) — the one thing we never do is
// offer the tool anyway and run the callee unconfined.
function calleeAvailable(name, agent) {
  if (!agent.calleeEnabled) return false;
  if (!agent.sandbox) return true;
  const reason = sandboxUnavailableReason(agent);
  if (reason) {
    process.stderr.write(
      `agent-talk: ask_${name} is not offered — ${reason}. This callee is only ` +
        `safe inside the relay-owned sandbox, so it is withheld rather than run without one.\n`
    );
    return false;
  }
  return true;
}

function buildTools() {
  const tools = [];
  const hostCanGateWrites = AGENTS[HOST]?.hostCaps?.perToolApproval === true;
  for (const [name, a] of Object.entries(AGENTS)) {
    if (name === HOST || !calleeAvailable(name, a)) continue;
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

    let args = write ? agent.writeArgs : agent.readArgs;
    let bin = agent.bin;
    let env = buildChildEnv();

    // Adapters whose CLI has no stdin prompt mode take it as an argv
    // positional instead. That is a real downgrade — argv is visible to other
    // local users in `ps` — and is documented per adapter, not smoothed over.
    if (agent.promptVia === "argv") args = [...args, String(prompt ?? "")];

    // Wrap in the relay-owned OS sandbox where the CLI cannot enforce
    // read-only itself. Failure to build the sandbox aborts the call.
    if (agent.sandbox) {
      try {
        if (agent.sandbox.env) env = { ...env, ...agent.sandbox.env() };
        const profile = buildSeatbeltProfile(sandboxSpecFor(agentName, agent));
        // The profile decides what a callee can touch, so make it inspectable
        // rather than something you have to reverse-engineer from a hang.
        const wrapped = sandboxCommand(sandboxOwnBin(agent), args, profile);
        bin = wrapped.cmd;
        args = wrapped.argv;
        if (process.env.AGENT_TALK_DEBUG_SANDBOX === "1") {
          process.stderr.write(
            `--- agent-talk sandbox profile for ${agentName} ---\n${profile}---\n` +
              `--- spawn: ${bin} [-p <profile>] ${JSON.stringify(args.slice(2))}\n` +
              `--- cwd: ${SERVER_CWD}\n--- XDG_CONFIG_HOME: ${env.XDG_CONFIG_HOME}\n`
          );
        }
      } catch (e) {
        running--;
        return resolve({
          ok: false,
          text: `${agentName} was not started: ${e.message}`,
        });
      }
    }

    // Never launched through a shell. detached puts the callee in its own
    // process group so the timeout can kill its whole tree, not just the top
    // process — which matters more here, since a sandboxed callee may be a
    // grandchild of sandbox-exec.
    const child = spawn(bin, args, {
      cwd: SERVER_CWD,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env,
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
    // argv adapters already carry the prompt, and must still see stdin close
    // or they will sit waiting on it.
    child.stdin.on("error", () => {});
    if (agent.promptVia !== "argv") child.stdin.write(String(prompt ?? ""));
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
