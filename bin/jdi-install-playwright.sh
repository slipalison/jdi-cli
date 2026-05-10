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
#   --skip-browser      Skip `npx playwright install chromium`
#   --skip-mcp          Skip MCP config injection (only dep + browser)
#   --runtime <r>       claude | opencode | all (default: all detected)

set -euo pipefail

PROJECT_DIR="$(pwd)"
SKIP_BROWSER=0
SKIP_MCP=0
RUNTIME=all

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-browser) SKIP_BROWSER=1; shift ;;
    --skip-mcp)     SKIP_MCP=1; shift ;;
    --runtime)      RUNTIME="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

case "$RUNTIME" in
  claude|opencode|all) ;;
  *) echo "Invalid --runtime. Use: claude | opencode | all"; exit 1 ;;
esac

detect_pm() {
  if [ -f "$PROJECT_DIR/pnpm-lock.yaml" ]; then echo pnpm
  elif [ -f "$PROJECT_DIR/yarn.lock" ];     then echo yarn
  elif [ -f "$PROJECT_DIR/bun.lockb" ];     then echo bun
  else echo npm
  fi
}

has_pw_dep() {
  local pkg="$PROJECT_DIR/package.json"
  [ -f "$pkg" ] || { echo 0; return; }
  if grep -qE '"@playwright/test"' "$pkg"; then echo 1; else echo 0; fi
}

install_pw_dep() {
  if [ "$(has_pw_dep)" = "1" ]; then
    echo "  [skip] @playwright/test already in package.json"
    return 0
  fi
  if [ ! -f "$PROJECT_DIR/package.json" ]; then
    echo "  [warn] package.json not found. Run 'npm init -y' first."
    return 1
  fi

  local pm
  pm="$(detect_pm)"
  echo "  Installing @playwright/test via $pm..."

  case "$pm" in
    pnpm) pnpm add -D @playwright/test ;;
    yarn) yarn add -D @playwright/test ;;
    bun)  bun add -d @playwright/test ;;
    *)    npm install --save-dev @playwright/test ;;
  esac
}

install_chromium() {
  if [ "$SKIP_BROWSER" = "1" ]; then
    echo "  [skip] --skip-browser flag set"
    return 0
  fi
  echo "  Installing chromium browser (~170MB, may take a minute)..."
  npx --yes playwright install chromium || {
    echo "  [warn] chromium install failed. Rerun later: npx playwright install chromium"
    return 0
  }
}

inject_claude_mcp() {
  local dir="$PROJECT_DIR/.claude"
  if [ ! -d "$dir" ]; then
    echo "  [skip] .claude/ not present (Claude Code not installed)"
    return
  fi

  local f="$dir/settings.local.json"
  if [ -f "$f" ] && grep -qE '"playwright"\s*:' "$f"; then
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
  if [ ! -d "$dir" ]; then
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

warn_copilot_antigravity() {
  if [ -f "$PROJECT_DIR/.github/copilot-instructions.md" ]; then
    echo "  [warn] Copilot detected: no MCP toggle support. Use Playwright via skill jdi-frontend-validator only."
  fi
  if [ -d "$PROJECT_DIR/skills" ] && [ -n "$(ls -A "$PROJECT_DIR/skills" 2>/dev/null || true)" ]; then
    echo "  [warn] Antigravity skills dir detected: MCP config not injected (support unverified)."
  fi
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

if [ "$SKIP_MCP" != "1" ]; then
  echo ""
  echo "Step 3: Inject MCP config in detected runtimes"
  if [ "$RUNTIME" = "claude" ]   || [ "$RUNTIME" = "all" ]; then inject_claude_mcp; fi
  if [ "$RUNTIME" = "opencode" ] || [ "$RUNTIME" = "all" ]; then inject_opencode_mcp; fi
  warn_copilot_antigravity
fi

echo ""
echo "Done. Restart your runtime to pick up MCP changes."
echo "  - Claude Code: close + reopen, OR run /mcp to verify"
echo "  - OpenCode: opencode reload"
echo ""
