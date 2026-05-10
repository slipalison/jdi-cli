<#
.SYNOPSIS
  jdi-uninstall (Windows): remove JDI do projeto.

.DESCRIPTION
  Remove arquivos JDI dos runtimes detectados. Por seguranca:
  - Default: NAO remove .jdi/ (state files com decisoes locked, roadmap, etc)
  - Default: NAO remove .githooks/ (user pode ter customizado)
  - --purge: remove TUDO incluindo .jdi/
  - --runtime <name>: so desinstala 1 runtime especifico

  SEMPRE pede confirmacao antes de remover. Use --yes pra skip prompts.

.PARAMETER Runtime
  Especifico: claude | copilot | antigravity | opencode | all (default: all detectados)

.PARAMETER Scope
  user | project (default: detect)

.PARAMETER Purge
  Remove tambem .jdi/ (state files - DESTRUTIVO).

.PARAMETER Yes
  Pula confirmacoes interativas.

.PARAMETER DryRun
  Mostra o que seria removido, sem aplicar.

.EXAMPLE
  .\bin\jdi-uninstall.ps1
  .\bin\jdi-uninstall.ps1 -Runtime claude
  .\bin\jdi-uninstall.ps1 -Purge -Yes
  .\bin\jdi-uninstall.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [ValidateSet('claude','copilot','antigravity','opencode','all')]
  [string]$Runtime = 'all',

  [ValidateSet('user','project','both')]
  [string]$Scope = 'both',

  [switch]$Purge,
  [switch]$Yes,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$ProjectDir = (Get-Location).Path
$UserHome = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }

function Confirm-Action {
  param([string]$Message)
  if ($Yes) { return $true }
  if ($DryRun) { return $true }
  $resp = Read-Host "$Message (y/N)"
  return ($resp -match '^[YySs]')
}

function Remove-Item-Safe {
  param([string]$Path, [string]$Label)
  if (-not (Test-Path $Path)) { return }

  if ($DryRun) {
    Write-Host "  [dry-run] removeria: $Path" -ForegroundColor DarkGray
    return
  }

  Remove-Item -Path $Path -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "  removido: $Label" -ForegroundColor Green
}

function Uninstall-Claude {
  param([string]$ScopeChoice)
  $targets = @()
  if ($ScopeChoice -in @('project','both')) {
    $targets += @{ Dir = (Join-Path $ProjectDir '.claude'); Scope = 'project' }
  }
  if ($ScopeChoice -in @('user','both')) {
    $targets += @{ Dir = (Join-Path $UserHome '.claude'); Scope = 'user' }
  }

  foreach ($t in $targets) {
    if (-not (Test-Path $t.Dir)) { continue }
    Write-Host ""
    Write-Host "Claude ($($t.Scope) scope) em: $($t.Dir)" -ForegroundColor Cyan

    # Remove agents jdi-*
    $agentsDir = Join-Path $t.Dir 'agents'
    if (Test-Path $agentsDir) {
      Get-ChildItem $agentsDir -Filter 'jdi-*.md' -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item-Safe $_.FullName "agents/$($_.Name)"
      }
    }

    # Remove commands jdi-*
    $cmdDir = Join-Path $t.Dir 'commands'
    if (Test-Path $cmdDir) {
      Get-ChildItem $cmdDir -Filter 'jdi-*.md' -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item-Safe $_.FullName "commands/$($_.Name)"
      }
    }

    # Remove skills shipped
    $skillsDir = Join-Path $t.Dir 'skills'
    if (Test-Path $skillsDir) {
      foreach ($skillName in @('frontend-rules','frontend-validator','dry','kiss','yagni','solid','clean-code')) {
        $sd = Join-Path $skillsDir $skillName
        Remove-Item-Safe $sd "skills/$skillName/"
      }
    }

    # CLAUDE.md (project scope only) - so se identico ao shipped
    if ($t.Scope -eq 'project') {
      $cmd = Join-Path $ProjectDir 'CLAUDE.md'
      if (Test-Path $cmd) {
        if (Confirm-Action "Remover CLAUDE.md? (pode ter sido editado)") {
          Remove-Item-Safe $cmd "CLAUDE.md"
        }
      }
    }
  }
}

function Uninstall-Copilot {
  $dest = Join-Path $ProjectDir '.github'
  if (-not (Test-Path $dest)) { return }

  Write-Host ""
  Write-Host "Copilot (project scope) em: $dest" -ForegroundColor Cyan

  $agentsDir = Join-Path $dest 'agents'
  if (Test-Path $agentsDir) {
    Get-ChildItem $agentsDir -Filter 'jdi-*.agent.md' -ErrorAction SilentlyContinue | ForEach-Object {
      Remove-Item-Safe $_.FullName "agents/$($_.Name)"
    }
  }

  $promptsDir = Join-Path $dest 'prompts'
  if (Test-Path $promptsDir) {
    Get-ChildItem $promptsDir -Filter 'jdi-*.prompt.md' -ErrorAction SilentlyContinue | ForEach-Object {
      Remove-Item-Safe $_.FullName "prompts/$($_.Name)"
    }
  }

  $instr = Join-Path $dest 'copilot-instructions.md'
  if (Test-Path $instr) {
    if (Confirm-Action "Remover .github/copilot-instructions.md? (pode ter sido editado)") {
      Remove-Item-Safe $instr ".github/copilot-instructions.md"
    }
  }
}

function Uninstall-Antigravity {
  param([string]$ScopeChoice)
  $targets = @()
  if ($ScopeChoice -in @('project','both')) {
    $targets += @{ Dir = (Join-Path $ProjectDir '.gemini/antigravity'); Scope = 'project' }
  }
  if ($ScopeChoice -in @('user','both')) {
    $targets += @{ Dir = (Join-Path $UserHome '.gemini/antigravity'); Scope = 'user' }
  }

  foreach ($t in $targets) {
    if (-not (Test-Path $t.Dir)) { continue }
    Write-Host ""
    Write-Host "Antigravity ($($t.Scope) scope) em: $($t.Dir)" -ForegroundColor Cyan

    $skillsDir = Join-Path $t.Dir 'skills'
    if (Test-Path $skillsDir) {
      # Remove skills jdi-* (1 dir cada)
      Get-ChildItem $skillsDir -Directory -Filter 'jdi-*' -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item-Safe $_.FullName "skills/$($_.Name)/"
      }
      # Remove skills universais
      foreach ($skillName in @('frontend-rules','frontend-validator','dry','kiss','yagni','solid','clean-code')) {
        $sd = Join-Path $skillsDir $skillName
        Remove-Item-Safe $sd "skills/$skillName/"
      }
    }

    if ($t.Scope -eq 'project') {
      $agm = Join-Path $ProjectDir 'agents.md'
      if (Test-Path $agm) {
        if (Confirm-Action "Remover agents.md (Antigravity)? (pode ter sido editado)") {
          Remove-Item-Safe $agm "agents.md"
        }
      }
    }
  }
}

function Uninstall-Opencode {
  param([string]$ScopeChoice)
  $targets = @()
  if ($ScopeChoice -in @('project','both')) {
    $targets += @{ Dir = (Join-Path $ProjectDir '.opencode'); Scope = 'project' }
  }
  if ($ScopeChoice -in @('user','both')) {
    $targets += @{ Dir = (Join-Path $UserHome '.config/opencode'); Scope = 'user' }
  }

  foreach ($t in $targets) {
    if (-not (Test-Path $t.Dir)) { continue }
    Write-Host ""
    Write-Host "OpenCode ($($t.Scope) scope) em: $($t.Dir)" -ForegroundColor Cyan

    $agentsDir = Join-Path $t.Dir 'agents'
    if (Test-Path $agentsDir) {
      Get-ChildItem $agentsDir -Filter 'jdi-*.md' -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item-Safe $_.FullName "agents/$($_.Name)"
      }
    }

    $cmdDir = Join-Path $t.Dir 'commands'
    if (Test-Path $cmdDir) {
      Get-ChildItem $cmdDir -Filter 'jdi-*.md' -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item-Safe $_.FullName "commands/$($_.Name)"
      }
    }

    $skillsDir = Join-Path $t.Dir 'skills'
    if (Test-Path $skillsDir) {
      foreach ($skillName in @('frontend-rules','frontend-validator','dry','kiss','yagni','solid','clean-code')) {
        $sd = Join-Path $skillsDir $skillName
        Remove-Item-Safe $sd "skills/$skillName/"
      }
    }

    if ($t.Scope -eq 'project') {
      $agm = Join-Path $ProjectDir 'AGENTS.md'
      if (Test-Path $agm) {
        if (Confirm-Action "Remover AGENTS.md (OpenCode)? (pode ter sido editado)") {
          Remove-Item-Safe $agm "AGENTS.md"
        }
      }
      $jsonc = Join-Path $t.Dir 'opencode.jsonc'
      if (Test-Path $jsonc) {
        if (Confirm-Action "Remover .opencode/opencode.jsonc? (pode ter config customizada)") {
          Remove-Item-Safe $jsonc ".opencode/opencode.jsonc"
        }
      }
    }
  }
}

# =========================================================
# Main
# =========================================================

Write-Host ""
Write-Host "JDI Uninstall" -ForegroundColor Cyan
Write-Host "  Dir:     $ProjectDir"
Write-Host "  Runtime: $Runtime"
Write-Host "  Scope:   $Scope"
if ($Purge) { Write-Host "  Purge:   YES (vai remover .jdi/ tambem)" -ForegroundColor Yellow }
if ($DryRun) { Write-Host "  Mode:    DRY-RUN (sem mudancas)" -ForegroundColor Yellow }
Write-Host ""

if (-not $Yes -and -not $DryRun) {
  if (-not (Confirm-Action "Continuar com uninstall? (acao destrutiva)")) {
    Write-Host "Cancelado."
    exit 0
  }
}

$runtimes = if ($Runtime -eq 'all') { @('claude','copilot','antigravity','opencode') } else { @($Runtime) }

foreach ($r in $runtimes) {
  switch ($r) {
    'claude'      { Uninstall-Claude -ScopeChoice $Scope }
    'copilot'     { Uninstall-Copilot }
    'antigravity' { Uninstall-Antigravity -ScopeChoice $Scope }
    'opencode'    { Uninstall-Opencode -ScopeChoice $Scope }
  }
}

# Purge .jdi/ (state) - so com flag explicito
if ($Purge) {
  Write-Host ""
  $jdiDir = Join-Path $ProjectDir '.jdi'
  if (Test-Path $jdiDir) {
    Write-Host "PURGE: removendo .jdi/ (state files - DECISIONS, ROADMAP, phases, etc)" -ForegroundColor Red
    if (Confirm-Action "TEM CERTEZA? Isso apaga decisoes locked permanentemente") {
      Remove-Item-Safe $jdiDir ".jdi/"
    } else {
      Write-Host "  .jdi/ preservado." -ForegroundColor DarkGray
    }
  }

  # Hooks tambem (default ship)
  $hooksDir = Join-Path $ProjectDir '.githooks'
  if (Test-Path $hooksDir) {
    if (Confirm-Action "Remover .githooks/?") {
      Remove-Item-Safe $hooksDir ".githooks/"
    }
  }
}

Write-Host ""
Write-Host "Uninstall completo." -ForegroundColor Green
if ($DryRun) {
  Write-Host "(dry-run - nada foi mudado)" -ForegroundColor Yellow
}
if (-not $Purge) {
  Write-Host ""
  Write-Host "Nota: .jdi/ preservado (state files). Use --purge pra remover tambem." -ForegroundColor DarkGray
}
