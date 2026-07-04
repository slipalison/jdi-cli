<#
.SYNOPSIS
  jdi-install-caveman (Windows): clones caveman plugin into Claude Code plugins dir.

.DESCRIPTION
  Optional install. Caveman is an ultra-compressed communication mode plugin for
  Claude Code (skills, commands, hooks). Default repo:
  https://github.com/JuliusBrussee/caveman

  Idempotent: if target dir exists, asks overwrite/keep/cancel.

.PARAMETER Repo
  Git URL of the caveman plugin. Default: https://github.com/JuliusBrussee/caveman.git

.PARAMETER Scope
  user (default)   -> ~/.claude/plugins/caveman/
  project          -> ./.claude/plugins/caveman/

.PARAMETER Force
  Overwrite existing install without prompting.

.EXAMPLE
  .\bin\jdi-install-caveman.ps1
  .\bin\jdi-install-caveman.ps1 -Scope project
  .\bin\jdi-install-caveman.ps1 -Repo https://github.com/forked/caveman.git -Force
#>
[CmdletBinding()]
param(
  [string]$Repo = 'https://github.com/JuliusBrussee/caveman.git',
  [ValidateSet('user','project')]
  [string]$Scope = 'user',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProjectDir = (Get-Location).Path
$UserHome = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }

$baseDir = if ($Scope -eq 'user') { Join-Path $UserHome '.claude\plugins' } else { Join-Path $ProjectDir '.claude\plugins' }
$target = Join-Path $baseDir 'caveman'

Write-Output ''
Write-Output '=== JDI: Install Caveman plugin ==='
Write-Output ''
Write-Output "  Repo:   $Repo"
Write-Output "  Scope:  $Scope"
Write-Output "  Target: $target"
Write-Output ''

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Error "git not in PATH. Install git and retry."
  exit 1
}

if (Test-Path $target) {
  if (-not $Force) {
    Write-Output "  Target exists."
    $answer = Read-Host "  Overwrite? (y/N)"
    if ($answer -notmatch '^[yY]') {
      Write-Output "  Skipped."
      exit 0
    }
  }
  Write-Output "  Removing old install..."
  Remove-Item -Recurse -Force $target
}

New-Item -ItemType Directory -Force -Path $baseDir | Out-Null

Write-Output "  Cloning..."
if ($Repo -notmatch '^(https://|git@)[\w.@:/-]+$') {
  Write-Error "Repo invalido (esperado https:// ou git@): $Repo"
  exit 1
}
& git clone --depth 1 -- $Repo $target 2>&1 | ForEach-Object { Write-Output "    $_" }

if ($LASTEXITCODE -ne 0) {
  Write-Error "git clone failed (exit $LASTEXITCODE)."
  exit $LASTEXITCODE
}

# Verify it looks like a Claude Code plugin
$looksValid = (Test-Path (Join-Path $target 'plugin.json')) -or
              (Test-Path (Join-Path $target '.claude-plugin')) -or
              (Test-Path (Join-Path $target 'skills')) -or
              (Test-Path (Join-Path $target 'commands')) -or
              (Test-Path (Join-Path $target 'agents'))

if (-not $looksValid) {
  Write-Warning "  Cloned repo does not look like a Claude Code plugin (no plugin.json / skills/ / commands/ / agents/)."
  Write-Warning "  Keeping clone but verify manually: $target"
}

Write-Output ''
Write-Output "Caveman installed at: $target"
Write-Output ''
Write-Output "Next steps:"
Write-Output "  1. Restart Claude Code (or run /plugin reload)"
Write-Output "  2. Verify with: /caveman-help"
Write-Output "  3. Toggle mode: /caveman lite|full|ultra"
Write-Output ''
