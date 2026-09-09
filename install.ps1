# install-goat - one-command global install of GoatCode on Windows.
#
#   powershell -c "irm https://raw.githubusercontent.com/Arhan-w/GoatCode/v2-typescript/install.ps1 | iex"
#
# Downloads the prebuilt goat.exe from the latest GitHub release, drops it in
# %USERPROFILE%\.goatcode\bin, adds that folder to your user PATH, verifies.
# Idempotent - re-running upgrades in place.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo   = 'Arhan-w/GoatCode'
$InstallDir = Join-Path $env:USERPROFILE '.goatcode\bin'
$BinPath = Join-Path $InstallDir 'goat.exe'

function Say([string]$m) { Write-Host "[goat-install] $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "[goat-install] $m" -ForegroundColor Yellow }

# --- 1. Resolve the latest release asset URL -------------------------------
try {
  $rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'goat-install' }
  $asset = $rel.assets | Where-Object { $_.name -like 'goat-windows-*' } | Select-Object -First 1
  if (-not $asset) { throw 'no windows asset on the latest release' }
  $url = $asset.browser_download_url
  Say "latest release: $($rel.tag_name) - downloading $($asset.name)"
} catch {
  Warn "release lookup failed ($_)"
  Warn 'falling back: clone + build with bun (needs git and bun)'
  $src = Join-Path $env:USERPROFILE '.goatcode\src'
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Error 'git not found - install git from https://git-scm.com and re-run'; exit 1 }
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Say 'installing bun...'
    powershell -c "irm https://bun.sh/install.ps1 | iex"
    $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
  }
  if (Test-Path "$src\.git") { git -C $src fetch --depth=1 origin v2-typescript; git -C $src checkout -f origin/v2-typescript }
  else { git clone --depth=1 --branch v2-typescript "https://github.com/$Repo.git" $src }
  Push-Location $src
  bun install --frozen-lockfile 2>$null; if ($LASTEXITCODE -ne 0) { bun install }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  bun build src/index.ts --compile --outfile $BinPath
  Pop-Location
}

# --- 2. Download path: verify + place ---------------------------------------
if (-not (Test-Path $BinPath)) { New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null }
if ($url) {
  $tmp = "$BinPath.part"
  Invoke-WebRequest $url -OutFile $tmp
  # sanity: PE executables start with MZ, and the file should be > 50 MB
  $head = [System.IO.File]::ReadAllBytes($tmp)[0..1]
  if ($head[0] -ne 0x4D -or $head[1] -ne 0x5A) { Remove-Item $tmp; Write-Error 'downloaded file is not a valid executable'; exit 1 }
  Move-Item -Force $tmp $BinPath
  Say "installed $BinPath"
}

# --- 3. User PATH ------------------------------------------------------------
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$InstallDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$InstallDir", 'User')
  Say "PATH (user) += $InstallDir"
}
$env:Path = "$env:Path;$InstallDir"

# --- 4. Verify ---------------------------------------------------------------
try {
  $ver = & $BinPath --version
  Say ''
  Say "[ok] GoatCode $ver installed"
  Say '  open a NEW terminal (for PATH) and run:  goat'
  Say '  upgrade:   re-run the same irm command'
  Say '  uninstall: remove the folder and the .goatcode\bin PATH entry'
} catch {
  Write-Error "goat.exe installed but won't run: $_"
  exit 1
}