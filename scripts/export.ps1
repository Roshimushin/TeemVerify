# Downloads the whole block store as one JSON file into the exports folder.
# Reads the function address and token from the .env file in the project folder.

$root = Split-Path $PSScriptRoot -Parent
$settings = @{}
Get-Content (Join-Path $root '.env') | Where-Object { $_ -match '^(\w+)=(.*)$' } | ForEach-Object {
    $settings[$Matches[1]] = $Matches[2]
}

$outDir = Join-Path $root 'exports'
New-Item -ItemType Directory -Force $outDir | Out-Null
$outFile = Join-Path $outDir ("teemverify-export-{0}.json" -f (Get-Date -Format 'yyyy-MM-dd-HHmm'))

Invoke-WebRequest -UseBasicParsing -Method Post `
    -Uri "$($settings.SUPABASE_URL)/functions/v1/verify-api" `
    -Headers @{ 'x-teemverify-token' = $settings.TEEMVERIFY_TOKEN } `
    -ContentType 'application/json' -Body '{"action":"export"}' `
    -OutFile $outFile

Write-Host "Saved $outFile"
