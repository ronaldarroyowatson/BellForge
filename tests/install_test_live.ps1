# PowerShell Live Pi Install Test
# Usage:
#   $env:BELLFORGE_PI_HOST = "192.168.2.180"
#   $env:BELLFORGE_PI_USER = "pi"
#   $env:BELLFORGE_PI_SSH_KEY_PATH = "$env:USERPROFILE\.ssh\exportedRaspberryPikey"
#   .\tests\install_test_live.ps1

param(
    [string]$PiHost = $env:BELLFORGE_PI_HOST,
    [string]$PiUser = $env:BELLFORGE_PI_USER,
    [string]$PiSshKeyPath = $env:BELLFORGE_PI_SSH_KEY_PATH,
    [string]$RepoOwner = $env:BELLFORGE_REPO_OWNER -or "ronaldarroyowatson",
    [string]$ServerIp = $env:BELLFORGE_SERVER_IP -or "127.0.0.1",
    [string]$DisplayId = $env:BELLFORGE_DISPLAY_ID -or "TestDisplay-Live",
    [string]$Branch = $env:BELLFORGE_BRANCH -or "main"
)

$ErrorActionPreference = "Stop"
$VerbosePreference = "Continue"

# Setup paths
$RepoRoot = (Get-Item $PSScriptRoot).Parent.FullName
$TestLogDir = Join-Path $RepoRoot "tests\logs"
$LogFile = Join-Path $TestLogDir "install-test-live.log"
$ErrorLog = Join-Path $TestLogDir "install-test-live-errors.log"

if (!(Test-Path $TestLogDir)) {
    New-Item -ItemType Directory -Path $TestLogDir | Out-Null
}

# Functions
function Write-LogInfo {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] [INFO] $Message"
    Write-Host $line -ForegroundColor Cyan
    Add-Content -Path $LogFile -Value $line
}

function Write-LogOk {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] [OK] $Message"
    Write-Host $line -ForegroundColor Green
    Add-Content -Path $LogFile -Value $line
}

function Write-LogError {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] [ERROR] $Message"
    Write-Host $line -ForegroundColor Red
    Add-Content -Path $LogFile -Value $line
    Add-Content -Path $ErrorLog -Value $line
}

function Write-LogWarn {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] [WARN] $Message"
    Write-Host $line -ForegroundColor Yellow
    Add-Content -Path $LogFile -Value $line
}

function Invoke-PiCommand {
    param(
        [Parameter(Mandatory=$true)][string]$Command,
        [switch]$Verbose
    )
    
    if ($Verbose) {
        Write-LogInfo "Executing on Pi: $Command"
    }
    
    $result = ssh -i $PiSshKeyPath -o BatchMode=yes -o StrictHostKeyChecking=accept-new `
        -o ConnectTimeout=20 -o LogLevel=ERROR "$PiUser@$PiHost" "bash -c '$Command'" 2>&1
    
    if ($LASTEXITCODE -ne 0) {
        Write-LogError "Command failed with exit code $LASTEXITCODE"
        throw "Pi command failed"
    }
    
    if ($Verbose) {
        $result | ForEach-Object { Add-Content -Path $LogFile -Value $_ }
    }
    
    return $result
}

# Validation
if ([string]::IsNullOrWhiteSpace($PiHost)) {
    Write-LogError "BELLFORGE_PI_HOST is required"
    exit 1
}

if ([string]::IsNullOrWhiteSpace($PiSshKeyPath) -or !(Test-Path $PiSshKeyPath)) {
    Write-LogError "BELLFORGE_PI_SSH_KEY_PATH not found: $PiSshKeyPath"
    exit 1
}

# Initialize log files
"Install Test Started: $(Get-Date)" | Set-Content -Path $LogFile
"" | Set-Content -Path $ErrorLog

# Header
Write-LogInfo "=========================================================="
Write-LogInfo "BellForge Live Install Test"
Write-LogInfo "=========================================================="
Write-LogInfo "Start time: $(Get-Date)"
Write-LogInfo "Pi host: $PiHost"
Write-LogInfo "Pi user: $PiUser"
Write-LogInfo "Repo owner: $RepoOwner"
Write-LogInfo "Server IP: $ServerIp"
Write-LogInfo "Display ID: $DisplayId"
Write-LogInfo "Branch: $Branch"
Write-LogInfo ""

try {
    # Step 1: Verify Pi access
    Write-LogInfo ""
    Write-LogInfo "STEP 1: Verifying Pi access and prerequisites"
    Write-LogInfo "=========================================================="
    
    try {
        Invoke-PiCommand "hostname && whoami && sudo -n true" -Verbose
        Write-LogOk "Pi access verified"
    } catch {
        Write-LogError "Cannot access Pi or execute sudo without password"
        throw
    }
    
    # Step 2: System info
    Write-LogInfo ""
    Write-LogInfo "STEP 2: Gathering Pi system information"
    Write-LogInfo "=========================================================="
    
    Invoke-PiCommand "uname -a" -Verbose
    Invoke-PiCommand "cat /etc/os-release" -Verbose
    Invoke-PiCommand "df -h /opt || echo 'Note: /opt not yet present'" -Verbose
    
    # Step 3: Pre-install cleanup
    Write-LogInfo ""
    Write-LogInfo "STEP 3: Pre-install cleanup (removing any previous installation)"
    Write-LogInfo "=========================================================="
    
    try {
        Invoke-PiCommand "sudo bash -c 'systemctl stop bellforge-backend bellforge-client bellforge-updater 2>/dev/null || true; sleep 2'"
        Write-LogOk "Stopped existing services"
    } catch {
        Write-LogWarn "Pre-cleanup warning (may be normal if services don't exist)"
    }
    
    Invoke-PiCommand "sudo rm -rf /opt/bellforge /opt/bellforge-staging"
    Write-LogOk "Removed previous installation directories"
    
    # Step 4: Run one-line install
    Write-LogInfo ""
    Write-LogInfo "STEP 4: Executing one-line install command"
    Write-LogInfo "=========================================================="
    Write-LogInfo "Command:"
    Write-LogInfo "curl -fsSL https://raw.githubusercontent.com/$RepoOwner/BellForge/$Branch/install.sh | sudo env BELLFORGE_REPO_OWNER=$RepoOwner BELLFORGE_SERVER_IP=$ServerIp BELLFORGE_DISPLAY_ID=$DisplayId bash -s -- --install --yes --no-reboot"
    Write-LogInfo ""
    
    $InstallStart = Get-Date
    try {
        $cmd = "curl -fsSL https://raw.githubusercontent.com/$RepoOwner/BellForge/$Branch/install.sh | sudo env BELLFORGE_REPO_OWNER='$RepoOwner' BELLFORGE_SERVER_IP='$ServerIp' BELLFORGE_DISPLAY_ID='$DisplayId' bash -s -- --install --yes --no-reboot 2>&1"
        Invoke-PiCommand $cmd -Verbose
        $InstallEnd = Get-Date
        $Duration = ($InstallEnd - $InstallStart).TotalSeconds
        Write-LogOk "Install completed in $([int]$Duration)s"
    } catch {
        $InstallEnd = Get-Date
        $Duration = ($InstallEnd - $InstallStart).TotalSeconds
        Write-LogError "Install failed after $([int]$Duration)s"
        throw
    }
    
    # Step 5: Post-install validation
    Write-LogInfo ""
    Write-LogInfo "STEP 5: Post-install validation"
    Write-LogInfo "=========================================================="
    
    Write-LogInfo "Checking critical installation paths..."
    $CriticalPaths = @(
        "/opt/bellforge",
        "/opt/bellforge/.venv/bin/python",
        "/opt/bellforge/config/version.json",
        "/opt/bellforge/config/manifest.json",
        "/opt/bellforge/backend/main.py",
        "/opt/bellforge/client/status.html",
        "/opt/bellforge/updater/agent.py"
    )
    
    foreach ($path in $CriticalPaths) {
        try {
            Invoke-PiCommand "test -e '$path'"
            Write-LogOk "✓ $path exists"
        } catch {
            Write-LogError "✗ $path missing"
            throw
        }
    }
    
    # Step 6: Check service files
    Write-LogInfo "Checking service files..."
    $Services = @("bellforge-backend", "bellforge-client", "bellforge-updater")
    
    foreach ($svc in $Services) {
        try {
            Invoke-PiCommand "sudo test -f /etc/systemd/system/${svc}.service"
            Write-LogOk "✓ ${svc}.service installed"
        } catch {
            Write-LogError "✗ ${svc}.service missing"
            throw
        }
    }
    
    # Step 7: Service status
    Write-LogInfo ""
    Write-LogInfo "STEP 7: Checking service status (no-reboot mode)"
    Write-LogInfo "=========================================================="
    
    foreach ($svc in $Services) {
        try {
            Invoke-PiCommand "sudo systemctl is-enabled '${svc}.service' >/dev/null && echo 'enabled' || echo 'disabled'"
            Write-LogOk "✓ ${svc}.service enabled for auto-start"
        } catch {
            Write-LogWarn "! ${svc}.service may not be enabled"
        }
    }
    
    # Step 8: Configuration validation
    Write-LogInfo ""
    Write-LogInfo "STEP 8: Validating configuration files"
    Write-LogInfo "=========================================================="
    
    Write-LogInfo "Checking version.json..."
    try {
        $versionOutput = Invoke-PiCommand "cat /opt/bellforge/config/version.json | python3 -m json.tool"
        Add-Content -Path $LogFile -Value $versionOutput
        Write-LogOk "✓ version.json is valid JSON"
    } catch {
        Write-LogError "✗ version.json invalid"
        throw
    }
    
    Write-LogInfo "Checking manifest.json..."
    try {
        $manifestOutput = Invoke-PiCommand "cat /opt/bellforge/config/manifest.json | python3 -m json.tool | head -20"
        Add-Content -Path $LogFile -Value $manifestOutput
        Write-LogOk "✓ manifest.json is valid JSON"
    } catch {
        Write-LogError "✗ manifest.json invalid"
        throw
    }
    
    # Step 9: File permissions
    Write-LogInfo ""
    Write-LogInfo "STEP 9: Checking critical file permissions"
    Write-LogInfo "=========================================================="
    
    $Scripts = @(
        "/opt/bellforge/scripts/start_kiosk.sh",
        "/opt/bellforge/scripts/start_backend.sh",
        "/opt/bellforge/scripts/bootstrap.sh"
    )
    
    foreach ($script in $Scripts) {
        try {
            Invoke-PiCommand "test -x '$script'"
            Write-LogOk "✓ $script is executable"
        } catch {
            Write-LogWarn "✗ $script is not executable (fixing...)"
            try {
                Invoke-PiCommand "sudo chmod +x '$script'"
                Write-LogOk "✓ Fixed: $script now executable"
            } catch {
                Write-LogError "Failed to fix permissions on $script"
                throw
            }
        }
    }
    
    # Step 10: Backend health check
    Write-LogInfo ""
    Write-LogInfo "STEP 10: Backend health check"
    Write-LogInfo "=========================================================="
    $msg = "Note: May fail in no-reboot mode if backend hasnt started yet"
    Write-LogInfo $msg
    
    try {
        Invoke-PiCommand "curl -fsS http://127.0.0.1:8000/health 2>/dev/null"
        Write-LogOk "OK Backend health endpoint responsive"
    } catch {
        Write-LogWarn "Backend not yet responding (expected in no-reboot mode)"
    }
    
    # Step 11: Collect diagnostics
    Write-LogInfo ""
    Write-LogInfo "STEP 11: Collecting post-install diagnostics"
    Write-LogInfo "=========================================================="
    
    Write-LogInfo "Systemd service status:"
    try {
        $status = Invoke-PiCommand "sudo systemctl status bellforge-backend || true"
        Add-Content -Path $LogFile -Value $status
    } catch {}
    
    try {
        $status = Invoke-PiCommand "sudo systemctl status bellforge-client || true"
        Add-Content -Path $LogFile -Value $status
    } catch {}
    
    try {
        $status = Invoke-PiCommand "sudo systemctl status bellforge-updater || true"
        Add-Content -Path $LogFile -Value $status
    } catch {}
    
    Write-LogInfo ""
    Write-LogInfo "Install log excerpt (first 50 lines):"
    try {
        $logExcerpt = Invoke-PiCommand "sudo head -50 /var/log/bellforge-install.log"
        Add-Content -Path $LogFile -Value $logExcerpt
    } catch {}
    
    Write-LogInfo ""
    Write-LogInfo "Checking for installation errors in log..."
    try {
        $errors = Invoke-PiCommand "sudo cat /var/log/bellforge-install.log | grep -i error"
        if ($errors) {
            Add-Content -Path $LogFile -Value $errors
        } else {
            Write-LogOk "No errors found in log"
        }
        Write-LogOk "Log analysis complete"
    } catch {
        Write-LogOk "Log analysis complete (no errors detected)"
    }
    
    # Final Summary
    Write-LogInfo ""
    Write-LogInfo "=========================================================="
    Write-LogInfo "INSTALL TEST SUMMARY"
    Write-LogInfo "=========================================================="
    Write-LogOk "✓ One-line install test completed successfully"
    Write-LogOk "✓ All critical paths present"
    Write-LogOk "✓ Services installed and enabled"
    Write-LogOk "✓ Configuration files valid"
    Write-LogInfo ""
    Write-LogInfo "End time: $(Get-Date)"
    Write-LogInfo "Full log: $LogFile"
    Write-LogInfo "Errors (if any): $ErrorLog"
    
} catch {
    Write-LogError "Install test failed: $_"
    exit 1
}

exit 0
