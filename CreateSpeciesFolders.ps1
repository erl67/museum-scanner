# Save spreadsheet as CSV, update lines 17-19 according to specific column header

# Path to the working directory
$workingDir = "C:\Users\x5769\Desktop\Egg Slip Scanning\Folders"

# Path to the CSV file (assumed to be in the same working directory)
$csvFile = Join-Path $workingDir "EggSlipReorganizationProject_FULL.xlsx - Full List.csv"

# Import the CSV
# Assumes columns: Family, Genus, Species (specificEpithet)
$data = Import-Csv -Path $csvFile

# Track unique Genus_species combinations
$uniqueSpecies = @{}

foreach ($row in $data) {
    $family  = $row.Family.Trim()
    $genus   = $row.Genus.Trim()
    $species = $row.specificEpithet.Trim()

    if ([string]::IsNullOrWhiteSpace($family) -or 
        [string]::IsNullOrWhiteSpace($genus) -or 
        [string]::IsNullOrWhiteSpace($species)) {
        continue
    }

    # Build folder name
    $folderName = "${genus}_${species}"

    # Build full path: Family\Genus_species
    $familyPath = Join-Path $workingDir $family
    $folderPath = Join-Path $familyPath $folderName

    # Ensure uniqueness
    if (-not $uniqueSpecies.ContainsKey($folderPath)) {
        $uniqueSpecies[$folderPath] = $true

        # Create Family folder if missing
        if (-not (Test-Path $familyPath)) {
            New-Item -ItemType Directory -Path $familyPath | Out-Null
            Write-Host "Created Family folder: $familyPath"
        }

        # Create Genus_species folder if missing
        if (-not (Test-Path $folderPath)) {
            New-Item -ItemType Directory -Path $folderPath | Out-Null
            Write-Host "Created Species folder: $folderPath"
        }
    }
}