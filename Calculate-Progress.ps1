<#
.SYNOPSIS
  Scan the folder above this script's folder and produce a CSV with counts per
  calendar day: Date, Scanned, Renamed.

.USAGE
  Store this script in the root's scripts folder and run it with no arguments.
  Expected layout:

    Egg Slip Scanning
    |-- Family
    |-- DATES
    `-- scripts
        |-- Calculate-Progress.ps1
        |-- file_counts_by_date.csv
        `-- progress.ipynb
#>

# The script lives in .\scripts, so the folder to scan is one level above it.
$ScriptRoot  = $PSScriptRoot
$RootPath    = Split-Path -Parent $ScriptRoot
$OutputCsv   = Join-Path -Path $ScriptRoot -ChildPath 'file_counts_by_date.csv'
$NotebookPath = Join-Path -Path $ScriptRoot -ChildPath 'progress.ipynb'

Write-Host "Scanning: $RootPath" -ForegroundColor Cyan

# Hashtable accumulators
$scannedCounts = @{}
$renamedCounts = @{}

# Track unique files per category by Name + DateOnly
$seenScanned = @{}
$seenRenamed = @{}

function Get-DailyKey {
    param(
        [System.IO.FileInfo]$File
    )

    $dateOnly = $File.LastWriteTime.ToString('yyyy-MM-dd')
    return "$($File.Name)|$dateOnly"
}

function Add-ScannedFile {
    param([System.IO.FileInfo]$File)

    $dateKey  = $File.LastWriteTime.ToString('yyyy-MM-dd')
    $dailyKey = Get-DailyKey -File $File

    if ($seenScanned.ContainsKey($dailyKey)) { return }
    $seenScanned[$dailyKey] = $true

    if (-not $scannedCounts.ContainsKey($dateKey)) {
        $scannedCounts[$dateKey] = 0
    }

    $scannedCounts[$dateKey] += 1
}

function Add-RenamedFile {
    param([System.IO.FileInfo]$File)

    $dateKey  = $File.LastWriteTime.ToString('yyyy-MM-dd')
    $dailyKey = Get-DailyKey -File $File

    if ($seenRenamed.ContainsKey($dailyKey)) { return }
    $seenRenamed[$dailyKey] = $true

    if (-not $renamedCounts.ContainsKey($dateKey)) {
        $renamedCounts[$dateKey] = 0
    }

    $renamedCounts[$dateKey] += 1
}

function Process-GenusFolder {
    param([string]$Directory)

    # Get immediate subfolder names.
    $subDirs = Get-ChildItem -LiteralPath $Directory -Directory -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Name

    $hasJPEG = $subDirs -contains 'JPEG'
    $hasTIFF = $subDirs -contains 'TIFF'

    # Get IMG* files in the root of this folder (potential "Scanned").
    $imgFiles = @(Get-ChildItem -LiteralPath $Directory -File -Filter 'IMG*' -ErrorAction SilentlyContinue)
    $hasIMG = $imgFiles.Count -gt 0

    # Treat this as a species folder if it has a JPEG subfolder, a TIFF
    # subfolder, or IMG* files in its root.
    if (-not ($hasJPEG -or $hasTIFF -or $hasIMG)) {
        return
    }

    foreach ($file in $imgFiles) {
        Add-ScannedFile -File $file
    }

    # Renamed files are all files in the TIFF subfolder.
    $tiffPath = Join-Path -Path $Directory -ChildPath 'TIFF'
    if (Test-Path -LiteralPath $tiffPath -PathType Container) {
        $tiffFiles = Get-ChildItem -LiteralPath $tiffPath -File -ErrorAction SilentlyContinue

        foreach ($file in $tiffFiles) {
            Add-RenamedFile -File $file
        }
    }
}

# Process the Family folder.
$familyPath = Join-Path -Path $RootPath -ChildPath 'Family'
if (Test-Path -LiteralPath $familyPath -PathType Container) {
    Get-ChildItem -LiteralPath $familyPath -Directory -Recurse -ErrorAction SilentlyContinue |
        ForEach-Object {
            Process-GenusFolder -Directory $_.FullName
        }
} else {
    Write-Host "Warning: Family folder not found at $familyPath" -ForegroundColor Yellow
}

# Process the DATES folder.
$datesPath = Join-Path -Path $RootPath -ChildPath 'DATES'
if (Test-Path -LiteralPath $datesPath -PathType Container) {
    Get-ChildItem -LiteralPath $datesPath -Directory -ErrorAction SilentlyContinue |
        ForEach-Object {
            $dateDir = $_
            $name = $dateDir.Name

            # Folders such as 25-08-XX: count IMG* JPG/JPEG files in the root.
            if ($name -match '^25-08-') {
                $jpgFiles = Get-ChildItem -LiteralPath $dateDir.FullName -File -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -match '^IMG' -and $_.Extension -match '^(?i)\.jpe?g$' }

                foreach ($file in $jpgFiles) {
                    Add-ScannedFile -File $file
                }
            }
            # Treat the species subfolders in 25-09-old like those in Family.
            elseif ($name -eq '25-09-old') {
                Get-ChildItem -LiteralPath $dateDir.FullName -Directory -ErrorAction SilentlyContinue |
                    ForEach-Object {
                        Process-GenusFolder -Directory $_.FullName
                    }
            }
            # Generic DD-MM-YY date folders: count IMG* JPG/JPEG files in the root.
            elseif ($name -match '^\d{2}-\d{2}-\d{2}$') {
                $jpgFiles = Get-ChildItem -LiteralPath $dateDir.FullName -File -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -match '^IMG' -and $_.Extension -match '^(?i)\.jpe?g$' }

                foreach ($file in $jpgFiles) {
                    Add-ScannedFile -File $file
                }
            }
        }
} else {
    Write-Host "Note: DATES folder not found at $datesPath" -ForegroundColor Yellow
}

# Combine all dates, sort them, and build output rows.
$allDates = ($scannedCounts.Keys + $renamedCounts.Keys) | Sort-Object -Unique

$result = @(
    foreach ($date in $allDates) {
        $scanned = if ($scannedCounts.ContainsKey($date)) {
            $scannedCounts[$date]
        } else {
            0
        }

        $renamed = if ($renamedCounts.ContainsKey($date)) {
            $renamedCounts[$date]
        } else {
            0
        }

        # Include days on which at least one category has 10 or more files.
        if ($scanned -ge 10 -or $renamed -ge 10) {
            [PSCustomObject]@{
                Date    = $date
                Scanned = $scanned
                Renamed = $renamed
            }
        }
    }
)

# Print CSV lines to the console for easy checking.
Write-Host ""
Write-Host "=== CSV Output Preview ==="
Write-Host "Date,Scanned,Renamed"

foreach ($row in $result) {
    Write-Host "$($row.Date),$($row.Scanned),$($row.Renamed)"
}

# Summary totals use the raw accumulators so DATES contributions are included.
$totalScanned = ($scannedCounts.Values | Measure-Object -Sum).Sum
$totalRenamed = ($renamedCounts.Values | Measure-Object -Sum).Sum

if ($null -eq $totalScanned) { $totalScanned = 0 }
if ($null -eq $totalRenamed) { $totalRenamed = 0 }

Write-Host ""
Write-Host "=== Summary Totals (not in CSV) ==="
Write-Host "Total Scanned: $totalScanned"
Write-Host "Total Renamed: $totalRenamed"
Write-Host ""

# Save the CSV beside this script and progress.ipynb in the scripts folder.
$result | Export-Csv -LiteralPath $OutputCsv -NoTypeInformation -Encoding UTF8
Write-Host "Wrote $($result.Count) rows to $OutputCsv" -ForegroundColor Green

# Offer to launch the notebook from the scripts folder.
if (-not (Test-Path -LiteralPath $NotebookPath -PathType Leaf)) {
    Write-Host "Notebook not found at $NotebookPath, so Jupyter was not started." -ForegroundColor Yellow
    return
}

do {
    $answer = (Read-Host "Start progress.ipynb in Jupyter Notebook now? [Y/N]").Trim()
} while ($answer -notmatch '^(?i:y(?:es)?|n(?:o)?)$')

if ($answer -match '^(?i:y(?:es)?)$') {
    $jupyterCommand = Get-Command jupyter -ErrorAction SilentlyContinue

    if ($null -eq $jupyterCommand) {
        Write-Host "Jupyter was not found. Install it or make sure the 'jupyter' command is available, then run:" -ForegroundColor Red
        Write-Host "jupyter notebook `"$NotebookPath`""
        return
    }

    Write-Host "Starting Jupyter Notebook..." -ForegroundColor Cyan

    # Start it separately so this progress script can finish immediately.
    Start-Process `
        -FilePath $jupyterCommand.Source `
        -ArgumentList @('notebook', "`"$NotebookPath`"") `
        -WorkingDirectory $ScriptRoot
} else {
    Write-Host "Jupyter Notebook was not started."
}
