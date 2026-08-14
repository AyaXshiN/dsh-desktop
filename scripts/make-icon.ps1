# 生成应用图标 build/icon.png（幂等，可重复运行）
# 用法: npm run icon（兼容 Windows PowerShell 5.1 / .NET Framework）
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$OutDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'build'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

# 圆角矩形路径
$r = 56
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $r, $r, 180, 90)
$path.AddArc($size - $r, 0, $r, $r, 270, 90)
$path.AddArc($size - $r, $size - $r, $r, $r, 0, 90)
$path.AddArc(0, $size - $r, $r, $r, 90, 90)
$path.CloseFigure()

# 深蓝底（静态画刷，规避 PS5.1 下 New-Object 构造 Brush 的兼容问题）
$g.FillPath([System.Drawing.Brushes]::RoyalBlue, $path)

# 白色 DSH 字样
$font = New-Object System.Drawing.Font('Segoe UI', [single]88, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$textRect = New-Object System.Drawing.RectangleF([single]0, [single]-6, [single]$size, [single]$size)
$g.DrawString('DSH', $font, [System.Drawing.Brushes]::White, $textRect, $sf)
$g.Dispose()

$pngPath = [System.IO.Path]::Combine($OutDir, 'icon.png')
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "written: $pngPath"
