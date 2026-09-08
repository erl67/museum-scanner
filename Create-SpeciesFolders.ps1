<#
Creates this folder structure from CSV columns:

<Project root>\<Family>\<Genus>_<specificEpithet>

The script and CSV are expected inside:
<Project root>\scripts
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$CsvFile,
    [string]$OutputRoot,

    # Change these parameters if the CSV headers change.
    [string]$FamilyColumn = "Family",
    [string]$GenusColumn = "Genus",
    [string]$SpeciesColumn = "specificEpithet"
)

# Script location:
# G:\My Drive\Egg Slip Scanning\scripts
$ScriptRoot = $PSScriptRoot

# Folder one level above scripts:
# G:\My Drive\Egg Slip Scanning
$ProjectRoot = Split-Path -Parent $ScriptRoot

# CSV defaults to the scripts folder.
if ([string]::IsNullOrWhiteSpace($CsvFile)) {
    $CsvFile = Join-Path `
        $ScriptRoot `
        "EggSlipReorganizationProject_FULL.xlsx - Full List.csv"
}

# Create Family\Genus_species folders under the project root.
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = $ProjectRoot
}

if (-not (Test-Path -LiteralPath $CsvFile -PathType Leaf)) {
    Write-Error "CSV file not found: $CsvFile"
    return
}

$data = @(Import-Csv -LiteralPath $CsvFile)

if ($data.Count -eq 0) {
    Write-Warning "The CSV contains no data rows."
    return
}

# Confirm that the requested columns exist.
$availableColumns = @(
    $data[0].PSObject.Properties.Name
)

$requiredColumns = @(
    $FamilyColumn
    $GenusColumn
    $SpeciesColumn
)

$missingColumns = @(
    $requiredColumns |
        Where-Object { $availableColumns -notcontains $_ }
)

if ($missingColumns.Count -gt 0) {
    Write-Error @"
Missing required CSV columns: $($missingColumns -join ", ")

Available columns:
$($availableColumns -join ", ")
"@
    return
}

# Prevent duplicate species folders.
$uniqueSpecies = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
)

$createdFamilies = 0
$createdSpecies = 0
$existingSpecies = 0
$duplicateRows = 0
$skippedRows = 0
$rowNumber = 1

foreach ($row in $data) {
    $rowNumber++

    $family = ([string]$row.$FamilyColumn).Trim()
    $genus = ([string]$row.$GenusColumn).Trim()
    $species = ([string]$row.$SpeciesColumn).Trim()

    if (
        [string]::IsNullOrWhiteSpace($family) -or
        [string]::IsNullOrWhiteSpace($genus) -or
        [string]::IsNullOrWhiteSpace($species)
    ) {
        Write-Warning `
            "Skipping CSV row $rowNumber because a required value is blank."

        $skippedRows++
        continue
    }

    $folderName = "${genus}_${species}"
    $familyPath = Join-Path $OutputRoot $family
    $folderPath = Join-Path $familyPath $folderName

    # Ignore duplicate spreadsheet entries.
    if (-not $uniqueSpecies.Add($folderPath)) {
        $duplicateRows++
        continue
    }

    if (-not (Test-Path -LiteralPath $familyPath -PathType Container)) {
        if ($PSCmdlet.ShouldProcess($familyPath, "Create family folder")) {
            New-Item `
                -ItemType Directory `
                -Path $familyPath `
                -Force |
                Out-Null

            Write-Host "Created family folder: $familyPath"
            $createdFamilies++
        }
    }

    if (Test-Path -LiteralPath $folderPath -PathType Container) {
        $existingSpecies++
        continue
    }

    if ($PSCmdlet.ShouldProcess($folderPath, "Create species folder")) {
        New-Item `
            -ItemType Directory `
            -Path $folderPath `
            -Force |
            Out-Null

        Write-Host "Created species folder: $folderPath" `
            -ForegroundColor Green

        $createdSpecies++
    }
}

Write-Host ""
Write-Host "=== Folder Creation Summary ===" -ForegroundColor Cyan
Write-Host "CSV rows read:                 $($data.Count)"
Write-Host "New family folders created:    $createdFamilies"
Write-Host "New species folders created:   $createdSpecies"
Write-Host "Species folders already there: $existingSpecies"
Write-Host "Duplicate rows ignored:        $duplicateRows"
Write-Host "Incomplete rows skipped:       $skippedRows"

if ($WhatIfPreference) {
    Write-Host ""
    Write-Host "This was a preview; no folders were created." `
        -ForegroundColor Yellow
}