# Downloads the latest tablet order pad (from the HPOS repository) so this server can serve it to the tablets.
$dest = Join-Path $PSScriptRoot "tablet\index.html"
New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/roshrpa/HPOS/main/index.html" -OutFile $dest
Write-Host "Tablet order pad updated:" $dest
