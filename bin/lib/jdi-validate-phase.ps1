# jdi-validate-phase: mechanical gate over the phase artifact chain.
# 1:1 mirror of jdi-validate-phase.sh - identical stdout, identical exit codes.
#
# Usage: .\jdi-validate-phase.ps1 <slug|position> [-ForPr] [-Quiet]
#        (also accepts --for-pr / --quiet for parity with the .sh flags)

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$PhaseId,

  [switch]$ForPr,
  [switch]$Quiet,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'Stop'

# No `??` here: null-coalescing is PS 7+ and breaks the PS 5.1 parser
# (5.1 is the fallback interpreter on stock Windows - see issue #24).
if ($null -eq $Rest) { $Rest = @() }
foreach ($arg in $Rest) {
  switch ($arg) {
    '--for-pr' { $ForPr = $true }
    '--quiet'  { $Quiet = $true }
    default {
      if ($arg.StartsWith('-')) { [Console]::Error.WriteLine("unknown flag: $arg"); exit 1 }
      if (-not $PhaseId) { $PhaseId = $arg }
    }
  }
}

if ([string]::IsNullOrWhiteSpace($PhaseId)) {
  [Console]::Error.WriteLine('usage: jdi-validate-phase.ps1 <slug|position> [--for-pr] [--quiet]')
  exit 1
}

function Say([string]$msg) { if (-not $Quiet) { Write-Output $msg } }

# --- Resolve phase via sibling resolver (KEY='value' lines) ---
$resolver = Join-Path $PSScriptRoot 'jdi-resolve-phase.ps1'
$resolved = & $resolver $PhaseId 2>$null
$resolveRc = $LASTEXITCODE
if ($resolveRc -ne 0 -or -not $resolved) {
  # Mirror the .sh: rc 2 = resolver's own "not found in ROADMAP"; anything
  # else = it could not run (missing .jdi/ROADMAP.md, bad input, ...).
  if ($resolveRc -eq 2) {
    Say "[fail] phase '$PhaseId' not found in ROADMAP.md"
  } else {
    Say "[fail] could not run the phase resolver (rc=$resolveRc) - is this a JDI project with .jdi/ROADMAP.md?"
  }
  exit 1
}

$map = @{}
foreach ($line in $resolved) {
  if ($line -match "^([A-Z_]+)='(.*)'$") { $map[$Matches[1]] = $Matches[2] }
}
$SLUG = $map['JDI_PHASE_SLUG']
$DIR  = $map['JDI_PHASE_DIR']

$script:FAILS = 0
$script:STATUS = 'pending'

# Present + all markers -> ok; present + marker missing -> invalid (fail);
# absent -> missing (fail) only with --for-pr.
function Check([string]$file, [string]$statusIfOk, [string]$fix, [string]$markerDesc, [string[]]$markers) {
  $path = Join-Path $DIR $file

  if (-not (Test-Path $path)) {
    if ($ForPr) {
      Say "[missing] $file - required for PR. Fix: $fix"
      $script:FAILS++
    } else {
      Say "[absent] $file - next: $fix"
    }
    return
  }

  $content = Get-Content -Raw $path
  foreach ($m in $markers) {
    if ($content -notmatch "(?m)$m") {
      Say "[invalid] $file - expected $markerDesc (missing: $m). Fix: $fix"
      $script:FAILS++
      return
    }
  }

  Say "[ok] $file - $markerDesc"
  $script:STATUS = $statusIfOk
}

# Ordered per the derived-status ladder (MEMORY.md): each ok advances STATUS.
Check 'CONTEXT.md' 'discussed' "/jdi-discuss $SLUG" `
  'Definition of Done with executable Verify: lines' `
  @('^## Definition of Done', 'Verify:')

Check 'PLAN.md' 'planned' "/jdi-plan $SLUG" `
  'tasks with Files modified/Acceptance/Dependencies/Test' `
  @('^#### T-', '\*\*Files modified:\*\*', '\*\*Acceptance:\*\*', '\*\*Dependencies:\*\*', '\*\*Test:\*\*')

Check 'SUMMARY.md' 'executed' "/jdi-do $SLUG" `
  'at least one task result line' `
  @('^- T-')

Check 'REVIEW.md' 'verified' "/jdi-verify $SLUG" `
  'a verdict line' `
  @('(Verdict|Veredicto):\*\* (APPROVED|APPROVED_WITH_WARNINGS|APPROVED_PENDING_MANUAL|BLOCKED)')

Check 'SHIPPED.md' 'done' "/jdi-ship $SLUG" `
  'the ship marker with verdict' `
  @('^verdict:')

# --for-pr: verdict must release the ship (worst-case across lines, like /jdi-loop).
$reviewPath = Join-Path $DIR 'REVIEW.md'
if ($ForPr -and (Test-Path $reviewPath)) {
  $verdicts = (Select-String -Path $reviewPath -Pattern '(Verdict|Veredicto):\*\* (APPROVED|APPROVED_WITH_WARNINGS|APPROVED_PENDING_MANUAL|BLOCKED)' -AllMatches).Matches |
    ForEach-Object { $_.Groups[2].Value }
  if ($verdicts -contains 'BLOCKED') {
    Say '[fail] REVIEW.md verdict is BLOCKED - blocked work is never shipped'
    $script:FAILS++
  } elseif ($verdicts -contains 'APPROVED_PENDING_MANUAL') {
    Say '[fail] REVIEW.md verdict is APPROVED_PENDING_MANUAL - autonomous chains require dod=auto_only (no human to confirm)'
    $script:FAILS++
  }
}

Say "derived status: $script:STATUS (phase $SLUG)"

if ($script:FAILS -gt 0) {
  Say "validate-phase: FAIL ($script:FAILS problem(s))"
  exit 1
}
Say 'validate-phase: PASS'
exit 0
