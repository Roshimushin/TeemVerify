# Serves the project folder at http://localhost:8765/ so design-preview/index.html can be
# opened in a browser with its scripts running. Stop with Ctrl+C.

param([int]$Port = 8765)

$root = Split-Path $PSScriptRoot -Parent
$types = @{ '.html' = 'text/html'; '.css' = 'text/css'; '.js' = 'text/javascript'; '.json' = 'application/json'; '.png' = 'image/png'; '.svg' = 'image/svg+xml' }
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $root at http://localhost:$Port/"

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $path = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
    if (-not $path) { $path = 'design-preview/index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $root $path))
    if ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf)) {
        $bytes = [IO.File]::ReadAllBytes($file)
        $type = $types[[IO.Path]::GetExtension($file)]
        $context.Response.ContentType = if ($type) { "$type; charset=utf-8" } else { 'application/octet-stream' }
        $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $context.Response.StatusCode = 404
    }
    $context.Response.Close()
}
