# Hiq konfigurimin e gabuar HID për Tysso (VID 3554) — pastaj rilidh USB dhe instalo driverin.
# Klik djathtas → Run as Administrator

$ErrorActionPreference = 'Continue'
Write-Host '=== Pastrim Tysso USB (HID -> Printer) ===' -ForegroundColor Cyan

$tyssoIds = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
  Where-Object { $_.InstanceId -match 'VID_3554&PID_FC03' }

if (-not $tyssoIds) {
  Write-Host 'Printeri nuk eshte i lidhur me USB. Lidhe kabllon dhe provo perseri.' -ForegroundColor Yellow
  exit 1
}

Write-Host "Gjetur $($tyssoIds.Count) pajisje Tysso (HID/Composite)..."

Get-Printer -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'Tysso*' } | ForEach-Object {
  Write-Host "Heq printerin: $($_.Name)"
  Remove-Printer -Name $_.Name -ErrorAction SilentlyContinue
}

foreach ($dev in ($tyssoIds | Sort-Object { $_.InstanceId.Length } -Descending)) {
  Write-Host "Heq: $($dev.FriendlyName) [$($dev.InstanceId)]"
  try {
    pnputil /remove-device $dev.InstanceId 2>$null | Out-Null
  } catch { }
  try {
    Remove-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false -ErrorAction Stop
    Write-Host '  OK' -ForegroundColor Green
  } catch {
    Write-Host "  Skip: $($_.Exception.Message)" -ForegroundColor DarkYellow
  }
}

Write-Host ''
Write-Host 'TANI:' -ForegroundColor Green
Write-Host '  1. Çkap kabllon USB nga printeri (10 sek)'
Write-Host '  2. Fik/ndiz printerin Tysso'
Write-Host '  3. Lidh USB ne port TJETER te laptopit (nese ke)'
Write-Host '  4. Hap: Printer Driver of PRP-188 PRP-250 PRP-350.exe'
Write-Host '  5. Zgjidh USB -> OK (prit derisa te gjeje portin)'
Write-Host ''
