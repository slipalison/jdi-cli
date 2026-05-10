<#
.SYNOPSIS
  jdi-build (Windows): gera runtimes/{claude,copilot,antigravity,opencode} a partir de core/.

.DESCRIPTION
  Equivalente PowerShell de bin/jdi-build.sh. Funciona em Windows sem precisar de bash/awk/sed.
  Usa regex nativo PowerShell pra parser do frontmatter YAML.

.PARAMETER Target
  Runtime alvo: claude | copilot | antigravity | opencode | all (default).

.EXAMPLE
  .\bin\jdi-build.ps1
  .\bin\jdi-build.ps1 -Target opencode
#>
[CmdletBinding()]
param(
  [ValidateSet('claude','copilot','antigravity','opencode','all')]
  [string]$Target = 'all'
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Core = Join-Path $Root 'core'
$Out  = Join-Path $Root 'runtimes'

function Ensure-Dirs {
  $dirs = @(
    "$Out\claude\agents", "$Out\claude\commands",
    "$Out\copilot\agents", "$Out\copilot\prompts",
    "$Out\antigravity\skills",
    "$Out\opencode\agents", "$Out\opencode\commands", "$Out\opencode\skills"
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

# Extrai sub-bloco do frontmatter sob `runtime_overrides.<runtime>:`.
# Retorna hashtable { key = value } com parsing simples de "key: value" indented.
function Get-RuntimeOverride {
  param(
    [string]$Frontmatter,
    [string]$Runtime
  )
  $result = [ordered]@{}
  $lines = $Frontmatter -split "`r?`n"
  $inOverrides = $false
  $inRuntime   = $false
  $runtimeIndent = -1
  $subBlocks = [ordered]@{}
  $currentSub = $null
  $currentSubLines = @()

  foreach ($line in $lines) {
    if ($line -match '^runtime_overrides:\s*$') { $inOverrides = $true; continue }
    if (-not $inOverrides) { continue }

    if ($line -match '^\S') { break }  # saiu do bloco runtime_overrides

    if ($line -match "^\s{2}${Runtime}:\s*$") {
      $inRuntime = $true
      $runtimeIndent = 2
      continue
    }

    if ($inRuntime) {
      if ($line -match '^\s{2}\S') { break }  # outro runtime — fim do bloco

      # linhas de 4 espacos: pares key: value, OU key: (sub-bloco)
      if ($line -match '^\s{4}(\w[\w-]*):\s*(.*)$') {
        $k = $Matches[1]
        $v = $Matches[2]

        # commit subbloco anterior
        if ($currentSub) {
          $subBlocks[$currentSub] = $currentSubLines
          $currentSub = $null
          $currentSubLines = @()
        }

        if ([string]::IsNullOrWhiteSpace($v)) {
          # sub-bloco abre
          $currentSub = $k
          $currentSubLines = @()
        } else {
          $result[$k] = $v
        }
      }
      elseif ($line -match '^\s{6}\S' -and $currentSub) {
        # linha do sub-bloco (6 espacos)
        $currentSubLines += ($line -replace '^\s{4}', '')
      }
      elseif ($line -match '^\s{4}- ' -and $currentSub) {
        $currentSubLines += ($line -replace '^\s{4}', '')
      }
    }
  }

  # commit ultimo subbloco
  if ($currentSub) {
    $subBlocks[$currentSub] = $currentSubLines
  }

  return @{ Scalars = $result; SubBlocks = $subBlocks }
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

function Build-ClaudeAgent {
  param([string]$SrcPath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($SrcPath)
  $dst  = Join-Path "$Out\claude\agents" "$name.md"

  $src = Read-MdSource -Path $SrcPath
  $desc = Get-BaseFrontmatterValue -Frontmatter $src.Frontmatter -Key 'description'
  $override = Get-RuntimeOverride -Frontmatter $src.Frontmatter -Runtime 'claude'

  $fm = New-Object System.Text.StringBuilder
  [void]$fm.AppendLine('---')
  [void]$fm.AppendLine("name: $name")
  if ($desc) { [void]$fm.AppendLine("description: $desc") }
  if ($override.Scalars['model']) { [void]$fm.AppendLine("model: $($override.Scalars['model'])") }
  if ($override.Scalars['tools']) { [void]$fm.AppendLine("tools: $($override.Scalars['tools'])") }
  [void]$fm.AppendLine('---')

  $content = $fm.ToString() + $src.Body
  Set-Content -Path $dst -Value $content -Encoding UTF8 -NoNewline
  Write-Host "  claude/agents/$name.md"
}

function Build-CopilotAgent {
  param([string]$SrcPath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($SrcPath)
  $dst  = Join-Path "$Out\copilot\agents" "$name.agent.md"

  $src = Read-MdSource -Path $SrcPath
  $desc = Get-BaseFrontmatterValue -Frontmatter $src.Frontmatter -Key 'description'
  $override = Get-RuntimeOverride -Frontmatter $src.Frontmatter -Runtime 'copilot'

  $fm = New-Object System.Text.StringBuilder
  [void]$fm.AppendLine('---')
  [void]$fm.AppendLine("name: $name")
  if ($desc) { [void]$fm.AppendLine("description: $desc") }
  if ($override.Scalars['model']) { [void]$fm.AppendLine("model: $($override.Scalars['model'])") }
  if ($override.Scalars['tools']) { [void]$fm.AppendLine("tools: $($override.Scalars['tools'])") }
  [void]$fm.AppendLine('---')

  $content = $fm.ToString() + $src.Body
  Set-Content -Path $dst -Value $content -Encoding UTF8 -NoNewline
  Write-Host "  copilot/agents/$name.agent.md"
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
  Set-Content -Path $dst -Value $content -Encoding UTF8 -NoNewline
  Write-Host "  antigravity/skills/$name/SKILL.md"
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
  Set-Content -Path $dst -Value $content -Encoding UTF8 -NoNewline
  Write-Host "  opencode/agents/$name.md"
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

  Write-Host "  command: $name"
}

function Main {
  Ensure-Dirs
  Write-Host "JDI build (PowerShell) - gerando runtimes a partir de core/"

  $agentFiles = Get-ChildItem -Path "$Core\agents" -Filter '*.md' -File | Sort-Object Name

  if ($Target -in 'claude','all') {
    Write-Host "`nclaude:"
    foreach ($f in $agentFiles) { Build-ClaudeAgent -SrcPath $f.FullName }
  }
  if ($Target -in 'copilot','all') {
    Write-Host "`ncopilot:"
    foreach ($f in $agentFiles) { Build-CopilotAgent -SrcPath $f.FullName }
  }
  if ($Target -in 'antigravity','all') {
    Write-Host "`nantigravity:"
    foreach ($f in $agentFiles) { Build-AntigravitySkill -SrcPath $f.FullName }
  }
  if ($Target -in 'opencode','all') {
    Write-Host "`nopencode:"
    foreach ($f in $agentFiles) { Build-OpencodeAgent -SrcPath $f.FullName }
  }

  Write-Host "`ncommands (todos os runtimes):"
  $cmdFiles = Get-ChildItem -Path "$Core\commands" -Filter '*.md' -File | Sort-Object Name
  foreach ($f in $cmdFiles) { Build-Command -SrcPath $f.FullName }

  Write-Host "`nBuild completo. Veja runtimes/$Target/"
}

Main
