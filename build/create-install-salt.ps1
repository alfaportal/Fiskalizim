# Creates %APPDATA%\RevolutionInvest\FiskalizimLicense\.install-salt
# UPDATE e ruan salt-in ekzistues (HARDWARE_ID i njëjtë).
param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$dir = Join-Path $env:APPDATA "RevolutionInvest\FiskalizimLicense"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$saltFile = Join-Path $dir ".install-salt"

if ($Force -and (Test-Path -LiteralPath $saltFile)) {
  Remove-Item -LiteralPath $saltFile -Force -ErrorAction SilentlyContinue
}

if (-not $Force -and (Test-Path -LiteralPath $saltFile)) {
  $existing = (Get-Content -LiteralPath $saltFile -Raw -ErrorAction SilentlyContinue)
  if ($existing -and $existing.Trim().Length -gt 0) {
    Write-Output "EXISTS"
    exit 0
  }
}

$salt = [guid]::NewGuid().Guid
try {
  $fs = [System.IO.File]::Open($saltFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($salt)
  $fs.Write($bytes, 0, $bytes.Length)
  $fs.Close()
  Write-Output "CREATED"
} catch [System.IO.IOException] {
  if ($Force) {
    Set-Content -LiteralPath $saltFile -Value $salt -Encoding ASCII -NoNewline
    Write-Output "FORCED"
    exit 0
  }
  Write-Output "EXISTS"
  exit 0
}
