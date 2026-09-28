# Make `winget` available on a Windows CI runner (F25).
#
# Newer runner images ship it; older ones do not. When it is missing, the
# Windows Package Manager is installed with Microsoft's own PowerShell module
# (Microsoft.WinGet.Client, Repair-WinGetPackageManager), and its folder is
# added to PATH for the steps that follow.
$ErrorActionPreference = "Stop"

function Show-Winget {
  $cmd = Get-Command winget -ErrorAction SilentlyContinue
  if ($cmd) {
    Write-Host "winget: $($cmd.Source)"
    & $cmd.Source --version
    return $true
  }
  return $false
}

if (Show-Winget) { exit 0 }

Write-Host "winget not found - installing the Windows Package Manager"
Set-PSRepository -Name PSGallery -InstallationPolicy Trusted
Install-Module -Name Microsoft.WinGet.Client -Force -Scope AllUsers -AllowClobber
Import-Module Microsoft.WinGet.Client
Repair-WinGetPackageManager -AllUsers -Force -Latest

$apps = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps"
$env:PATH = "$apps;$env:PATH"
if ($env:GITHUB_PATH) { Add-Content -Path $env:GITHUB_PATH -Value $apps }
if (-not (Show-Winget)) {
  $found = Get-ChildItem "$env:ProgramFiles\WindowsApps" -Filter winget.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $found) { throw "winget is still not available after installing it" }
  $dir = Split-Path $found.FullName
  $env:PATH = "$dir;$env:PATH"
  if ($env:GITHUB_PATH) { Add-Content -Path $env:GITHUB_PATH -Value $dir }
  if (-not (Show-Winget)) { throw "winget is still not available after installing it" }
}
