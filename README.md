Process_Images.ps1

# Egg Slip Scanning – PowerShell Workflow

A fast, repeatable process for organizing CZUR scans into `JPEG/` and `TIFF/` derivatives, with consistent naming and light automation.

---

## Folder & Naming Conventions

* **Family folder** contains one folder per species:

  * Catalogued: `Genus_species`
  * Not yet catalogued: `Genus_species_(uncatalogued)`
* Inside each species folder the script creates:

  * `JPEG/` – renamed copies for review/renaming
  * `TIFF/` – final LZW-compressed TIFFs (created from `JPEG/`)

**File naming**

* Catalogued placeholder: `Genus_species_E01.jpg`, `Genus_species_E02.jpg`, … (2-digit zero-padded)
* Uncatalogued placeholder: `Genus_species_Uncatalogued01.jpg`, `…02.jpg`, …
* Later, you manually replace `E##` with the **actual catalog number** (e.g., `E1234`), and tag backs as `(A)` / `(B)` when needed.

**Timestamp extraction**

* If original CZUR filenames match `YYYY_MM_DD_HH_MM_SS`, the script applies that time to the copied file’s **Created/Modified** timestamps.

---

## What the Script Does

> File: `Process-Images.ps1` (run from a species folder)

1. **If `JPEG/` does not exist**

   * Creates `JPEG/`
   * Copies all `*.jpg` in the species folder into `JPEG/`
   * Applies placeholder names (catalogued = `_E##`, uncatalogued = `_Uncatalogued##`)
   * Attempts to set timestamps from original filenames
   * Prints next steps (rename in Explorer, verify against spreadsheet)
   * **Stop here** (you’ll run the script again later to make TIFFs)

2. **If `JPEG/` exists and `TIFF/` does not**

   * Creates `TIFF/`
   * Converts every `JPEG/*.jpg` to LZW-compressed `.tif` in `TIFF/`
   * Moves your shell to the **next species folder** (alphabetically) and prints a reminder to run the script again there

3. **If both `JPEG/` and `TIFF/` exist**

   * If either contains files: warns you (already processed; double-check)
   * If both are empty: deletes them and **re-runs itself** (fresh start)

---

## One-Time Setup (per Family)

1. **Connect the CZUR scanner** and open CZUR software.
2. Set **storage folder** to the *Family* folder you’re working on.
3. In **File Explorer**, create species folders as needed. Use the patterns above.

---

## Scanning Procedure (per Family)

1. **Scan the front of each envelope** first (as a separator/reference image).
2. **Scan slips**, front first; scan backs where present (you’ll add `(A)/(B)` when renaming).
3. For long white envelopes (bulk/overflow):

   * Scan those first; mark their **E numbers** yellow in the spreadsheet.
   * Copy those images into the correct **species** folder later.
4. If an envelope already shows initials/“scanned”, still scan the back to track it in batch context.
5. If a species envelope is **missing**, create a placeholder folder:

   * `Genus_species - Missing`
6. At the **end of a Family**, remember to change CZUR’s storage folder to the next Family.

---

## Organizing by Species (before running the script)

1. In Explorer, use the **envelope scans** to separate species.
2. Copy each species’ slip scans into the **matching species folder**.

   * Do **not** copy the envelope scan into the species folder (keep it as a visual separator only).
3. For long-envelope items, confirm destination via the **spreadsheet** and place them correctly.

---

## Running the Script & Renaming

1. In Explorer, **Shift+Right-click** the *species* folder → **Open PowerShell window here**.

2. Run the script:

   ```
   ..\..\..\Process-Images.ps1
   ```

   (You can type `..\..\..\P` then press **Tab** to autocomplete.)

3. **First run** (no `JPEG/` yet):

   * Script creates `JPEG/` and copies/renames your scans with placeholders.
   * In Explorer:

     * Use **Extra large icons** + **Preview pane** to read numbers quickly.
     * **Sort by Date → Ascending** to keep scan order.
     * Rename `E##` to the **actual catalog number** (e.g., `E1234`).
     * For backs/multipage, name as `E1234(A)`, `E1234(B)`, etc.

4. **Spreadsheet check**

   * Check off scans; fill in scan date.
   * If something is missing: check the **Zeros** sheet, re-check the envelope (slips can stick), verify numbers, rescan if needed.
   * Rescans: drop into the *Family* folder, copy into the species folder, then into `JPEG/` and rename manually.
   * If still missing, highlight **red** in the spreadsheet.
   * Consolidate any items highlighted **yellow** (from long envelopes) into the correct species; use another long envelope if needed and include the original small envelope.
   * Reorder physical cards in the envelope to **numerical order** if needed.

5. **Second run** (with renamed JPEGs):

   ```
   ..\..\..\Process-Images.ps1
   ```

   * Script makes `TIFF/` (LZW-compressed) from your `JPEG/` files.
   * Automatically advances to the **next species folder** and prompts you to run it again there.

---

## Tips

* Use **Up Arrow** in PowerShell to repeat the last command—no need to retype the path.
* Keep the **original CZUR files** in the species folder (outside `JPEG/`/`TIFF/`) for provenance.
* If both `JPEG/` and `TIFF/` already contain files, the script warns and exits—double-check you’re in the right place.
* If both subfolders exist but are empty, the script deletes them and restarts cleanly.

---

## Quick Reference

* Catalogued placeholders → `Genus_species_E01.jpg` → rename to real numbers later.
* Uncatalogued placeholders → `Genus_species_(uncatalogued)` folder → `Genus_species_Uncatalogued01.jpg`, etc.
* Backs/multipage → append `(A)`, `(B)`.
* Run order: **create `JPEG/` → rename** → **create `TIFF/`**.
* The script then **moves you to the next species** automatically.


<p align="center">
  <img src="https://github.com/erl67/museum-scanner/raw/main/output.png" alt="Script Output">
</p>
