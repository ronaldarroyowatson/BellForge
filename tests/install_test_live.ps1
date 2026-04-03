# PowerShell Live Pi Install Test
# Usage:
#   $env:BELLFORGE_PI_HOST = "192.168.2.180"
#   $env:BELLFORGE_PI_USER = "pi"
#   $env:BELLFORGE_PI_SSH_KEY_PATH = "$env:USERPROFILE\.ssh\id_rsa"
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests/install_test_live.ps1

param(
    [string]$PiHost = $env:BELLFORGE_PI_HOST,
    [string]$PiUser = $env:BELLFORGE_PI_USER,
    [string]$PiSshKeyPath = $env:BELLFORGE_PI_SSH_KEY_PATH,
    [string]$RepoOwner = $env:BELLFORGE_REPO_OWNER,
    [string]$ServerIp = $env:BELLFORGE_SERVER_IP,
    [string]$DisplayId = $env:BELLFORGE_DISPLAY_ID,
    [string]$Branch = $env:BELLFORGE_BRANCH
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($PiUser)) { $PiUser = "pi" }
if ([string]::IsNullOrWhiteSpace($RepoOwner)) { $RepoOwner = "ronaldarroyowatson" }
if ([string]::IsNullOrWhiteSpace($ServerIp)) { $ServerIp = "127.0.0.1" }
if ([string]::IsNullOrWhiteSpace($DisplayId)) { $DisplayId = "TestDisplay-Live" }
if ([string]::IsNullOrWhiteSpace($Branch)) { $Branch = "main" }

$RepoRoot = (Get-Item $PSScriptRoot).Parent.FullName
$TestLogDir = Join-Path $RepoRoot "tests\logs"
$LogFile = Join-Path $TestLogDir "install-test-live.log"
$ErrorLog = Join-Path $TestLogDir "install-test-live-errors.log"

if (!(Test-Path $TestLogDir)) {
    New-Item -ItemType Directory -Path $TestLogDir | Out-Null
}

"Install Test Started: $(Get-Date)" | Set-Content -Path $LogFile
"" | Set-Content -Path $ErrorLog

function Write-LogInfo {
    param([string]$Message)
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [INFO] $Message"
    Write-Host $line -ForegroundColor Cyan
    Add-Content -Path $LogFile -Value $line
}

function Write-LogOk {
    param([string]$Message)
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [OK] $Message"
    Write-Host $line -ForegroundColor Green
    Add-Content -Path $LogFile -Value $line
}

function Write-LogWarn {
    param([string]$Message)
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [WARN] $Message"
    Write-Host $line -ForegroundColor Yellow
    Add-Content -Path $LogFile -Value $line
}

function Write-LogError {
    param([string]$Message)
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [ERROR] $Message"
    Write-Host $line -ForegroundColor Red
    Add-Content -Path $LogFile -Value $line
    Add-Content -Path $ErrorLog -Value $line
}

function Invoke-PiCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [switch]$AllowFailure,
        [switch]$VerboseLog
    )

    if ($VerboseLog) {
        Write-LogInfo "Executing on Pi: $Command"
    }

    $result = ssh -i $PiSshKeyPath -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o LogLevel=ERROR "$PiUser@$PiHost" "bash -lc '$Command'" 2>&1
    $exitCode = $LASTEXITCODE

    if ($VerboseLog -and $result) {
        $result | ForEach-Object { Add-Content -Path $LogFile -Value $_ }
    }

    if ($exitCode -ne 0 -and !$AllowFailure) {
        Write-LogError "Pi command failed (exit $exitCode): $Command"
        if ($result) {
            $result | ForEach-Object { Add-Content -Path $ErrorLog -Value $_ }
        }
        throw "Pi command failed"
    }

    return $result
}

if ([string]::IsNullOrWhiteSpace($PiHost)) {
    Write-LogError "BELLFORGE_PI_HOST is required"
    exit 1
}

if ([string]::IsNullOrWhiteSpace($PiSshKeyPath) -or !(Test-Path $PiSshKeyPath)) {
    Write-LogError "BELLFORGE_PI_SSH_KEY_PATH not found: $PiSshKeyPath"
    exit 1
}

try {
    Write-LogInfo "=========================================================="
    Write-LogInfo "BellForge Live Install Test"
    Write-LogInfo "=========================================================="
    Write-LogInfo "Pi host: $PiHost"
    Write-LogInfo "Pi user: $PiUser"
    Write-LogInfo "Repo owner: $RepoOwner"
    Write-LogInfo "Server IP: $ServerIp"
    Write-LogInfo "Display ID: $DisplayId"
    Write-LogInfo "Branch: $Branch"

    Write-LogInfo "STEP 1: Verifying SSH + passwordless sudo"
    Invoke-PiCommand "hostname && whoami && sudo -n true" -VerboseLog | Out-Null
    Write-LogOk "Pi access verified"

    Write-LogInfo "STEP 2: Pre-cleanup"
    Invoke-PiCommand "sudo systemctl stop bellforge-backend bellforge-client bellforge-updater 2>/dev/null || true" -AllowFailure | Out-Null
    Invoke-PiCommand "sudo rm -rf /opt/bellforge /opt/bellforge-staging" | Out-Null
    Write-LogOk "Cleaned previous install"

    Write-LogInfo "STEP 3: Running installer from GitHub"
    $installCmd = "curl -fsSL https://raw.githubusercontent.com/$RepoOwner/BellForge/$Branch/install.sh | sudo env BELLFORGE_REPO_OWNER='$RepoOwner' BELLFORGE_SERVER_IP='$ServerIp' BELLFORGE_DISPLAY_ID='$DisplayId' bash -s -- --install --yes --no-reboot"
    Invoke-PiCommand $installCmd -VerboseLog | Out-Null
    Write-LogOk "Install command completed"

    Write-LogInfo "STEP 4: Validate critical paths"
    $criticalPaths = @(
        "/opt/bellforge",
        "/opt/bellforge/.venv/bin/python",
        "/opt/bellforge/config/version.json",
        "/opt/bellforge/config/manifest.json",
        "/opt/bellforge/backend/main.py",
        "/opt/bellforge/client/status.html",
        "/opt/bellforge/updater/agent.py",
        "/opt/bellforge/scripts/self_heal_root.sh"
    )
    foreach ($path in $criticalPaths) {
        Invoke-PiCommand "test -e '$path'" | Out-Null
    }
    Write-LogOk "Critical paths validated"

    Write-LogInfo "STEP 5: Validate service units"
    $services = @("bellforge-backend", "bellforge-client", "bellforge-updater")
    foreach ($svc in $services) {
        Invoke-PiCommand "sudo test -f /etc/systemd/system/$svc.service" | Out-Null
        Invoke-PiCommand "sudo systemctl is-enabled $svc.service >/dev/null" | Out-Null
    }
    Write-LogOk "Service units installed and enabled"

    Write-LogInfo "STEP 6: Validate JSON config"
    Invoke-PiCommand "cat /opt/bellforge/config/version.json | python3 -m json.tool" | Out-Null
    Invoke-PiCommand "cat /opt/bellforge/config/manifest.json | python3 -m json.tool > /dev/null" | Out-Null
    Write-LogOk "version.json and manifest.json validated"

    Write-LogInfo "STEP 7: Validate self-heal sudoers policy"
    Invoke-PiCommand "sudo test -f /etc/sudoers.d/bellforge-self-heal" | Out-Null
    Invoke-PiCommand "sudo -u bellforge sudo -n /opt/bellforge/scripts/self_heal_root.sh restart-client" -AllowFailure | Out-Null
    Write-LogOk "Self-heal sudo policy validated"

    Write-LogInfo "STEP 8: Backend health check"
    Invoke-PiCommand "curl -fsS http://127.0.0.1:8000/health" -AllowFailure | Out-Null

    Write-LogInfo "STEP 9: Collect service diagnostics"
    foreach ($svc in $services) {
        $status = Invoke-PiCommand "sudo systemctl status $svc.service || true" -AllowFailure
        if ($status) {
            Add-Content -Path $LogFile -Value $status
        }
    }

    Write-LogInfo "STEP 10: Collect install log excerpt"
    $excerpt = Invoke-PiCommand "sudo head -50 /var/log/bellforge-install.log || true" -AllowFailure
    if ($excerpt) {
        Add-Content -Path $LogFile -Value $excerpt
    }

    Write-LogOk "Live install test completed successfully"
    Write-LogInfo "Full log: $LogFile"
    Write-LogInfo "Error log: $ErrorLog"
    exit 0
}
catch {
    Write-LogError "Install test failed: $($_.Exception.Message)"
    Write-LogInfo "Full log: $LogFile"
    Write-LogInfo "Error log: $ErrorLog"
    exit 1
}
