<#
.SYNOPSIS
  jdi-install (Windows): copia runtimes/<runtime>/ pra destino do runtime.

.DESCRIPTION
  Equivalente PowerShell de bin/jdi-install.sh. Funciona em Windows nativo.

.PARAMETER Runtime
  claude | copilot | antigravity | opencode | all

.PARAMETER Scope
  user | project (default: project)

.EXAMPLE
  .\bin\jdi-install.ps1 -Runtime claude -Scope project
  .\bin\jdi-install.ps1 -Runtime opencode -Scope user
  .\bin\jdi-install.ps1 -Runtime all
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true, Position=0)]
  [ValidateSet('claude','copilot','antigravity','opencode','all')]
  [string]$Runtime,

  [ValidateSet('user','project')]
  [string]$Scope = 'project'
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$ProjectDir = (Get-Location).Path
$UserHome = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }

function Copy-Tree {
  param([string]$From, [string]$To)
  if (-not (Test-Path $From)) { return }
  New-Item -ItemType Directory -Force -Path $To | Out-Null
  Copy-Item -Path (Join-Path $From '*') -Destination $To -Recurse -Force
}

function Install-Claude {
  $dest = if ($Scope -eq 'user') { Join-Path $UserHome '.claude' } else { Join-Path $ProjectDir '.claude' }
  New-Item -ItemType Directory -Force -Path "$dest\agents" | Out-Null
  New-Item -ItemType Directory -Force -Path "$dest\commands" | Out-Null
  New-Item -ItemType Directory -Force -Path "$dest\skills" | Out-Null

  Copy-Tree -From "$Root\runtimes\claude\agents" -To "$dest\agents"
  Copy-Tree -From "$Root\runtimes\claude\commands" -To "$dest\commands"
  Copy-Tree -From "$Root\runtimes\claude\skills" -To "$dest\skills"

  if ($Scope -eq 'project') {
    if (Test-Path "$Root\runtimes\claude\CLAUDE.md") {
      Copy-Item -Path "$Root\runtimes\claude\CLAUDE.md" -Destination "$ProjectDir\CLAUDE.md" -Force
    }
    if (Test-Path "$Root\runtimes\claude\settings.example.json") {
      $target = Join-Path $dest 'settings.example.json'
      if (-not (Test-Path $target)) {
        Copy-Item -Path "$Root\runtimes\claude\settings.example.json" -Destination $target
        Write-Host "  -> revise $target e renomeie para settings.json (ou .local.json)"
      }
    }
  }
  Write-Host "Claude Code instalado em: $dest (scope=$Scope)"
}

function Install-Copilot {
  $dest = Join-Path $ProjectDir '.github'
  New-Item -ItemType Directory -Force -Path "$dest\agents" | Out-Null
  New-Item -ItemType Directory -Force -Path "$dest\prompts" | Out-Null

  Copy-Tree -From "$Root\runtimes\copilot\agents" -To "$dest\agents"
  Copy-Tree -From "$Root\runtimes\copilot\prompts" -To "$dest\prompts"

  if (Test-Path "$Root\runtimes\copilot\copilot-instructions.md") {
    Copy-Item -Path "$Root\runtimes\copilot\copilot-instructions.md" -Destination "$dest\copilot-instructions.md" -Force
  }
  Write-Host "Copilot instalado em: $dest"
  Write-Host "  -> Copilot e sempre project-scoped via .github/"
}

function Install-Antigravity {
  $dest = if ($Scope -eq 'user') { Join-Path $UserHome '.gemini\antigravity' } else { Join-Path $ProjectDir '.gemini\antigravity' }
  New-Item -ItemType Directory -Force -Path "$dest\skills" | Out-Null
  Copy-Tree -From "$Root\runtimes\antigravity\skills" -To "$dest\skills"

  if ($Scope -eq 'project' -and (Test-Path "$Root\runtimes\antigravity\agents.md")) {
    Copy-Item -Path "$Root\runtimes\antigravity\agents.md" -Destination "$ProjectDir\agents.md" -Force
  }
  Write-Host "Antigravity instalado em: $dest (scope=$Scope)"
}

function Install-Opencode {
  $dest = if ($Scope -eq 'user') { Join-Path $UserHome '.config\opencode' } else { Join-Path $ProjectDir '.opencode' }
  New-Item -ItemType Directory -Force -Path "$dest\agents" | Out-Null
  New-Item -ItemType Directory -Force -Path "$dest\commands" | Out-Null
  New-Item -ItemType Directory -Force -Path "$dest\skills" | Out-Null

  Copy-Tree -From "$Root\runtimes\opencode\agents" -To "$dest\agents"
  Copy-Tree -From "$Root\runtimes\opencode\commands" -To "$dest\commands"
  Copy-Tree -From "$Root\runtimes\opencode\skills" -To "$dest\skills"

  if ($Scope -eq 'project') {
    if (Test-Path "$Root\runtimes\opencode\AGENTS.md") {
      Copy-Item -Path "$Root\runtimes\opencode\AGENTS.md" -Destination "$ProjectDir\AGENTS.md" -Force
    }
    $jsoncTarget = Join-Path $dest 'opencode.jsonc'
    if (-not (Test-Path $jsoncTarget) -and (Test-Path "$Root\runtimes\opencode\opencode.example.jsonc")) {
      Copy-Item -Path "$Root\runtimes\opencode\opencode.example.jsonc" -Destination $jsoncTarget
      Write-Host "  -> revise $jsoncTarget (gerado a partir do exemplo)"
    }
  }
  Write-Host "OpenCode instalado em: $dest (scope=$Scope)"
}

function Install-GitHooks {
  $hooksDir = Join-Path $ProjectDir '.githooks'
  New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null

  foreach ($hook in @('pre-commit','post-commit')) {
    $src = Join-Path "$Root\bin\git-hooks" $hook
    if (Test-Path $src) {
      Copy-Item -Path $src -Destination (Join-Path $hooksDir $hook) -Force
    }
  }

  Write-Host ""
  Write-Host "Git hooks copiados pra .githooks/. Para ativar:"
  Write-Host "  git config core.hooksPath .githooks"
  Write-Host ""
  Write-Host "  Windows: hooks rodam via git-bash (vem com Git for Windows)."
  Write-Host "           Sem Git for Windows, hooks sao silenciosamente ignorados."
}

switch ($Runtime) {
  'claude'      { Install-Claude }
  'copilot'     { Install-Copilot }
  'antigravity' { Install-Antigravity }
  'opencode'    { Install-Opencode }
  'all' {
    Install-Claude
    Install-Copilot
    Install-Antigravity
    Install-Opencode
  }
}

Install-GitHooks

# Escreve .jdi/VERSION pra rastreio em updates futuros
if ($Scope -eq 'project' -or $Scope -eq 'user') {
  if (Test-Path (Join-Path $ProjectDir '.jdi')) {
    $pkgJson = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
    Set-Content -Path (Join-Path $ProjectDir '.jdi/VERSION') -Value $pkgJson.version -Encoding UTF8 -NoNewline
  }
}
