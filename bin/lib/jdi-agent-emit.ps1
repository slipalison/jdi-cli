# jdi-agent-emit.ps1 - shared agent emitter: canonical JDI agent frontmatter
# (core/agents/*.md, core/templates/*-specialist.md, .jdi/agents/*.md) ->
# runtime-native agent files. PowerShell twin of jdi-agent-emit.sh: every
# emitter MUST produce byte-identical output (LF, UTF-8 without BOM).
#
# Dot-sourced by:
#   jdi-build.ps1             core/agents/  -> runtimes/<rt>/...
#   jdi-sync-specialists.ps1  .jdi/agents/  -> the project's runtime dirs (#33)
#   jdi-install.ps1           pt-BR directive injector (shared with sync)
#
# Public API:
#   Get-AgentContent -Runtime <rt> -SrcPath <src>     runtime-native text (LF)
#   Write-AgentFile -Runtime <rt> -SrcPath <src> -Dst <dst>
#   Get-AgentDestPath -Runtime <rt> -Name <n>         relative discovery path
#   Add-LangDirectiveToText -Text <t>                 idempotent pt-BR injector
#   Add-LangDirectiveToFile -FilePath <f>             in-place variant
#
# Windows PowerShell 5.1 compatible: ASCII-only source, no PS7 syntax.

$script:LangPtBr = 'pt-BR'
$script:LangDirectiveMarker = '<!-- jdi:lang-directive -->'
$script:LangDirectiveFile = Join-Path $PSScriptRoot '..\..\core\templates\lang-directive.pt-BR.md'
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# Le arquivo e devolve hashtable com:
#  Frontmatter = string (sem os ---)
#  Body        = string (corpo apos o frontmatter, LF, com newline final)
# CRLF e normalizado pra LF na leitura, e o corpo ganha exatamente o mesmo
# newline final que o awk do .sh emite - assim um .jdi/agents/*.md salvo com
# CRLF ou sem newline final rende os mesmos bytes nos dois shells.
function Read-MdSource {
  param([string]$Path)
  $content = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  $content = $content.Replace("`r`n", "`n")
  if ($content -match '^---\n([\s\S]*?)\n---\n([\s\S]*)$') {
    $body = $Matches[2]
    if ($body.Length -gt 0 -and -not $body.EndsWith("`n")) { $body += "`n" }
    return @{
      Frontmatter = $Matches[1]
      Body        = $body
    }
  }
  return @{ Frontmatter = ''; Body = $content }
}

# Escreve UTF-8 SEM BOM, LF (consistente com jdi-agent-emit.sh).
# `Set-Content -Encoding UTF8` emite BOM no Windows PowerShell 5.1 - isso gera
# churn cross-shell gigante em runtimes/ (skills com BOM, commands sem).
function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $Content = $Content.Replace("`r`n", "`n")
  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  [System.IO.File]::WriteAllText($Path, $Content, $script:Utf8NoBom)
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
    $State.CurrentSub = $Key
    $State.CurrentSubLines = @()
  } else {
    $State.Scalars[$Key] = $Value
  }
}

# Aplica uma linha pertencente ao bloco do runtime alvo ao estado acumulado.
function Update-OverrideState {
  param([hashtable]$State, [string]$Line)

  if ($Line -match '^\s{4}(\w[\w-]*):\s*(.*)$') {
    Add-OverrideScalarOrSubBlock -State $State -Key $Matches[1] -Value $Matches[2]
  }
  elseif ($Line -match '^\s{6}\S' -and $State.CurrentSub) {
    $State.CurrentSubLines += ($Line -replace '^\s{4}', '')
  }
  elseif ($Line -match '^\s{4}- ' -and $State.CurrentSub) {
    $State.CurrentSubLines += ($Line -replace '^\s{4}', '')
  }
}

# Extrai sub-bloco do frontmatter sob `runtime_overrides.<runtime>:`.
# Retorna hashtable { Scalars = {key=value}; SubBlocks = {key=lines[]} }.
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
  $lines = $Frontmatter -split "`n"
  $inOverrides = $false
  $inRuntime   = $false

  foreach ($line in $lines) {
    if ($line -match '^runtime_overrides:\s*$') { $inOverrides = $true; continue }
    if (-not $inOverrides) { continue }

    if ($line -match '^\S') { break }

    if ($line -match "^\s{2}${Runtime}:\s*$") {
      $inRuntime = $true
      continue
    }

    if ($inRuntime) {
      if ($line -match '^\s{2}\S') { break }
      Update-OverrideState -State $state -Line $line
    }
  }

  Close-OverrideSubBlock -State $state

  return @{ Scalars = $state.Scalars; SubBlocks = $state.SubBlocks }
}

# Valor escalar do frontmatter base (ex: description, name).
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

# Bloco multilinha do frontmatter base (ex: triggers: lista).
function Get-BaseFrontmatterBlock {
  param(
    [string]$Frontmatter,
    [string]$Key
  )
  $lines = $Frontmatter -split "`n"
  $collecting = $false
  $captured = @()
  foreach ($line in $lines) {
    if ($collecting) {
      if ($line -match '^\S') { break }
      if ($line -match '^\s+\S') { $captured += $line; continue }
    }
    if ($line -match "^${Key}:\s*$") { $collecting = $true; $captured += $line; continue }
  }
  return ($captured -join "`n")
}

# runtime_intent.reasoning (deep|medium|low).
function Get-IntentReasoning {
  param([string]$Frontmatter)
  if ($Frontmatter -match '(?ms)^runtime_intent:\s*$(.*?)(?=^\S|\z)') {
    if ($Matches[1] -match '(?m)^\s{2}reasoning:\s*(\S+)') {
      return $Matches[1]
    }
  }
  return ''
}

# Claude Code e GitHub Copilot: name + description + model + tools de
# runtime_overrides.<runtime>. So a chave do runtime difere.
function Get-ScalarAgentContent {
  param([string]$Runtime, [string]$SrcPath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($SrcPath)
  $src  = Read-MdSource -Path $SrcPath
  $desc = Get-BaseFrontmatterValue -Frontmatter $src.Frontmatter -Key 'description'
  $override = Get-RuntimeOverride -Frontmatter $src.Frontmatter -Runtime $Runtime

  $fm = New-Object System.Collections.Generic.List[string]
  $fm.Add('---')
  $fm.Add("name: $name")
  if ($desc) { $fm.Add("description: $desc") }
  if ($override.Scalars['model']) { $fm.Add("model: $($override.Scalars['model'])") }
  if ($override.Scalars['tools']) { $fm.Add("tools: $($override.Scalars['tools'])") }
  $fm.Add('---')
  return (($fm -join "`n") + "`n" + $src.Body)
}

# Antigravity: agents sao skills descobertas por description + triggers.
function Get-AntigravitySkillContent {
  param([string]$SrcPath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($SrcPath)
  $src = Read-MdSource -Path $SrcPath
  $desc = Get-BaseFrontmatterValue -Frontmatter $src.Frontmatter -Key 'description'
  $triggersBlock = Get-BaseFrontmatterBlock -Frontmatter $src.Frontmatter -Key 'triggers'
  $override = Get-RuntimeOverride -Frontmatter $src.Frontmatter -Runtime 'antigravity'

  $fm = New-Object System.Collections.Generic.List[string]
  $fm.Add('---')
  $fm.Add("name: $name")
  if ($desc) { $fm.Add("description: $desc") }
  if ($triggersBlock) {
    $fm.Add($triggersBlock)
    if ($override.SubBlocks['triggers_extra']) {
      foreach ($l in $override.SubBlocks['triggers_extra']) { $fm.Add($l) }
    }
  }
  $fm.Add('---')
  return (($fm -join "`n") + "`n" + $src.Body)
}

# OpenCode: description + mode/model/temperature + permission. O nome e o
# filename - OpenCode deriva, entao nao e emitido.
function Get-OpencodeAgentContent {
  param([string]$SrcPath)
  $src = Read-MdSource -Path $SrcPath
  $desc = Get-BaseFrontmatterValue -Frontmatter $src.Frontmatter -Key 'description'
  $override = Get-RuntimeOverride -Frontmatter $src.Frontmatter -Runtime 'opencode'

  $fm = New-Object System.Collections.Generic.List[string]
  $fm.Add('---')
  if ($desc) { $fm.Add("description: $desc") }
  foreach ($k in @('mode','model','temperature')) {
    if ($override.Scalars[$k]) { $fm.Add("${k}: $($override.Scalars[$k])") }
  }
  if ($override.SubBlocks['permission']) {
    $fm.Add('permission:')
    foreach ($l in $override.SubBlocks['permission']) { $fm.Add($l) }
  }
  $fm.Add('---')
  return (($fm -join "`n") + "`n" + $src.Body)
}

# Junie subagent (.junie/agents/<n>.md): name + description + tools
# allowlist (enforced by Junie) + reasoningLevel. Tools derive from the
# claude override filtered to Junie's supported set; Agent/WebFetch/Skill
# drop out (Junie delegates natively and has WebSearch only). Model is
# never emitted - Junie is LLM-agnostic and the user picks the model.
function Get-JunieAgentContent {
  param([string]$SrcPath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($SrcPath)
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
  switch (Get-IntentReasoning -Frontmatter $src.Frontmatter) {
    'deep'   { $level = 'high' }
    'medium' { $level = 'medium' }
    'low'    { $level = 'low' }
  }

  $fm = New-Object System.Collections.Generic.List[string]
  $fm.Add('---')
  $fm.Add("name: $name")
  if ($desc) { $fm.Add("description: $desc") }
  if ($toolsFiltered) { $fm.Add("tools: [$toolsFiltered]") }
  if ($level) { $fm.Add("reasoningLevel: $level") }
  $fm.Add('---')
  return (($fm -join "`n") + "`n" + $src.Body)
}

# --- public API ---------------------------------------------------------------

# Runtime-native agent text (LF) for <SrcPath>.
function Get-AgentContent {
  param([string]$Runtime, [string]$SrcPath)
  switch ($Runtime) {
    'claude'      { return (Get-ScalarAgentContent -Runtime 'claude' -SrcPath $SrcPath) }
    'copilot'     { return (Get-ScalarAgentContent -Runtime 'copilot' -SrcPath $SrcPath) }
    'antigravity' { return (Get-AntigravitySkillContent -SrcPath $SrcPath) }
    'opencode'    { return (Get-OpencodeAgentContent -SrcPath $SrcPath) }
    'junie'       { return (Get-JunieAgentContent -SrcPath $SrcPath) }
  }
  throw "unknown runtime '$Runtime' (claude|copilot|antigravity|opencode|junie)"
}

# Same, written to <Dst> (parent dir created).
function Write-AgentFile {
  param([string]$Runtime, [string]$SrcPath, [string]$Dst)
  Write-Utf8NoBom -Path $Dst -Content (Get-AgentContent -Runtime $Runtime -SrcPath $SrcPath)
}

# Relative path (from a project root) where <Runtime> discovers agent <Name>.
# Matches the install layout in PORTABILITY.md. Forward slashes on purpose:
# the path is printed (porcelain / git add) and compared with the .sh twin.
function Get-AgentDestPath {
  param([string]$Runtime, [string]$Name)
  switch ($Runtime) {
    'claude'      { return ".claude/agents/$Name.md" }
    'copilot'     { return ".github/agents/$Name.agent.md" }
    'opencode'    { return ".opencode/agents/$Name.md" }
    'antigravity' { return ".agents/skills/$Name/SKILL.md" }
    'junie'       { return ".junie/agents/$Name.md" }
  }
  throw "unknown runtime '$Runtime'"
}

# --- pt-BR language directive ----------------------------------------------
# Inserts core/templates/lang-directive.pt-BR.md right after the closing
# `---` of the frontmatter. Idempotent: text already carrying the marker is
# returned unchanged. Line semantics mirror the awk injector exactly: the
# directive file contributes one line per newline-terminated record (its
# trailing blank line included), and CRLF input is normalized to LF.

function Add-LangDirectiveToText {
  param([string]$Text)
  $Text = $Text.Replace("`r`n", "`n")
  if ($Text.Contains($script:LangDirectiveMarker)) { return $Text }

  $directive = [System.IO.File]::ReadAllText($script:LangDirectiveFile, [System.Text.Encoding]::UTF8)
  $directive = $directive.Replace("`r`n", "`n")
  $directiveLines = [string[]]($directive -split "`n")
  # awk sees N records for N newline-terminated lines; -split yields N+1
  # elements when the file ends with a newline - drop that last empty one.
  if ($directiveLines.Length -gt 0 -and $directiveLines[-1] -eq '') {
    $directiveLines = $directiveLines[0..($directiveLines.Length - 2)]
  }

  $textLines = [string[]]($Text -split "`n")
  $trailing = ($textLines.Length -gt 0 -and $textLines[-1] -eq '')
  if ($trailing) { $textLines = $textLines[0..($textLines.Length - 2)] }

  $fm = 0
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($line in $textLines) {
    $out.Add($line)
    if ($line -eq '---' -and $fm -lt 2) {
      $fm++
      if ($fm -eq 2) { foreach ($d in $directiveLines) { $out.Add([string]$d) } }
    }
  }
  $result = ($out -join "`n")
  if ($trailing) { $result += "`n" }
  return $result
}

# Insere a diretiva num unico arquivo .md. Idempotente. Ignora silenciosamente
# arquivo inexistente. Le/escreve UTF-8 sem BOM explicitamente (nao
# Get-Content/Set-Content) porque o PowerShell 5.1 decodifica arquivo sem BOM
# pela codepage ANSI por default, o que corromperia os bytes non-ASCII.
function Add-LangDirectiveToFile {
  param([string]$FilePath)
  if (-not (Test-Path $FilePath)) { return }
  $text = [System.IO.File]::ReadAllText($FilePath, [System.Text.Encoding]::UTF8)
  if ($text.Contains($script:LangDirectiveMarker)) { return }
  Write-Utf8NoBom -Path $FilePath -Content (Add-LangDirectiveToText -Text $text)
}
