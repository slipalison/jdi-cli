<#
.SYNOPSIS
  jdi-update (Windows): atualiza JDI em projeto que ja tem JDI instalado.

.DESCRIPTION
  Diferente do install, o update:
  - Detecta automaticamente quais runtimes estao instalados no projeto
  - Sobrescreve runtime files (agents, commands, skills) - shipped pelo JDI
  - NUNCA toca state files (PROJECT.md, DECISIONS.md, ROADMAP.md, STATE.md, phases/, registry.md)
  - Detecta specialists em .jdi/agents/ e pergunta se regenera (template pode ter mudado)
  - Atualiza .jdi/VERSION com versao nova

.PARAMETER ForceSpecialists
  Regenera specialists sem perguntar (assume Yes pra regen).

.PARAMETER SkipSpecialists
  Nao mexe em specialists mesmo se template mudou.

.PARAMETER DryRun
  Mostra o que seria atualizado, sem aplicar mudanca.

.EXAMPLE
  .\bin\jdi-update.ps1
  .\bin\jdi-update.ps1 -DryRun
  .\bin\jdi-update.ps1 -ForceSpecialists
#>
[CmdletBinding()]
param(
  [switch]$ForceSpecialists,
  [switch]$SkipSpecialists,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$ProjectDir = (Get-Location).Path
$UserHome = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }

# Le versao nova do package.json shipado
$pkgJson = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
$NewVersion = $pkgJson.version

# Pre-flight
if (-not (Test-Path (Join-Path $ProjectDir '.jdi'))) {
  Write-Host "Esse diretorio nao tem .jdi/. Use 'npx jdi-cli install <runtime>' pra primeira instalacao." -ForegroundColor Yellow
  exit 1
}

# Le versao instalada
$VersionFile = Join-Path $ProjectDir '.jdi/VERSION'
$OldVersion = if (Test-Path $VersionFile) { (Get-Content $VersionFile -Raw).Trim() } else { 'unknown (pre-1.2.1)' }

Write-Host ""
Write-Host "JDI Update" -ForegroundColor Cyan
Write-Host "  De:   $OldVersion"
Write-Host "  Para: $NewVersion"
Write-Host "  Dir:  $ProjectDir"
if ($DryRun) { Write-Host "  Mode: DRY-RUN (sem mudancas)" -ForegroundColor Yellow }
Write-Host ""

if ($OldVersion -eq $NewVersion -and -not $DryRun) {
  Write-Host "Ja na versao mais recente ($NewVersion). Use --force pra reinstalar mesmo assim." -ForegroundColor Green
  exit 0
}

# =========================================================
# Detecta runtimes instalados
# =========================================================

$detected = @()

if ((Test-Path (Join-Path $ProjectDir '.claude')) -or (Test-Path (Join-Path $UserHome '.claude/agents/jdi-architect.md'))) {
  $detected += 'claude'
}
if (Test-Path (Join-Path $ProjectDir '.github/agents')) {
  # Verifica se tem agents JDI especificamente
  if (Get-ChildItem (Join-Path $ProjectDir '.github/agents') -Filter 'jdi-*.agent.md' -ErrorAction SilentlyContinue | Select-Object -First 1) {
    $detected += 'copilot'
  }
}
if ((Test-Path (Join-Path $ProjectDir '.gemini/antigravity')) -or (Test-Path (Join-Path $UserHome '.gemini/antigravity/skills/jdi-architect'))) {
  $detected += 'antigravity'
}
if ((Test-Path (Join-Path $ProjectDir '.opencode')) -or (Test-Path (Join-Path $UserHome '.config/opencode/agents/jdi-architect.md'))) {
  $detected += 'opencode'
}

if ($detected.Count -eq 0) {
  Write-Host "Nenhum runtime JDI detectado. Tem .jdi/ mas nao .claude/, .github/, .gemini/, .opencode/." -ForegroundColor Yellow
  Write-Host "Use 'npx jdi-cli install <runtime>' pra instalar." -ForegroundColor Yellow
  exit 1
}

Write-Host "Runtimes detectados: $($detected -join ', ')" -ForegroundColor Cyan
Write-Host ""

# =========================================================
# Atualiza runtime files (sobrescreve)
# =========================================================

$installScript = Join-Path $Root 'bin/jdi-install.ps1'

foreach ($runtime in $detected) {
  # Detecta scope - se tem em user dir tbm, atualiza user; se so projeto, project
  $userScopeMarker = switch ($runtime) {
    'claude'      { Join-Path $UserHome '.claude/agents/jdi-architect.md' }
    'antigravity' { Join-Path $UserHome '.gemini/antigravity/skills/jdi-architect' }
    'opencode'    { Join-Path $UserHome '.config/opencode/agents/jdi-architect.md' }
    default       { $null }
  }

  $hasUserScope = $userScopeMarker -and (Test-Path $userScopeMarker)
  $projectMarker = switch ($runtime) {
    'claude'      { Join-Path $ProjectDir '.claude/agents/jdi-architect.md' }
    'copilot'     { Join-Path $ProjectDir '.github/agents/jdi-architect.agent.md' }
    'antigravity' { Join-Path $ProjectDir '.gemini/antigravity/skills/jdi-architect' }
    'opencode'    { Join-Path $ProjectDir '.opencode/agents/jdi-architect.md' }
  }
  $hasProjectScope = Test-Path $projectMarker

  if ($hasProjectScope) {
    Write-Host "Atualizando $runtime (project scope)..." -ForegroundColor Cyan
    if (-not $DryRun) {
      & pwsh -NoProfile -ExecutionPolicy Bypass -File $installScript -Runtime $runtime -Scope project | Out-Null
    } else {
      Write-Host "  [dry-run] copia runtimes/$runtime/* pra escopo project"
    }
  }

  if ($hasUserScope) {
    Write-Host "Atualizando $runtime (user scope)..." -ForegroundColor Cyan
    if (-not $DryRun) {
      & pwsh -NoProfile -ExecutionPolicy Bypass -File $installScript -Runtime $runtime -Scope user | Out-Null
    } else {
      Write-Host "  [dry-run] copia runtimes/$runtime/* pra escopo user"
    }
  }
}

Write-Host ""

# =========================================================
# Detecta specialists e pergunta sobre regen
# =========================================================

$specialistDir = Join-Path $ProjectDir '.jdi/agents'
$specialists = @()

if (Test-Path $specialistDir) {
  $doers = Get-ChildItem $specialistDir -Filter 'jdi-doer-*.md' -ErrorAction SilentlyContinue
  $reviewers = Get-ChildItem $specialistDir -Filter 'jdi-reviewer-*.md' -ErrorAction SilentlyContinue
  $specialists = @($doers) + @($reviewers)
}

if ($specialists.Count -gt 0) {
  Write-Host "Specialists detectados em .jdi/agents/:" -ForegroundColor Cyan
  foreach ($s in $specialists) { Write-Host "  - $($s.Name)" }
  Write-Host ""

  # Detecta se template/skills mudaram - heuristica: skills_to_load presente?
  $needsRegen = $false
  foreach ($s in $specialists) {
    $content = Get-Content $s.FullName -Raw
    if ($content -notmatch '<skills_to_load>') {
      $needsRegen = $true
      break
    }
  }

  if ($needsRegen) {
    Write-Host "Specialists existentes NAO tem <skills_to_load> - foram gerados antes da 1.2.1." -ForegroundColor Yellow
    Write-Host "Pra ativar skills universais (DRY/KISS/YAGNI/SOLID/Clean Code) via eager loading," -ForegroundColor Yellow
    Write-Host "specialists precisam ser regenerados." -ForegroundColor Yellow
    Write-Host ""

    $shouldRegen = $false
    if ($ForceSpecialists) {
      $shouldRegen = $true
    } elseif ($SkipSpecialists) {
      $shouldRegen = $false
    } else {
      $resp = Read-Host "Regenerar specialists? Vai rodar /jdi-bootstrap (Y/n)"
      $shouldRegen = ($resp -eq '' -or $resp -match '^[YySs]')
    }

    if ($shouldRegen) {
      Write-Host ""
      Write-Host "ACAO MANUAL NECESSARIA:" -ForegroundColor Yellow
      Write-Host "  Abra teu runtime e rode:  /jdi-bootstrap" -ForegroundColor Cyan
      Write-Host "  Architect vai detectar specialists existentes e oferecer 'Recriar'." -ForegroundColor Cyan
      Write-Host "  Os specialists novos terao <skills_to_load> com as 5 universais wired." -ForegroundColor Cyan
    } else {
      Write-Host "  Specialists mantidos como estao - skills universais ficam em modo discoverable only." -ForegroundColor DarkGray
    }
  } else {
    Write-Host "Specialists ja tem <skills_to_load> - up to date." -ForegroundColor Green
  }
}

# =========================================================
# Atualiza .jdi/VERSION
# =========================================================

if (-not $DryRun) {
  Set-Content -Path $VersionFile -Value $NewVersion -Encoding UTF8 -NoNewline
}

Write-Host ""
Write-Host "JDI atualizado: $OldVersion -> $NewVersion" -ForegroundColor Green
if ($DryRun) {
  Write-Host "(dry-run - nada foi mudado)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Changelog: https://github.com/slipalison/jdi-cli/releases" -ForegroundColor DarkGray
