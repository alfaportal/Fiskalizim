# Revolution Fiskalizim — instalim / rregullim printeri Tysso (USB001)
# Ekzekutoni si Administrator: klik djathtas → Run with PowerShell

$ErrorActionPreference = 'Stop'
$mainName = 'Tysso Thermal Receipt Printer'
$driverName = 'Tysso Thermal Receipt Printer'
$usbPort = 'USB001'
$driverExe = Join-Path $env:USERPROFILE 'Desktop\Printer Driver of PRP-188 PRP-250 PRP-350.exe'

Write-Host '=== Revolution Fiskalizim — Tysso USB ===' -ForegroundColor Cyan

if (-not (Get-PrinterDriver -Name $driverName -ErrorAction SilentlyContinue)) {
  if (Test-Path -LiteralPath $driverExe) {
    Write-Host "Instaloj driverin PRP/Tysso: $driverExe"
    Start-Process -FilePath $driverExe -Wait
  } else {
    Write-Host "KUJDES: Nuk u gjet driveri. Vendoseni në Desktop:" -ForegroundColor Yellow
    Write-Host "  Printer Driver of PRP-188 PRP-250 PRP-350.exe"
  }
}

$main = Get-Printer -Name $mainName -ErrorAction SilentlyContinue
if ($main) {
  if ($main.PortName -ne $usbPort) {
    Write-Host "Ndryshoj portin: $($main.PortName) -> $usbPort"
    Set-Printer -Name $mainName -PortName $usbPort
  }
} elseif (Get-PrinterDriver -Name $driverName -ErrorAction SilentlyContinue) {
  Write-Host "Shtoj printerin $mainName në $usbPort"
  Add-Printer -Name $mainName -DriverName $driverName -PortName $usbPort
}

Get-Printer -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -like 'Tysso*' -and $_.Name -match 'Copy'
} | ForEach-Object {
  Write-Host "Heq kopjen e vjetër: $($_.Name)"
  Remove-Printer -Name $_.Name -ErrorAction SilentlyContinue
}

$final = Get-Printer -Name $mainName -ErrorAction SilentlyContinue
if ($final) {
  Write-Host ''
  Write-Host 'OK — Printeri gati:' -ForegroundColor Green
  Write-Host "  Emri:   $($final.Name)"
  Write-Host "  Porti:  $($final.PortName)"
  Write-Host "  Status: $($final.PrinterStatus)"
} else {
  Write-Host ''
  Write-Host 'Dështoi — lidhni printerin me USB dhe provoni përsëri.' -ForegroundColor Red
  exit 1
}
