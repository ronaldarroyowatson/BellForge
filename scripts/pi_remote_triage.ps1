param(
  [Parameter(Mandatory = $false)]
  [string]$PiHost = "192.168.2.180",

  [Parameter(Mandatory = $false)]
  [string]$User = "pi",

  [Parameter(Mandatory = $false)]
  [string]$KeyPath,

  [Parameter(Mandatory = $false)]
  [switch]$InstallCli,

  [Parameter(Mandatory = $false)]
  [switch]$RunTriage,

  [Parameter(Mandatory = $false)]
  [string]$RemoteCommand
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($KeyPath)) {
  $KeyPath = Join-Path $HOME ".ssh/exportedRaspberryPiKey"
}

$knownHostsPath = Join-Path $HOME ".ssh/known_hosts"

$sshArgs = @(
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", ("UserKnownHostsFile={0}" -f $knownHostsPath),
  "-o", "IdentitiesOnly=yes",
  "-o", "KexAlgorithms=curve25519-sha256,diffie-hellman-group14-sha256,diffie-hellman-group14-sha1",
  "-i", $KeyPath
)

$remoteHost = $User + "@" + $PiHost

if ($InstallCli) {
  Write-Host "Copying bellforge_cli.py to Pi..." -ForegroundColor Yellow
  $remoteCliPath = $remoteHost + ":/home/" + $User + "/bellforge_cli.py"
  scp @sshArgs "scripts/bellforge_cli.py" $remoteCliPath
  ssh @sshArgs $remoteHost "sudo install -m 0755 /home/${User}/bellforge_cli.py /opt/bellforge/scripts/bellforge_cli.py"
}

if ($RunTriage) {
  Write-Host "Running remote triage..." -ForegroundColor Yellow
  ssh @sshArgs $remoteHost "python3 /opt/bellforge/scripts/bellforge_cli.py triage --save /tmp/bellforge-triage.json"
  $localOut = "tests/logs/triage-$PiHost-$(Get-Date -Format 'yyyyMMdd-HHmmss').json"
  New-Item -ItemType Directory -Force -Path (Split-Path $localOut -Parent) | Out-Null
  $remoteTriagePath = $remoteHost + ":/tmp/bellforge-triage.json"
  scp @sshArgs $remoteTriagePath $localOut
  Write-Host "Saved triage report to $localOut" -ForegroundColor Green
}

if ($RemoteCommand) {
  Write-Host "Running remote command: $RemoteCommand" -ForegroundColor Yellow
  ssh @sshArgs $remoteHost $RemoteCommand
}

if (-not $InstallCli -and -not $RunTriage -and -not $RemoteCommand) {
  Write-Host "No action selected. Examples:" -ForegroundColor Cyan
  Write-Host "  .\\scripts\\pi_remote_triage.ps1 -PiHost 192.168.2.180 -InstallCli -RunTriage"
  Write-Host "  .\\scripts\\pi_remote_triage.ps1 -PiHost 192.168.2.180 -RemoteCommand \"python3 /opt/bellforge/scripts/bellforge_cli.py display-status\""
}
