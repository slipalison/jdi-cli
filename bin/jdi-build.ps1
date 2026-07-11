<#
.SYNOPSIS
  jdi-build (Windows): gera runtimes/{claude,copilot,antigravity,opencode} a partir de core/.

.DESCRIPTION
  Equivalente PowerShell de bin/jdi-build.sh. Funciona em Windows sem precisar de bash/awk/sed.
  Usa regex nativo PowerShell pra parser do frontmatter YAML.

.PARAMETER Target
  Runtime alvo: claude | copilot | antigravity | opencode | junie | all (default).

.EXAMPLE
  .\bin\jdi-build.ps1
  .\bin\jdi-build.ps1 -Target opencode
#>
[CmdletBinding()]
param(
  [ValidateSet('claude','copilot','antigravity','opencode','junie','all')]
  [string]$Target = 'all'
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Core = Join-Path $Root 'core'
$Out  = Join-Path $Root 'runtimes'

function Ensure-Dirs {
  $dirs = @(
    "$Out\claude\agents", "$Out\claude\commands", "$Out\claude\skills",
    "$Out\copilot\agents", "$Out\copilot\prompts",
    "$Out\antigravity\skills",
    "$Out\opencode\agents", "$Out\opencode\commands", "$Out\opencode\skills",
    "$Out\junie\agents", "$Out\junie\skills"
  )
  foreach ($d in $dirs) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
  }
}

# Le arquivo e devolve hashtable com:
#  Frontmatter = string (sem os ---)
#  Body        = string (corpo apos o frontmatter)
function Read-MdSource {
  param([string]$Path)
  $content = Get-Content -Path $Path -Raw -Encoding UTF8
  if ($content -match '^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$') {
    return @{
      Frontmatter = $Matches[1]
      Body        = $Matches[2]
    }
  }
  return @{ Frontmatter = ''; Body = $content }
}

# Escreve UTF-8 SEM BOM (consistente com bin/jdi-build.sh e pwsh 7+).
# `Set-Content -Encoding UTF8` emite BOM no Windows PowerShell 5.1 - isso gera
# churn cross-shell gigante em runtimes/ (skills com BOM, commands sem).
function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  # Normalize to LF: StringBuilder.AppendLine emits CRLF on Windows, while
  # jdi-build.sh emits LF. Committed blobs are LF (.gitattributes) - writing
  # LF here keeps both builders byte-identical in the worktree too.
  $Content = $Content.Replace("`r`n", "`n")
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

# Fecha o sub-bloco atual ($State.CurrentSub) gravando suas linhas em SubBlocks.
function Close-OverrideSubBlock {
  param([hashtable]$State)
  if ($State.CurrentSub) {
    $State.SubBlocks[$State.CurrentSub] = $State.CurrentSubLines
    $State.CurrentSub = $null
    $State.CurrentSubLines = @()
  }
}

# Processa uma linha de 4 espacos: par `key: value` (escalar) OU `key:` (abre sub-bloco).
function Add-OverrideScalarOrSubBlock {
  param([hashtable]$State, [string]$Key, [string]$Value)
  Close-OverrideSubBlock -State $State
  if ([string]::IsNullOrWhiteSpace($Value)) {
    # sub-bloco abre
    $State.CurrentSub = $Key
    $State.CurrentSubLines = @()
  } else {
    $State.Scalars[$Key] = $Value
  }
}

# Aplica uma linha pertencente ao bloco do runtime alvo ao estado acumulado.
function Update-OverrideState {
  param([hashtable]$State, [string]$Line)

  # linhas de 4 espacos: pares key: value, OU key: (sub-bloco)
  if ($Line -match '^\s{4}(\w[\w-]*):\s*(.*)$') {
    Add-OverrideScalarOrSubBlock -State $State -Key $Matches[1] -Value $Matches[2]
  }
  elseif ($Line -match '^\s{6}\S' -and $State.CurrentSub) {
    # linha do sub-bloco (6 espacos)
    $State.CurrentSubLines += ($Line -replace '^\s{4}', '')
  }
  elseif ($Line -match '^\s{4}- ' -and $State.CurrentSub) {
    $State.CurrentSubLines += ($Line -replace '^\s{4}', '')
  }
}

# Extrai sub-bloco do frontmatter sob `runtime_overrides.<runtime>:`.
# Retorna hashtable { key = value } com parsing simples de "key: value" indented.
function Get-RuntimeOverride {
  param(
    [string]$Frontmatter,
    [string]$Runtime
  )
  $state = @{
    Scalars         = [ordered]@{}
    SubBlocks       = [ordered]@{}
    CurrentSub      = $null
    CurrentSubLines = @()
  }
  $lines = $Frontmatter -split "`r?`n"
  $inOverrides = $false
  $inRuntime   = $false

  foreach ($line in $lines) {
    if ($line -match '^runtime_overrides:\s*$') { $inOverrides = $true; continue }
    if (-not $inOverrides) { continue }

    if ($line -match '^\S') { break }  # saiu do bloco runtime_overrides

    if ($line -match "^\s{2}${Runtime}:\s*$") {
      $inRuntime = $true
      continue
    }

    if ($inRuntime) {
      if ($line -match '^\s{2}\S') { break }  # outro runtime - fim do bloco
      Update-OverrideState -State $state -Line $line
    }
  }

  # commit ultimo subbloco
  Close-OverrideSubBlock -State $state

  return @{ Scalars = $state.Scalars; SubBlocks = $state.SubBlocks }
}

# Pega valor escalar do frontmatter base (ex: description, name, triggers).
function Get-BaseFrontmatterValue {
  param(
    [string]$Frontmatter,
    [string]$Key
  )
  if ($Frontmatter -match "(?m)^${Key}:\s*(.+)$") {
    return $Matches[1].Trim()
  }
  return $null
}

# Pega bloco multilinha do frontmatter base (ex: triggers: lista).
function Get-BaseFrontmatterBlock {
  param(
    [string]$Frontmatter,
    [string]$Key
  )
  $lines = $Frontmatter -split "`r?`n"
  $collecting = $false
  $captured = @()
  foreach ($line in $lines) {
    if ($collecting) {
      if ($line -match '^\S') { break }   # proxima chave top-level
      if ($line -match '^\s+\S') { $captured += $line; continue }
    }
    if ($line -match "^${Key}:\s*$") { $collecting = $true; $captured += $line; continue }
  }
  return ($captured -join "`n")
}

# Builder comum dos agents com frontmatter escalar (name/desc/model/tools).
# Claude e Copilot so diferem em runtime, destino e label.
function Build-ScalarAgent {
  param([string]$SrcPath, [string]$Runtime, [string]$Dst, [string]$Label)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($SrcPath)
  $src  = Read-MdSource -Path $SrcPath
  $desc = Get-BaseFrontmatterValue -Frontmatter $src.Frontmatter -Key 'description'
  $override = Get-RuntimeOverride -Frontmatter $src.Frontmatter -Runtime $Runtime

  $fm = New-Object System.Text.StringBuilder
  [void]$fm.AppendLine('---')
  [void]$fm.AppendLine("name: $name")
  if ($desc) { [void]$fm.AppendLine("description: $desc") }
  if ($override.Scalars['model']) { [void]$fm.AppendLine("model: $($override.Scalars['model'])") }
  if ($override.Scalars['tools']) { [void]$fm.AppendLine("tools: $($override.Scalars['tools'])") }
  [void]$fm.AppendLine('---')

  Write-Utf8NoBom -Path $Dst -Content ($fm.ToString() + $src.Body)
  Write-Output "  $Label"
}

function Build-ClaudeAgent {
  param([string]$SrcPath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($SrcPath)
  Build-ScalarAgent -SrcPath $SrcPath -Runtime 'claude' `
    -Dst (Join-Path "$Out\claude\agents" "$name.md") `
    -Label "claude/agents/$name.md"
}

function Build-CopilotAgent {
  param([string]$SrcPath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($SrcPath)
  Build-ScalarAgent -SrcPath $SrcPath -Runtime 'copilot' `
    -Dst (Join-Path "$Out\copilot\agents" "$name.agent.md") `
    -Label "copilot/agents/$name.agent.md"
}

function Build-AntigravitySkill {
  param([string]$SrcPath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($SrcPath)
  $skillDir = Join-Path "$Out\antigravity\skills" $name
  $dst = Join-Path $skillDir 'SKILL.md'
  New-Item -ItemType Directory -Force -Path "$skillDir\references" | Out-Null
  New-Item -ItemType Directory -Force -Path "$skillDir\scripts" | Out-Null

  $src = Read-MdSource -Path $SrcPath
  $desc = Get-BaseFrontmatterValue -Frontmatter $src.Frontmatter -Key 'description'
  $triggersBlock = Get-BaseFrontmatterBlock -Frontmatter $src.Frontmatter -Key 'triggers'
  $override = Get-RuntimeOverride -Frontmatter $src.Frontmatter -Runtime 'antigravity'

  $fm = New-Object System.Text.StringBuilder
  [void]$fm.AppendLine('---')
  [void]$fm.AppendLine("name: $name")
  if ($desc) { [void]$fm.AppendLine("description: $desc") }
  if ($triggersBlock) {
    [void]$fm.AppendLine($triggersBlock)
    if ($override.SubBlocks['triggers_extra']) {
      foreach ($l in $override.SubBlocks['triggers_extra']) {
        [void]$fm.AppendLine($l)
      }
    }
  }
  [void]$fm.AppendLine('---')

  $content = $fm.ToString() + $src.Body
  Write-Utf8NoBom -Path $dst -Content $content
  Write-Output "  antigravity/skills/$name/SKILL.md"
}

function Build-OpencodeAgent {
  param([string]$SrcPath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($SrcPath)
  $dst  = Join-Path "$Out\opencode\agents" "$name.md"

  $src = Read-MdSource -Path $SrcPath
  $desc = Get-BaseFrontmatterValue -Frontmatter $src.Frontmatter -Key 'description'
  $override = Get-RuntimeOverride -Frontmatter $src.Frontmatter -Runtime 'opencode'

  $fm = New-Object System.Text.StringBuilder
  [void]$fm.AppendLine('---')
  if ($desc) { [void]$fm.AppendLine("description: $desc") }
  foreach ($k in @('mode','model','temperature')) {
    if ($override.Scalars[$k]) {
      [void]$fm.AppendLine("${k}: $($override.Scalars[$k])")
    }
  }
  if ($override.SubBlocks['permission']) {
    [void]$fm.AppendLine('permission:')
    foreach ($l in $override.SubBlocks['permission']) {
      [void]$fm.AppendLine($l)
    }
  }
  [void]$fm.AppendLine('---')

  $content = $fm.ToString() + $src.Body
  Write-Utf8NoBom -Path $dst -Content $content
  Write-Output "  opencode/agents/$name.md"
}

function Build-JunieAgent {
  # Junie subagent (.junie/agents/<n>.md): name + description + tools
  # allowlist (enforced by Junie) + reasoningLevel. Tools derive from the
  # claude override filtered to Junie's supported set; Agent/WebFetch/Skill
  # drop out (Junie delegates natively and has WebSearch only). Model is
  # never emitted — Junie is LLM-agnostic and the user picks the model.
  param([string]$SrcPath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($SrcPath)
  $dst  = Join-Path "$Out\junie\agents" "$name.md"

  $src = Read-MdSource -Path $SrcPath
  $desc = Get-BaseFrontmatterValue -Frontmatter $src.Frontmatter -Key 'description'
  $override = Get-RuntimeOverride -Frontmatter $src.Frontmatter -Runtime 'claude'

  $toolsFiltered = ''
  if ($override.Scalars['tools']) {
    $allowed = @('Read','Bash','Glob','Grep','Write','Edit','WebSearch','AskUserQuestion')
    $kept = ($override.Scalars['tools'] -replace '[\[\]]', '') -split ',' |
      ForEach-Object { $_.Trim() } | Where-Object { $allowed -contains $_ }
    if ($kept) { $toolsFiltered = ($kept -join ', ') }
  }

  $level = ''
  if ($src.Frontmatter -match '(?ms)^runtime_intent:\s*$(.*?)(?=^\S|\z)') {
    if ($Matches[1] -match '(?m)^\s{2}reasoning:\s*(\S+)') {
      switch ($Matches[1]) {
        'deep'   { $level = 'high' }
        'medium' { $level = 'medium' }
        'low'    { $level = 'low' }
      }
    }
  }

  $fm = New-Object System.Text.StringBuilder
  [void]$fm.AppendLine('---')
  [void]$fm.AppendLine("name: $name")
  if ($desc) { [void]$fm.AppendLine("description: $desc") }
  if ($toolsFiltered) { [void]$fm.AppendLine("tools: [$toolsFiltered]") }
  if ($level) { [void]$fm.AppendLine("reasoningLevel: $level") }
  [void]$fm.AppendLine('---')

  Write-Utf8NoBom -Path $dst -Content ($fm.ToString() + $src.Body)
  Write-Output "  junie/agents/$name.md"
}

function Build-Command {
  param([string]$SrcPath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($SrcPath)

  Copy-Item -Path $SrcPath -Destination (Join-Path "$Out\claude\commands" "$name.md") -Force
  Copy-Item -Path $SrcPath -Destination (Join-Path "$Out\copilot\prompts" "$name.prompt.md") -Force

  $skillDir = Join-Path "$Out\antigravity\skills" $name
  New-Item -ItemType Directory -Force -Path "$skillDir\scripts" | Out-Null
  Copy-Item -Path $SrcPath -Destination (Join-Path $skillDir 'SKILL.md') -Force

  Copy-Item -Path $SrcPath -Destination (Join-Path "$Out\opencode\commands" "$name.md") -Force

  # junie: skills/<name>/SKILL.md (semantic discovery — NOT a custom command:
  # Junie template args would treat the body's $VARS as required parameters)
  $junieSkillDir = Join-Path "$Out\junie\skills" $name
  New-Item -ItemType Directory -Force -Path $junieSkillDir | Out-Null
  Copy-Item -Path $SrcPath -Destination (Join-Path $junieSkillDir 'SKILL.md') -Force

  Write-Output "  command: $name"
}

# Standalone skill em core/skills/<name>/SKILL.md (com optional references/ + scripts/).
# Diferente de Build-AntigravitySkill que converte agent em skill - aqui a skill ja eh skill.
function Build-StandaloneSkill {
  param(
    [string]$SrcDir,        # core/skills/<name>/
    [string]$Runtime,       # claude | opencode | antigravity
    [string]$DestRoot       # runtimes/<runtime>/skills/<name>/
  )

  $name = Split-Path -Leaf $SrcDir
  $srcSkill = Join-Path $SrcDir 'SKILL.md'
  if (-not (Test-Path $srcSkill)) { return }

  New-Item -ItemType Directory -Force -Path $DestRoot | Out-Null

  $src = Read-MdSource -Path $srcSkill
  $desc = Get-BaseFrontmatterValue -Frontmatter $src.Frontmatter -Key 'description'

  $fm = New-Object System.Text.StringBuilder
  [void]$fm.AppendLine('---')
  [void]$fm.AppendLine("name: $name")
  if ($desc) { [void]$fm.AppendLine("description: $desc") }

  if ($Runtime -eq 'antigravity') {
    # Antigravity descobre skills por triggers - merge de runtime_overrides.antigravity.triggers
    $override = Get-RuntimeOverride -Frontmatter $src.Frontmatter -Runtime 'antigravity'
    if ($override.SubBlocks['triggers']) {
      [void]$fm.AppendLine('triggers:')
      foreach ($l in $override.SubBlocks['triggers']) {
        [void]$fm.AppendLine($l)
      }
    }
  }

  [void]$fm.AppendLine('---')

  $content = $fm.ToString() + $src.Body
  Write-Utf8NoBom -Path (Join-Path $DestRoot 'SKILL.md') -Content $content

  # Copia subdirs opcionais (references/, scripts/)
  foreach ($subdir in @('references', 'scripts')) {
    $srcSub = Join-Path $SrcDir $subdir
    if (Test-Path $srcSub) {
      $dstSub = Join-Path $DestRoot $subdir
      if (Test-Path $dstSub) { Remove-Item -Recurse -Force $dstSub }
      Copy-Item -Path $srcSub -Destination $dstSub -Recurse -Force
    }
  }

  Write-Output "  $Runtime/skills/$name/SKILL.md"
}

# Gera os agents por runtime, respeitando $Target. Header por runtime so quando ativo.
function Build-AgentsForTargets {
  param([System.IO.FileInfo[]]$AgentFiles)

  if ($Target -in 'claude','all') {
    Write-Output "`nclaude:"
    foreach ($f in $AgentFiles) { Build-ClaudeAgent -SrcPath $f.FullName }
  }
  if ($Target -in 'copilot','all') {
    Write-Output "`ncopilot:"
    foreach ($f in $AgentFiles) { Build-CopilotAgent -SrcPath $f.FullName }
  }
  if ($Target -in 'antigravity','all') {
    Write-Output "`nantigravity:"
    foreach ($f in $AgentFiles) { Build-AntigravitySkill -SrcPath $f.FullName }
  }
  if ($Target -in 'opencode','all') {
    Write-Output "`nopencode:"
    foreach ($f in $AgentFiles) { Build-OpencodeAgent -SrcPath $f.FullName }
  }
  if ($Target -in 'junie','all') {
    Write-Output "`njunie:"
    foreach ($f in $AgentFiles) { Build-JunieAgent -SrcPath $f.FullName }
  }
}

# Gera uma standalone skill (core/skills/<name>/) para cada runtime alvo.
# Copilot nao tem conceito nativo de skill - skip.
function Build-StandaloneSkillForTargets {
  param([System.IO.DirectoryInfo]$SkillDir)

  if ($Target -in 'claude','all') {
    Build-StandaloneSkill -SrcDir $SkillDir.FullName -Runtime 'claude' -DestRoot (Join-Path "$Out\claude\skills" $SkillDir.Name)
  }
  if ($Target -in 'opencode','all') {
    Build-StandaloneSkill -SrcDir $SkillDir.FullName -Runtime 'opencode' -DestRoot (Join-Path "$Out\opencode\skills" $SkillDir.Name)
  }
  if ($Target -in 'antigravity','all') {
    Build-StandaloneSkill -SrcDir $SkillDir.FullName -Runtime 'antigravity' -DestRoot (Join-Path "$Out\antigravity\skills" $SkillDir.Name)
  }
  if ($Target -in 'junie','all') {
    Build-StandaloneSkill -SrcDir $SkillDir.FullName -Runtime 'junie' -DestRoot (Join-Path "$Out\junie\skills" $SkillDir.Name)
  }
}

# Descobre e gera todas as standalone skills em core/skills/<name>/SKILL.md.
function Build-StandaloneSkills {
  $skillDirs = @()
  if (Test-Path "$Core\skills") {
    $skillDirs = Get-ChildItem -Path "$Core\skills" -Directory -ErrorAction SilentlyContinue | Sort-Object Name
  }

  if ($skillDirs.Count -gt 0) {
    Write-Output "`nskills (standalone):"
    foreach ($d in $skillDirs) {
      Build-StandaloneSkillForTargets -SkillDir $d
    }
  }
}

function Main {
  Ensure-Dirs
  Write-Output "JDI build (PowerShell) - gerando runtimes a partir de core/"

  $agentFiles = Get-ChildItem -Path "$Core\agents" -Filter '*.md' -File | Sort-Object Name
  Build-AgentsForTargets -AgentFiles $agentFiles

  Write-Output "`ncommands (todos os runtimes):"
  $cmdFiles = Get-ChildItem -Path "$Core\commands" -Filter '*.md' -File | Sort-Object Name
  foreach ($f in $cmdFiles) { Build-Command -SrcPath $f.FullName }

  Build-StandaloneSkills

  Write-Output "`nBuild completo. Veja runtimes/$Target/"
}

Main
