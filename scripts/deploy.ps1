# Deploys the verify-api server function to Supabase.
# Needs the Supabase command-line tool, signed in once with "supabase login".

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
& 'C:\Users\jbeck\tools\supabase-cli\supabase.exe' functions deploy verify-api `
    --project-ref hfbmawmztowmjkphbqmg --no-verify-jwt --use-api
