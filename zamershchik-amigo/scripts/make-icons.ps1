# Иконки PWA — то же рисунок, что scripts/make-icons.mjs, но без Node.
# Нужен на компьютере, где ещё не установлен Node: правый клик → «Запуск с помощью PowerShell».
#   powershell -ExecutionPolicy Bypass -File scripts\make-icons.ps1

Add-Type -AssemblyName System.Drawing

$outDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'public\icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$bg      = [System.Drawing.Color]::FromArgb(255, 22, 42, 68)
$frame   = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
$slat    = [System.Drawing.Color]::FromArgb(255, 255, 176, 32)
$warm    = [System.Drawing.Color]::FromArgb(255, 255, 214, 140)
$glass   = [System.Drawing.Color]::FromArgb(255, 214, 231, 244)

function New-RoundedPath([System.Drawing.RectangleF]$rect, [float]$radius) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
  $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-Icon([int]$size, [double]$padding) {
  $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $full = [System.Drawing.RectangleF]::new(0, 0, $size, $size)
  $g.FillPath((New-Object System.Drawing.SolidBrush($bg)), (New-RoundedPath $full ($size * 0.22)))

  $box = [float]($size * (1 - $padding * 2))
  $ox = [float](($size - $box) / 2)
  $oy = $ox

  $g.FillPath((New-Object System.Drawing.SolidBrush($frame)), (New-RoundedPath ([System.Drawing.RectangleF]::new($ox, $oy, $box, $box)) ($size * 0.04)))

  $pad = [float]($box * 0.09)
  $glassRect = [System.Drawing.RectangleF]::new($ox + $pad, $oy + $pad, $box - $pad * 2, $box - $pad * 2)
  $g.FillPath((New-Object System.Drawing.SolidBrush($glass)), (New-RoundedPath $glassRect ($size * 0.025)))

  $slatPad = [float]($box * 0.16)
  $slatArea = [float]($box - $slatPad * 2)
  $slats = 4
  $slatHeight = [float][Math]::Max(2, $slatArea * 0.17)
  $gap = [float](($slatArea - $slats * $slatHeight) / ($slats - 1))

  for ($i = 0; $i -lt $slats; $i++) {
    $y = [float]($oy + $slatPad + $i * ($slatHeight + $gap))
    $rect = [System.Drawing.RectangleF]::new($ox + $slatPad, $y, $slatArea, $slatHeight)
    $brush = New-Object System.Drawing.SolidBrush($(if ($i % 2) { $warm } else { $slat }))
    $g.FillPath($brush, (New-RoundedPath $rect ($slatHeight / 2)))
  }

  # шнур управления
  $cordBrush = New-Object System.Drawing.SolidBrush($frame)
  $cordX = [float]($ox + $box - $box * 0.06)
  for ($y = [int]($oy + $slatPad); $y -lt [int]($oy + $box - $slatPad); $y += 3) {
    $g.FillRectangle($cordBrush, $cordX, $y, [float]($size * 0.012), 2)
  }

  $g.Dispose()
  return $bitmap
}

$targets = @(
  @{ file = 'icon-192.png';        size = 192; padding = 0.14 },
  @{ file = 'icon-512.png';        size = 512; padding = 0.14 },
  @{ file = 'maskable-512.png';    size = 512; padding = 0.26 },
  @{ file = 'apple-touch-icon.png'; size = 180; padding = 0.16 }
)

foreach ($target in $targets) {
  $icon = New-Icon $target.size $target.padding
  $file = Join-Path $outDir $target.file
  $icon.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $icon.Dispose()
  $kb = [Math]::Round((Get-Item $file).Length / 1KB, 1)
  Write-Host "  $($target.file)  $($target.size)x$($target.size)  $kb KB"
}

Write-Host "Иконки записаны в $outDir"