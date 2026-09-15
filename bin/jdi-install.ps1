<#
.SYNOPSIS
  jdi-install (Windows): copia runtimes/<runtime>/ pra destino do runtime.

.DESCRIPTION
  Equivalente PowerShell de bin/jdi-install.sh. Funciona em Windows nativo.

.PARAMETER Runtime
  claude | copilot | antigravity | opencode | junie | all

.PARAMETER Scope
  user | project (default: project)

.PARAMETER Githooks
  Opt-in: copia hooks no-op pra .githooks/ (shell no repo do consumidor;
  desligado por padrao pela invariante no-code-in-consumer-repo).

.EXAMPLE
  .\bin\jdi-install.ps1 -Runtime claude -Scope project
  .\bin\jdi-install.ps1 -Runtime opencode -Scope user
  .\bin\jdi-install.ps1 -Runtime all -Githooks
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true, Position=0)]
  [ValidateSet('claude','copilot','antigravity','opencode','junie','all')]
  [string]$Runtime,

  [ValidateSet('user','project')]
  [string]$Scope = 'project',

  [switch]$Githooks
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

# Idioma de instalacao - vem de bin/jdi.js via variavel de ambiente
# (JDI_LANG=en|pt-BR), nunca de parametro deste script (mantem os .sh/.ps1
# sem -Lang proprio).
# Shared lib: $LangPtBr, $LangDirectiveMarker, $Utf8NoBom, Add-LangDirectiveToFile
# (the same injector jdi-sync-specialists.ps1 applies to the specialist
# copies, so both agree byte for byte).
. (Join-Path $PSScriptRoot 'lib\jdi-agent-emit.ps1')
$JdiLang = if ($env:JDI_LANG) { $env:JDI_LANG } else { 'en' }

# Per-project specialists (.jdi/agents/, written by /jdi-bootstrap) must live
# where the runtime discovers agents (.claude/agents/ etc.) or every
# Agent(subagent_type=jdi-doer-*) spawn fails (#33). Always materialized in
# the PROJECT dir - specialists are project state - for both scopes. No-op
# before bootstrap.
function Sync-Specialists {
  param([string]$Rt)
  $specs = Get-ChildItem -Path (Join-Path $ProjectDir '.jdi\agents') -Filter 'jdi-*.md' -ErrorAction SilentlyContinue
  if (-not $specs) { return }
  $env:JDI_LANG = $JdiLang
  & (Join-Path $PSScriptRoot 'lib\jdi-sync-specialists.ps1') -Runtime $Rt -Quiet
  Write-Output "  -> specialists de .jdi/agents/ sincronizados pro runtime $Rt (npx -y jdi-cli sync-specialists)"
}

# Aplica a injecao a todo .md de 1o nivel num diretorio (agents/, commands/,
# prompts/). Silencioso se o diretorio nao existir ou estiver vazio.
function Add-LangDirectiveToDir {
  param([string]$Dir)
  if (-not (Test-Path $Dir)) { return }
  Get-ChildItem -Path $Dir -Filter '*.md' -File | ForEach-Object {
    Add-LangDirectiveToFile -FilePath $_.FullName
  }
}

# Aplica a injecao a todo skills/<nome>/SKILL.md sob um diretorio.
function Add-LangDirectiveToSkills {
  param([string]$SkillsRoot)
  if (-not (Test-Path $SkillsRoot)) { return }
  Get-ChildItem -Path $SkillsRoot -Directory | ForEach-Object {
    $skillFile = Join-Path $_.FullName 'SKILL.md'
    if (Test-Path $skillFile) { Add-LangDirectiveToFile -FilePath $skillFile }
  }
}

function Install-Claude {
  $dest = if ($Scope -eq 'user') { Join-Path $UserHome '.claude' } else { Join-Path $ProjectDir '.claude' }
  New-Item -ItemType Directory -Force -Path "$dest\agents" | Out-Null
  New-Item -ItemType Directory -Force -Path "$dest\commands" | Out-Null
  New-Item -ItemType Directory -Force -Path "$dest\skills" | Out-Null

  Copy-Tree -From "$Root\runtimes\claude\agents" -To "$dest\agents"
  Copy-Tree -From "$Root\runtimes\claude\commands" -To "$dest\commands"
  Copy-Tree -From "$Root\runtimes\claude\skills" -To "$dest\skills"

  Sync-Specialists -Rt 'claude'

  if ($JdiLang -eq $LangPtBr) {
    Add-LangDirectiveToDir -Dir "$dest\agents"
    Add-LangDirectiveToDir -Dir "$dest\commands"
    Add-LangDirectiveToSkills -SkillsRoot "$dest\skills"
  }

  if ($Scope -eq 'project') {
    if (Test-Path "$Root\runtimes\claude\CLAUDE.md") {
      Copy-Item -Path "$Root\runtimes\claude\CLAUDE.md" -Destination "$ProjectDir\CLAUDE.md" -Force
    }
    if (Test-Path "$Root\runtimes\claude\settings.example.json") {
      $target = Join-Path $dest 'settings.example.json'
      if (-not (Test-Path $target)) {
        Copy-Item -Path "$Root\runtimes\claude\settings.example.json" -Destination $target
        Write-Output "  -> revise $target e renomeie para settings.json (ou .local.json)"
      }
    }
  }
  Write-Output "Claude Code instalado em: $dest (scope=$Scope)"
}

function Install-Copilot {
  $dest = Join-Path $ProjectDir '.github'
  New-Item -ItemType Directory -Force -Path "$dest\agents" | Out-Null
  New-Item -ItemType Directory -Force -Path "$dest\prompts" | Out-Null
  New-Item -ItemType Directory -Force -Path "$dest\skills" | Out-Null

  Copy-Tree -From "$Root\runtimes\copilot\agents" -To "$dest\agents"
  Copy-Tree -From "$Root\runtimes\copilot\prompts" -To "$dest\prompts"
  # Skills servem as 3 superficies: Copilot CLI (que NAO le .github/prompts/),
  # VS Code agent mode e o coding agent do github.com
  Copy-Tree -From "$Root\runtimes\copilot\skills" -To "$dest\skills"

  Sync-Specialists -Rt 'copilot'

  if ($JdiLang -eq $LangPtBr) {
    Add-LangDirectiveToDir -Dir "$dest\agents"
    Add-LangDirectiveToDir -Dir "$dest\prompts"
    Add-LangDirectiveToSkills -SkillsRoot "$dest\skills"
  }

  if (Test-Path "$Root\runtimes\copilot\copilot-instructions.md") {
    Copy-Item -Path "$Root\runtimes\copilot\copilot-instructions.md" -Destination "$dest\copilot-instructions.md" -Force
  }

  # Coding agent (issues delegadas): setup do ambiente + gate de artefatos.
  # Nunca sobrescreve workflows existentes do consumidor.
  if (Test-Path "$Root\runtimes\copilot\workflows") {
    New-Item -ItemType Directory -Force -Path "$dest\workflows" | Out-Null
    foreach ($wf in (Get-ChildItem "$Root\runtimes\copilot\workflows" -Filter '*.yml')) {
      $target = Join-Path "$dest\workflows" $wf.Name
      if (Test-Path $target) {
        Write-Output "  -> workflows/$($wf.Name) ja existe - preservado (compare com runtimes/copilot/workflows/)"
      } else {
        Copy-Item -Path $wf.FullName -Destination $target
        Write-Output "  -> workflows/$($wf.Name) instalado"
      }
    }
  }

  Write-Output "Copilot instalado em: $dest"
  Write-Output "  -> Copilot e sempre project-scoped via .github/"
  Write-Output "  -> CLI: comandos JDI aparecem como skills ('/skills reload' na sessao; digite '/jdi-status' na mensagem)"
  Write-Output "  -> coding agent (issues delegadas): persona jdi-solo + workflows copilot-setup-steps/jdi-artifacts-gate"
  Write-Output "     use --githooks pra ativar o gate pre-commit dentro da sessao do agente"
}

function Install-Antigravity {
  # Antigravity 2.0 (May 2026) canonical skill paths:
  #   user scope    -> ~/.gemini/config/skills/   (whole suite: IDE + agy CLI)
  #   project scope -> <root>/.agents/skills/     (tool-agnostic workspace dir)
  # The 1.x path (~/.gemini/antigravity/) is no longer read by 2.0.
  $dest = if ($Scope -eq 'user') { Join-Path $UserHome '.gemini\config' } else { Join-Path $ProjectDir '.agents' }
  New-Item -ItemType Directory -Force -Path "$dest\skills" | Out-Null
  Copy-Tree -From "$Root\runtimes\antigravity\skills" -To "$dest\skills"

  Sync-Specialists -Rt 'antigravity'

  if ($JdiLang -eq $LangPtBr) {
    Add-LangDirectiveToSkills -SkillsRoot "$dest\skills"
  }

  if ($Scope -eq 'project' -and (Test-Path "$Root\runtimes\antigravity\agents.md")) {
    Copy-Item -Path "$Root\runtimes\antigravity\agents.md" -Destination "$dest\agents.md" -Force
  }
  Write-Output "Antigravity 2.0 instalado em: $dest\skills (scope=$Scope)"

  # Legacy 1.x install detected? Point the user to the migration.
  $legacy = @()
  if (Test-Path (Join-Path $UserHome '.gemini\antigravity\skills')) { $legacy += (Join-Path $UserHome '.gemini\antigravity') }
  if (Test-Path (Join-Path $ProjectDir '.gemini\antigravity\skills')) { $legacy += (Join-Path $ProjectDir '.gemini\antigravity') }
  if ($legacy.Count -gt 0) {
    Write-Output "  aviso: instalacao Antigravity 1.x detectada em: $($legacy -join ', ')"
    Write-Output "         o 2.0 nao le esse diretorio. 'jdi update' migra; 'jdi uninstall antigravity' limpa."
  }
}

function Install-Opencode {
  $dest = if ($Scope -eq 'user') { Join-Path $UserHome '.config\opencode' } else { Join-Path $ProjectDir '.opencode' }
  New-Item -ItemType Directory -Force -Path "$dest\agents" | Out-Null
  New-Item -ItemType Directory -Force -Path "$dest\commands" | Out-Null
  New-Item -ItemType Directory -Force -Path "$dest\skills" | Out-Null

  Copy-Tree -From "$Root\runtimes\opencode\agents" -To "$dest\agents"
  Copy-Tree -From "$Root\runtimes\opencode\commands" -To "$dest\commands"
  Copy-Tree -From "$Root\runtimes\opencode\skills" -To "$dest\skills"

  Sync-Specialists -Rt 'opencode'

  if ($JdiLang -eq $LangPtBr) {
    Add-LangDirectiveToDir -Dir "$dest\agents"
    Add-LangDirectiveToDir -Dir "$dest\commands"
    Add-LangDirectiveToSkills -SkillsRoot "$dest\skills"
  }

  if ($Scope -eq 'project') {
    if (Test-Path "$Root\runtimes\opencode\AGENTS.md") {
      Copy-Item -Path "$Root\runtimes\opencode\AGENTS.md" -Destination "$ProjectDir\AGENTS.md" -Force
    }
    $jsoncTarget = Join-Path $dest 'opencode.jsonc'
    if (-not (Test-Path $jsoncTarget) -and (Test-Path "$Root\runtimes\opencode\opencode.example.jsonc")) {
      Copy-Item -Path "$Root\runtimes\opencode\opencode.example.jsonc" -Destination $jsoncTarget
      Write-Output "  -> revise $jsoncTarget (gerado a partir do exemplo)"
    }
  }
  Write-Output "OpenCode instalado em: $dest (scope=$Scope)"
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

  Write-Output ""
  Write-Output "Git hooks copiados pra .githooks/. Para ativar:"
  Write-Output "  git config core.hooksPath .githooks"
  Write-Output ""
  Write-Output "  Windows: hooks rodam via git-bash (vem com Git for Windows)."
  Write-Output "           Sem Git for Windows, hooks sao silenciosamente ignorados."
}

function Install-Junie {
  # Junie CLI (JetBrains, beta 2026): commands sao SKILLS (semantic discovery,
  # .junie/skills/<n>/SKILL.md) e agents sao SUBAGENTS (.junie/agents/<n>.md,
  # tools allowlist enforced). Custom commands do Junie exigem args nomeados
  # obrigatorios - incompativel com os corpos JDI; skills nao tem o problema.
  $dest = if ($Scope -eq 'user') { Join-Path $UserHome '.junie' } else { Join-Path $ProjectDir '.junie' }
  New-Item -ItemType Directory -Force -Path "$dest\agents" | Out-Null
  New-Item -ItemType Directory -Force -Path "$dest\skills" | Out-Null
  Copy-Tree -From "$Root\runtimes\junie\agents" -To "$dest\agents"
  Copy-Tree -From "$Root\runtimes\junie\skills" -To "$dest\skills"

  Sync-Specialists -Rt 'junie'

  if ($JdiLang -eq $LangPtBr) {
    Add-LangDirectiveToDir -Dir "$dest\agents"
    Add-LangDirectiveToSkills -SkillsRoot "$dest\skills"
  }

  if ($Scope -eq 'project') {
    Copy-Item -Path "$Root\runtimes\junie\AGENTS.md" -Destination "$dest\AGENTS.md" -Force
  }

  Write-Output "Junie instalado em: $dest (scope=$Scope)"
}

switch ($Runtime) {
  'claude'      { Install-Claude }
  'copilot'     { Install-Copilot }
  'antigravity' { Install-Antigravity }
  'opencode'    { Install-Opencode }
  'junie'       { Install-Junie }
  'all' {
    Install-Claude
    Install-Copilot
    Install-Antigravity
    Install-Opencode
    Install-Junie
  }
}

# Opt-in: shell scripts no repo do consumidor so com pedido explicito.
if ($Githooks) {
  Install-GitHooks
} else {
  Write-Output "  (git hooks nao instalados - opcional via -Githooks)"
}

# Escreve .jdi/VERSION pra rastreio em updates futuros
if ($Scope -eq 'project' -or $Scope -eq 'user') {
  if (Test-Path (Join-Path $ProjectDir '.jdi')) {
    $pkgJson = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
    # WriteAllText + UTF8 sem BOM: Set-Content -Encoding UTF8 no PS 5.1 grava
    # BOM, e o bash (update.sh de outro dev) leria "\xEF\xBB\xBFpt-BR" != "pt-BR".
    [System.IO.File]::WriteAllText((Join-Path $ProjectDir '.jdi/VERSION'), [string]$pkgJson.version, $Utf8NoBom)
    # Escreve .jdi/LANG pra jdi update reaplicar a diretiva sem exigir -Lang de novo
    [System.IO.File]::WriteAllText((Join-Path $ProjectDir '.jdi/LANG'), [string]$JdiLang, $Utf8NoBom)
  }
}
