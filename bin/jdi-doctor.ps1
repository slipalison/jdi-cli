<#
.SYNOPSIS
  jdi-doctor (Windows): diagnostica ambiente JDI.

.DESCRIPTION
  Equivalente PowerShell de bin/jdi-doctor.sh.
  Saida com OK / WARN / FAIL por check.
  Exit 0 se tudo OK ou so WARN. Exit 1 se algum FAIL.

.PARAMETER Verbose
  Mostra notas extras de debug.

.EXAMPLE
  .\bin\jdi-doctor.ps1
  .\bin\jdi-doctor.ps1 -Verbose
#>
[CmdletBinding()]
param()

$JdiRoot    = Split-Path -Parent $PSScriptRoot
$ProjectDir = (Get-Location).Path
$UserHome   = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }

function Write-OK    { param($m) Write-Output "  OK    $m" }
function Write-WARN  { param($m) Write-Output "  WARN  $m" ; $script:Warns++ }
function Write-FAIL  { param($m) Write-Output "  FAIL  $m" ; $script:Fails++ }
function Write-Note  { param($m) if ($VerbosePreference -eq 'Continue') { Write-Output "  note  $m" } }
function Write-Section { param($t) Write-Output ""; Write-Output $t }

$script:Fails = 0
$script:Warns = 0

function Test-Cmd {
  param([string]$Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------------------
Write-Section '1. Dependencias'

# PowerShell nao precisa de awk/sed/find - scripts .ps1 substituem
foreach ($cmd in @('git')) {
  if (Test-Cmd $cmd) {
    $path = (Get-Command $cmd).Source
    Write-OK "$cmd disponivel ($path)"
  } else {
    Write-FAIL "$cmd ausente. Instale: https://git-scm.com/download/win"
  }
}

# Git for Windows traz bash + awk + sed (necessarios pros .sh e pros git hooks)
$gitBash = (Get-Command bash -ErrorAction SilentlyContinue)
if ($gitBash) {
  Write-OK "bash disponivel ($($gitBash.Source)) - hooks .sh e scripts originais funcionam"
} else {
  Write-WARN "bash ausente. Scripts .sh e git hooks nao funcionam. Instale Git for Windows ou WSL."
}

# ---------------------------------------------------------------------------
Write-Section '2. Runtimes'

$ClaudeOK = $false
if (Test-Cmd 'claude') {
  Write-OK "claude CLI: $((Get-Command claude).Source)"
  $ClaudeOK = $true
} elseif (Test-Path "$UserHome\.claude") {
  Write-WARN "~/.claude/ existe mas claude CLI nao esta no PATH"
  $ClaudeOK = $true
} else {
  Write-WARN "Claude Code nao detectado (sem CLI nem ~/.claude/)"
}

$CopilotOK = $false
if (Test-Cmd 'code') {
  $exts = & code --list-extensions 2>$null
  if ($exts -match 'github.copilot') {
    Write-OK 'VS Code + extensao Copilot detectados'
    $CopilotOK = $true
  } else {
    Write-WARN 'VS Code presente mas extensao Copilot nao instalada'
  }
} elseif (Test-Cmd 'gh') {
  $ghExts = & gh extension list 2>$null
  if ($ghExts -match 'copilot') {
    Write-OK 'gh CLI com extensao copilot'
    $CopilotOK = $true
  } else {
    Write-WARN 'Copilot nao detectado (sem VS Code ou sem extensao)'
  }
} else {
  Write-WARN 'Copilot nao detectado (sem VS Code nem gh)'
}

$AntigravityOK = $false
if (Test-Cmd 'antigravity') {
  Write-OK "antigravity CLI: $((Get-Command antigravity).Source)"
  $AntigravityOK = $true
} elseif (Test-Path "$UserHome\.gemini\antigravity") {
  Write-OK '~/.gemini/antigravity/ existe'
  $AntigravityOK = $true
} else {
  Write-WARN 'Antigravity nao detectado'
}

$OpencodeOK = $false
if (Test-Cmd 'opencode') {
  Write-OK "opencode CLI: $((Get-Command opencode).Source)"
  $OpencodeOK = $true
} elseif (Test-Path "$UserHome\.config\opencode") {
  Write-OK '~/.config/opencode/ existe'
  $OpencodeOK = $true
} else {
  Write-WARN 'OpenCode nao detectado (sem CLI nem ~/.config/opencode/)'
}

if (-not ($ClaudeOK -or $CopilotOK -or $AntigravityOK -or $OpencodeOK)) {
  Write-FAIL 'Nenhum runtime detectado. JDI nao serve pra nada sem runtime.'
}

# ---------------------------------------------------------------------------
Write-Section '3. Tooling opcional'

if (Test-Cmd 'ctx7') {
  Write-OK "ctx7 disponivel ($((Get-Command ctx7).Source))"
} elseif (Test-Cmd 'npx') {
  Write-WARN 'ctx7 ausente. Recomendado pra docs de libs. Instale: npm i -g ctx7'
} else {
  Write-WARN 'ctx7 e npx ausentes. Researcher fica limitado a WebSearch.'
}

if (Test-Cmd 'gh') {
  Write-OK 'gh CLI disponivel (necessario pra /jdi-ship abrir PR)'
} else {
  Write-WARN 'gh CLI ausente. /jdi-ship nao consegue criar PR. Install: cli.github.com'
}

# ---------------------------------------------------------------------------
Write-Section '4. Repo JDI (source of truth)'

if ((Test-Path "$JdiRoot\core\agents") -and (Test-Path "$JdiRoot\core\commands")) {
  $agentsCount = (Get-ChildItem -Path "$JdiRoot\core\agents" -Filter '*.md' -File -ErrorAction SilentlyContinue).Count
  $cmdsCount   = (Get-ChildItem -Path "$JdiRoot\core\commands" -Filter '*.md' -File -ErrorAction SilentlyContinue).Count
  Write-OK "core/ encontrado ($agentsCount agents, $cmdsCount commands)"
  if ($agentsCount -lt 1) {
    Write-FAIL 'core/agents/ vazio. Repo do JDI nao esta integro.'
  }
} else {
  Write-FAIL "core/ ausente em $JdiRoot. Esse script roda do repo do JDI?"
}

foreach ($s in @('jdi-build.ps1','jdi-install.ps1')) {
  if (Test-Path "$JdiRoot\bin\$s") {
    Write-OK "$s presente"
  } else {
    Write-WARN "$s ausente em bin/. Repo incompleto?"
  }
}

# ---------------------------------------------------------------------------
Write-Section '5. Adapters buildados (runtimes/)'

$runtimeChecks = @{
  'claude'      = @{ Path = "$JdiRoot\runtimes\claude\agents";          Filter = '*.md' }
  'copilot'     = @{ Path = "$JdiRoot\runtimes\copilot\agents";         Filter = '*.agent.md' }
  'antigravity' = @{ Path = "$JdiRoot\runtimes\antigravity\skills";     Filter = 'SKILL.md' }
  'opencode'    = @{ Path = "$JdiRoot\runtimes\opencode\agents";        Filter = '*.md' }
}

foreach ($rt in $runtimeChecks.Keys) {
  $info = $runtimeChecks[$rt]
  if (Test-Path $info.Path) {
    $count = (Get-ChildItem -Path $info.Path -Filter $info.Filter -Recurse -File -ErrorAction SilentlyContinue).Count
    if ($count -gt 0) {
      Write-OK "runtimes/$rt buildado ($count agents/skills)"
    } else {
      Write-WARN "runtimes/$rt vazio. Rode: .\bin\jdi-build.ps1"
    }
  } else {
    Write-WARN "runtimes/$rt ausente. Rode: .\bin\jdi-build.ps1"
  }
}

# ---------------------------------------------------------------------------
Write-Section "6. Projeto atual ($ProjectDir)"

if ($ProjectDir -eq $JdiRoot) {
  Write-Note 'Voce esta no proprio repo do JDI. Rode jdi-doctor de dentro do seu projeto pra checar install.'
}

if (Test-Path "$ProjectDir\.jdi") {
  Write-OK 'projeto eh JDI (.jdi/ existe)'
  foreach ($f in @('PROJECT.md','ROADMAP.md','STATE.md')) {
    if (Test-Path "$ProjectDir\.jdi\$f") {
      Write-OK ".jdi/$f presente"
    } else {
      Write-WARN ".jdi/$f ausente. /jdi-new nao completou ou foi removido."
    }
  }
  foreach ($f in @('DECISIONS.md','specialists.md','reviewers.md','registry.md','todos.md')) {
    if (Test-Path "$ProjectDir\.jdi\$f") { Write-OK ".jdi/$f presente" } else { Write-Note ".jdi/$f ausente (criado on-demand)" }
  }
  if (Test-Path "$ProjectDir\.jdi\agents") {
    $specCount = (Get-ChildItem -Path "$ProjectDir\.jdi\agents" -Filter "jdi-doer-*.md" -File -ErrorAction SilentlyContinue).Count + (Get-ChildItem -Path "$ProjectDir\.jdi\agents" -Filter "jdi-reviewer-*.md" -File -ErrorAction SilentlyContinue).Count
    if ($specCount -gt 0) {
      Write-OK ".jdi/agents/ com $specCount specialist(s) per-project"
    } else {
      Write-Note '.jdi/agents/ vazio (rode /jdi-bootstrap pra criar specialists)'
    }
  }
  if (Test-Path "$ProjectDir\.jdi\phases") {
    $phaseCount = (Get-ChildItem -Path "$ProjectDir\.jdi\phases" -Directory -ErrorAction SilentlyContinue).Count
    Write-OK ".jdi/phases/ com $phaseCount phase(s)"
  }

  $cfgPath = Join-Path $ProjectDir '.jdi\config.json'
  if (Test-Path $cfgPath) {
    try {
      $cfg  = Get-Content $cfgPath -Raw | ConvertFrom-Json
      $mode = if ($cfg.orchestration -and $cfg.orchestration.mode) { $cfg.orchestration.mode } else { 'standard' }
      if ($mode -eq 'enhanced') {
        Write-OK ".jdi/config.json orchestration: enhanced (advisory multi-agent layers opt-in; degrade when host cannot fan out)"
      } else {
        Write-Note ".jdi/config.json orchestration: standard (single-agent path)"
      }
    } catch {
      Write-WARN ".jdi/config.json present but not valid JSON"
    }
  }
} else {
  Write-WARN '.jdi/ ausente. Rode /jdi-new ou esta fora de um projeto JDI.'
}

# ---------------------------------------------------------------------------
Write-Section '7. Runtime instalado no projeto'

$InstallFound = $false
function Check-Install {
  param([string]$Path, [string]$Filter, [string]$Label)
  if (Test-Path $Path) {
    $count = (Get-ChildItem -Path $Path -Filter $Filter -File -Recurse -ErrorAction SilentlyContinue).Count
    if ($count -gt 0) {
      Write-OK "$Label com $count agents JDI"
      $script:InstallFound = $true
    }
  }
}

Check-Install -Path "$ProjectDir\.claude\agents" -Filter 'jdi-*.md' -Label '.claude/agents/'
Check-Install -Path "$ProjectDir\.github\agents" -Filter 'jdi-*.agent.md' -Label '.github/agents/'
Check-Install -Path "$ProjectDir\.gemini\antigravity\skills" -Filter 'SKILL.md' -Label '.gemini/antigravity/skills/'
Check-Install -Path "$ProjectDir\.opencode\agents" -Filter 'jdi-*.md' -Label '.opencode/agents/'
Check-Install -Path "$UserHome\.claude\agents" -Filter 'jdi-*.md' -Label '~/.claude/agents/ (scope user)'
Check-Install -Path "$UserHome\.config\opencode\agents" -Filter 'jdi-*.md' -Label '~/.config/opencode/agents/ (scope user)'

if (-not $script:InstallFound -and (Test-Path "$ProjectDir\.jdi")) {
  Write-FAIL "Projeto eh JDI mas nenhum runtime instalado. Rode: $JdiRoot\bin\jdi-install.ps1 -Runtime <runtime>"
}

# ---------------------------------------------------------------------------
Write-Section '8. Git hooks'

if (Test-Path "$ProjectDir\.githooks\pre-commit") {
  Write-OK '.githooks/pre-commit existe'
  if (-not $gitBash) {
    Write-WARN 'Hook eh bash mas Git for Windows ausente. Hook nao executara em commits.'
  }

  $hooksPath = & git -C "$ProjectDir" config core.hooksPath 2>$null
  if ($hooksPath -in @('.githooks',"$ProjectDir\.githooks","$ProjectDir/.githooks")) {
    Write-OK 'git core.hooksPath aponta pra .githooks'
  } else {
    Write-WARN 'git core.hooksPath nao configurado. Rode: git config core.hooksPath .githooks'
  }
} elseif (Test-Path "$ProjectDir\.jdi") {
  Write-WARN '.githooks/ ausente em projeto JDI. Rode jdi-install.ps1 pra instalar.'
}

# ---------------------------------------------------------------------------
Write-Section '9. Repo git limpo (recomendado pra /jdi-create)'

$gitDir = & git -C "$ProjectDir" rev-parse --git-dir 2>$null
if ($LASTEXITCODE -eq 0) {
  & git -C "$ProjectDir" diff-index --quiet HEAD -- 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-OK 'working tree limpo'
  } else {
    Write-Note 'working tree com mudancas (ok pra /jdi-do, mas commit antes de /jdi-create)'
  }
} else {
  Write-WARN 'Diretorio nao eh repo git. /jdi-new e atomic commits nao funcionam sem git.'
}

# ---------------------------------------------------------------------------
Write-Section '10. Playwright + MCP (optional)'

$pkgPath = Join-Path $ProjectDir 'package.json'
$hasPwDep = $false
if (Test-Path $pkgPath) {
  try {
    $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
    $allDeps = @{}
    if ($pkg.dependencies)    { $pkg.dependencies.PSObject.Properties    | ForEach-Object { $allDeps[$_.Name] = $_.Value } }
    if ($pkg.devDependencies) { $pkg.devDependencies.PSObject.Properties | ForEach-Object { $allDeps[$_.Name] = $_.Value } }
    if ($allDeps.ContainsKey('@playwright/test')) { $hasPwDep = $true }
  } catch { Write-Verbose "package.json parse failed: $($_.Exception.Message)" }
}

if ($hasPwDep) {
  Write-OK '@playwright/test in package.json'
} else {
  Write-Note '@playwright/test not installed (run: npx jdi-cli install-playwright)'
}

$claudeMcp = Join-Path $ProjectDir '.claude\settings.local.json'
if (Test-Path $claudeMcp) {
  if ((Get-Content $claudeMcp -Raw) -match '"playwright"\s*:') {
    Write-OK 'Claude Code MCP playwright configured'
  } else {
    Write-Note 'Claude Code settings.local.json present but no MCP playwright entry'
  }
}

$opencodeMcp = Join-Path $ProjectDir '.opencode\opencode.jsonc'
if (Test-Path $opencodeMcp) {
  if ((Get-Content $opencodeMcp -Raw) -match '"playwright"\s*:') {
    Write-OK 'OpenCode MCP playwright configured'
  } else {
    Write-Note 'OpenCode opencode.jsonc present but no MCP playwright entry'
  }
}

$copilotMcp = Join-Path $ProjectDir '.vscode\mcp.json'
if (Test-Path $copilotMcp) {
  if ((Get-Content $copilotMcp -Raw) -match '"playwright"\s*:') {
    Write-OK 'Copilot (VS Code) MCP playwright configured'
  } else {
    Write-Note '.vscode/mcp.json present but no playwright entry'
  }
}

$agUser    = Join-Path $UserHome '.gemini\settings.json'
$agProject = Join-Path $ProjectDir '.gemini\settings.json'
if ((Test-Path $agUser) -and ((Get-Content $agUser -Raw) -match '"playwright"\s*:')) {
  Write-OK 'Antigravity MCP playwright configured (user scope)'
} elseif ((Test-Path $agProject) -and ((Get-Content $agProject -Raw) -match '"playwright"\s*:')) {
  Write-OK 'Antigravity MCP playwright configured (project scope)'
}

# ---------------------------------------------------------------------------
Write-Section '11. Specialists (single vs multi-stack)'

$specPath = Join-Path $ProjectDir '.jdi\specialists.md'
$revPath  = Join-Path $ProjectDir '.jdi\reviewers.md'

if (Test-Path $specPath) {
  $doers = (Get-Content $specPath | Select-String -Pattern 'jdi-doer-[a-z0-9-]+' -AllMatches).Matches |
           ForEach-Object { $_.Value } | Sort-Object -Unique
  if ($doers.Count -eq 0) {
    Write-Note 'specialists.md exists but no doer registered'
  } elseif ($doers.Count -eq 1) {
    Write-OK "Single-stack: $($doers[0])"
  } else {
    Write-OK "Multi-stack: $($doers.Count) doer specialists"
    $doers | ForEach-Object { Write-Note "  - $_" }
  }
} else {
  Write-Note '.jdi/specialists.md missing (run /jdi-bootstrap)'
}

if (Test-Path $revPath) {
  $revs = (Get-Content $revPath | Select-String -Pattern 'jdi-reviewer-[a-z0-9-]+' -AllMatches).Matches |
          ForEach-Object { $_.Value } | Sort-Object -Unique
  if ($revs.Count -gt 1) {
    Write-Note "  Reviewer chain length: $($revs.Count) (multi-stack /jdi-verify)"
  }
}

# ---------------------------------------------------------------------------
Write-Section '12. Caveman plugin (optional)'

$cavemanUser    = Join-Path $UserHome '.claude\plugins\caveman'
$cavemanProject = Join-Path $ProjectDir '.claude\plugins\caveman'

if (Test-Path $cavemanUser) {
  Write-OK "Caveman installed (user scope: $cavemanUser)"
} elseif (Test-Path $cavemanProject) {
  Write-OK "Caveman installed (project scope: $cavemanProject)"
} else {
  Write-Note 'Caveman plugin not installed (run: npx jdi-cli install-caveman)'
}

# ---------------------------------------------------------------------------
Write-Section 'Resumo'

if ($script:Fails -gt 0) {
  Write-Output "  $($script:Fails) FAIL, $($script:Warns) WARN"
  Write-Output '  -> Resolva os FAIL antes de usar JDI.'
  exit 1
} elseif ($script:Warns -gt 0) {
  Write-Output "  $($script:Warns) WARN (JDI funciona mas com limitacoes)"
  exit 0
} else {
  Write-Output '  Tudo OK. JDI pronto pra rodar.'
  exit 0
}
