# Adds dated statement-action pairs for say-do cards (manual vote blocks, for now).
#   scripts\saydo.ps1 -File pairs.json
# pairs.json holds one pair or a list of them, e.g.
#   [{ "actor": "Senator Alvarez", "trigger": "credit_taking",
#      "statement_text": "Said she delivered the Northvale Bridge Act.", "statement_date": "2026-10-12",
#      "statement_url": "https://...",
#      "action_text": "Voted no on the Northvale Bridge Act (S. 214, roll call 88).", "action_date": "2025-06-12",
#      "action_url": "https://...", "relation": "gap",
#      "bundled_context": "included a 0.5% fuel-tax increase", "stated_reason": "Opposed the fuel tax, not the bridge.",
#      "stated_reason_url": "https://..." }]
# trigger: credit_taking | accusation | promise | position. relation: match | gap.
# Describe what was said and done; character labels are refused. Doesn't call the Claude API.

param([Parameter(Mandatory)][string]$File)

$root = Split-Path $PSScriptRoot -Parent
$settings = @{}
Get-Content (Join-Path $root '.env') | Where-Object { $_ -match '^(\w+)=(.*)$' } | ForEach-Object {
    $settings[$Matches[1]] = $Matches[2]
}

# Windows PowerShell 5.1 passes a JSON list on as one object; piping it again unrolls it.
$pairs = @(Get-Content -Raw -Encoding UTF8 $File | ConvertFrom-Json | ForEach-Object { $_ })
foreach ($pair in $pairs) {
    $body = @{ action = 'add_say_do'; pair = $pair } | ConvertTo-Json -Depth 5
    try {
        $reply = Invoke-RestMethod -Method Post -TimeoutSec 60 `
            -Uri "$($settings.SUPABASE_URL)/functions/v1/verify-api" `
            -Headers @{ 'x-teemverify-token' = $settings.TEEMVERIFY_TOKEN } `
            -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
        "Added: $($pair.actor) - $($pair.action_text) ($($reply.id))"
    } catch {
        $message = $_.ErrorDetails.Message
        if (-not $message -and $_.Exception.Response) {
            $message = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd()
        }
        "Not added: $($pair.actor) - $($pair.action_text): $message"
    }
}
