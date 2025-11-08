# Get current folder and species name
$folder = Get-Location
$folderName = Split-Path $folder -Leaf

# Check if folder contains "(uncatalogued)"
if ($folderName -match '(.+)_\(uncatalogued\)') {
    $species = $matches[1]
    $isUncatalogued = $true
} else {
    $species = $folderName
    $isUncatalogued = $false
}

$jpegFolder = Join-Path $folder "JPEG"
$tiffFolder = Join-Path $folder "TIFF"

$jpegExists = Test-Path $jpegFolder
$tiffExists = Test-Path $tiffFolder

# Case 1: JPEG folder doesn't exist - create it and rename files
if (-not $jpegExists) {
    Write-Host "JPEG folder not found. Creating and processing images...`n" -ForegroundColor Green
    
    New-Item -ItemType Directory -Path $jpegFolder | Out-Null
    
    # Get files to process
    $files = Get-ChildItem -Path $folder -File -Filter *.jpg |
             Where-Object { $_.DirectoryName -ne $jpegFolder } |
             Sort-Object LastWriteTime
    
    if ($files.Count -eq 0) {
        Write-Host "ERROR: No JPG files found in the folder!" -ForegroundColor Red
        exit
    }
    
    $counter = 1
    
    foreach ($file in $files) {
        # zero-pad to 2 digits
        $num = "{0:D2}" -f $counter
    
        # build new filename based on catalogued status
        if ($isUncatalogued) {
            $newName = "{0}_Uncatalogued{1}{2}" -f $species, $num, $file.Extension
        } else {
            $newName = "{0}_E{1}{2}" -f $species, $num, $file.Extension
        }
    
        $destPath = Join-Path $jpegFolder $newName
    
        Copy-Item -Path $file.FullName -Destination $destPath
    
        # Extract date/time from original filename
        if ($file.Name -match '(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})') {
            $year = $matches[1]
            $month = $matches[2]
            $day = $matches[3]
            $hour = $matches[4]
            $minute = $matches[5]
            $second = $matches[6]
            
            try {
                $timestamp = Get-Date -Year $year -Month $month -Day $day -Hour $hour -Minute $minute -Second $second
                (Get-Item $destPath).LastWriteTime = $timestamp
                (Get-Item $destPath).CreationTime = $timestamp
                Write-Host "Copied: $($file.Name) -> $newName (Date: $timestamp)"
            } catch {
                Write-Host "Copied: $($file.Name) -> $newName (Could not parse date)"
            }
        } else {
            Write-Host "Copied: $($file.Name) -> $newName"
        }
    
        $counter++
    }
    
    Write-Host "`nDone! Renamed $($counter - 1) files into JPEG folder." -ForegroundColor Green
    
    if ($isUncatalogued) {
        Write-Host "Files renamed as Uncatalogued. Adjust numbers as necessary before running again to create TIFFs.`n" -ForegroundColor Yellow
    } else {
        Write-Host "Update the JPEG files with actual catalog numbers before running again to create TIFFs.`n" -ForegroundColor Yellow
    }
    
    exit
}

# Case 2: JPEG exists but TIFF doesn't - convert to TIFF
if ($jpegExists -and -not $tiffExists) {
    Write-Host "JPEG folder found. Converting to TIFF...`n" -ForegroundColor Green
    
    Add-Type -AssemblyName System.Drawing
    
    # Create TIFF folder
    New-Item -ItemType Directory -Path $tiffFolder | Out-Null
    
    # Get all JPEGs from the JPEG subfolder
    $files = Get-ChildItem -Path (Join-Path $jpegFolder "*.jpg")
    
    if ($files.Count -eq 0) {
        Write-Host "ERROR: No JPG files found in JPEG folder!" -ForegroundColor Red
        exit
    }
    
    $counter = 1
    $total = $files.Count
    
    foreach ($file in $files) {
        try {
            # Load image into memory stream to avoid file locks
            $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
            $ms = New-Object System.IO.MemoryStream(,$bytes)
            $jpeg = [System.Drawing.Image]::FromStream($ms)
            
            # Set up LZW compression (lossless)
            $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
            $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
                [System.Drawing.Imaging.Encoder]::Compression, 
                [long][System.Drawing.Imaging.EncoderValue]::CompressionLZW
            )
            
            $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | 
                Where-Object { $_.MimeType -eq 'image/tiff' }
            
            # Save to TIFF folder with .tif extension
            $outputPath = Join-Path $tiffFolder ($file.BaseName + '.tif')
            
            $jpeg.Save($outputPath, $codec, $encoderParams)
            
            Write-Host "[$counter/$total] Converted: $($file.Name) -> TIFF\$($file.BaseName).tif"
            
            # Clean up
            $jpeg.Dispose()
            $ms.Dispose()
            
            $counter++
            
        } catch {
            Write-Host "[$counter/$total] ERROR converting $($file.Name): $_" -ForegroundColor Red
            $counter++
        }
    }
    
    # Move up one directory to avoid accidentally using the same folder
    cd ..
    
    Write-Host "`nDone! Processed $($counter - 1) files into TIFF.`n" -ForegroundColor Green

    $width = 80  # Adjust this to your preferred width
    Write-Host
    Write-Host "$('Next steps:'.PadRight($width))" -ForegroundColor Magenta -BackgroundColor Black
    Write-Host "$('  1. Create a new directory for the next species (use: mkdir Genus_species)'.PadRight($width))" -ForegroundColor Magenta -BackgroundColor Black
    Write-Host "$('  2. Change directory to new species (use: cd Genus_species)'.PadRight($width))" -ForegroundColor Magenta -BackgroundColor Black
    Write-Host "$('  3. Update the storage folder in CZUR app to the new directory'.PadRight($width))"-ForegroundColor Magenta -BackgroundColor Black
    Write-Host
    exit
}

# Case 3: Both folders exist - check if they contain files
if ($jpegExists -and $tiffExists) {
    $jpegFiles = Get-ChildItem -Path $jpegFolder -File
    $tiffFiles = Get-ChildItem -Path $tiffFolder -File
    
    if ($jpegFiles.Count -gt 0 -or $tiffFiles.Count -gt 0) {
        Write-Host "`nWARNING: Folders already exist and contain files, possibly already processed. Double check!" -ForegroundColor Red
        Write-Host "JPEG folder: $($jpegFiles.Count) files" -ForegroundColor Red
        Write-Host "TIFF folder: $($tiffFiles.Count) files`n" -ForegroundColor Red
    } else {
        Write-Host "`nBoth folders exist but are empty. Deleting folders and restarting...`n" -ForegroundColor Yellow
        Remove-Item $jpegFolder -Force
        Remove-Item $tiffFolder -Force
        Write-Host "Folders deleted. Rerunning script...`n" -ForegroundColor Green
        
        # Rerun the script
        & $PSCommandPath
    }
    
    exit
}
