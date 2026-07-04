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

# Skills universais shipped pelo JDI (runtimes/<rt>/skills/). Mantenha em sync com o ship.
$UniversalSkills = @(
  'clean-architecture','clean-code','ddd','dry',
  'frontend-rules','frontend-validator',
  'hexagonal','kiss','onion','solid',
  'the-method','vertical-slice','yagni'
)

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
    Write-Output "  [dry-run] removeria: $Path"
    return
  }

  Remove-Item -Path $Path -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output "  removido: $Label"
}

# Constroi a lista de targets (Dir + Scope label) a partir do scope escolhido.
# $ProjectPath e $UserPath sao os diretorios base de cada scope.
function Resolve-ScopeTargets {
  param(
    [string]$ScopeChoice,
    [string]$ProjectPath,
    [string]$UserPath
  )
  $targets = @()
  if ($ScopeChoice -in @('project','both')) {
    $targets += @{ Dir = $ProjectPath; Scope = 'project' }
  }
  if ($ScopeChoice -in @('user','both')) {
    $targets += @{ Dir = $UserPath; Scope = 'user' }
  }
  return $targets
}

# Remove arquivos jdi-* (por filtro) dentro de um subdiretorio, se ele existir.
function Remove-PrefixedFiles {
  param(
    [string]$BaseDir,
    [string]$SubDir,
    [string]$Filter
  )
  $dir = Join-Path $BaseDir $SubDir
  if (-not (Test-Path $dir)) { return }
  Get-ChildItem $dir -Filter $Filter -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item-Safe $_.FullName "$SubDir/$($_.Name)"
  }
}

# Remove as skills universais shipped dentro de <BaseDir>/skills/, se existir.
function Remove-UniversalSkills {
  param([string]$BaseDir)
  $skillsDir = Join-Path $BaseDir 'skills'
  if (-not (Test-Path $skillsDir)) { return }
  foreach ($skillName in $UniversalSkills) {
    $sd = Join-Path $skillsDir $skillName
    Remove-Item-Safe $sd "skills/$skillName/"
  }
}

# Remove um arquivo unico apos confirmacao, se ele existir.
function Remove-FileWithConfirm {
  param(
    [string]$Path,
    [string]$Label,
    [string]$Prompt
  )
  if (-not (Test-Path $Path)) { return }
  if (Confirm-Action $Prompt) {
    Remove-Item-Safe $Path $Label
  }
}

# Executor generico: resolve targets do scope, itera, imprime o header padrao
# e roda a acao especifica do runtime ($Action) por target $t. Centraliza o
# scaffold antes repetido em cada Uninstall-*.
function Invoke-RuntimeUninstall {
  param(
    [string]$Label,
    [string]$ScopeChoice,
    [string]$ProjectPath,
    [string]$UserPath,
    [scriptblock]$Action
  )
  $targets = Resolve-ScopeTargets -ScopeChoice $ScopeChoice -ProjectPath $ProjectPath -UserPath $UserPath
  foreach ($t in $targets) {
    if (-not (Test-Path $t.Dir)) { continue }
    Write-Output ""
    Write-Output "$Label ($($t.Scope) scope) em: $($t.Dir)"
    & $Action $t
  }
}

function Uninstall-Claude {
  param([string]$ScopeChoice)
  Invoke-RuntimeUninstall -Label 'Claude' -ScopeChoice $ScopeChoice `
    -ProjectPath (Join-Path $ProjectDir '.claude') `
    -UserPath (Join-Path $UserHome '.claude') -Action {
    param($t)
    Remove-PrefixedFiles -BaseDir $t.Dir -SubDir 'agents' -Filter 'jdi-*.md'
    Remove-PrefixedFiles -BaseDir $t.Dir -SubDir 'commands' -Filter 'jdi-*.md'
    Remove-UniversalSkills -BaseDir $t.Dir
    # Orphaned update-notifier hooks from installs <= 0.1.15 (feature removed
    # in 0.1.16; only these exact JDI-owned filenames are touched)
    foreach ($h in @('jdi-check-update.js','jdi-check-update-worker.js','jdi-update-banner.js','JDI_VERSION')) {
      Remove-Item-Safe (Join-Path $t.Dir "hooks\$h") "hooks/$h"
    }
    if ($t.Scope -eq 'project') {
      Remove-FileWithConfirm -Path (Join-Path $ProjectDir 'CLAUDE.md') `
        -Label "CLAUDE.md" `
        -Prompt "Remover CLAUDE.md? (pode ter sido editado)"
    }
  }
}

function Uninstall-Copilot {
  Invoke-RuntimeUninstall -Label 'Copilot' -ScopeChoice 'project' `
    -ProjectPath (Join-Path $ProjectDir '.github') -UserPath '' -Action {
    param($t)
    Remove-PrefixedFiles -BaseDir $t.Dir -SubDir 'agents' -Filter 'jdi-*.agent.md'
    Remove-PrefixedFiles -BaseDir $t.Dir -SubDir 'prompts' -Filter 'jdi-*.prompt.md'
    Remove-FileWithConfirm -Path (Join-Path $t.Dir 'copilot-instructions.md') `
      -Label ".github/copilot-instructions.md" `
      -Prompt "Remover .github/copilot-instructions.md? (pode ter sido editado)"
  }
}

function Uninstall-Antigravity {
  param([string]$ScopeChoice)
  Invoke-RuntimeUninstall -Label 'Antigravity' -ScopeChoice $ScopeChoice `
    -ProjectPath (Join-Path $ProjectDir '.gemini/antigravity') `
    -UserPath (Join-Path $UserHome '.gemini/antigravity') -Action {
    param($t)
    $skillsDir = Join-Path $t.Dir 'skills'
    if (Test-Path $skillsDir) {
      Get-ChildItem $skillsDir -Directory -Filter 'jdi-*' -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item-Safe $_.FullName "skills/$($_.Name)/"
      }
    }
    Remove-UniversalSkills -BaseDir $t.Dir
    if ($t.Scope -eq 'project') {
      Remove-FileWithConfirm -Path (Join-Path $ProjectDir 'agents.md') `
        -Label "agents.md" `
        -Prompt "Remover agents.md (Antigravity)? (pode ter sido editado)"
    }
  }
}

function Uninstall-Opencode {
  param([string]$ScopeChoice)
  Invoke-RuntimeUninstall -Label 'OpenCode' -ScopeChoice $ScopeChoice `
    -ProjectPath (Join-Path $ProjectDir '.opencode') `
    -UserPath (Join-Path $UserHome '.config/opencode') -Action {
    param($t)
    Remove-PrefixedFiles -BaseDir $t.Dir -SubDir 'agents' -Filter 'jdi-*.md'
    Remove-PrefixedFiles -BaseDir $t.Dir -SubDir 'commands' -Filter 'jdi-*.md'
    Remove-UniversalSkills -BaseDir $t.Dir
    if ($t.Scope -eq 'project') {
      Remove-FileWithConfirm -Path (Join-Path $ProjectDir 'AGENTS.md') `
        -Label "AGENTS.md" `
        -Prompt "Remover AGENTS.md (OpenCode)? (pode ter sido editado)"
      Remove-FileWithConfirm -Path (Join-Path $t.Dir 'opencode.jsonc') `
        -Label ".opencode/opencode.jsonc" `
        -Prompt "Remover .opencode/opencode.jsonc? (pode ter config customizada)"
    }
  }
}

# =========================================================
# Main
# =========================================================

Write-Output ""
Write-Output "JDI Uninstall"
Write-Output "  Dir:     $ProjectDir"
Write-Output "  Runtime: $Runtime"
Write-Output "  Scope:   $Scope"
if ($Purge) { Write-Output "  Purge:   YES (vai remover .jdi/ tambem)" }
if ($DryRun) { Write-Output "  Mode:    DRY-RUN (sem mudancas)" }
Write-Output ""

if (-not $Yes -and -not $DryRun) {
  if (-not (Confirm-Action "Continuar com uninstall? (acao destrutiva)")) {
    Write-Output "Cancelado."
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
  Write-Output ""
  $jdiDir = Join-Path $ProjectDir '.jdi'
  if (Test-Path $jdiDir) {
    Write-Output "PURGE: removendo .jdi/ (state files - DECISIONS, ROADMAP, phases, etc)"
    if (Confirm-Action "TEM CERTEZA? Isso apaga decisoes locked permanentemente") {
      Remove-Item-Safe $jdiDir ".jdi/"
    } else {
      Write-Output "  .jdi/ preservado."
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

Write-Output ""
Write-Output "Uninstall completo."
if ($DryRun) {
  Write-Output "(dry-run - nada foi mudado)"
}
if (-not $Purge) {
  Write-Output ""
  Write-Output "Nota: .jdi/ preservado (state files). Use --purge pra remover tambem."
}
