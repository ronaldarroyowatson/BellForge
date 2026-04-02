param(
  [Parameter(Mandatory = $false)]
  [string]$SourcePpk = "$HOME\.ssh\raspberrypi5privatekey.ppk",

  [Parameter(Mandatory = $false)]
  [string]$OutputPrivate,

  [Parameter(Mandatory = $false)]
  [System.Security.SecureString]$Passphrase,

  [Parameter(Mandatory = $false)]
  [string]$ToolsDir = "$PSScriptRoot\..\tools",

  [Parameter(Mandatory = $false)]
  [string]$PuttyGenUrl = "https://the.earth.li/~sgtatham/putty/latest/w64/puttygen.exe"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-ModernPuttyGen {
  param(
    [string]$TargetDir,
    [string]$DownloadUrl
  )

  New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
  $targetExe = Join-Path $TargetDir "puttygen.exe"

  if (-not (Test-Path $targetExe)) {
    Write-Output "Downloading modern puttygen..."
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $targetExe
  }

  return $targetExe
}

function Get-PlainPassphrase {
  param([System.Security.SecureString]$SecurePass)
  $marshal = [Runtime.InteropServices.Marshal]
  $ptr = [IntPtr]::Zero
  try {
    $ptr = $marshal::SecureStringToBSTR($SecurePass)
    return $marshal::PtrToStringBSTR($ptr)
  } finally {
    if ($ptr -ne [IntPtr]::Zero) {
      $marshal::ZeroFreeBSTR($ptr)
    }
  }
}

if (-not (Test-Path $SourcePpk)) {
  throw "Source PPK not found: $SourcePpk"
}

$sourceItem = Get-Item $SourcePpk
if (-not $OutputPrivate) {
  $OutputPrivate = Join-Path $sourceItem.DirectoryName ($sourceItem.BaseName + "_openssh")
}

if (-not $Passphrase) {
  $Passphrase = Read-Host "Enter PPK passphrase" -AsSecureString
}

$plainPassphrase = ""
if ($Passphrase) {
  $plainPassphrase = Get-PlainPassphrase -SecurePass $Passphrase
}
$passFile = Join-Path $env:TEMP ("ppk_pass_" + [guid]::NewGuid().ToString("N") + ".txt")
$emptyFile = Join-Path $env:TEMP ("ppk_empty_" + [guid]::NewGuid().ToString("N") + ".txt")

try {
  # File-based passphrase parameters avoid command-line argument leakage.
  Set-Content -Path $passFile -Value $plainPassphrase -NoNewline -Encoding ascii
  Set-Content -Path $emptyFile -Value "" -NoNewline -Encoding ascii

  $puttygen = Get-ModernPuttyGen -TargetDir $ToolsDir -DownloadUrl $PuttyGenUrl

  # Convert encrypted PPK -> unencrypted OpenSSH private key.
  & $puttygen $SourcePpk --old-passphrase $passFile --new-passphrase $emptyFile -O private-openssh -o $OutputPrivate
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $OutputPrivate)) {
    throw "PPK to OpenSSH conversion failed. Verify passphrase and key file."
  }

  # Derive public key from the new OpenSSH private key.
  $pubOut = "$OutputPrivate.pub"
  $pubKey = & ssh-keygen -y -f $OutputPrivate 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($pubKey)) {
    throw "Failed to derive public key from converted private key."
  }
  Set-Content -Path $pubOut -Value $pubKey -Encoding ascii

  # Restrict private key ACL to current user.
  & icacls $OutputPrivate /inheritance:r /grant:r "$env:USERNAME:(R,W)" /c | Out-Null

  Write-Output "Converted private key: $OutputPrivate"
  Write-Output "Derived public key:    $pubOut"
  Write-Output "Use with SSH: ssh -i $OutputPrivate pi@192.168.2.180"
}
finally {
  Remove-Item -ErrorAction SilentlyContinue $passFile
  Remove-Item -ErrorAction SilentlyContinue $emptyFile
}
