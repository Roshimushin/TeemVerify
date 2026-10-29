# Talks to the research queue for Claude Code sessions (see .claude/skills/research-queue).
#   scripts\queue.ps1 next [-Limit 10]      prints queued claims as JSON, most-seen first
#   scripts\queue.ps1 submit -File x.json   sends findings: {"results":[{"queue_id":...,"items":[...]}]}
# Neither command calls the Claude API, so neither spends API money.

param(
    [Parameter(Mandatory, Position = 0)][ValidateSet('next', 'submit')][string]$Command,
    [int]$Limit = 10,
    [string]$File
)

$root = Split-Path $PSScriptRoot -Parent
$settings = @{}
Get-Content (Join-Path $root '.env') | Where-Object { $_ -match '^(\w+)=(.*)$' } | ForEach-Object {
    $settings[$Matches[1]] = $Matches[2]
}

function Invoke-VerifyApi($body) {
    Invoke-RestMethod -Method Post -TimeoutSec 300 `
        -Uri "$($settings.SUPABASE_URL)/functions/v1/verify-api" `
        -Headers @{ 'x-teemverify-token' = $settings.TEEMVERIFY_TOKEN } `
        -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
}

if ($Command -eq 'next') {
    Invoke-VerifyApi (@{ action = 'queue_next'; limit = $Limit } | ConvertTo-Json) | ConvertTo-Json -Depth 6
} else {
    if (-not $File) { throw 'submit needs -File' }
    $payload = Get-Content -Raw -Encoding UTF8 $File | ConvertFrom-Json
    $body = @{ action = 'submit_results'; results = $payload.results } | ConvertTo-Json -Depth 10
    Invoke-VerifyApi $body | ConvertTo-Json -Depth 6
}
