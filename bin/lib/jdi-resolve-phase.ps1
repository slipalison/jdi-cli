# jdi-resolve-phase.ps1 — phase ID resolver (PowerShell)
#
# Usage (from a command MD file) — PREFER -AsObject (avoids Invoke-Expression):
#   $p = & "$JDI_LIB\jdi-resolve-phase.ps1" -Id $phaseInput -AsObject
#   if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
#   $p.Slug; $p.Dir; $p.Position; $p.SchemaVersion; $p.FolderExists
#
# Without -AsObject it emits Bash-style KEY='value' lines for parity with the
# .sh version. Do NOT pipe those to Invoke-Expression — parse them or use
# -AsObject. The emitted slug is re-validated below, but Invoke-Expression on
# untrusted KEY=value text is an unnecessary dynamic-execution sink.
#
# Exit codes:
#   0  resolved
#   1  invalid input
#   2  phase not found in ROADMAP
#   3  .jdi/ROADMAP.md or .jdi/STATE.md missing
#   4  multiple folder candidates (corrupt state)

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Id,

  [switch]$AsObject
)

$ErrorActionPreference = 'Stop'

function Fail([int]$code, [string]$msg) {
  [Console]::Error.WriteLine("ERROR: $msg")
  exit $code
}

if ([string]::IsNullOrWhiteSpace($Id)) {
  Fail 1 'phase ID required (integer position or slug)'
}

# --- Input shape ---
# Resolver is permissive: accepts canonical slug (letter-start)
# AND legacy slug form (digit-prefixed, e.g. "02-auth-flow") for v1 lookups.
# Validator lib stays strict for NEW slug creation.
$isInteger = $Id -match '^[0-9]+$'
if (-not $isInteger -and -not ($Id -match '^[a-z0-9][a-z0-9-]{2,49}$')) {
  Fail 1 "invalid phase ID '$Id' (must be integer or slug a-z0-9-, 3-40 chars)"
}

# --- State files ---
if (-not (Test-Path .jdi/ROADMAP.md)) { Fail 3 '.jdi/ROADMAP.md not found (run /jdi-new first)' }
if (-not (Test-Path .jdi/STATE.md))   { Fail 3 '.jdi/STATE.md not found (corrupt project)' }

# --- Schema detection ---
$schemaVersion = 1
$state = Get-Content .jdi/STATE.md -Raw
$svMatch = [regex]::Match($state, 'schema_version:\s*(\d+)')
if ($svMatch.Success) { $schemaVersion = [int]$svMatch.Groups[1].Value }

# --- Parse ROADMAP phases into (position, rawSlug) tuples ---
$roadmap = Get-Content .jdi/ROADMAP.md
$phases = New-Object System.Collections.Generic.List[object]
$current = 0
foreach ($line in $roadmap) {
  if ($line -match '^### Phase\s+(\d+)\s*:') {
    $current = [int]$Matches[1]
  }
  elseif ($current -gt 0 -and $line -match '^- \*\*Slug:\*\*\s*(\S+)') {
    $raw = $Matches[1]
    $canonical = $raw -replace '^\d+-', ''
    $phases.Add([PSCustomObject]@{
      Position      = $current
      RawSlug       = $raw
      CanonicalSlug = $canonical
    })
    $current = 0
  }
}

# --- Lookup ---
$match = $null
if ($isInteger) {
  $position = [int]$Id
  $match = $phases | Where-Object { $_.Position -eq $position } | Select-Object -First 1
  if (-not $match) { Fail 2 "phase $position not found in ROADMAP" }
}
else {
  $match = $phases | Where-Object {
    $_.RawSlug -eq $Id -or $_.CanonicalSlug -eq $Id
  } | Select-Object -First 1
  if (-not $match) { Fail 2 "slug '$Id' not found in ROADMAP" }
}

$position      = $match.Position
$rawSlug       = $match.RawSlug
$canonicalSlug = $match.CanonicalSlug
$nn            = '{0:D2}' -f $position

# Re-validate slugs sourced from ROADMAP.md before emitting them. The CLI arg
# is checked above; ROADMAP content is not trusted blindly. Defends callers
# (and any Invoke-Expression usage) against a tampered slug with metacharacters.
foreach ($s in @($rawSlug, $canonicalSlug)) {
  if ($s -notmatch '^[a-z0-9][a-z0-9-]{2,49}$') {
    Fail 4 "corrupt slug in ROADMAP.md: '$s'"
  }
}

# --- Folder resolution ---
$folder = $null
$candidatesByGlob = @()

if (Test-Path ".jdi/phases/$canonicalSlug")        { $folder = ".jdi/phases/$canonicalSlug" }
elseif ($rawSlug -ne $canonicalSlug -and (Test-Path ".jdi/phases/$rawSlug")) { $folder = ".jdi/phases/$rawSlug" }
elseif (Test-Path ".jdi/phases/$nn-$canonicalSlug") { $folder = ".jdi/phases/$nn-$canonicalSlug" }
else {
  $candidatesByGlob = Get-ChildItem .jdi/phases -Directory -Filter "*-$canonicalSlug" -ErrorAction SilentlyContinue
  if ($candidatesByGlob.Count -eq 1) { $folder = $candidatesByGlob[0].FullName }
  elseif ($candidatesByGlob.Count -gt 1) {
    $names = ($candidatesByGlob | ForEach-Object { $_.Name }) -join ', '
    Fail 4 "multiple folder candidates for slug '$canonicalSlug': $names"
  }
}

$folderExists = [bool]$folder
if (-not $folderExists) {
  if ($schemaVersion -ge 2) { $folder = ".jdi/phases/$canonicalSlug" }
  else                      { $folder = ".jdi/phases/$nn-$canonicalSlug" }
}

# --- Emit ---
if ($AsObject) {
  [PSCustomObject]@{
    Slug          = $canonicalSlug
    Dir           = $folder
    Position      = $position
    SchemaVersion = $schemaVersion
    FolderExists  = $folderExists
  }
}
else {
  "JDI_PHASE_SLUG='$canonicalSlug'"
  "JDI_PHASE_DIR='$folder'"
  "JDI_PHASE_POSITION='$position'"
  "JDI_PHASE_SCHEMA='$schemaVersion'"
  "JDI_PHASE_FOLDER_EXISTS='$(if ($folderExists) { 'true' } else { 'false' })'"
}

exit 0
