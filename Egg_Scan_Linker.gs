/**
 * Egg Scan Linker V4.2 — bounded-memory, resumable Drive indexer
 *
 * ONE-TIME SETUP
 * 1. Apps Script editor -> Services (+) -> Drive API -> Add.
 * 2. Strongly recommended: paste the Family folder ID into ROOT_FOLDER_ID.
 *
 * V4 holds one Drive page at a time and writes matches immediately to a
 * hidden sheet. If one execution cannot finish, a time trigger resumes it.
 */

const CONFIG = Object.freeze({
  E_NUMBER_COL: 14,
  TARGET_COL: 15,
  START_ROW: 2,
  ROOT_FOLDER_ID: '1rnIKpQg83jHh85Qr_TQqJ-ayEs0Q65HJ',
  ROOT_FOLDER_NAMES: ['Family', 'Egg Slip Scanning'],
  INDEX_SHEET_NAME: '__EGG_SCAN_INDEX_DO_NOT_EDIT',
  INDEX_MARKER: 'EGG_SCAN_INDEX_V4_STREAMING',
  INDEX_MAX_AGE_HOURS: 24,
  DRIVE_PAGE_SIZE: 250,
  PARENT_QUERY_BATCH_SIZE: 50,
  DRIVE_LIST_MAX_ATTEMPTS: 5,
  MAX_RUN_MS: 240000,
  CONTINUE_AFTER_MS: 60000,
  LINK_READ_SIZE: 2000,
  SHEET_WRITE_SIZE: 500,
  DIRECT_DEBUG_MAX_FILES: 250,
  CONTINUATION_FUNCTION: 'continueDriveScanIndex_'
});

const IDX = Object.freeze({
  DATA_FIRST_ROW: 3,
  ENUM_COL: 1,
  DATA_COLS: 7,
  FOLDER_ID_COL: 9,
  FOLDER_NAME_COL: 10,
  FOLDER_DONE_COL: 11,
  META_LABEL_COL: 14,
  META_VALUE_COL: 15
});

const META = Object.freeze({
  MARKER: 1, STATUS: 2, STARTED_AT: 3, COMPLETED_AT: 4,
  FOLDER_CURSOR: 5, PHASE: 6, PAGE_TOKEN: 7, ACTIVE_COUNT: 8,
  INDEX_NEXT_ROW: 9, FOLDER_NEXT_ROW: 10, FOLDERS_PROCESSED: 11,
  IMAGES_SEEN: 12, IMAGES_ACCEPTED: 13, INDEX_RECORDS: 14,
  LAST_ERROR: 15
});

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🥚 Egg Scans')
    .addItem('1. Build / Refresh Drive Index', 'refreshDriveScanIndex')
    .addItem('Resume Index Now (if idle)', 'resumeDriveScanIndex')
    .addItem('2. Link Entire Sheet', 'linkEntireSheetFast')
    .addItem('Process Selected Rows', 'processSelectedRowsFast')
    .addSeparator()
    .addItem('Test Selected Row (Fast Debug)', 'testActiveRow')
    .addItem('Show Index Status', 'showDriveIndexStatus')
    .addSeparator()
    .addItem('Clear ALL "Not Found" / "Missing Data" Cells', 'clearNotFound')
    .addToUi();
}

function getColumnMapping(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const map = { eNum: CONFIG.E_NUMBER_COL, target: CONFIG.TARGET_COL };
  headers.forEach((header, i) => {
    const clean = String(header).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (clean === 'catalognumber' || clean === 'catalognumbernumeric') map.eNum = i + 1;
    if (clean === 'scanlink') map.target = i + 1;
  });
  return map;
}

function refreshDriveScanIndex() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(1000)) {
    SpreadsheetApp.getUi().alert(
      'The index is already running in the background. Wait for that run to finish before starting over.'
    );
    return;
  }
  try {
    assertAdvancedDriveEnabled_();
    initializeIndexBuild_();
    showBuildResult_(runIndexBuild_());
  } catch (error) {
    recordBuildError_(error);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function resumeDriveScanIndex() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(1000)) {
    SpreadsheetApp.getUi().alert(
      'The index is already running in the background. No second worker was started.'
    );
    return;
  }
  try {
    assertAdvancedDriveEnabled_();
    showBuildResult_(runIndexBuild_());
  } catch (error) {
    recordBuildError_(error);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function continueDriveScanIndex_() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(5000)) {
    scheduleContinuation_();
    return;
  }
  try {
    assertAdvancedDriveEnabled_();
    runIndexBuild_();
  } catch (error) {
    recordBuildError_(error);
    deleteContinuationTriggers_();
  } finally {
    lock.releaseLock();
  }
}

function initializeIndexBuild_() {
  const ss = SpreadsheetApp.getActive();
  PropertiesService.getScriptProperties().setProperty('EGG_SCAN_SPREADSHEET_ID', ss.getId());
  let sheet = ss.getSheetByName(CONFIG.INDEX_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CONFIG.INDEX_SHEET_NAME, 1);
  deleteContinuationTriggers_();
  sheet.clearContents();
  ensureSheetSize_(sheet, 1000, 15);

  sheet.getRange(2, 1, 1, IDX.DATA_COLS).setValues([[
    'E number', 'Label', 'URL', 'Updated (ms)', 'In JPEG folder', 'Shared', 'File ID'
  ]]);
  sheet.getRange(2, IDX.FOLDER_ID_COL, 1, 3)
    .setValues([['Folder ID', 'Folder name', 'Processed']]);
  sheet.getRange(1, IDX.META_LABEL_COL, 15, 1).setValues([
    ['Marker'], ['Status'], ['Started'], ['Completed'], ['Folder cursor'],
    ['Phase'], ['Page token'], ['Active folder count'], ['Next index row'],
    ['Next folder row'], ['Folders processed'], ['JPEGs examined'],
    ['JPEGs accepted'], ['Index records'], ['Last error']
  ]);

  const roots = resolveRootFolders_();
  if (!roots.length) {
    throw new Error('No root folder found. Set CONFIG.ROOT_FOLDER_ID to the Family folder ID.');
  }
  ensureSheetSize_(sheet, IDX.DATA_FIRST_ROW + roots.length, 15);
  sheet.getRange(IDX.DATA_FIRST_ROW, IDX.FOLDER_ID_COL, roots.length, 3)
    .setValues(roots.map(folder => [folder.id, folder.name, false]));

  const values = Array.from({ length: 15 }, () => ['']);
  values[META.MARKER - 1] = [CONFIG.INDEX_MARKER];
  values[META.STATUS - 1] = ['BUILDING'];
  values[META.STARTED_AT - 1] = [Date.now()];
  values[META.COMPLETED_AT - 1] = [0];
  values[META.FOLDER_CURSOR - 1] = [IDX.DATA_FIRST_ROW];
  values[META.PHASE - 1] = ['CHILDREN'];
  values[META.PAGE_TOKEN - 1] = [''];
  values[META.ACTIVE_COUNT - 1] = [Math.min(CONFIG.PARENT_QUERY_BATCH_SIZE, roots.length)];
  values[META.INDEX_NEXT_ROW - 1] = [IDX.DATA_FIRST_ROW];
  values[META.FOLDER_NEXT_ROW - 1] = [IDX.DATA_FIRST_ROW + roots.length];
  values[META.FOLDERS_PROCESSED - 1] = [0];
  values[META.IMAGES_SEEN - 1] = [0];
  values[META.IMAGES_ACCEPTED - 1] = [0];
  values[META.INDEX_RECORDS - 1] = [0];
  values[META.LAST_ERROR - 1] = [''];
  sheet.getRange(1, IDX.META_VALUE_COL, 15, 1).setValues(values);
  if (!sheet.isSheetHidden()) sheet.hideSheet();
}

function resolveRootFolders_() {
  const rootId = String(CONFIG.ROOT_FOLDER_ID || '').trim();
  if (rootId) {
    const file = Drive.Files.get(rootId, {
      fields: 'id,name,mimeType', supportsAllDrives: true
    });
    if (file.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error('CONFIG.ROOT_FOLDER_ID does not identify a Drive folder.');
    }
    return [{ id: file.id, name: String(file.name || 'Family') }];
  }

  const names = CONFIG.ROOT_FOLDER_NAMES
    .map(name => `name = '${escapeDriveQueryValue_(name)}'`).join(' or ');
  const q = "mimeType = 'application/vnd.google-apps.folder' and trashed = false and (" + names + ')';
  const roots = [];
  let token = '';
  do {
    const options = {
      q: q, pageSize: 100, fields: 'nextPageToken,files(id,name)',
      spaces: 'drive', corpora: 'user', includeItemsFromAllDrives: true,
      supportsAllDrives: true
    };
    if (token) options.pageToken = token;
    const page = driveListWithRetry_(options);
    (page.files || []).forEach(file => roots.push({ id: file.id, name: file.name }));
    token = page.nextPageToken || '';
  } while (token);
  return deduplicateById_(roots);
}

/** Fetches, writes, and checkpoints one Drive page at a time. */
function runIndexBuild_() {
  const started = Date.now();
  const sheet = getBoundSpreadsheet_().getSheetByName(CONFIG.INDEX_SHEET_NAME);
  if (!sheet || metaValue_(sheet, META.MARKER) !== CONFIG.INDEX_MARKER) {
    throw new Error('No V4 build exists. Run “Build / Refresh Drive Index” first.');
  }
  let state = readBuildState_(sheet);
  if (state.status === 'READY') return buildResultObject_(state, true);
  if (state.status === 'ERROR') throw new Error('Previous build stopped: ' + state.lastError);
  if (state.status !== 'BUILDING') throw new Error('Unexpected index status: ' + state.status);
  const knownFolderIds = loadKnownFolderIds_(sheet, state.folderNextRow);

  while (Date.now() - started < CONFIG.MAX_RUN_MS) {
    state = readBuildState_(sheet);
    if (state.folderCursor >= state.folderNextRow) {
      finalizeIndexBuild_(sheet, state);
      return buildResultObject_(readBuildState_(sheet), true);
    }

    const available = state.folderNextRow - state.folderCursor;
    const activeCount = state.activeCount > 0
      ? Math.min(state.activeCount, available)
      : Math.min(CONFIG.PARENT_QUERY_BATCH_SIZE, available);
    const rows = sheet.getRange(state.folderCursor, IDX.FOLDER_ID_COL, activeCount, 2)
      .getDisplayValues();
    const folders = rows.map(row => ({ id: row[0], name: row[1] })).filter(f => f.id);
    if (!folders.length) throw new Error('Empty folder queue at row ' + state.folderCursor);
    if (state.activeCount !== folders.length) {
      setMetaValue_(sheet, META.ACTIVE_COUNT, folders.length);
    }
    const parents = folders.map(folder =>
      `'${escapeDriveQueryValue_(folder.id)}' in parents`).join(' or ');

    if (state.phase === 'CHILDREN') {
      const options = {
        q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false and (" + parents + ')',
        pageSize: CONFIG.DRIVE_PAGE_SIZE,
        fields: 'nextPageToken,files(id,name)', spaces: 'drive', corpora: 'user',
        includeItemsFromAllDrives: true, supportsAllDrives: true
      };
      if (state.pageToken) options.pageToken = state.pageToken;
      const page = driveListWithRetry_(options);
      appendNewFolders_(sheet, page.files || [], knownFolderIds);
      if (page.nextPageToken) {
        setMetaValue_(sheet, META.PAGE_TOKEN, page.nextPageToken);
      } else {
        setMetaValues_(sheet, [[META.PHASE, 'IMAGES'], [META.PAGE_TOKEN, '']]);
      }
    } else if (state.phase === 'IMAGES') {
      const options = {
        q: "mimeType = 'image/jpeg' and trashed = false and (" + parents + ')',
        pageSize: CONFIG.DRIVE_PAGE_SIZE,
        fields: 'nextPageToken,files(id,name,parents,modifiedTime,webViewLink,shared,driveId)',
        spaces: 'drive', corpora: 'user', includeItemsFromAllDrives: true,
        supportsAllDrives: true
      };
      if (state.pageToken) options.pageToken = state.pageToken;
      const page = driveListWithRetry_(options);
      appendImagePage_(sheet, page.files || [], folders);
      if (page.nextPageToken) {
        setMetaValue_(sheet, META.PAGE_TOKEN, page.nextPageToken);
      } else {
        completeActiveFolderBatch_(sheet, folders.length);
      }
    } else {
      throw new Error('Unknown build phase: ' + state.phase);
    }
  }
  scheduleContinuation_();
  return buildResultObject_(readBuildState_(sheet), false);
}

function appendNewFolders_(sheet, files, knownIds) {
  const rows = [];
  files.forEach(file => {
    if (!file.id || knownIds.has(file.id)) return;
    knownIds.add(file.id);
    rows.push([file.id, String(file.name || ''), false]);
  });
  if (!rows.length) return;
  const nextRow = Number(metaValue_(sheet, META.FOLDER_NEXT_ROW));
  ensureSheetSize_(sheet, nextRow + rows.length, 15);
  sheet.getRange(nextRow, IDX.FOLDER_ID_COL, rows.length, 3).setValues(rows);
  setMetaValue_(sheet, META.FOLDER_NEXT_ROW, nextRow + rows.length);
}

function appendImagePage_(sheet, files, activeFolders) {
  const folderNames = new Map(activeFolders.map(folder => [folder.id, folder.name]));
  const rows = [];
  let accepted = 0;
  files.forEach(file => {
    const name = String(file.name || '');
    const eNumbers = extractENumbers_(name);
    if (!eNumbers.length) return;
    accepted++;
    const inJpeg = (file.parents || []).some(id =>
      String(folderNames.get(id) || '').trim().toUpperCase() === 'JPEG');
    const label = extractCardLabel_(name);
    const url = file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`;
    const updated = Date.parse(file.modifiedTime || '') || 0;
    const shared = file.shared === true || Boolean(file.driveId);
    eNumbers.forEach(eNum => rows.push([
      eNum, label, url, updated, inJpeg, shared, file.id
    ]));
  });

  const state = readBuildState_(sheet);
  if (rows.length) {
    ensureSheetSize_(sheet, state.indexNextRow + rows.length, 15);
    for (let offset = 0; offset < rows.length; offset += CONFIG.SHEET_WRITE_SIZE) {
      const chunk = rows.slice(offset, offset + CONFIG.SHEET_WRITE_SIZE);
      sheet.getRange(state.indexNextRow + offset, 1, chunk.length, IDX.DATA_COLS)
        .setValues(chunk);
    }
  }
  setMetaValues_(sheet, [
    [META.INDEX_NEXT_ROW, state.indexNextRow + rows.length],
    [META.IMAGES_SEEN, state.imagesSeen + files.length],
    [META.IMAGES_ACCEPTED, state.imagesAccepted + accepted],
    [META.INDEX_RECORDS, state.indexRecords + rows.length]
  ]);
}

function completeActiveFolderBatch_(sheet, count) {
  const state = readBuildState_(sheet);
  sheet.getRange(state.folderCursor, IDX.FOLDER_DONE_COL, count, 1)
    .setValues(Array.from({ length: count }, () => [true]));
  setMetaValues_(sheet, [
    [META.FOLDER_CURSOR, state.folderCursor + count],
    [META.FOLDERS_PROCESSED, state.foldersProcessed + count],
    [META.PHASE, 'CHILDREN'], [META.PAGE_TOKEN, ''], [META.ACTIVE_COUNT, 0]
  ]);
}

function finalizeIndexBuild_(sheet, state) {
  if (state.indexRecords > 1) {
    sheet.getRange(IDX.DATA_FIRST_ROW, 1, state.indexRecords, IDX.DATA_COLS)
      .sort([{ column: 1, ascending: true }, { column: 2, ascending: true }]);
  }
  setMetaValues_(sheet, [
    [META.STATUS, 'READY'], [META.COMPLETED_AT, Date.now()], [META.LAST_ERROR, '']
  ]);
  deleteContinuationTriggers_();
}

function linkEntireSheetFast() {
  const sheet = getActiveDataSheet_();
  const map = getColumnMapping(sheet);
  const sheetLastRow = sheet.getLastRow();
  const dataLastRow = findLastNonblankRow_(sheet, map.eNum, sheetLastRow);

  // Remove statuses left by an older run below the actual data endpoint.
  // Links and other values are deliberately preserved.
  if (sheetLastRow > dataLastRow) {
    clearTrailingMissingData_(sheet, map.target, dataLastRow + 1, sheetLastRow);
  }
  if (dataLastRow < CONFIG.START_ROW) {
    SpreadsheetApp.getUi().alert('No catalog/E-number data rows were found.');
    return;
  }
  linkRows_(sheet, CONFIG.START_ROW, dataLastRow - CONFIG.START_ROW + 1);
}

/** Finds the real endpoint from the key catalog column, not sheet formatting. */
function findLastNonblankRow_(sheet, column, sheetLastRow) {
  if (sheetLastRow < CONFIG.START_ROW) return CONFIG.START_ROW - 1;
  const count = sheetLastRow - CONFIG.START_ROW + 1;
  const values = sheet.getRange(CONFIG.START_ROW, column, count, 1).getDisplayValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0]).trim() !== '') return CONFIG.START_ROW + i;
  }
  return CONFIG.START_ROW - 1;
}

function clearTrailingMissingData_(sheet, column, firstRow, lastRow) {
  if (lastRow < firstRow) return;
  const count = lastRow - firstRow + 1;
  const values = sheet.getRange(firstRow, column, count, 1).getDisplayValues();
  const col = columnToLetter_(column);
  const ranges = [];
  let runStart = null;

  for (let i = 0; i <= values.length; i++) {
    const shouldClear = i < values.length && String(values[i][0]).trim() === 'Missing Data';
    if (shouldClear && runStart === null) runStart = i;
    if (!shouldClear && runStart !== null) {
      ranges.push(`${col}${firstRow + runStart}:${col}${firstRow + i - 1}`);
      runStart = null;
    }
  }
  for (let i = 0; i < ranges.length; i += 500) {
    sheet.getRangeList(ranges.slice(i, i + 500)).clearContent();
  }
}

function processSelectedRowsFast() {
  const sheet = getActiveDataSheet_();
  const range = sheet.getActiveRange();
  if (!range) return;
  const first = Math.max(CONFIG.START_ROW, range.getRow());
  const last = range.getLastRow();
  if (last >= first) linkRows_(sheet, first, last - first + 1);
}

function linkRows_(sheet, firstRow, rowCount) {
  const started = Date.now();
  const indexSheet = requireReadyIndex_();
  const map = getColumnMapping(sheet);
  const inputs = sheet.getRange(firstRow, map.eNum, rowCount, 1).getDisplayValues();
  const wanted = new Set();
  inputs.forEach(row => {
    const eNum = cleanENumber_(row[0]);
    if (eNum) wanted.add(eNum);
  });
  const descriptors = loadDescriptorsForEnums_(indexSheet, wanted);
  for (let offset = 0; offset < inputs.length; offset += CONFIG.SHEET_WRITE_SIZE) {
    const chunk = inputs.slice(offset, offset + CONFIG.SHEET_WRITE_SIZE).map(row => {
      const eNum = cleanENumber_(row[0]);
      if (!eNum) return [plainRichText_('Missing Data')];
      const descriptor = descriptors.get(eNum);
      return [descriptor ? richTextFromDescriptor_(descriptor) : plainRichText_('Not Found')];
    });
    sheet.getRange(firstRow + offset, map.target, chunk.length, 1).setRichTextValues(chunk);
  }
  const seconds = (Date.now() - started) / 1000;
  SpreadsheetApp.getUi().alert(
    `Egg scan linking complete.\n\nRows: ${rowCount.toLocaleString()}\n` +
    `Catalog numbers matched: ${descriptors.size.toLocaleString()}\n` +
    `Elapsed: ${seconds.toFixed(1)} seconds`
  );
}

/** Index rows are sorted by E-number, so only one group is held at once. */
function loadDescriptorsForEnums_(sheet, wanted) {
  const count = Number(metaValue_(sheet, META.INDEX_RECORDS)) || 0;
  const found = new Map();
  let currentEnum = null;
  let candidates = [];
  function finishGroup() {
    if (currentEnum !== null && wanted.has(currentEnum)) {
      found.set(currentEnum, makeDescriptor_(rankCandidateGroup_(candidates)));
    }
    candidates = [];
  }
  for (let offset = 0; offset < count; offset += CONFIG.LINK_READ_SIZE) {
    const size = Math.min(CONFIG.LINK_READ_SIZE, count - offset);
    const rows = sheet.getRange(IDX.DATA_FIRST_ROW + offset, 1, size, 6).getValues();
    rows.forEach(row => {
      const eNum = String(row[0] || '');
      if (!eNum) return;
      if (currentEnum !== null && eNum !== currentEnum) finishGroup();
      if (eNum !== currentEnum) currentEnum = eNum;
      if (wanted.has(eNum)) candidates.push(candidateFromRow_(row));
    });
  }
  finishGroup();
  return found;
}

function testActiveRow() {
  const sheet = getActiveDataSheet_();
  const row = sheet.getActiveCell().getRow();
  if (row < CONFIG.START_ROW) {
    SpreadsheetApp.getUi().alert('Select a data row (row 2 or below).');
    return;
  }
  const map = getColumnMapping(sheet);
  const eNum = cleanENumber_(sheet.getRange(row, map.eNum).getDisplayValue());
  if (!eNum) {
    SpreadsheetApp.getUi().alert('Row ' + row + ' has no valid E-number.');
    return;
  }
  // Debug is deliberately live. A corrected filename must be visible
  // immediately even when the global index was built before the correction.
  const matches = directDebugLookup_(eNum);
  if (!matches.length) {
    SpreadsheetApp.getUi().alert(`No JPEG found for E${eNum} in the live Drive lookup.`);
    return;
  }
  sheet.getRange(row, map.target)
    .setRichTextValue(richTextFromDescriptor_(makeDescriptor_(matches)));
  const patchResult = patchSavedIndexForEnum_(eNum, matches);
  const report = matches.map(match => `• ${match.label}\n  ${match.url}`).join('\n');
  SpreadsheetApp.getUi().alert(
    `Matches for E${eNum} (live Drive lookup):\n\n${report}\n\n${patchResult.message}`
  );
}

/**
 * Replaces just one E-number's cached records after a live debug lookup.
 * The complete Drive tree is not rescanned. The final sort preserves the
 * streaming linker's requirement that index rows remain grouped by E-number.
 */
function patchSavedIndexForEnum_(eNum, matches) {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(1000)) {
    return { patched: false, message: 'The sheet row was updated; the index is currently building.' };
  }
  try {
    const sheet = getBoundSpreadsheet_().getSheetByName(CONFIG.INDEX_SHEET_NAME);
    if (!sheet || metaValue_(sheet, META.MARKER) !== CONFIG.INDEX_MARKER ||
        metaValue_(sheet, META.STATUS) !== 'READY') {
      return { patched: false, message: 'The sheet row was updated; the index is not READY yet.' };
    }

    const state = readBuildState_(sheet);
    const existing = state.indexRecords
      ? sheet.getRange(IDX.DATA_FIRST_ROW, IDX.ENUM_COL, state.indexRecords, 1)
          .createTextFinder(eNum).matchEntireCell(true).findAll()
      : [];
    const newRows = matches.map(match => [
      eNum, match.label, match.url, match.updated, match.inJpegFolder,
      match.isShared, match.id || ''
    ]);

    // Existing E-number rows are contiguous because the cache is sorted.
    const reusable = Math.min(existing.length, newRows.length);
    if (existing.length) {
      const first = Math.min.apply(null, existing.map(range => range.getRow()));
      const replacement = [];
      for (let i = 0; i < existing.length; i++) {
        replacement.push(i < reusable ? newRows[i] : ['', '', '', '', '', '', '']);
      }
      sheet.getRange(first, 1, replacement.length, IDX.DATA_COLS).setValues(replacement);
    }

    const extras = newRows.slice(reusable);
    let newSpan = state.indexRecords;
    if (extras.length) {
      ensureSheetSize_(sheet, state.indexNextRow + extras.length, 15);
      sheet.getRange(state.indexNextRow, 1, extras.length, IDX.DATA_COLS).setValues(extras);
      newSpan += extras.length;
      setMetaValues_(sheet, [
        [META.INDEX_NEXT_ROW, state.indexNextRow + extras.length],
        [META.INDEX_RECORDS, newSpan]
      ]);
    }

    if (newSpan > 1) {
      sheet.getRange(IDX.DATA_FIRST_ROW, 1, newSpan, IDX.DATA_COLS)
        .sort([{ column: 1, ascending: true }, { column: 2, ascending: true }]);
    }
    return { patched: true, message: 'The selected row and saved index were both updated.' };
  } finally {
    lock.releaseLock();
  }
}

function findSavedMatches_(sheet, eNum) {
  const count = Number(metaValue_(sheet, META.INDEX_RECORDS)) || 0;
  if (!count) return [];
  const matches = sheet.getRange(IDX.DATA_FIRST_ROW, IDX.ENUM_COL, count, 1)
    .createTextFinder(eNum).matchEntireCell(true).findAll();
  if (!matches.length) return [];
  const first = Math.min.apply(null, matches.map(range => range.getRow()));
  const rows = sheet.getRange(first, 1, matches.length, 6).getValues();
  return rankCandidateGroup_(rows.map(candidateFromRow_));
}

/** Fast debug path: one E token, no global index construction. */
function directDebugLookup_(eNum) {
  const query = `mimeType = 'image/jpeg' and title contains 'E${eNum}' and trashed = false`;
  const files = DriveApp.searchFiles(query);
  const candidates = [];
  let examined = 0;
  while (files.hasNext() && examined < CONFIG.DIRECT_DEBUG_MAX_FILES) {
    const file = files.next();
    examined++;
    const name = file.getName();
    if (!extractENumbers_(name).includes(eNum)) continue;
    const placement = inspectDriveAppPlacement_(file);
    if (!placement.insideTarget) continue;
    candidates.push({
      label: extractCardLabel_(name), url: file.getUrl(),
      updated: file.getLastUpdated().getTime(),
      inJpegFolder: placement.inJpegFolder, isShared: false,
      id: file.getId()
    });
  }
  return rankCandidateGroup_(candidates);
}

function inspectDriveAppPlacement_(file) {
  const rootId = String(CONFIG.ROOT_FOLDER_ID || '').trim();
  const rootNames = new Set(CONFIG.ROOT_FOLDER_NAMES.map(name => name.trim().toLowerCase()));
  const queue = [];
  const directParents = file.getParents();
  let inJpegFolder = false;
  while (directParents.hasNext()) {
    const parent = directParents.next();
    if (parent.getName().trim().toUpperCase() === 'JPEG') inJpegFolder = true;
    queue.push(parent);
  }
  const visited = new Set();
  while (queue.length) {
    const folder = queue.shift();
    const id = folder.getId();
    if (visited.has(id)) continue;
    visited.add(id);
    if ((rootId && id === rootId) ||
        (!rootId && rootNames.has(folder.getName().trim().toLowerCase()))) {
      return { insideTarget: true, inJpegFolder: inJpegFolder };
    }
    const parents = folder.getParents();
    while (parents.hasNext()) queue.push(parents.next());
  }
  return { insideTarget: false, inJpegFolder: inJpegFolder };
}

function rankCandidateGroup_(candidates) {
  const best = new Map();
  candidates.forEach(candidate => {
    const key = candidate.label.toLowerCase();
    const existing = best.get(key);
    if (!existing || compareCandidates_(candidate, existing) < 0) best.set(key, candidate);
  });
  let result = Array.from(best.values());
  if (result.some(file => /\([A-Z0-9]+\)/i.test(file.label))) {
    result = result.filter(file => /\([A-Z0-9]+\)/i.test(file.label));
  }
  result.sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' })
  );
  return result;
}

function compareCandidates_(a, b) {
  if (a.isShared !== b.isShared) return a.isShared ? -1 : 1;
  if (a.inJpegFolder !== b.inJpegFolder) return a.inJpegFolder ? -1 : 1;
  return b.updated - a.updated;
}

function candidateFromRow_(row) {
  return {
    label: String(row[1] || ''), url: String(row[2] || ''),
    updated: Number(row[3]) || 0, inJpegFolder: row[4] === true,
    isShared: row[5] === true
  };
}

function makeDescriptor_(matches) {
  let text = '';
  const spans = [];
  matches.forEach((file, i) => {
    if (i) text += ', ';
    const start = text.length;
    text += file.label;
    spans.push([start, text.length, file.url]);
  });
  return { text: text, spans: spans };
}

function richTextFromDescriptor_(descriptor) {
  const builder = SpreadsheetApp.newRichTextValue().setText(descriptor.text);
  descriptor.spans.forEach(span => builder.setLinkUrl(span[0], span[1], span[2]));
  return builder.build();
}

function plainRichText_(text) {
  return SpreadsheetApp.newRichTextValue().setText(text).build();
}

function extractENumbers_(fileName) {
  const found = new Set();
  const regex = /(?:^|[^a-zA-Z0-9])E(\d+)(?![0-9])/gi;
  let match;
  while ((match = regex.exec(String(fileName))) !== null) found.add(match[1]);
  return Array.from(found);
}

function extractCardLabel_(fileName) {
  const match = String(fileName).match(/E\d+.*?\.(jpe?g)$/i);
  return match ? match[0] : String(fileName);
}

function cleanENumber_(value) {
  return String(value == null ? '' : value).replace(/[^0-9]/g, '');
}

function showDriveIndexStatus() {
  const sheet = getBoundSpreadsheet_().getSheetByName(CONFIG.INDEX_SHEET_NAME);
  if (!sheet || metaValue_(sheet, META.MARKER) !== CONFIG.INDEX_MARKER) {
    SpreadsheetApp.getUi().alert('No V4 Drive index exists yet.');
    return;
  }
  const state = readBuildState_(sheet);
  const workerRunning = isIndexWorkerRunning_();
  const total = Math.max(0, state.folderNextRow - IDX.DATA_FIRST_ROW);
  const percent = total ? Math.min(100, state.foldersProcessed / total * 100).toFixed(1) : '0.0';
  SpreadsheetApp.getUi().alert(
    `Index status: ${state.status}\n` +
    `Worker: ${workerRunning ? 'RUNNING NOW' : (state.status === 'BUILDING' ? 'waiting for continuation' : 'idle')}\n\n` +
    `Folders: ${state.foldersProcessed.toLocaleString()} / ${total.toLocaleString()} (${percent}%)\n` +
    `JPEGs examined: ${state.imagesSeen.toLocaleString()}\n` +
    `JPEGs containing E-numbers: ${state.imagesAccepted.toLocaleString()}\n` +
    `Index records: ${state.indexRecords.toLocaleString()}\n` +
    `Started: ${state.startedAt ? new Date(state.startedAt).toLocaleString() : 'unknown'}\n` +
    `Completed: ${state.completedAt ? new Date(state.completedAt).toLocaleString() : 'not yet'}\n` +
    (state.lastError ? `Last error: ${state.lastError}` : '')
  );
}

function isIndexWorkerRunning_() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(1)) return true;
  lock.releaseLock();
  return false;
}

function showBuildResult_(result) {
  if (result.complete) {
    SpreadsheetApp.getUi().alert(
      `Drive index complete.\n\nFolders: ${result.foldersProcessed.toLocaleString()}\n` +
      `JPEGs examined: ${result.imagesSeen.toLocaleString()}\n` +
      `JPEGs containing E-numbers: ${result.imagesAccepted.toLocaleString()}\n` +
      `Index records: ${result.indexRecords.toLocaleString()}\n\n` +
      `Now run “2. Link Entire Sheet”.`
    );
  } else {
    SpreadsheetApp.getUi().alert(
      'The index is still building, but it did not fail.\n\n' +
      'Progress was saved and continuation was scheduled automatically. ' +
      'You can close the spreadsheet and check “Show Index Status” later.'
    );
  }
}

function requireReadyIndex_() {
  const sheet = getBoundSpreadsheet_().getSheetByName(CONFIG.INDEX_SHEET_NAME);
  if (!sheet || metaValue_(sheet, META.MARKER) !== CONFIG.INDEX_MARKER) {
    throw new Error('Build the Drive index first: Egg Scans -> 1. Build / Refresh Drive Index.');
  }
  const state = readBuildState_(sheet);
  if (state.status !== 'READY') {
    throw new Error('The Drive index is ' + state.status + '. Wait for READY, then link the sheet.');
  }
  if (state.completedAt &&
      Date.now() - state.completedAt > CONFIG.INDEX_MAX_AGE_HOURS * 3600000) {
    getBoundSpreadsheet_().toast('The saved index is older than 24 hours.', 'Egg Scans');
  }
  return sheet;
}

function readBuildState_(sheet) {
  const v = sheet.getRange(1, IDX.META_VALUE_COL, 15, 1).getValues().map(row => row[0]);
  return {
    status: String(v[META.STATUS - 1] || ''),
    startedAt: Number(v[META.STARTED_AT - 1]) || 0,
    completedAt: Number(v[META.COMPLETED_AT - 1]) || 0,
    folderCursor: Number(v[META.FOLDER_CURSOR - 1]) || IDX.DATA_FIRST_ROW,
    phase: String(v[META.PHASE - 1] || 'CHILDREN'),
    pageToken: String(v[META.PAGE_TOKEN - 1] || ''),
    activeCount: Number(v[META.ACTIVE_COUNT - 1]) || 0,
    indexNextRow: Number(v[META.INDEX_NEXT_ROW - 1]) || IDX.DATA_FIRST_ROW,
    folderNextRow: Number(v[META.FOLDER_NEXT_ROW - 1]) || IDX.DATA_FIRST_ROW,
    foldersProcessed: Number(v[META.FOLDERS_PROCESSED - 1]) || 0,
    imagesSeen: Number(v[META.IMAGES_SEEN - 1]) || 0,
    imagesAccepted: Number(v[META.IMAGES_ACCEPTED - 1]) || 0,
    indexRecords: Number(v[META.INDEX_RECORDS - 1]) || 0,
    lastError: String(v[META.LAST_ERROR - 1] || '')
  };
}

function buildResultObject_(state, complete) {
  return {
    complete: complete, foldersProcessed: state.foldersProcessed,
    imagesSeen: state.imagesSeen, imagesAccepted: state.imagesAccepted,
    indexRecords: state.indexRecords
  };
}

function loadKnownFolderIds_(sheet, nextRow) {
  const count = Math.max(0, nextRow - IDX.DATA_FIRST_ROW);
  if (!count) return new Set();
  return new Set(sheet.getRange(IDX.DATA_FIRST_ROW, IDX.FOLDER_ID_COL, count, 1)
    .getDisplayValues().map(row => row[0]).filter(Boolean));
}

function metaValue_(sheet, row) {
  return sheet.getRange(row, IDX.META_VALUE_COL).getValue();
}

function setMetaValue_(sheet, row, value) {
  sheet.getRange(row, IDX.META_VALUE_COL).setValue(value);
}

function setMetaValues_(sheet, pairs) {
  const range = sheet.getRange(1, IDX.META_VALUE_COL, 15, 1);
  const values = range.getValues();
  pairs.forEach(pair => { values[pair[0] - 1][0] = pair[1]; });
  range.setValues(values);
}

function scheduleContinuation_() {
  deleteContinuationTriggers_();
  ScriptApp.newTrigger(CONFIG.CONTINUATION_FUNCTION)
    .timeBased().after(CONFIG.CONTINUE_AFTER_MS).create();
}

function deleteContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === CONFIG.CONTINUATION_FUNCTION) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function recordBuildError_(error) {
  try {
    const sheet = getBoundSpreadsheet_().getSheetByName(CONFIG.INDEX_SHEET_NAME);
    if (!sheet) return;
    setMetaValues_(sheet, [
      [META.STATUS, 'ERROR'],
      [META.LAST_ERROR, String(error && error.message ? error.message : error).slice(0, 1000)]
    ]);
  } catch (ignored) {}
}

function driveListWithRetry_(options) {
  for (let attempt = 1; attempt <= CONFIG.DRIVE_LIST_MAX_ATTEMPTS; attempt++) {
    try {
      return Drive.Files.list(options);
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      const transient = /(?:\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|rate limit|backend error|internal error|service unavailable|temporar(?:y|ily)|timed? ?out|try again)/i.test(message);
      if (!transient || attempt === CONFIG.DRIVE_LIST_MAX_ATTEMPTS) throw error;
      Utilities.sleep(Math.pow(2, attempt - 1) * 500 + Math.floor(Math.random() * 250));
    }
  }
  throw new Error('Unreachable Drive retry state.');
}

function escapeDriveQueryValue_(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function deduplicateById_(files) {
  const map = new Map();
  files.forEach(file => map.set(file.id, file));
  return Array.from(map.values());
}

function ensureSheetSize_(sheet, rows, cols) {
  if (sheet.getMaxRows() < rows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  }
  if (sheet.getMaxColumns() < cols) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), cols - sheet.getMaxColumns());
  }
}

function clearNotFound() {
  const sheet = getActiveDataSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < CONFIG.START_ROW) return;
  const map = getColumnMapping(sheet);
  const count = lastRow - CONFIG.START_ROW + 1;
  const values = sheet.getRange(CONFIG.START_ROW, map.target, count, 1).getDisplayValues();
  const statuses = new Set(['Not Found', 'API Error', 'Missing Data']);
  const a1 = [];
  let runStart = null;
  for (let i = 0; i <= values.length; i++) {
    const clear = i < values.length && statuses.has(String(values[i][0]).trim());
    if (clear && runStart === null) runStart = i;
    if (!clear && runStart !== null) {
      const col = columnToLetter_(map.target);
      a1.push(`${col}${CONFIG.START_ROW + runStart}:${col}${CONFIG.START_ROW + i - 1}`);
      runStart = null;
    }
  }
  for (let i = 0; i < a1.length; i += 500) {
    sheet.getRangeList(a1.slice(i, i + 500)).clearContent();
  }
  const cleared = values.reduce((n, row) =>
    n + (statuses.has(String(row[0]).trim()) ? 1 : 0), 0);
  SpreadsheetApp.getUi().alert(`Cleared ${cleared.toLocaleString()} non-link cells.`);
}

function columnToLetter_(column) {
  let n = column;
  let result = '';
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + n % 26) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

function getActiveDataSheet_() {
  const sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() === CONFIG.INDEX_SHEET_NAME) {
    throw new Error('Select the data sheet before running Egg Scans.');
  }
  return sheet;
}

/** Time-driven continuations have no browser UI, so reopen the bound sheet. */
function getBoundSpreadsheet_() {
  const active = SpreadsheetApp.getActive();
  if (active) return active;
  const id = PropertiesService.getScriptProperties().getProperty('EGG_SCAN_SPREADSHEET_ID');
  if (!id) throw new Error('Spreadsheet ID is unavailable. Start the index once from its menu.');
  return SpreadsheetApp.openById(id);
}

function assertAdvancedDriveEnabled_() {
  if (typeof Drive === 'undefined' || !Drive.Files || !Drive.Files.list) {
    throw new Error(
      'Enable the Advanced Drive service: Apps Script editor -> Services (+) -> Drive API -> Add.'
    );
  }
}
