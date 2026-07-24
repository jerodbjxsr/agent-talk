// Installer tests: run install.sh against an isolated fake HOME with stub
// claude/codex on PATH. Nothing touches the real user config.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const STUBS = join(HERE, "stubs");

function runInstaller({ home, args = [] } = {}) {
  return execFileSync("bash", [join(REPO, "install.sh"), ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${STUBS}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function freshHome() {
  return mkdtempSync(join(tmpdir(), "agenttalk-home-"));
}

test("dry run reports changes and writes nothing", () => {
  const home = freshHome();
  try {
    const out = runInstaller({ home, args: ["--dry-run"] });
    assert.match(out, /would update: .*config\.toml/);
    assert.match(out, /would update: .*CLAUDE\.md/);
    assert.equal(existsSync(join(home, ".codex")), false);
    assert.equal(existsSync(join(home, ".claude")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("fresh install writes managed regions into both configs", () => {
  const home = freshHome();
  try {
    const out = runInstaller({ home });
    assert.match(out, /updated: .*config\.toml/);
    assert.match(out, /updated: .*CLAUDE\.md/);
    // Non-interactive stdin → the genimg prompt reads EOF and skips.
    assert.match(out, /Skipped the image script/);

    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    assert.match(toml, />>> agent-talk >>>/);
    assert.match(toml, /<<< agent-talk <<</);
    assert.match(toml, /\[mcp_servers\.agent_talk\]/);
    assert.match(toml, /"--host", "codex"/);
    assert.match(toml, /\[mcp_servers\.agent_talk\.tools\.ask_claude\]\napproval_mode = "approve"/);
    assert.match(toml, /tool_timeout_sec = 600/);
    // The write tool must NOT be auto-approved.
    assert.doesNotMatch(toml, /ask_claude_write/);

    const md = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    assert.match(md, /agent-talk >>>/);
    assert.match(md, /# Other coding agents are always available/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("re-run is a no-op (reconcile converges)", () => {
  const home = freshHome();
  try {
    runInstaller({ home });
    const toml1 = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    const md1 = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    const out = runInstaller({ home });
    assert.match(out, /unchanged: .*config\.toml/);
    assert.match(out, /unchanged: .*CLAUDE\.md/);
    assert.equal(readFileSync(join(home, ".codex", "config.toml"), "utf8"), toml1);
    assert.equal(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8"), md1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reconcile repairs edits inside the region and preserves everything outside", () => {
  const home = freshHome();
  try {
    // User content that must survive, before and after the managed region.
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "CLAUDE.md"),
      "# My own standing orders\n\nDo not touch this line.\n"
    );
    runInstaller({ home });

    // Corrupt the managed region and add trailing user content.
    const mdPath = join(home, ".claude", "CLAUDE.md");
    let md = readFileSync(mdPath, "utf8");
    md = md.replace("# Other coding agents are always available", "# TAMPERED HEADING");
    md += "\n# User section added later\n";
    writeFileSync(mdPath, md);

    runInstaller({ home });
    const repaired = readFileSync(mdPath, "utf8");
    assert.match(repaired, /# Other coding agents are always available/);
    assert.doesNotMatch(repaired, /TAMPERED/);
    assert.match(repaired, /# My own standing orders/);
    assert.match(repaired, /Do not touch this line\./);
    assert.match(repaired, /# User section added later/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("host mounts: claude via mcp add, opencode and gemini via owned JSON keys", () => {
  const home = freshHome();
  try {
    runInstaller({ home });

    // Claude: driven through the CLI (stubbed), reconcile = remove + add.
    const mcpLog = readFileSync(join(home, ".claude-stub-mcp.log"), "utf8");
    assert.match(mcpLog, /^mcp remove -s user agent_talk$/m);
    assert.match(mcpLog, /^mcp add -s user agent_talk -- .* --host claude$/m);

    // OpenCode: owned key in otherwise-untouched JSON.
    const oc = JSON.parse(
      readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8")
    );
    assert.equal(oc.mcp.agent_talk.type, "local");
    assert.deepEqual(oc.mcp.agent_talk.command.slice(-2), ["--host", "opencode"]);
    assert.equal(oc.mcp.agent_talk.timeout, 600000);

    // Gemini: per-server trust (why this host only ever gets read-only tools).
    const gm = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"));
    assert.deepEqual(gm.mcpServers.agent_talk.args.slice(-2), ["--host", "gemini"]);
    assert.equal(gm.mcpServers.agent_talk.trust, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("JSON mounts preserve user keys and converge on re-run", () => {
  const home = freshHome();
  try {
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      join(home, ".config", "opencode", "opencode.json"),
      '{"theme":"dark","mcp":{"other":{"type":"remote","url":"https://x"}}}\n'
    );
    runInstaller({ home });
    const first = readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8");
    const oc = JSON.parse(first);
    assert.equal(oc.theme, "dark"); // user key preserved
    assert.equal(oc.mcp.other.url, "https://x"); // sibling server preserved
    assert.equal(oc.mcp.agent_talk.type, "local");

    const out = runInstaller({ home });
    assert.match(out, /unchanged: .*opencode\.json/);
    assert.equal(
      readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8"),
      first
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("invalid JSON config aborts instead of clobbering", () => {
  const home = freshHome();
  try {
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), "{broken");
    assert.throws(
      () => runInstaller({ home }),
      (e) => {
        assert.match(String(e.stderr), /not valid JSON/);
        return true;
      }
    );
    assert.equal(
      readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8"),
      "{broken" // untouched
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dry run does not touch claude mcp or create JSON configs", () => {
  const home = freshHome();
  try {
    const out = runInstaller({ home, args: ["--dry-run"] });
    assert.match(out, /would run: claude mcp add/);
    assert.equal(existsSync(join(home, ".claude-stub-mcp.log")), false);
    assert.equal(existsSync(join(home, ".config")), false);
    assert.equal(existsSync(join(home, ".gemini")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy Frenemy config block is warned about, never deleted", () => {
  const home = freshHome();
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    const legacy =
      '[mcp_servers.claude]\ncommand = "/usr/local/bin/node"\n' +
      'args = ["/somewhere/frenemy/ask-claude-mcp.mjs"]\n' +
      'tool_timeout_sec = 600\n\n' +
      '[mcp_servers.claude.tools.ask_claude]\napproval_mode = "approve"\n';
    writeFileSync(join(home, ".codex", "config.toml"), legacy);

    const out = runInstaller({ home });
    assert.match(out, /legacy Frenemy \[mcp_servers\.claude\] block/);
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    assert.match(toml, /\[mcp_servers\.claude\]/); // untouched
    assert.match(toml, /\[mcp_servers\.agent_talk\]/); // added
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a half-broken marker pair aborts instead of guessing", () => {
  const home = freshHome();
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      "# >>> agent-talk >>> managed by install.sh; edits inside are overwritten\n" +
        "[mcp_servers.agent_talk]\n" // close marker missing
    );
    assert.throws(
      () => runInstaller({ home }),
      (e) => {
        assert.match(String(e.stderr), /marker but not its pair/);
        return true;
      }
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("backup file is created when an existing config changes", () => {
  const home = freshHome();
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5.6-terra"\n');
    const out = runInstaller({ home });
    // The pre-existing pinned model also triggers the stale-pin warning.
    assert.match(out, /pins a model/);
    assert.equal(
      readFileSync(join(home, ".codex", "config.toml.agent-talk-backup"), "utf8"),
      'model = "gpt-5.6-terra"\n'
    );
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    assert.match(toml, /^model = "gpt-5\.6-terra"$/m); // user line preserved
    assert.match(toml, /\[mcp_servers\.agent_talk\]/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
