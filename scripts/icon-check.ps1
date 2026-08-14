Add-Type -AssemblyName System.Drawing
$b = [System.Drawing.Bitmap]::FromFile('C:\Users\19365\Desktop\dsh\dsh-desktop\build\icon.png')
Write-Host ('size: ' + $b.Width + 'x' + $b.Height)
Write-Host ('corner(2,2): ' + $b.GetPixel(2, 2))
Write-Host ('center(128,128): ' + $b.GetPixel(128, 128))
Write-Host ('mid-top(128,20): ' + $b.GetPixel(128, 20))
Write-Host ('text-zone(100,128): ' + $b.GetPixel(100, 128))
$b.Dispose()
