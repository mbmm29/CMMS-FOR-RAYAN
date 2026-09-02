$siteRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add('http://127.0.0.1:4173/')
$listener.Start()

$mimeTypes = @{
    '.css' = 'text/css; charset=utf-8'
    '.html' = 'text/html; charset=utf-8'
    '.js' = 'application/javascript; charset=utf-8'
    '.webmanifest' = 'application/manifest+json; charset=utf-8'
    '.jpeg' = 'image/jpeg'
    '.jpg' = 'image/jpeg'
    '.png' = 'image/png'
}

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $relativePath = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
    if ([string]::IsNullOrWhiteSpace($relativePath)) { $relativePath = 'index.html' }

    $targetPath = [IO.Path]::GetFullPath((Join-Path $siteRoot $relativePath))
    if (-not $targetPath.StartsWith($siteRoot, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
        $context.Response.StatusCode = 404
        $context.Response.Close()
        continue
    }

    $extension = [IO.Path]::GetExtension($targetPath).ToLowerInvariant()
    $contentType = $mimeTypes[$extension]
    if (-not $contentType) { $contentType = 'application/octet-stream' }
    $context.Response.ContentType = $contentType
    $content = [IO.File]::ReadAllBytes($targetPath)
    $context.Response.ContentLength64 = $content.Length
    $context.Response.OutputStream.Write($content, 0, $content.Length)
    $context.Response.Close()
}
