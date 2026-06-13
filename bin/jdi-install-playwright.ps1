<#
.SYNOPSIS
  jdi-install-playwright (Windows): installs Playwright dev dep + chromium browser
  + injects Playwright MCP config in detected runtime configs.

.DESCRIPTION
  Optional install. Adds:
   - @playwright/test as devDependency (via detected pkg manager: pnpm > yarn > npm)
   - chromium browser via `npx playwright install chromium`
   - MCP server config in:
     * .claude/settings.local.json     (Claude Code)
     * .opencode/opencode.jsonc        (OpenCode)
   Copilot has no MCP; skip with warn.
   Antigravity MCP support unverified; skip with warn.

  Idempotent: if @playwright/test already present, skips dep install.
  If MCP config already has playwright entry, skips injection.

.PARAMETER SkipBrowser
  Skip `npx playwright install chromium`. Use if browser already installed.

.PARAMETER SkipMcp
  Skip MCP config injection. Only install dep + browser.

.PARAMETER Runtime
  Force MCP injection only into this runtime. Default: detect all present.
  Values: claude | opencode | copilot | antigravity | all

.PARAMETER AntigravityScope
  Antigravity MCP scope: user (~/.gemini/settings.json) or project (.gemini/settings.json).
  Default: user

.EXAMPLE
  .\bin\jdi-install-playwright.ps1
  .\bin\jdi-install-playwright.ps1 -SkipBrowser
  .\bin\jdi-install-playwright.ps1 -Runtime claude
  .\bin\jdi-install-playwright.ps1 -Runtime all -AntigravityScope project
#>
[CmdletBinding()]
param(
  [switch]$SkipBrowser,
  [switch]$SkipMcp,
  [ValidateSet('claude','opencode','copilot','antigravity','all')]
  [string]$Runtime = 'all',
  [ValidateSet('user','project')]
  [string]$AntigravityScope = 'user'
)

$ErrorActionPreference = 'Stop'
$ProjectDir = (Get-Location).Path

function Detect-PackageManager {
  if (Test-Path (Join-Path $ProjectDir 'pnpm-lock.yaml')) { return 'pnpm' }
  if (Test-Path (Join-Path $ProjectDir 'yarn.lock'))      { return 'yarn' }
  if (Test-Path (Join-Path $ProjectDir 'bun.lockb'))      { return 'bun' }
  return 'npm'
}

function Has-PlaywrightDep {
  $pkg = Join-Path $ProjectDir 'package.json'
  if (-not (Test-Path $pkg)) { return $false }
  $json = Get-Content $pkg -Raw | ConvertFrom-Json
  $deps = @{}
  if ($json.dependencies)    { $json.dependencies.PSObject.Properties    | ForEach-Object { $deps[$_.Name] = $_.Value } }
  if ($json.devDependencies) { $json.devDependencies.PSObject.Properties | ForEach-Object { $deps[$_.Name] = $_.Value } }
  return $deps.ContainsKey('@playwright/test')
}

function Install-PlaywrightDep {
  if (Has-PlaywrightDep) {
    Write-Information -MessageData "  [skip] @playwright/test already in package.json" -InformationAction Continue
    return $true
  }

  if (-not (Test-Path (Join-Path $ProjectDir 'package.json'))) {
    Write-Warning "package.json not found. Run 'npm init -y' first or this command outside a JS/TS project."
    return $false
  }

  $pm = Detect-PackageManager
  Write-Information -MessageData "  Installing @playwright/test via $pm..." -InformationAction Continue

  switch ($pm) {
    'pnpm' { & pnpm add -D '@playwright/test' }
    'yarn' { & yarn add -D '@playwright/test' }
    'bun'  { & bun add -d '@playwright/test' }
    default { & npm install --save-dev '@playwright/test' }
  }

  return ($LASTEXITCODE -eq 0)
}

function Install-ChromiumBrowser {
  if ($SkipBrowser) {
    Write-Information -MessageData "  [skip] -SkipBrowser flag set" -InformationAction Continue
    return $true
  }
  Write-Information -MessageData "  Installing chromium browser (~170MB, may take a minute)..." -InformationAction Continue
  & npx --yes playwright install chromium
  return ($LASTEXITCODE -eq 0)
}

function Inject-ClaudeMcp {
  $claudeDir = Join-Path $ProjectDir '.claude'
  if (-not (Test-Path $claudeDir)) {
    Write-Output "  [skip] .claude/ not present (Claude Code not installed)"
    return
  }

  $settingsPath = Join-Path $claudeDir 'settings.local.json'
  $settings = @{}

  if (Test-Path $settingsPath) {
    try {
      $raw = Get-Content $settingsPath -Raw
      $parsed = $raw | ConvertFrom-Json
      $parsed.PSObject.Properties | ForEach-Object { $settings[$_.Name] = $_.Value }
    } catch {
      Write-Warning "  Existing $settingsPath is not valid JSON; skipping injection."
      return
    }
  }

  if (-not $settings.ContainsKey('mcpServers')) { $settings['mcpServers'] = @{} }
  $mcp = @{}
  if ($settings['mcpServers'] -is [psobject]) {
    $settings['mcpServers'].PSObject.Properties | ForEach-Object { $mcp[$_.Name] = $_.Value }
  } elseif ($settings['mcpServers'] -is [hashtable]) {
    $mcp = $settings['mcpServers']
  }

  if ($mcp.ContainsKey('playwright')) {
    Write-Output "  [skip] mcpServers.playwright already present in settings.local.json"
    return
  }

  $mcp['playwright'] = @{
    command = 'npx'
    args    = @('-y', '@playwright/mcp@latest')
  }
  $settings['mcpServers'] = $mcp

  $json = $settings | ConvertTo-Json -Depth 8
  $json | Out-File -FilePath $settingsPath -Encoding UTF8 -NoNewline
  Write-Output "  -> wrote .claude/settings.local.json (mcpServers.playwright)"
}

function Inject-OpencodeMcp {
  $ocDir = Join-Path $ProjectDir '.opencode'
  if (-not (Test-Path $ocDir)) {
    Write-Output "  [skip] .opencode/ not present (OpenCode not installed)"
    return
  }

  $configPath = Join-Path $ocDir 'opencode.jsonc'
  $raw = ''
  if (Test-Path $configPath) {
    $raw = Get-Content $configPath -Raw
    if ($raw -match '"playwright"\s*:') {
      Write-Output "  [skip] mcp.playwright already present in opencode.jsonc"
      return
    }
  } else {
    $raw = "// OpenCode config - JDI managed `n{`n  `"`$schema`": `"https://opencode.ai/config.json`"`n}`n"
  }

  # Strip comments for parse, keep header for re-emit
  $stripped = ($raw -replace '(?m)^\s*//.*$','') -replace '/\*[\s\S]*?\*/',''
  try {
    $parsed = $stripped | ConvertFrom-Json
  } catch {
    Write-Warning "  Existing opencode.jsonc is not parseable; skipping injection."
    return
  }

  $obj = @{}
  $parsed.PSObject.Properties | ForEach-Object { $obj[$_.Name] = $_.Value }

  if (-not $obj.ContainsKey('mcp')) { $obj['mcp'] = @{} }
  $mcp = @{}
  if ($obj['mcp'] -is [psobject]) {
    $obj['mcp'].PSObject.Properties | ForEach-Object { $mcp[$_.Name] = $_.Value }
  } elseif ($obj['mcp'] -is [hashtable]) {
    $mcp = $obj['mcp']
  }

  $mcp['playwright'] = @{
    type    = 'local'
    command = @('npx', '-y', '@playwright/mcp@latest')
    enabled = $true
  }
  $obj['mcp'] = $mcp

  $newJson = $obj | ConvertTo-Json -Depth 8
  $header = "// OpenCode config - JDI managed (mcp.playwright managed; rest is yours)`n"
  $output = $header + $newJson + "`n"
  $output | Out-File -FilePath $configPath -Encoding UTF8 -NoNewline
  Write-Output "  -> wrote .opencode/opencode.jsonc (mcp.playwright)"
}

function Inject-CopilotMcp {
  # Copilot MCP via VS Code workspace: .vscode/mcp.json
  $vscodeDir = Join-Path $ProjectDir '.vscode'
  $f = Join-Path $vscodeDir 'mcp.json'

  if ((Test-Path $f) -and ((Get-Content $f -Raw) -match '"playwright"\s*:')) {
    Write-Output "  [skip] servers.playwright already present in .vscode/mcp.json"
    return
  }

  New-Item -ItemType Directory -Force -Path $vscodeDir | Out-Null

  $settings = @{}
  if (Test-Path $f) {
    try {
      $parsed = Get-Content $f -Raw | ConvertFrom-Json
      $parsed.PSObject.Properties | ForEach-Object { $settings[$_.Name] = $_.Value }
    } catch {
      Write-Warning "  Existing .vscode/mcp.json not valid JSON; skipping."
      return
    }
  }

  if (-not $settings.ContainsKey('servers')) { $settings['servers'] = @{} }
  $servers = @{}
  if ($settings['servers'] -is [psobject]) {
    $settings['servers'].PSObject.Properties | ForEach-Object { $servers[$_.Name] = $_.Value }
  } elseif ($settings['servers'] -is [hashtable]) {
    $servers = $settings['servers']
  }

  $servers['playwright'] = @{
    command = 'npx'
    args    = @('-y', '@playwright/mcp@latest')
  }
  $settings['servers'] = $servers

  ($settings | ConvertTo-Json -Depth 8) | Out-File -FilePath $f -Encoding UTF8 -NoNewline
  Write-Output "  -> wrote .vscode/mcp.json (servers.playwright) for Copilot"
}

function Inject-AntigravityMcp {
  $base = if ($AntigravityScope -eq 'user') { Join-Path $UserHome '.gemini' } else { Join-Path $ProjectDir '.gemini' }
  $f = Join-Path $base 'settings.json'

  if ((Test-Path $f) -and ((Get-Content $f -Raw) -match '"playwright"\s*:')) {
    Write-Output "  [skip] mcpServers.playwright already present in $f"
    return
  }

  New-Item -ItemType Directory -Force -Path $base | Out-Null

  $settings = @{}
  if (Test-Path $f) {
    try {
      $parsed = Get-Content $f -Raw | ConvertFrom-Json
      $parsed.PSObject.Properties | ForEach-Object { $settings[$_.Name] = $_.Value }
    } catch {
      Write-Warning "  Existing $f not valid JSON; skipping."
      return
    }
  }

  if (-not $settings.ContainsKey('mcpServers')) { $settings['mcpServers'] = @{} }
  $mcp = @{}
  if ($settings['mcpServers'] -is [psobject]) {
    $settings['mcpServers'].PSObject.Properties | ForEach-Object { $mcp[$_.Name] = $_.Value }
  } elseif ($settings['mcpServers'] -is [hashtable]) {
    $mcp = $settings['mcpServers']
  }

  $mcp['playwright'] = @{
    command = 'npx'
    args    = @('-y', '@playwright/mcp@latest')
  }
  $settings['mcpServers'] = $mcp

  ($settings | ConvertTo-Json -Depth 8) | Out-File -FilePath $f -Encoding UTF8 -NoNewline
  Write-Output "  -> wrote $f (mcpServers.playwright) for Antigravity"
}

# =====================================================================
# Main
# =====================================================================

Write-Output ''
Write-Output '=== JDI: Install Playwright + MCP ==='
Write-Output ''

Write-Output 'Step 1: Install dep'
$depOk = Install-PlaywrightDep
if (-not $depOk) {
  Write-Error "Dep install failed. Aborting."
  exit 1
}

Write-Output ''
Write-Output 'Step 2: Install browser'
$bOk = Install-ChromiumBrowser
if (-not $bOk) {
  Write-Warning "Browser install failed. You can rerun later: 'npx playwright install chromium'"
}

if (-not $SkipMcp) {
  Write-Output ''
  Write-Output 'Step 3: Inject MCP config in detected runtimes'
  if ($Runtime -in 'claude','all')      { Inject-ClaudeMcp }
  if ($Runtime -in 'opencode','all')    { Inject-OpencodeMcp }
  if ($Runtime -in 'copilot','all')     { Inject-CopilotMcp }
  if ($Runtime -in 'antigravity','all') { Inject-AntigravityMcp }
}

Write-Output ''
Write-Output 'Done. Restart your runtime to pick up MCP changes.'
Write-Output '  - Claude Code: close + reopen, OR run /mcp to verify'
Write-Output '  - OpenCode: opencode reload'
Write-Output '  - Copilot (VS Code): reload window, palette `MCP: List Servers`'
Write-Output '  - Antigravity: restart antigravity'
Write-Output ''
