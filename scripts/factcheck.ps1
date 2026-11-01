# Looks a claim up in Google Fact Check Tools, live, for /research-queue.
#   scripts\factcheck.ps1 "claim text"
# Prints fact-checks by admitted outlets (SOURCES.md) as JSON. Google's API terms forbid
# storing these results as a database: use them as leads to open and cite, never save them.
# Needs GOOGLE_FACTCHECK_KEY in .env (Google Cloud > Fact Check Tools API > API key).

param([Parameter(Mandatory, Position = 0)][string]$Claim)

$root = Split-Path $PSScriptRoot -Parent
$settings = @{}
Get-Content (Join-Path $root '.env') | Where-Object { $_ -match '^(\w+)=(.*)$' } | ForEach-Object {
    $settings[$Matches[1]] = $Matches[2]
}
if (-not $settings.GOOGLE_FACTCHECK_KEY) { throw 'GOOGLE_FACTCHECK_KEY is not set in .env' }

# Admitted fact-checkers' web addresses, read from sources.ts so there is one list.
$sources = Get-Content -Raw (Join-Path $root 'supabase\functions\verify-api\sources.ts')
$sites = [regex]::Matches($sources, '"([a-z0-9.-]+\.[a-z]+)": "') | ForEach-Object { $_.Groups[1].Value }

$query = [uri]::EscapeDataString($Claim.Substring(0, [Math]::Min(300, $Claim.Length)))
$reply = Invoke-RestMethod -TimeoutSec 30 `
    -Uri "https://factchecktools.googleapis.com/v1alpha1/claims:search?query=$query&languageCode=en&pageSize=20&key=$($settings.GOOGLE_FACTCHECK_KEY)"

$leads = foreach ($claim in $reply.claims) {
    foreach ($review in $claim.claimReview) {
        $hostName = ([uri]$review.url).Host.ToLower() -replace '^www\.', ''
        $site = $sites | Where-Object { $hostName -eq $_ -or $hostName.EndsWith(".$_") } | Select-Object -First 1
        if ($site) {
            [pscustomobject]@{
                outlet = $review.publisher.name; url = $review.url; claim = $claim.text
                claimant = $claim.claimant; rating = $review.textualRating; published = $review.reviewDate
            }
        }
    }
}
ConvertTo-Json -Depth 4 @($leads)
