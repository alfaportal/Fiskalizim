param(
  [Parameter(Mandatory = $true)]
  [string]$Dir
)

$ErrorActionPreference = "Continue"
$log = Join-Path $env:TEMP "Revolution-Fiskalizim-lock-run.log"
"START Dir=$Dir $(Get-Date -Format o)" | Out-File $log -Encoding utf8
function Log($m) { $m | Out-File $log -Append -Encoding utf8 }

try {
  if (-not (Test-Path -LiteralPath $Dir)) { Log "MISSING_DIR"; exit 2 }

  icacls $Dir /grant "Administrators:(F)" "SYSTEM:(F)" /Q 2>&1 | Out-File $log -Append
  takeown /F $Dir /R /D Y 2>&1 | Out-File $log -Append
  icacls $Dir /reset /T /Q 2>&1 | Out-File $log -Append
  attrib -H -S $Dir /S /D 2>&1 | Out-File $log -Append

  icacls $Dir /grant "Administrators:(F)" "SYSTEM:(F)" /Q 2>&1 | Out-File $log -Append
  takeown /F $Dir /R /D Y 2>&1 | Out-File $log -Append
  icacls $Dir /inheritance:r /Q 2>&1 | Out-File $log -Append
  icacls $Dir /grant:r "SYSTEM:(OI)(CI)F" /grant:r "Administrators:(OI)(CI)F" /grant:r "ALL APPLICATION PACKAGES:(OI)(CI)RX" /grant:r "ALL RESTRICTED APPLICATION PACKAGES:(OI)(CI)RX" /T /Q 2>&1 | Out-File $log -Append

  Get-ChildItem -LiteralPath $Dir -Recurse -File -Force -EA SilentlyContinue | ForEach-Object {
    icacls $_.FullName /grant:r "Users:(RX)" /grant:r "Authenticated Users:(RX)" /Q | Out-Null
  }
  Get-ChildItem -LiteralPath $Dir -Recurse -Directory -Force -EA SilentlyContinue | ForEach-Object {
    icacls $_.FullName /grant:r "Users:(RX)" /grant:r "Authenticated Users:(RX)" /Q | Out-Null
  }

  icacls $Dir /grant:r "SYSTEM:(F)" /grant:r "Administrators:(F)" /grant:r "Users:(X)" /grant:r "Authenticated Users:(X)" /grant:r "ALL APPLICATION PACKAGES:(X)" /grant:r "ALL RESTRICTED APPLICATION PACKAGES:(X)" /Q 2>&1 | Out-File $log -Append
  attrib +H +S $Dir 2>&1 | Out-File $log -Append
  cmd /c "attrib +H `"$Dir`"" 2>&1 | Out-File $log -Append

  Log "DONE"
  exit 0
} catch {
  Log "ERR: $_"
  exit 1
}
