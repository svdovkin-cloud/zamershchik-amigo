# Временный статический сервер для локальной проверки фронтенда.
#   powershell -ExecutionPolicy Bypass -File tools\static-server.ps1 -Port 8787
# Отдаёт только файлы внутри папки проекта, слушает исключительно 127.0.0.1.
param([int]$Port = 8787)

$root = Split-Path -Parent $PSScriptRoot
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "Слушаю http://127.0.0.1:$Port/ (корень: $root)"

$MIME = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.mjs'  = 'application/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.webmanifest' = 'application/manifest+json; charset=utf-8'
  '.png'  = 'image/png'
  '.svg'  = 'image/svg+xml'
}

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $relative = [System.Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
    if (-not $relative) { $relative = 'index.html' }
    $file = [System.IO.Path]::GetFullPath((Join-Path $root $relative))

    if (-not $file.StartsWith($root) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
      $context.Response.StatusCode = 404
      $context.Response.Close()
      continue
    }

    $ext = [System.IO.Path]::GetExtension($file).ToLower()
    $bytes = [System.IO.File]::ReadAllBytes($file)
    $context.Response.ContentType = $MIME[$ext]
    $context.Response.ContentLength64 = $bytes.Length
    $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $context.Response.Close()
  }
} finally {
  $listener.Stop()
}