param(
  [string]$DbPath = ".\\realistic-test.sqlite",
  [string]$WorkspaceRoot = "..",
  [string]$OllamaBaseUrl = "http://192.168.1.168:11434",
  [string]$EmbeddingModel = "bge-m3",
  [int]$Limit = 5
)

$ErrorActionPreference = "Stop"

$cli = "node .\\packages\\cli\\dist\\cli.js"

Write-Host "[1/4] Init DB: $DbPath"
& $cli --db $DbPath init | Out-Host

Write-Host "[2/4] Index MEMORY.md"
$memoryMd = Join-Path $WorkspaceRoot "MEMORY.md"
if (Test-Path $memoryMd) {
  Get-Content $memoryMd -Raw -Encoding UTF8 | & $cli --db $DbPath remember --source file --source-id "MEMORY.md" | Out-Host
}

Write-Host "[3/4] Index daily logs memory\\*.md (excluding personal.md)"
$dailyDir = Join-Path $WorkspaceRoot "memory"
Get-ChildItem $dailyDir -Filter "*.md" | Where-Object { $_.Name -ne "personal.md" } | ForEach-Object {
  $p = $_.FullName
  Get-Content $p -Raw -Encoding UTF8 | & $cli --db $DbPath remember --title $_.Name --source file --source-id $p | Out-Host
}

Write-Host "[4/4] Example hybrid queries"
$queries = @(
  "c'est quoi le plan revenue / 800€/mois ?",
  "pourquoi memory-lancedb est unavailable ?"
)

foreach ($q in $queries) {
  Write-Host "\n--- QUERY: $q"
  & $cli --db $DbPath search $q --hybrid --ollama-base-url $OllamaBaseUrl --embedding-model $EmbeddingModel --ollama-timeout-ms 5000 --limit $Limit | Out-Host
}
