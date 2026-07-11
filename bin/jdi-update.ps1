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
  Write-Output "Esse diretorio nao tem .jdi/. Use 'npx jdi-cli install <runtime>' pra primeira instalacao."
  exit 1
}

# Le versao instalada
$VersionFile = Join-Path $ProjectDir '.jdi/VERSION'
$OldVersion = if (Test-Path $VersionFile) { (Get-Content $VersionFile -Raw).Trim() } else { 'unknown (pre-1.2.1)' }

Write-Output ""
Write-Output "JDI Update"
Write-Output "  De:   $OldVersion"
Write-Output "  Para: $NewVersion"
Write-Output "  Dir:  $ProjectDir"
if ($DryRun) { Write-Output "  Mode: DRY-RUN (sem mudancas)" }
Write-Output ""

if ($OldVersion -eq $NewVersion -and -not $DryRun) {
  Write-Output "Ja na versao mais recente ($NewVersion). Use --force pra reinstalar mesmo assim."
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
# Antigravity 2.0 paths (+ legacy 1.x for migration)
if ((Test-Path (Join-Path $ProjectDir '.agents/skills/jdi-architect')) -or (Test-Path (Join-Path $UserHome '.gemini/config/skills/jdi-architect')) -or
    (Test-Path (Join-Path $ProjectDir '.gemini/antigravity')) -or (Test-Path (Join-Path $UserHome '.gemini/antigravity/skills/jdi-architect'))) {
  $detected += 'antigravity'
}
if ((Test-Path (Join-Path $ProjectDir '.opencode')) -or (Test-Path (Join-Path $UserHome '.config/opencode/agents/jdi-architect.md'))) {
  $detected += 'opencode'
}
if ((Test-Path (Join-Path $ProjectDir '.junie/agents/jdi-architect.md')) -or (Test-Path (Join-Path $UserHome '.junie/agents/jdi-architect.md'))) {
  $detected += 'junie'
}

if ($detected.Count -eq 0) {
  Write-Output "Nenhum runtime JDI detectado. Tem .jdi/ mas nao .claude/, .github/, .gemini/, .opencode/."
  Write-Output "Use 'npx jdi-cli install <runtime>' pra instalar."
  exit 1
}

Write-Output "Runtimes detectados: $($detected -join ', ')"
Write-Output ""

# =========================================================
# Atualiza runtime files (sobrescreve)
# =========================================================

$installScript = Join-Path $Root 'bin/jdi-install.ps1'

foreach ($runtime in $detected) {
  # Detecta scope - se tem em user dir tbm, atualiza user; se so projeto, project
  $userScopeMarker = switch ($runtime) {
    'claude'      { Join-Path $UserHome '.claude/agents/jdi-architect.md' }
    'antigravity' { Join-Path $UserHome '.gemini/config/skills/jdi-architect' }
    'opencode'    { Join-Path $UserHome '.config/opencode/agents/jdi-architect.md' }
    'junie'       { Join-Path $UserHome '.junie/agents/jdi-architect.md' }
    default       { $null }
  }

  # Antigravity 1.x legado -> migracao (instala no path 2.0 + remove o velho)
  $userLegacy = if ($runtime -eq 'antigravity') { Join-Path $UserHome '.gemini/antigravity' } else { $null }
  $projLegacy = if ($runtime -eq 'antigravity') { Join-Path $ProjectDir '.gemini/antigravity' } else { $null }
  $hasUserLegacy = $userLegacy -and (Test-Path (Join-Path $userLegacy 'skills'))
  $hasProjLegacy = $projLegacy -and (Test-Path (Join-Path $projLegacy 'skills'))

  $hasUserScope = ($userScopeMarker -and (Test-Path $userScopeMarker)) -or $hasUserLegacy
  $projectMarker = switch ($runtime) {
    'claude'      { Join-Path $ProjectDir '.claude/agents/jdi-architect.md' }
    'copilot'     { Join-Path $ProjectDir '.github/agents/jdi-architect.agent.md' }
    'antigravity' { Join-Path $ProjectDir '.agents/skills/jdi-architect' }
    'opencode'    { Join-Path $ProjectDir '.opencode/agents/jdi-architect.md' }
    'junie'       { Join-Path $ProjectDir '.junie/agents/jdi-architect.md' }
  }
  $hasProjectScope = (Test-Path $projectMarker) -or $hasProjLegacy

  if ($hasProjectScope) {
    Write-Output "Atualizando $runtime (project scope)..."
    if (-not $DryRun) {
      & pwsh -NoProfile -ExecutionPolicy Bypass -File $installScript -Runtime $runtime -Scope project | Out-Null
      if ($hasProjLegacy) {
        Remove-Item -Recurse -Force $projLegacy -Confirm:$false
        Write-Output "  migrado: skills 1.x removidas de $projLegacy (2.0 usa .agents/skills/)"
      }
    } else {
      Write-Output "  [dry-run] copia runtimes/$runtime/* pra escopo project"
      if ($hasProjLegacy) { Write-Output "  [dry-run] migra 1.x: remove $projLegacy" }
    }
  }

  if ($hasUserScope) {
    Write-Output "Atualizando $runtime (user scope)..."
    if (-not $DryRun) {
      & pwsh -NoProfile -ExecutionPolicy Bypass -File $installScript -Runtime $runtime -Scope user | Out-Null
      if ($hasUserLegacy) {
        Remove-Item -Recurse -Force $userLegacy -Confirm:$false
        Write-Output "  migrado: skills 1.x removidas de $userLegacy (2.0 usa ~/.gemini/config/skills/)"
      }
    } else {
      Write-Output "  [dry-run] copia runtimes/$runtime/* pra escopo user"
      if ($hasUserLegacy) { Write-Output "  [dry-run] migra 1.x: remove $userLegacy" }
    }
  }
}

Write-Output ""

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
  Write-Output "Specialists detectados em .jdi/agents/:"
  foreach ($s in $specialists) { Write-Output "  - $($s.Name)" }
  Write-Output ""

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
    Write-Output "Specialists existentes NAO tem <skills_to_load> - foram gerados antes da 1.2.1."
    Write-Output "Pra ativar skills universais (DRY/KISS/YAGNI/SOLID/Clean Code) via eager loading,"
    Write-Output "specialists precisam ser regenerados."
    Write-Output ""

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
      Write-Output ""
      Write-Output "ACAO MANUAL NECESSARIA:"
      Write-Output "  Abra teu runtime e rode:  /jdi-bootstrap"
      Write-Output "  Architect vai detectar specialists existentes e oferecer 'Recriar'."
      Write-Output "  Os specialists novos terao <skills_to_load> com as 5 universais wired."
    } else {
      Write-Output "  Specialists mantidos como estao - skills universais ficam em modo discoverable only."
    }
  } else {
    Write-Output "Specialists ja tem <skills_to_load> - up to date."
  }
}

# =========================================================
# Atualiza .jdi/VERSION
# =========================================================

if (-not $DryRun) {
  Set-Content -Path $VersionFile -Value $NewVersion -Encoding UTF8 -NoNewline
}

Write-Output ""
Write-Output "JDI atualizado: $OldVersion -> $NewVersion"
if ($DryRun) {
  Write-Output "(dry-run - nada foi mudado)"
}
Write-Output ""
Write-Output "Changelog: https://github.com/slipalison/jdi-cli/releases"
