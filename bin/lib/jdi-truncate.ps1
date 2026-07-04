# jdi-truncate.ps1 - markdown-aware truncation pra context budget
#
# Uso:
#   pwsh -File jdi-truncate.ps1 -Path <path> [-Budget 8192]
#
# Estrategia:
#   - Preserva YAML frontmatter inteiro
#   - Preserva TODAS as linhas de heading (#, ##, ...)
#   - Preserva 1a linha nao-vazia de cada secao
#   - Resto vira "[... N lines omitted]"
#   - Footer aponta pro arquivo original
#
# Se file <= budget, ecoa inteiro. Output sempre pra stdout.

param(
  [Parameter(Mandatory = $true)]
  [string]$Path,

  [int]$Budget = 8192
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
  Write-Error "arquivo nao encontrado: $Path"
  exit 1
}

$content = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
if ($null -eq $content) { $content = "" }

if ($content.Length -le $Budget) {
  Write-Output $content
  exit 0
}

$lines = $content -split "`r?`n"
$inFrontmatter = $false
$paragraphKept = $false
$omitted = 0
$out = New-Object System.Collections.Generic.List[string]

for ($i = 0; $i -lt $lines.Length; $i++) {
  $line = $lines[$i]

  # Frontmatter (so se comecar na linha 1 = index 0)
  if ($i -eq 0 -and $line -eq "---") {
    $inFrontmatter = $true
    $out.Add($line)
    continue
  }
  if ($inFrontmatter) {
    $out.Add($line)
    if ($line -eq "---") {
      $inFrontmatter = $false
    }
    continue
  }

  # Heading - sempre preserva
  if ($line -match '^#{1,6}\s') {
    if ($omitted -gt 0) {
      $out.Add("[... $omitted lines omitted]")
      $omitted = 0
    }
    $out.Add($line)
    $paragraphKept = $false
    continue
  }

  # Linha vazia
  if ($line -match '^\s*$') {
    if (-not $paragraphKept) {
      $out.Add($line)
    } else {
      $omitted++
    }
    continue
  }

  # Conteudo
  if (-not $paragraphKept) {
    $out.Add($line)
    $paragraphKept = $true
  } else {
    $omitted++
  }
}

if ($omitted -gt 0) {
  $out.Add("[... $omitted lines omitted]")
}
$out.Add("")
$out.Add("[Truncated by jdi-truncate. Read $Path for full content]")

Write-Output ($out -join "`n")
