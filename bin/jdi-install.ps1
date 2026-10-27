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

# The files JDI ships for a runtime: copied by one Node helper (the same one
# jdi-install.sh calls), which writes only those files, injects the pt-BR
# directive only into them and keeps <dest>/.jdi-installed.json. A file the
# project edited is kept (the new version goes to <file>.jdi-new; JDI_FORCE_FILES
# replaces it). Third-party agents and skills next to them are never touched
# (#78: update used to add the directive to every agent/skill in the dir).
function Install-Files {
  param([string]$Rt, [string]$Dest, [string]$Dirs)
  $sep = [System.IO.Path]::DirectorySeparatorChar
  $src = [System.IO.Path]::Combine($Root, 'runtimes', $Rt)
  $Dest = $Dest -replace '[\\/]', $sep
  $helper = [System.IO.Path]::Combine($Root, 'bin', 'lib', 'install-files.js')
  $node = if ($env:JDI_NODE) { $env:JDI_NODE } else { 'node' }
  $nodeArgs = @($helper, $src, $Dest, '--dirs', $Dirs, '--lang', $JdiLang)
  if ($env:JDI_FORCE_FILES) { $nodeArgs += '--force' }
  & $node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "install-files falhou para $Dest" }
}

# Project config files JDI offers once (settings/opencode examples): only on a
# first install - never recreated by update (JDI_UPDATE), the project may have
# removed or renamed them on purpose.
function Test-FirstInstall {
  return -not $env:JDI_UPDATE
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
  # tier copies (Copilot/OpenCode, routing.runtime_models)
  & node (Join-Path $PSScriptRoot 'lib\tiers.js') $Rt --quiet
  Write-Output "  -> specialists de .jdi/agents/ sincronizados pro runtime $Rt (npx -y jdi-cli sync-specialists)"
}

# Instruction files carry the JDI part as a MANAGED BLOCK: only that block is
# replaced, the project's own rules around it are preserved byte for byte
# (<= 0.15.x copied the whole file over them). Same Node helper as install.sh.
function Merge-Instructions {
  param([string]$Src, [string]$Dest, [string]$Runtime)
  # Node gets the raw string: normalize the separators this script writes
  # Windows-style, so the same call also works under pwsh on Linux/macOS.
  $sep = [System.IO.Path]::DirectorySeparatorChar
  $Src = $Src -replace '[\\/]', $sep
  $Dest = $Dest -replace '[\\/]', $sep
  $helper = [System.IO.Path]::Combine($Root, 'bin', 'lib', 'instructions.js')
  & node $helper merge $Src $Dest $Runtime
  if ($LASTEXITCODE -ne 0) { throw "instructions merge falhou para $Dest" }
}

function Install-Claude {
  $dest = if ($Scope -eq 'user') { Join-Path $UserHome '.claude' } else { Join-Path $ProjectDir '.claude' }
  Install-Files -Rt 'claude' -Dest $dest -Dirs 'agents,commands,skills'

  Sync-Specialists -Rt 'claude'

  if ($Scope -eq 'project') {
    if (Test-Path "$Root\runtimes\claude\CLAUDE.md") {
      Merge-Instructions -Src "$Root\runtimes\claude\CLAUDE.md" -Dest "$ProjectDir\CLAUDE.md" -Runtime claude
    }
    if ((Test-FirstInstall) -and (Test-Path "$Root\runtimes\claude\settings.example.json")) {
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
  # Skills servem as 3 superficies: Copilot CLI (que NAO le .github/prompts/),
  # VS Code agent mode e o coding agent do github.com
  Install-Files -Rt 'copilot' -Dest $dest -Dirs 'agents,prompts,skills'

  Sync-Specialists -Rt 'copilot'

  if (Test-Path "$Root\runtimes\copilot\copilot-instructions.md") {
    Merge-Instructions -Src "$Root\runtimes\copilot\copilot-instructions.md" -Dest "$dest\copilot-instructions.md" -Runtime copilot
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
  Install-Files -Rt 'antigravity' -Dest $dest -Dirs 'skills'

  Sync-Specialists -Rt 'antigravity'

  if ($Scope -eq 'project' -and (Test-Path "$Root\runtimes\antigravity\agents.md")) {
    Merge-Instructions -Src "$Root\runtimes\antigravity\agents.md" -Dest "$dest\agents.md" -Runtime antigravity
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
  Install-Files -Rt 'opencode' -Dest $dest -Dirs 'agents,commands,skills'

  Sync-Specialists -Rt 'opencode'

  if ($Scope -eq 'project') {
    if (Test-Path "$Root\runtimes\opencode\AGENTS.md") {
      Merge-Instructions -Src "$Root\runtimes\opencode\AGENTS.md" -Dest "$ProjectDir\AGENTS.md" -Runtime opencode
    }
    $jsoncTarget = Join-Path $dest 'opencode.jsonc'
    if ((Test-FirstInstall) -and -not (Test-Path $jsoncTarget) -and (Test-Path "$Root\runtimes\opencode\opencode.example.jsonc")) {
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
  Install-Files -Rt 'junie' -Dest $dest -Dirs 'agents,skills'

  Sync-Specialists -Rt 'junie'

  if ($Scope -eq 'project') {
    Merge-Instructions -Src "$Root\runtimes\junie\AGENTS.md" -Dest "$dest\AGENTS.md" -Runtime junie
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
