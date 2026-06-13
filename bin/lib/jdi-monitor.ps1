# jdi-monitor.ps1 — context budget monitor (heuristica)
#
# Uso:
#   pwsh -File jdi-monitor.ps1 -Paths @("a.md","b.md")
#
# Estima tokens consumidos por leitura inline dos paths informados
# (heuristica chars/4 = tokens). Le .jdi/config.json pra resolver
# context_window + thresholds. Imprime status pra stderr e sai 0.
#
# Status:
#   PEAK     0-30%   ok, full operations
#   GOOD     30-60%  ok, prefere frontmatter
#   WARN     60-70%  context aquecendo, considere checkpoint
#   CRITICAL 70%+    fracture zone — sugere /jdi-thread

param(
  [string[]]$Paths = @()
)

$ErrorActionPreference = "Stop"

# Defaults
$ContextWindow = 200000
$WarnPct = 60
$CriticalPct = 70

if (Test-Path -LiteralPath ".jdi/config.json") {
  try {
    $cfg = Get-Content -LiteralPath ".jdi/config.json" -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.context_window) { $ContextWindow = [int]$cfg.context_window }
    if ($cfg.thresholds) {
      if ($cfg.thresholds.warn_pct) { $WarnPct = [int]$cfg.thresholds.warn_pct }
      if ($cfg.thresholds.critical_pct) { $CriticalPct = [int]$cfg.thresholds.critical_pct }
    }
  } catch {
    # config invalido — usa defaults
    Write-Verbose "jdi-monitor: failed to parse .jdi/config.json, using defaults: $($_.Exception.Message)"
  }
}

$totalChars = 0
foreach ($p in $Paths) {
  if (Test-Path -LiteralPath $p -PathType Leaf) {
    $totalChars += (Get-Item -LiteralPath $p).Length
  }
}

$tokens = [int]([math]::Floor($totalChars / 4))
$pct = if ($ContextWindow -gt 0) { [int]([math]::Floor($tokens * 100 / $ContextWindow)) } else { 0 }

$state = "PEAK"
$hint = ""
if ($pct -ge $CriticalPct) {
  $state = "CRITICAL"
  $hint = "fracture zone — considere /jdi-thread (proxima phase em sessao nova)"
} elseif ($pct -ge $WarnPct) {
  $state = "WARN"
  $hint = "context aquecendo — checkpoint recomendado"
} elseif ($pct -ge 30) {
  $state = "GOOD"
}

$msg = "[jdi-monitor] $state ${pct}% (~${tokens} tokens / ${ContextWindow})"
if ($hint) { $msg = "$msg. $hint" }

[Console]::Error.WriteLine($msg)
exit 0
