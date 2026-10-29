# Sends a few sentences to the "lookup" (cheap) or "check" (researched) action and prints the results.
# Usage: scripts\try-check.ps1 [-Action lookup|check] "First sentence." "Second sentence."
# Each run can spend a little real money (logged in api_spend, counted against the daily cap).

param(
    [ValidateSet('lookup', 'check')][string]$Action = 'lookup',
    [Parameter(Mandatory, ValueFromRemainingArguments)][string[]]$Sentences
)

$root = Split-Path $PSScriptRoot -Parent
$settings = @{}
Get-Content (Join-Path $root '.env') | Where-Object { $_ -match '^(\w+)=(.*)$' } | ForEach-Object {
    $settings[$Matches[1]] = $Matches[2]
}

$body = @{ action = $Action; url = 'test://try-check'; sentences = $Sentences; daily_cap_usd = 5 } | ConvertTo-Json
$reply = Invoke-RestMethod -Method Post -TimeoutSec 300 `
    -Uri "$($settings.SUPABASE_URL)/functions/v1/verify-api" `
    -Headers @{ 'x-teemverify-token' = $settings.TEEMVERIFY_TOKEN } `
    -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body))

foreach ($r in $reply.results) {
    Write-Host "`n[$($r.status)] $($r.sentence)"
    if ($r.error) { Write-Host "  error: $($r.error)" }
    foreach ($i in $r.items) {
        $tier = if ($null -ne $i.tier) { " tier $($i.tier)" } else { '' }
        Write-Host "  - $($i.kind)$tier : $($i.text)"
        Write-Host "    why: $($i.reason)"
        foreach ($e in $i.exhibits) { Write-Host "    exhibit ($($e.source_type)): $($e.url)" }
    }
}
Write-Host ("`nSpent today: `${0:N3}" -f $reply.spent_today_usd)
