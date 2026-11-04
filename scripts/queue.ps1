# Talks to the research queue for Claude Code sessions (see .claude/skills/research-queue and
# .claude/skills/research-batch).
#   scripts\queue.ps1 next [-Limit 10] [-Stream becket_pick|page|trending|fact_checker_seed]
#                                           prints queued claims as JSON, most-seen first
#   scripts\queue.ps1 submit -File x.json   sends findings: {"results":[{"queue_id":...,"items":[...]}]}
#   scripts\queue.ps1 match -Text "..."     stored claims close in meaning (to skip duplicates)
#   scripts\queue.ps1 stats -Since <ISO>    what research produced since then (batch report)
#   scripts\queue.ps1 log -Since <ISO> [-Target 50] [-NotionUrl ...]   logs a finished batch run
# None of these calls the Claude API, so none spends API money.

param(
    [Parameter(Mandatory, Position = 0)][ValidateSet('next', 'submit', 'match', 'stats', 'log')][string]$Command,
    [int]$Limit = 10,
    [string]$File,
    [ValidateSet('', 'becket_pick', 'page', 'trending', 'fact_checker_seed')][string]$Stream = '',
    [string]$Text,
    [string]$Since,
    [int]$Target = 0,
    [string]$NotionUrl
)

$root = Split-Path $PSScriptRoot -Parent
$settings = @{}
Get-Content (Join-Path $root '.env') | Where-Object { $_ -match '^(\w+)=(.*)$' } | ForEach-Object {
    $settings[$Matches[1]] = $Matches[2]
}

function Invoke-VerifyApi($body) {
    try {
        Invoke-RestMethod -Method Post -TimeoutSec 300 `
            -Uri "$($settings.SUPABASE_URL)/functions/v1/verify-api" `
            -Headers @{ 'x-teemverify-token' = $settings.TEEMVERIFY_TOKEN } `
            -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
    } catch {
        # Windows PowerShell 5.1 hides the server's error message unless it's read from the stream.
        $message = $_.ErrorDetails.Message
        if (-not $message -and $_.Exception.Response) {
            $message = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd()
        }
        throw "verify-api: $message"
    }
}

switch ($Command) {
    'next' {
        $request = @{ action = 'queue_next'; limit = $Limit }
        if ($Stream) { $request.stream = $Stream }
        Invoke-VerifyApi ($request | ConvertTo-Json) | ConvertTo-Json -Depth 6
    }
    'submit' {
        if (-not $File) { throw 'submit needs -File' }
        $payload = Get-Content -Raw -Encoding UTF8 $File | ConvertFrom-Json
        $body = @{ action = 'submit_results'; results = $payload.results } | ConvertTo-Json -Depth 10
        Invoke-VerifyApi $body | ConvertTo-Json -Depth 6
    }
    'match' {
        if (-not $Text) { throw 'match needs -Text' }
        Invoke-VerifyApi (@{ action = 'match'; text = $Text; threshold = 0.8; count = 5 } | ConvertTo-Json) | ConvertTo-Json -Depth 6
    }
    'stats' {
        if (-not $Since) { throw 'stats needs -Since' }
        Invoke-VerifyApi (@{ action = 'batch_stats'; since = $Since } | ConvertTo-Json) | ConvertTo-Json -Depth 6
    }
    'log' {
        if (-not $Since) { throw 'log needs -Since' }
        $request = @{ action = 'batch_log'; started_at = $Since }
        if ($Target) { $request.block_target = $Target }
        if ($NotionUrl) { $request.notion_url = $NotionUrl }
        Invoke-VerifyApi ($request | ConvertTo-Json) | ConvertTo-Json -Depth 6
    }
}
