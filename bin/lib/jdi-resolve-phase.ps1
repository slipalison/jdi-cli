# jdi-resolve-phase.ps1 - phase ID resolver (PowerShell)
#
# Usage (from a command MD file) - PREFER -AsObject (avoids Invoke-Expression):
#   $p = & "$JDI_LIB\jdi-resolve-phase.ps1" -Id $phaseInput -AsObject
#   if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
#   $p.Slug; $p.Dir; $p.Position; $p.SchemaVersion; $p.FolderExists
#
# Without -AsObject it emits Bash-style KEY='value' lines for parity with the
# .sh version. Do NOT pipe those to Invoke-Expression - parse them or use
# -AsObject. The emitted slug is re-validated below, but Invoke-Expression on
# untrusted KEY=value text is an unnecessary dynamic-execution sink.
#
# Exit codes:
#   0  resolved
#   1  invalid input
#   2  phase not found in ROADMAP
#   3  .jdi/ROADMAP.md missing (STATE.md is optional — untracked advisory cache)
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

# --- Layout detection ---
# v3 (conflict-free) keeps one file per phase under .jdi/roadmap/ and
# regenerates .jdi/ROADMAP.md as an UNTRACKED view. When the dir exists it is
# the source of truth and the view is never parsed (it may be stale or absent
# on a fresh clone). Legacy projects fall through to the ROADMAP.md parser.
$layoutV3 = Test-Path .jdi/roadmap -PathType Container
if (-not $layoutV3 -and -not (Test-Path .jdi/ROADMAP.md)) {
  Fail 3 '.jdi/ROADMAP.md not found (run /jdi-new first)'
}

# --- Schema detection ---
# STATE.md is an untracked advisory cache (0.3.0+) — absence is normal on a
# fresh clone and only schema_version is read from it. Missing file implies
# v2: legacy v1 projects always track STATE.md in git.
$schemaVersion = 2
if (Test-Path .jdi/STATE.md) {
  $schemaVersion = 1
  $state = Get-Content .jdi/STATE.md -Raw
  $svMatch = [regex]::Match($state, 'schema_version:\s*(\d+)')
  if ($svMatch.Success) { $schemaVersion = [int]$svMatch.Groups[1].Value }
}

# --- Parse phases into (position, rawSlug) tuples ---
$phases = New-Object System.Collections.Generic.List[object]

if ($layoutV3) {
  # v3: position = 1-based rank sorting entries by (order asc, slug asc).
  # `order` comes from the entry frontmatter and may be fractional
  # (insert-between never renumbers sibling files). Filename = slug of record.
  $entries = @(Get-ChildItem .jdi/roadmap -File -Filter '*.md' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch '^(_|LEGACY)' } |
    ForEach-Object {
      $order = [double]999999
      $inFm = $false
      foreach ($line in (Get-Content $_.FullName)) {
        if (-not $inFm) {
          if ($line -eq '---') { $inFm = $true; continue } else { break }
        }
        if ($line -eq '---') { break }
        if ($line -match '^order:\s*(\S+)') {
          $parsed = 0.0
          if ([double]::TryParse($Matches[1], [System.Globalization.NumberStyles]::Float,
              [System.Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
            $order = $parsed
          }
          break
        }
      }
      [PSCustomObject]@{ Order = $order; Slug = $_.BaseName }
    })

  # Explicit comparison sort: PS 5.1 Sort-Object is neither guaranteed stable
  # nor ordinal on strings; the .sh side is LC_ALL=C (ordinal). Parity first.
  [Array]::Sort($entries, [System.Comparison[object]]{
    param($a, $b)
    $c = $a.Order.CompareTo($b.Order)
    if ($c -ne 0) { return $c }
    return [string]::CompareOrdinal($a.Slug, $b.Slug)
  })

  $rank = 0
  foreach ($e in $entries) {
    $rank++
    $phases.Add([PSCustomObject]@{
      Position      = $rank
      RawSlug       = $e.Slug
      CanonicalSlug = $e.Slug
    })
  }
  $schemaVersion = 3
}
else {
  $roadmap = Get-Content .jdi/ROADMAP.md
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
}

# --- Lookup ---
$match = $null
if ($isInteger) {
  $position = [int]$Id
  $match = $phases | Where-Object { $_.Position -eq $position } | Select-Object -First 1
  if (-not $match) { Fail 2 "phase $position not found in ROADMAP" }
}
else {
  if ($layoutV3) {
    # v3 filenames are canonical; accept the legacy NN-slug spelling too.
    $q = $Id -replace '^\d+-', ''
    $match = $phases | Where-Object { $_.CanonicalSlug -eq $q } | Select-Object -First 1
  }
  else {
    $match = $phases | Where-Object {
      $_.RawSlug -eq $Id -or $_.CanonicalSlug -eq $Id
    } | Select-Object -First 1
  }
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
