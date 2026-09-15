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

# Frontmatter parsing + per-runtime emitters live in the shared lib (also
# used by jdi-sync-specialists.ps1 for .jdi/agents/ -> runtime dirs, #33).
. (Join-Path $PSScriptRoot 'lib\jdi-agent-emit.ps1')

function Ensure-Dirs {
  $dirs = @(
    "$Out\claude\agents", "$Out\claude\commands", "$Out\claude\skills",
    "$Out\copilot\agents", "$Out\copilot\prompts", "$Out\copilot\skills",
    "$Out\antigravity\skills",
    "$Out\opencode\agents", "$Out\opencode\commands", "$Out\opencode\skills",
    "$Out\junie\agents", "$Out\junie\skills"
  )
  foreach ($d in $dirs) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
  }
}

function Build-ClaudeAgent {
  param([string]$SrcPath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($SrcPath)
  Write-AgentFile -Runtime 'claude' -SrcPath $SrcPath -Dst (Join-Path "$Out\claude\agents" "$name.md")
  Write-Output "  claude/agents/$name.md"
}

function Build-CopilotAgent {
  param([string]$SrcPath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($SrcPath)
  Write-AgentFile -Runtime 'copilot' -SrcPath $SrcPath -Dst (Join-Path "$Out\copilot\agents" "$name.agent.md")
  Write-Output "  copilot/agents/$name.agent.md"
}

function Build-AntigravitySkill {
  param([string]$SrcPath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($SrcPath)
  $skillDir = Join-Path "$Out\antigravity\skills" $name
  New-Item -ItemType Directory -Force -Path "$skillDir\references" | Out-Null
  New-Item -ItemType Directory -Force -Path "$skillDir\scripts" | Out-Null
  Write-AgentFile -Runtime 'antigravity' -SrcPath $SrcPath -Dst (Join-Path $skillDir 'SKILL.md')
  Write-Output "  antigravity/skills/$name/SKILL.md"
}

function Build-OpencodeAgent {
  param([string]$SrcPath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($SrcPath)
  Write-AgentFile -Runtime 'opencode' -SrcPath $SrcPath -Dst (Join-Path "$Out\opencode\agents" "$name.md")
  Write-Output "  opencode/agents/$name.md"
}

function Build-JunieAgent {
  param([string]$SrcPath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($SrcPath)
  Write-AgentFile -Runtime 'junie' -SrcPath $SrcPath -Dst (Join-Path "$Out\junie\agents" "$name.md")
  Write-Output "  junie/agents/$name.md"
}

function Build-Command {
  param([string]$SrcPath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($SrcPath)

  Copy-Item -Path $SrcPath -Destination (Join-Path "$Out\claude\commands" "$name.md") -Force
  # copilot: prompts/<name>.prompt.md (VS Code slash) + skills/<name>/SKILL.md
  # (Copilot CLI + cloud agent: Agent Skills GA Apr/2026 - the CLI does NOT
  # read .github/prompts/, so skills are the CLI's discovery path)
  Copy-Item -Path $SrcPath -Destination (Join-Path "$Out\copilot\prompts" "$name.prompt.md") -Force
  $copilotSkillDir = Join-Path "$Out\copilot\skills" $name
  New-Item -ItemType Directory -Force -Path $copilotSkillDir | Out-Null
  Copy-Item -Path $SrcPath -Destination (Join-Path $copilotSkillDir 'SKILL.md') -Force

  $skillDir = Join-Path "$Out\antigravity\skills" $name
  New-Item -ItemType Directory -Force -Path "$skillDir\scripts" | Out-Null
  Copy-Item -Path $SrcPath -Destination (Join-Path $skillDir 'SKILL.md') -Force

  Copy-Item -Path $SrcPath -Destination (Join-Path "$Out\opencode\commands" "$name.md") -Force

  # junie: skills/<name>/SKILL.md (semantic discovery - NOT a custom command:
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
  if ($Target -in 'copilot','all') {
    Build-StandaloneSkill -SrcDir $SkillDir.FullName -Runtime 'copilot' -DestRoot (Join-Path "$Out\copilot\skills" $SkillDir.Name)
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
