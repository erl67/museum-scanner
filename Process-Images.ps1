[CmdletBinding()]
param(
    # Defaults to the folder from which the script is launched.
    # You can also pass a species folder explicitly with -SpeciesFolder.
    [Parameter(Position = 0)]
    [string]$SpeciesFolder = (Get-Location).Path
)

# Resolve the species folder independently of the script's own location.
try {
    $folder = Get-Item -LiteralPath $SpeciesFolder -ErrorAction Stop
} catch {
    Write-Error "Species folder not found: $SpeciesFolder"
    return
}

if (-not $folder.PSIsContainer) {
    Write-Error "The species path must be a folder: $SpeciesFolder"
    return
}

$folderName = $folder.Name
$width = 80

Write-Host "Processing species folder: $($folder.FullName)`n" -ForegroundColor Cyan

# Check whether the species folder name contains "_(uncatalogued)".
if ($folderName -match '(.+)_\(uncatalogued\)') {
    $species = $matches[1]
    $isUncatalogued = $true
} else {
    $species = $folderName
    $isUncatalogued = $false
}

$jpegFolder = Join-Path -Path $folder.FullName -ChildPath "JPEG"
$tiffFolder = Join-Path -Path $folder.FullName -ChildPath "TIFF"

$jpegExists = Test-Path -LiteralPath $jpegFolder -PathType Container
$tiffExists = Test-Path -LiteralPath $tiffFolder -PathType Container

# Case 1: JPEG folder does not exist; create it and rename the images.
if (-not $jpegExists) {
    Write-Host "JPEG folder not found. Creating and processing images...`n" -ForegroundColor Green

    New-Item -ItemType Directory -Path $jpegFolder | Out-Null

    $files = @(
        Get-ChildItem -LiteralPath $folder.FullName -File -Filter *.jpg |
            Sort-Object LastWriteTime
    )

    if ($files.Count -eq 0) {
        Write-Host "ERROR: No JPG files found in the species folder!" -ForegroundColor Red
        return
    }

    $counter = 1

    foreach ($file in $files) {
        $num = "{0:D2}" -f $counter

        if ($isUncatalogued) {
            $newName = "{0}_Uncatalogued{1}{2}" -f $species, $num, $file.Extension
        } else {
            $newName = "{0}_E{1}{2}" -f $species, $num, $file.Extension
        }

        $destPath = Join-Path -Path $jpegFolder -ChildPath $newName
        Copy-Item -LiteralPath $file.FullName -Destination $destPath

        # Extract date and time from the original filename.
        if ($file.Name -match '(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})') {
            try {
                $timestamp = Get-Date `
                    -Year $matches[1] `
                    -Month $matches[2] `
                    -Day $matches[3] `
                    -Hour $matches[4] `
                    -Minute $matches[5] `
                    -Second $matches[6]

                $copiedFile = Get-Item -LiteralPath $destPath
                $copiedFile.LastWriteTime = $timestamp
                $copiedFile.CreationTime = $timestamp
                Write-Host "Copied: $($file.Name) -> $newName (Date: $timestamp)"
            } catch {
                Write-Host "Copied: $($file.Name) -> $newName (Could not parse date)"
            }
        } else {
            Write-Host "Copied: $($file.Name) -> $newName"
        }

        $counter++
    }

    Write-Host

    $lines = @(
        "Next steps:",
        "  1. Use Explorer and update file names to include the actual catalogue number",
        "  2. Verify catalogue numbers with the spreadsheet, fix errors, and annotate the scan date",
        "  3. Run the script again to create TIFF files"
    )

    foreach ($line in $lines) {
        Write-Host $line.PadRight($width) -ForegroundColor Magenta -BackgroundColor Black
    }

    Write-Host

    if ($isUncatalogued) {
        Write-Host "Files renamed as Uncatalogued. Adjust numbers sequentially before running again to create TIFFs.`n" -ForegroundColor Yellow
    }

    return
}

# Case 2: JPEG exists but TIFF does not; convert the JPEG files to TIFF.
if ($jpegExists -and -not $tiffExists) {
    Write-Host "JPEG folder found. Converting to TIFF...`n" -ForegroundColor Green

    Add-Type -AssemblyName System.Drawing
    New-Item -ItemType Directory -Path $tiffFolder | Out-Null

    $files = @(
        Get-ChildItem -LiteralPath $jpegFolder -File -Filter *.jpg |
            Sort-Object Name
    )

    if ($files.Count -eq 0) {
        Write-Host "ERROR: No JPG files found in the JPEG folder!" -ForegroundColor Red
        return
    }

    $counter = 1
    $total = $files.Count

    foreach ($file in $files) {
        $memoryStream = $null
        $jpeg = $null

        try {
            # Load into memory so the original JPEG is not left locked.
            $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
            $memoryStream = [System.IO.MemoryStream]::new([byte[]]$bytes)
            $jpeg = [System.Drawing.Image]::FromStream($memoryStream)

            $encoderParams = [System.Drawing.Imaging.EncoderParameters]::new(1)
            $encoderParams.Param[0] = [System.Drawing.Imaging.EncoderParameter]::new(
                [System.Drawing.Imaging.Encoder]::Compression,
                [long][System.Drawing.Imaging.EncoderValue]::CompressionLZW
            )

            $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
                Where-Object MimeType -eq 'image/tiff'

            $outputPath = Join-Path -Path $tiffFolder -ChildPath ($file.BaseName + '.tif')
            $jpeg.Save($outputPath, $codec, $encoderParams)

            Write-Host "[$counter/$total] Converted: $($file.Name) -> TIFF\$($file.BaseName).tif"
        } catch {
            Write-Host "[$counter/$total] ERROR converting $($file.Name): $_" -ForegroundColor Red
        } finally {
            if ($null -ne $jpeg) {
                $jpeg.Dispose()
            }
            if ($null -ne $memoryStream) {
                $memoryStream.Dispose()
            }
        }

        $counter++
    }

    Write-Host "`nDone! Processed $($counter - 1) files into TIFF.`n" -ForegroundColor Green

    # Move to the next species alphabetically within the same genus folder.
    $current = $folder
    $parent = $current.Parent
    $folders = @(Get-ChildItem -LiteralPath $parent.FullName -Directory | Sort-Object Name)

    $index = -1
    for ($i = 0; $i -lt $folders.Count; $i++) {
        if ($folders[$i].FullName -eq $current.FullName) {
            $index = $i
            break
        }
    }

    if ($index -ge 0 -and $index -lt ($folders.Count - 1)) {
        $nextFolder = $folders[$index + 1]
        Set-Location -LiteralPath $nextFolder.FullName

        $lines = @(
            "Next steps:",
            "  1. Folder updated to the next species ($($nextFolder.Name))",
            "  2. Run the script again to start processing the next species of scans"
        )

        foreach ($line in $lines) {
            Write-Host $line.PadRight($width) -ForegroundColor Magenta -BackgroundColor Black
        }

        Write-Host
    } else {
        Write-Host "You are already in the last species folder. No next folder exists."
        Set-Location -LiteralPath $parent.FullName
    }

    return
}

# Case 3: Both folders exist; check whether they contain files.
if ($jpegExists -and $tiffExists) {
    $jpegFiles = @(Get-ChildItem -LiteralPath $jpegFolder -File)
    $tiffFiles = @(Get-ChildItem -LiteralPath $tiffFolder -File)

    if ($jpegFiles.Count -gt 0 -or $tiffFiles.Count -gt 0) {
        Write-Host "`nWARNING: Folders already exist and contain files; this species may already be processed. Double-check!" -ForegroundColor Red
        Write-Host "JPEG folder: $($jpegFiles.Count) files" -ForegroundColor Red
        Write-Host "TIFF folder: $($tiffFiles.Count) files`n" -ForegroundColor Red
    } else {
        Write-Host "`nBoth folders exist but are empty. Deleting the empty folders and restarting...`n" -ForegroundColor Yellow
        Remove-Item -LiteralPath $jpegFolder -Force
        Remove-Item -LiteralPath $tiffFolder -Force
        Write-Host "Empty folders deleted. Rerunning the script...`n" -ForegroundColor Green

        # Keep the same species target even though the script is stored elsewhere.
        & $PSCommandPath -SpeciesFolder $folder.FullName
    }

    return
}
