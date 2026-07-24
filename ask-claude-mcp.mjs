#!/usr/bin/env node
// Compatibility wrapper: this was Frenemy's entry point, and existing installs
// (~/.codex/config.toml) point at this filename. The relay now lives in
// agent-talk-mcp.mjs; with no --host flag it behaves exactly as before
// (host = codex, tools = ask_claude / ask_claude_write).
import { main } from "./agent-talk-mcp.mjs";
main();
