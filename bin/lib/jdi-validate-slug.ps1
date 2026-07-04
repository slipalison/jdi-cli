# jdi-validate-slug.ps1 - strict phase slug validator (PowerShell)
#
# Usage:
#   & "$JDI_LIB\jdi-validate-slug.ps1" -Slug $slug [-CheckUnique]
#
# Validates a candidate slug against JDI naming rules. With -CheckUnique,
# also asserts the slug is not already taken by an existing phase folder
# OR a ROADMAP entry.
#
# Exit codes:
#   0  valid (slug printed to stdout)
#   1  invalid shape
#   2  reserved keyword
#   3  duplicate (folder or ROADMAP)
#   4  ambiguous (corrupt state - multiple folder forms)

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Slug,

  [switch]$CheckUnique
)

$ErrorActionPreference = 'Stop'

function Fail([int]$code, [string]$msg) {
  [Console]::Error.WriteLine("ERROR: $msg")
  exit $code
}

if ([string]::IsNullOrWhiteSpace($Slug)) { Fail 1 'slug required' }

# --- Rule 1: shape ---
if ($Slug -notmatch '^[a-z][a-z0-9-]{2,39}$') {
  Fail 1 "slug '$Slug' invalid shape (need lowercase a-z0-9-, start with letter, 3-40 chars)"
}
if ($Slug -match '--')  { Fail 1 "slug '$Slug' contains double hyphen" }
if ($Slug.EndsWith('-')) { Fail 1 "slug '$Slug' ends with hyphen" }

# --- Rule 2: reserved keywords ---
$reserved = @('current','all','none','archive','removed','history','latest','pending','ready','done','blocked','partial')
if ($reserved -contains $Slug) {
  Fail 2 "slug '$Slug' is reserved (JDI keyword)"
}

# --- Rule 3 + 4: uniqueness ---
if ($CheckUnique) {
  if (Test-Path .jdi/phases) {
    $collisions = @()
    Get-ChildItem .jdi/phases -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $name = $_.Name
      $canonical = $name -replace '^\d+-', ''
      if ($canonical -eq $Slug -or $name -eq $Slug) { $collisions += $name }
    }
    if ($collisions.Count -ge 2) {
      $list = $collisions -join ' '
      Fail 4 "ambiguous existing folders for slug '$Slug': $list (run /jdi-migrate-phases)"
    }
    if ($collisions.Count -eq 1) {
      Fail 3 "slug '$Slug' already exists (folder: $($collisions[0]))"
    }
  }

  if (Test-Path .jdi/ROADMAP.md) {
    $roadmap = Get-Content .jdi/ROADMAP.md
    foreach ($line in $roadmap) {
      if ($line -match '^- \*\*Slug:\*\*\s*(\S+)') {
        $raw = $Matches[1]
        $canonical = $raw -replace '^\d+-', ''
        if ($raw -eq $Slug -or $canonical -eq $Slug) {
          Fail 3 "slug '$Slug' already listed in ROADMAP.md"
        }
      }
    }
  }
}

Write-Output $Slug
exit 0
