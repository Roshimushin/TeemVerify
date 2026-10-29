# Runs a whole page's sentences through "lookup" the way the extension does, and reports
# what happened and what it cost. Input: a JSON file {"url": "...", "sentences": ["...", ...]}.
# Usage: scripts\try-page.ps1 -File page.json

param([Parameter(Mandatory)][string]$File)

$root = Split-Path $PSScriptRoot -Parent
$settings = @{}
Get-Content (Join-Path $root '.env') | Where-Object { $_ -match '^(\w+)=(.*)$' } | ForEach-Object {
    $settings[$Matches[1]] = $Matches[2]
}

function Invoke-VerifyApi($body) {
    Invoke-RestMethod -Method Post -TimeoutSec 300 `
        -Uri "$($settings.SUPABASE_URL)/functions/v1/verify-api" `
        -Headers @{ 'x-teemverify-token' = $settings.TEEMVERIFY_TOKEN } `
        -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 5)))
}

$page = Get-Content -Raw -Encoding UTF8 $File | ConvertFrom-Json
$before = (Invoke-VerifyApi @{ action = 'spend' }).spent_today_usd
$counts = @{}
$started = Get-Date
for ($i = 0; $i -lt $page.sentences.Count; $i += 8) {
    $chunk = @($page.sentences[$i..([Math]::Min($i + 7, $page.sentences.Count - 1))])
    $reply = Invoke-VerifyApi @{ action = 'lookup'; url = $page.url; sentences = $chunk; daily_cap_usd = 5 }
    foreach ($r in $reply.results) { $counts[$r.status] = 1 + [int]$counts[$r.status] }
}
$after = (Invoke-VerifyApi @{ action = 'spend' }).spent_today_usd

Write-Host "$($page.sentences.Count) sentences in $([int]((Get-Date) - $started).TotalSeconds)s"
$counts.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Host ("  {0}: {1}" -f $_.Name, $_.Value) }
Write-Host ("Cost: `${0:N4}" -f ($after - $before))
