<#
.SYNOPSIS
  jdi-update (Windows): atualiza JDI em projeto que ja tem JDI instalado.

.DESCRIPTION
  Diferente do install, o update:
  - Detecta automaticamente quais runtimes estao instalados no projeto
  - Sobrescreve runtime files (agents, commands, skills) - shipped pelo JDI
  - NUNCA toca state files (PROJECT.md, DECISIONS.md, ROADMAP.md, STATE.md, phases/, registry.md)
  - Atualiza os blocos gerenciados (jdi:managed) dos specialists em .jdi/agents/ e aponta `specialists upgrade --adopt` para os gerados antes da 0.17
  - Atualiza .jdi/VERSION com versao nova

.PARAMETER ForceSpecialists
  Indica /jdi-bootstrap (Recriar) para specialists gerados antes da 0.17.

.PARAMETER SkipSpecialists
  Nao mexe em specialists (nem nos blocos gerenciados jdi:managed).

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

# Idioma: $env:JDI_LANG so chega setado quando o usuario passou -Lang em
# `jdi update` (ver bin/jdi.js). Sem override explicito, cai no idioma
# persistido em .jdi/LANG (escrito pelo install). Sem esse arquivo
# (projeto pre-i18n, ou greenfield onde o install rodou antes de .jdi/
# existir), infere pelo marker da diretiva nos arquivos instalados --
# senao o update reverteria pt-BR pra 'en' silenciosamente ao re-copiar.
# Fica no ambiente do processo, entao jdi-install.ps1 (subprocesso
# abaixo) herda sem precisar de -Lang proprio.
$LangFile = Join-Path $ProjectDir '.jdi/LANG'
$ExplicitLang = if ($env:JDI_LANG) { $env:JDI_LANG } else { '' }
$CurrentLang = 'en'
if (Test-Path $LangFile) {
  $CurrentLang = (Get-Content $LangFile -Raw).Trim()
} else {
  $probeDirs = @('.claude\commands', '.github\prompts', '.opencode\commands', '.agents\skills\jdi-new', '.junie\skills\jdi-new')
  foreach ($pd in $probeDirs) {
    $full = Join-Path $ProjectDir $pd
    if (-not (Test-Path $full)) { continue }
    $hit = Get-ChildItem -Path $full -Recurse -Filter '*.md' -File -ErrorAction SilentlyContinue |
      Select-String -SimpleMatch '<!-- jdi:lang-directive -->' -Quiet |
      Select-Object -First 1
    if ($hit) { $CurrentLang = 'pt-BR'; break }
  }
}
$env:JDI_LANG = if ($ExplicitLang) { $ExplicitLang } else { $CurrentLang }

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
  # Troca de idioma explicita na mesma versao NAO e no-op: precisa
  # re-copiar os runtime files pra injetar/remover a diretiva.
  if ($ExplicitLang -and ($ExplicitLang -ne $CurrentLang)) {
    Write-Output "Mesma versao ($NewVersion), mas -Lang mudou ($CurrentLang -> $ExplicitLang) - reaplicando runtime files."
    Write-Output ""
  } else {
    Write-Output "Ja na versao mais recente ($NewVersion). Use --force pra reinstalar mesmo assim."
    exit 0
  }
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

  # Desde a 0.17 as partes do JDI nos specialists (entradas, regras de
  # trabalho, retorno curto) sao BLOCOS GERENCIADOS
  # (<!-- jdi:managed id=... -->): o update troca so esses blocos e mantem
  # byte a byte tudo o que o projeto escreveu fora deles. Specialists sem
  # blocos (gerados antes da 0.17) precisam de `specialists upgrade --adopt`
  # uma vez — mostra a diferenca antes de gravar.
  $jdiJs = [System.IO.Path]::Combine($Root, 'bin', 'jdi.js')
  if ($SkipSpecialists) {
    Write-Output "  Specialists mantidos como estao (-SkipSpecialists)."
  } else {
    Push-Location $ProjectDir
    try {
      if ($DryRun) {
        & node $jdiJs specialists upgrade
      } else {
        & node $jdiJs specialists upgrade --write
        & ([System.IO.Path]::Combine($Root, 'bin', 'lib', 'jdi-sync-specialists.ps1')) -Runtime all -Quiet
      }
    } finally {
      Pop-Location
    }
  }
  $legacy = $false
  foreach ($s in $specialists) {
    if ((Get-Content $s.FullName -Raw) -notmatch '<!-- jdi:managed id=') { $legacy = $true; break }
  }
  if ($legacy) {
    Write-Output ""
    Write-Output "Specialists gerados antes da 0.17 (sem blocos gerenciados): as entradas"
    Write-Output "(brief), o retorno curto e as regras novas so chegam a eles com:"
    Write-Output "  npx -y jdi-cli@$NewVersion specialists upgrade --adopt          # mostra a diferenca"
    Write-Output "  npx -y jdi-cli@$NewVersion specialists upgrade --adopt --write  # grava"
    Write-Output "  npx -y jdi-cli@$NewVersion sync-specialists"
    Write-Output "Tudo fora dos blocos e preservado. Alternativa: /jdi-bootstrap (Recriar)."
    if ($ForceSpecialists) {
      Write-Output ""
      Write-Output "ACAO MANUAL NECESSARIA (-ForceSpecialists):"
      Write-Output "  Abra teu runtime e rode:  /jdi-bootstrap"
      Write-Output "  Architect vai detectar specialists existentes e oferecer 'Recriar'."
    }
  }
  Write-Output "  Auditoria: npx -y jdi-cli@$NewVersion specialists lint"
}

# =========================================================
# Atualiza .jdi/VERSION
# =========================================================

if (-not $DryRun) {
  # WriteAllText + UTF8 sem BOM: Set-Content -Encoding UTF8 no PS 5.1 grava
  # BOM, e o bash (update.sh de outro dev) leria "\xEF\xBB\xBFpt-BR" != "pt-BR".
  $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($VersionFile, [string]$NewVersion, $Utf8NoBom)
  [System.IO.File]::WriteAllText($LangFile, [string]$env:JDI_LANG, $Utf8NoBom)
}

Write-Output ""
Write-Output "JDI atualizado: $OldVersion -> $NewVersion"
if ($DryRun) {
  Write-Output "(dry-run - nada foi mudado)"
}
Write-Output ""
Write-Output "Changelog: https://github.com/slipalison/jdi-cli/releases"
