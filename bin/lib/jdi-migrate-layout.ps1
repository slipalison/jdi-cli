# jdi-migrate-layout.ps1 - migrate a legacy .jdi/ to the conflict-free layout
# (v3). PowerShell mirror of jdi-migrate-layout.sh - see it for the full
# contract. Idempotent; stages but does NOT commit.
#
# Usage:
#   jdi-migrate-layout.ps1 [-DryRun] [-Force]
#
# Exit: 0 migrated (or already v3), 1 precondition failed.

[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
# PS 7.4+ turns native-command nonzero exits into terminating errors when
# ErrorActionPreference is Stop ($PSNativeCommandUseErrorActionPreference
# defaults to $true). This script probes git with EXPECTED failures
# (ls-files --error-unmatch, rm --cached of untracked paths) - keep native
# exit codes as data, not exceptions. No-op on 5.1/7.0-7.3.
$PSNativeCommandUseErrorActionPreference = $false
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Fail([string]$msg) {
  [Console]::Error.WriteLine("ERROR: $msg")
  exit 1
}
function Act([string]$msg) { Write-Output "  $msg" }

if (-not (Test-Path .jdi -PathType Container)) {
  Fail 'no .jdi/ here - run from the project root of a JDI project'
}
git rev-parse --git-dir *> $null
if ($LASTEXITCODE -ne 0) { Fail 'not a git repository - v3 migration rewires git tracking' }

# Already v3? Re-running is a render refresh, not an error.
if (Test-Path .jdi/roadmap -PathType Container) {
  Write-Output 'layout v3 already present (.jdi/roadmap/ exists)'
  if (-not $DryRun) {
    & "$ScriptDir\jdi-render.ps1" -Quiet
    Write-Output 'views refreshed. Nothing to migrate.'
  }
  exit 0
}

if (-not $Force) {
  git diff --quiet -- .jdi 2>$null
  if ($LASTEXITCODE -ne 0) {
    Fail 'uncommitted changes under .jdi/ - commit them first (or -Force)'
  }
}

Write-Output 'migrate-layout: legacy shared files -> conflict-free per-entry layout (v3)'
if ($DryRun) { Write-Output '(dry-run - no changes)' }

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Lf([string]$path, [string]$content) {
  [System.IO.File]::WriteAllText($path, $content, $utf8NoBom)
}

function Ignore-Add([string]$pattern) {
  if (Test-Path .gitignore) {
    foreach ($line in (Get-Content .gitignore)) {
      if ($line -eq $pattern) { return }
    }
  }
  if ($DryRun) { Act "would: gitignore $pattern"; return }
  # LF append (Add-Content writes CRLF and would break sh/ps1 parity)
  $raw = if (Test-Path .gitignore) { [System.IO.File]::ReadAllText('.gitignore') } else { '' }
  if ($raw -ne '' -and -not $raw.EndsWith("`n")) { $raw += "`n" }
  [System.IO.File]::WriteAllText('.gitignore', $raw + $pattern + "`n", $utf8NoBom)
}

function Move-Frozen([string]$src, [string]$dst) {
  if (-not (Test-Path $src)) { return }
  Act "freeze $src -> $dst"
  if ($DryRun) { return }
  $dir = Split-Path -Parent $dst
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  git ls-files --error-unmatch $src *> $null
  if ($LASTEXITCODE -eq 0) {
    git mv -f $src $dst
    if ($LASTEXITCODE -ne 0) { Fail "git mv $src failed" }
  }
  else {
    Move-Item -Force $src $dst
  }
}

# --- 1. ROADMAP.md -> .jdi/roadmap/<slug>.md ------------------------------

if (-not (Test-Path .jdi/ROADMAP.md)) {
  Fail '.jdi/ROADMAP.md not found - nothing to split (corrupt project?)'
}

# Split: preamble -> _header; each '### Phase N:' block (until next phase or
# '## ' section) -> one entry; the rest -> _footer.
$headerLines = New-Object System.Collections.Generic.List[string]
$footerLines = New-Object System.Collections.Generic.List[string]
$phases = New-Object System.Collections.Generic.List[object]
$state = ''
$current = $null

$roadRaw = [System.IO.File]::ReadAllText('.jdi/ROADMAP.md')
$roadRaw = $roadRaw -replace "`r`n", "`n" -replace "`r", "`n"
foreach ($line in ($roadRaw.TrimEnd("`n") -split "`n")) {
  if ($line -match '^### Phase (\d+):\s*(.*)$') {
    $current = [PSCustomObject]@{
      Order = [int]$Matches[1]
      Name  = $Matches[2]
      Lines = (New-Object System.Collections.Generic.List[string])
    }
    $phases.Add($current)
    $state = 'phase'
    continue
  }
  if ($state -eq 'phase' -and $line -match '^## ') { $state = 'footer' }
  switch ($state) {
    ''       { $headerLines.Add($line) }
    'phase'  { $current.Lines.Add($line) }
    'footer' { $footerLines.Add($line) }
  }
}

if ($phases.Count -eq 0) {
  Fail "no '### Phase N:' blocks found in ROADMAP.md - cannot split"
}

Act "split ROADMAP.md into $($phases.Count) phase file(s) under .jdi/roadmap/"
if (-not $DryRun) {
  New-Item -ItemType Directory -Force .jdi/roadmap | Out-Null
  foreach ($p in $phases) {
    $rawSlug = ''
    foreach ($l in $p.Lines) {
      if ($l -match '^- \*\*Slug:\*\*\s*(\S+)') { $rawSlug = $Matches[1]; break }
    }
    if ($rawSlug -eq '') { Fail "phase '$($p.Name)' has no '- **Slug:**' line - fix ROADMAP.md first" }
    $slug = $rawSlug -replace '^\d+-', ''
    if ($slug -notmatch '^[a-z0-9][a-z0-9-]{2,49}$') { Fail "phase '$($p.Name)' has invalid slug '$rawSlug'" }
    if (Test-Path ".jdi/roadmap/$slug.md") { Fail "duplicate slug '$slug' in ROADMAP.md - fix before migrating" }

    $body = New-Object System.Collections.Generic.List[string]
    foreach ($l in $p.Lines) {
      if ($l -match '^- \*\*Slug:\*\*') { $body.Add("- **Slug:** $slug") } else { $body.Add($l) }
    }
    $end = $body.Count - 1
    while ($end -ge 0 -and $body[$end] -eq '') { $end-- }
    $bodyText = if ($end -ge 0) { (($body.GetRange(0, $end + 1)) -join "`n") + "`n" } else { '' }

    Write-Lf ".jdi/roadmap/$slug.md" ("---`norder: $($p.Order)`nname: $($p.Name)`n---`n" + $bodyText)
  }

  foreach ($pair in @(
    @{ Lines = $headerLines; Path = '.jdi/roadmap/_header.md' },
    @{ Lines = $footerLines; Path = '.jdi/roadmap/_footer.md' }
  )) {
    $end = $pair.Lines.Count - 1
    while ($end -ge 0 -and $pair.Lines[$end] -eq '') { $end-- }
    if ($end -ge 0) {
      Write-Lf $pair.Path ((($pair.Lines.GetRange(0, $end + 1)) -join "`n") + "`n")
    }
  }
}

Act 'untrack .jdi/ROADMAP.md (becomes a rendered view)'
if (-not $DryRun) {
  git rm --cached --quiet .jdi/ROADMAP.md 2>$null | Out-Null
  Remove-Item -Force .jdi/ROADMAP.md -ErrorAction SilentlyContinue
}
Ignore-Add '.jdi/ROADMAP.md'

# --- 2-4. freeze the append streams ---------------------------------------

if (-not $DryRun) {
  foreach ($d in @('.jdi/decisions', '.jdi/todos', '.jdi/registry')) {
    New-Item -ItemType Directory -Force $d | Out-Null
  }
}
Move-Frozen '.jdi/DECISIONS.md'       '.jdi/decisions/LEGACY.md'
Move-Frozen '.jdi/todos.md'           '.jdi/todos/LEGACY.md'
Move-Frozen '.jdi/registry.md'        '.jdi/registry/LEGACY.md'
Move-Frozen '.jdi/specialists.md'     '.jdi/registry/LEGACY-specialists.md'
Move-Frozen '.jdi/reviewers.md'       '.jdi/registry/LEGACY-reviewers.md'
Move-Frozen '.jdi/skills-registry.md' '.jdi/registry/LEGACY-skills.md'

Ignore-Add '.jdi/DECISIONS.md'
Ignore-Add '.jdi/todos.md'
Ignore-Add '.jdi/registry.md'
Ignore-Add '.jdi/specialists.md'
Ignore-Add '.jdi/reviewers.md'
Ignore-Add '.jdi/skills-registry.md'

if (-not $DryRun) {
  foreach ($d in @('.jdi/roadmap', '.jdi/decisions', '.jdi/todos', '.jdi/registry')) {
    if (-not (Get-ChildItem $d -Force -ErrorAction SilentlyContinue)) {
      New-Item -ItemType File "$d/.gitkeep" | Out-Null
    }
  }
}

# --- 5. STATE.md (fold in the 0.3.0 migration for old projects) -----------

git ls-files --error-unmatch .jdi/STATE.md *> $null
if ($LASTEXITCODE -eq 0) {
  Act 'untrack .jdi/STATE.md (per-clone advisory cache)'
  if (-not $DryRun) { git rm --cached --quiet .jdi/STATE.md | Out-Null }
}
Ignore-Add '.jdi/STATE.md'

# --- 7. render views at the old paths -------------------------------------

if (-not $DryRun) {
  & "$ScriptDir\jdi-render.ps1" -Quiet
  Act 'views rendered (untracked): ROADMAP.md DECISIONS.md todos.md registry.md specialists.md reviewers.md skills-registry.md'
}

# --- 8. stage -------------------------------------------------------------

if (-not $DryRun) {
  git add .jdi/ .gitignore
  Write-Output ''
  Write-Output 'migrate-layout: DONE (staged, not committed).'
  Write-Output 'Review with: git status .jdi/'
  Write-Output 'Commit with:  git commit -m "chore(jdi): migrate .jdi/ to conflict-free layout (v3)"'
  Write-Output ''
  Write-Output 'Merge note: branches created BEFORE this migration still edit the old'
  Write-Output 'tracked paths and will hit ONE visible delete/modify conflict when'
  Write-Output 'merged - rebase them (or re-run their JDI step) after this lands on'
  Write-Output 'the default branch. New branches are conflict-free by construction.'
}
else {
  Write-Output ''
  Write-Output 'migrate-layout: dry-run complete. Re-run without -DryRun to apply.'
}
exit 0
