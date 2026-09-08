# The script is stored in:
# G:\My Drive\Egg Slip Scanning\scripts

# Source is one directory above the script folder:
# G:\My Drive\Egg Slip Scanning
$Source = Split-Path -Parent $PSScriptRoot

# Destination (local backup)
$Destination = "C:\Users\x5769\Documents\EggBackup"

# Robocopy options
$RobocopyOptions = @(
    "/E"         # Copy all subfolders, including empty ones
    "/Z"         # Use restartable mode
    "/COPY:DAT"  # Copy data, attributes, and timestamps
    "/DCOPY:T"   # Preserve directory timestamps
    "/R:2"       # Retry failed copies twice
    "/W:2"       # Wait two seconds between retries
    "/MT:8"      # Use eight copying threads
    "/V"         # Produce verbose output
    "/TEE"       # Display output while also supporting log output
    "/ETA"       # Show estimated completion time
)

Write-Host "Backing up:"
Write-Host "  Source:      $Source"
Write-Host "  Destination: $Destination"
Write-Host ""

& robocopy.exe $Source $Destination @RobocopyOptions

# Robocopy exit codes 0–7 indicate success or nonfatal differences.
$RobocopyExitCode = $LASTEXITCODE

if ($RobocopyExitCode -ge 8) {
    Write-Error "Robocopy failed with exit code $RobocopyExitCode."
    exit $RobocopyExitCode
}

Write-Host ""
Write-Host "Backup completed successfully. Robocopy exit code: $RobocopyExitCode"
exit 0