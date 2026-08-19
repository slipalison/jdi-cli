#!/usr/bin/env bash
# jdi-install-playwright (POSIX): installs Playwright dev dep + chromium browser
# + injects Playwright MCP config in detected runtime configs.
#
# Optional install. Idempotent.
#
# Usage:
#   ./bin/jdi-install-playwright.sh
#   ./bin/jdi-install-playwright.sh --skip-browser
#   ./bin/jdi-install-playwright.sh --runtime claude
#
# Flags:
#   --skip-browser            Skip `npx playwright install chromium`
#   --skip-mcp                Skip MCP config injection (only dep + browser)
#   --runtime <r>             claude | opencode | copilot | antigravity | all (default: all)
#   --antigravity-scope <s>   user (default) | project

set -euo pipefail

PROJECT_DIR="$(pwd)"
USER_HOME="${HOME:-${USERPROFILE:-}}"
SKIP_BROWSER=0
SKIP_MCP=0
RUNTIME=all
AG_SCOPE=user

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-browser)      SKIP_BROWSER=1; shift ;;
    --skip-mcp)          SKIP_MCP=1; shift ;;
    --runtime)           RUNTIME="$2"; shift 2 ;;
    --antigravity-scope) AG_SCOPE="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

case "$RUNTIME" in
  claude|opencode|copilot|antigravity|all) ;;
  *) echo "Invalid --runtime. Use: claude | opencode | copilot | antigravity | all"; exit 1 ;;
esac

case "$AG_SCOPE" in
  user|project) ;;
  *) echo "Invalid --antigravity-scope. Use: user | project"; exit 1 ;;
esac

detect_pm() {
  if [[ -f "$PROJECT_DIR/pnpm-lock.yaml" ]]; then echo pnpm
  elif [[ -f "$PROJECT_DIR/yarn.lock" ]];     then echo yarn
  elif [[ -f "$PROJECT_DIR/bun.lockb" ]];     then echo bun
  else echo npm
  fi
}

has_pw_dep() {
  local pkg="$PROJECT_DIR/package.json"
  [[ -f "$pkg" ]] || { echo 0; return; }
  if grep -qE '"@playwright/test"' "$pkg"; then echo 1; else echo 0; fi
}

install_pw_dep() {
  if [[ "$(has_pw_dep)" == "1" ]]; then
    echo "  [skip] @playwright/test already in package.json"
    return 0
  fi
  if [[ ! -f "$PROJECT_DIR/package.json" ]]; then
    echo "  [warn] package.json not found. Run 'npm init -y' first."
    return 1
  fi

  local pm
  pm="$(detect_pm)"
  echo "  Installing @playwright/test via $pm..."

  case "$pm" in
    # --ignore-scripts (S6505): @playwright/test needs no lifecycle scripts --
    # browsers install via the explicit 'playwright install' step below.
    pnpm) pnpm add -D --ignore-scripts @playwright/test ;;
    yarn) yarn add -D --ignore-scripts @playwright/test ;;
    bun)  bun add -d --ignore-scripts @playwright/test ;;
    *)    npm install --save-dev --ignore-scripts @playwright/test ;;
  esac
}

install_chromium() {
  if [[ "$SKIP_BROWSER" == "1" ]]; then
    echo "  [skip] --skip-browser flag set"
    return 0
  fi
  echo "  Installing chromium browser (~170MB, may take a minute)..."
  # Run the locally installed binary -- no on-demand npx package execution (S6505)
  "$PROJECT_DIR/node_modules/.bin/playwright" install chromium || {
    echo "  [warn] chromium install failed. Rerun later: npx playwright install chromium"
    return 0
  }
}

inject_claude_mcp() {
  local dir="$PROJECT_DIR/.claude"
  if [[ ! -d "$dir" ]]; then
    echo "  [skip] .claude/ not present (Claude Code not installed)"
    return
  fi

  local f="$dir/settings.local.json"
  if [[ -f "$f" ]] && grep -qE '"playwright"\s*:' "$f"; then
    echo "  [skip] mcpServers.playwright already present in settings.local.json"
    return
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "  [warn] node not in PATH; cannot edit JSON safely"
    return
  fi

  node - <<'NODE_EOF'
const fs = require('fs');
const path = require('path');
const f = path.join(process.cwd(), '.claude', 'settings.local.json');
let s = {};
if (fs.existsSync(f)) {
  try { s = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { console.log('  [warn] settings.local.json invalid JSON; skip'); process.exit(0); }
}
s.mcpServers = s.mcpServers || {};
if (s.mcpServers.playwright) {
  console.log('  [skip] mcpServers.playwright already present');
  process.exit(0);
}
s.mcpServers.playwright = {
  command: 'npx',
  args: ['-y', '@playwright/mcp@latest']
};
fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
console.log('  -> wrote .claude/settings.local.json (mcpServers.playwright)');
NODE_EOF
}

inject_opencode_mcp() {
  local dir="$PROJECT_DIR/.opencode"
  if [[ ! -d "$dir" ]]; then
    echo "  [skip] .opencode/ not present (OpenCode not installed)"
    return
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "  [warn] node not in PATH; cannot edit JSONC safely"
    return
  fi

  node - <<'NODE_EOF'
const fs = require('fs');
const path = require('path');
const f = path.join(process.cwd(), '.opencode', 'opencode.jsonc');
let raw = '';
if (fs.existsSync(f)) {
  raw = fs.readFileSync(f, 'utf8');
  if (/"playwright"\s*:/.test(raw)) {
    console.log('  [skip] mcp.playwright already present in opencode.jsonc');
    process.exit(0);
  }
} else {
  raw = '// OpenCode config - JDI managed\n{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
}
const stripped = raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
let obj;
try { obj = JSON.parse(stripped); }
catch { console.log('  [warn] opencode.jsonc not parseable; skip'); process.exit(0); }
obj.mcp = obj.mcp || {};
obj.mcp.playwright = {
  type: 'local',
  command: ['npx', '-y', '@playwright/mcp@latest'],
  enabled: true
};
const header = '// OpenCode config - JDI managed (mcp.playwright managed; rest is yours)\n';
fs.writeFileSync(f, header + JSON.stringify(obj, null, 2) + '\n');
console.log('  -> wrote .opencode/opencode.jsonc (mcp.playwright)');
NODE_EOF
}

inject_copilot_mcp() {
  local vscode_dir="$PROJECT_DIR/.vscode"
  local f="$vscode_dir/mcp.json"

  if [[ -f "$f" ]] && grep -q '"playwright"' "$f" 2>/dev/null; then
    echo "  [skip] servers.playwright already present in .vscode/mcp.json"
    return
  fi

  mkdir -p "$vscode_dir"

  if ! command -v node >/dev/null 2>&1; then
    echo "  [warn] node not in PATH; cannot edit JSON safely"
    return
  fi

  node - <<'NODE_EOF'
const fs = require('fs');
const path = require('path');
const f = path.join(process.cwd(), '.vscode', 'mcp.json');
let s = {};
if (fs.existsSync(f)) {
  try { s = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { console.log('  [warn] mcp.json invalid JSON; skip'); process.exit(0); }
}
s.servers = s.servers || {};
if (s.servers.playwright) {
  console.log('  [skip] servers.playwright already present');
  process.exit(0);
}
s.servers.playwright = { command: 'npx', args: ['-y', '@playwright/mcp@latest'] };
fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
console.log('  -> wrote .vscode/mcp.json (servers.playwright) for Copilot');
NODE_EOF
}

inject_antigravity_mcp() {
  # Antigravity 2.0 (May 2026): user-scope MCP lives in
  # ~/.gemini/config/mcp_config.json (shared by IDE + agy CLI). Detect the
  # generation by the presence of ~/.gemini/config/; fall back to the 1.x
  # settings.json otherwise. Project scope keeps .gemini/settings.json
  # (2.0 documents no project-scope MCP file).
  local base f
  if [[ "$AG_SCOPE" == "user" ]]; then
    if [[ -d "$USER_HOME/.gemini/config" ]] || command -v agy >/dev/null 2>&1; then
      base="$USER_HOME/.gemini/config"
      f="$base/mcp_config.json"
    else
      base="$USER_HOME/.gemini"
      f="$base/settings.json"
    fi
  else
    base="$PROJECT_DIR/.gemini"
    f="$base/settings.json"
  fi

  if [[ -f "$f" ]] && grep -q '"playwright"' "$f" 2>/dev/null; then
    echo "  [skip] mcpServers.playwright already present in $f"
    return
  fi

  mkdir -p "$base"

  if ! command -v node >/dev/null 2>&1; then
    echo "  [warn] node not in PATH; cannot edit JSON safely"
    return
  fi

  AG_FILE="$f" node - <<'NODE_EOF'
const fs = require('fs');
const f = process.env.AG_FILE;
let s = {};
if (fs.existsSync(f)) {
  try { s = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { console.log('  [warn] settings.json invalid JSON; skip'); process.exit(0); }
}
s.mcpServers = s.mcpServers || {};
if (s.mcpServers.playwright) {
  console.log('  [skip] mcpServers.playwright already present');
  process.exit(0);
}
s.mcpServers.playwright = { command: 'npx', args: ['-y', '@playwright/mcp@latest'] };
fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
console.log('  -> wrote ' + f + ' (mcpServers.playwright) for Antigravity');
NODE_EOF
}

# =====================================================================
# Main
# =====================================================================

echo ""
echo "=== JDI: Install Playwright + MCP ==="
echo ""

echo "Step 1: Install dep"
install_pw_dep || { echo "Dep install failed. Aborting."; exit 1; }

echo ""
echo "Step 2: Install browser"
install_chromium

if [[ "$SKIP_MCP" != "1" ]]; then
  echo ""
  echo "Step 3: Inject MCP config in detected runtimes"
  if [[ "$RUNTIME" == "claude" ]]      || [[ "$RUNTIME" == "all" ]]; then inject_claude_mcp; fi
  if [[ "$RUNTIME" == "opencode" ]]    || [[ "$RUNTIME" == "all" ]]; then inject_opencode_mcp; fi
  if [[ "$RUNTIME" == "copilot" ]]     || [[ "$RUNTIME" == "all" ]]; then inject_copilot_mcp; fi
  if [[ "$RUNTIME" == "antigravity" ]] || [[ "$RUNTIME" == "all" ]]; then inject_antigravity_mcp; fi
fi

echo ""
echo "Done. Restart your runtime to pick up MCP changes."
echo "  - Claude Code: close + reopen, OR run /mcp to verify"
echo "  - OpenCode: opencode reload"
echo "  - Copilot (VS Code): reload window, palette 'MCP: List Servers'"
echo "  - Antigravity: restart antigravity"
echo ""
