/*
 * The break-point store (docs/blocks-spec.md, Stage 6, "The store"):
 * `<data>/breaks/<showKey>.json`, one small file per show (the key
 * transitions.showKey uses), holding that show's settings and a record per
 * file, keyed by the file's path. A file reached under two show keys still
 * has one record, found by its path wherever it is stored.
 */

const fs = require('fs');
const path = require('path');

const CURRENT_SCANNER_VERSION = 1;

// How close an old approved point and a freshly found one must be (by kind
// and time) to be "the same break" after a file changes - the same 45s the
// show pattern itself groups points by.
const CARRY_APPROVAL_NEAR_S = 45;

// A show key can hold any character a real title does ("Are You Afraid of
// the Dark?", "Click: The Calendar Girl Christmas") - Windows forbids several
// of those in a filename, so they're percent-encoded going to disk and
// decoded back by listShowKeys.
const UNSAFE_IN_FILENAME = /[<>:"/\\|?*\x00-\x1f%]/g;

function sanitizeKey(key) {
    return key.replace(UNSAFE_IN_FILENAME, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

function desanitizeKey(name) {
    return name.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function showFile(breaksDir, key) {
    return path.join(breaksDir, sanitizeKey(key) + '.json');
}

function emptyShow() {
    return { theatrical: false, pattern: null, files: {} };
}

function loadShow(breaksDir, key) {
    const file = showFile(breaksDir, key);
    if (!fs.existsSync(file)) {
        return emptyShow();
    }
    return { ...emptyShow(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function saveShow(breaksDir, key, show) {
    fs.mkdirSync(breaksDir, { recursive: true });
    fs.writeFileSync(showFile(breaksDir, key), JSON.stringify(show));
}

function listShowKeys(breaksDir) {
    if (!fs.existsSync(breaksDir)) {
        return [];
    }
    return fs.readdirSync(breaksDir)
        .filter( (f) => f.endsWith('.json') )
        .map( (f) => desanitizeKey(f.slice(0, -'.json'.length)) );
}

// "Found by its path wherever it is stored": walks every show's file until
// one holds this path.
function findRecord(breaksDir, filePath) {
    for (const key of listShowKeys(breaksDir)) {
        const show = loadShow(breaksDir, key);
        if (show.files[filePath]) {
            return { key, record: show.files[filePath] };
        }
    }
    return null;
}

function fingerprintOf(file) {
    return { ratingKey: file.ratingKey, size: file.size, mtimeMs: file.mtimeMs };
}

function sameFingerprint(record, file) {
    return !!record
        && (record.ratingKey === file.ratingKey)
        && (record.size === file.size)
        && (record.mtimeMs === file.mtimeMs);
}

// A record with no fingerprint match (new, or the file changed) needs a
// scan; one with a stored error is left for the caller's own retry schedule.
function needsScan(record, file) {
    return !record || !sameFingerprint(record, file);
}

// When a file changes, its old approved (or hand) points come back as
// `found`, carrying their approvedBy along, so the UI can say "approved
// before the file changed" and the pattern can approve them again in one
// click (docs/blocks-spec.md, Stage 6, "The store").
function carryApprovals(oldPoints, newPoints, nearS = CARRY_APPROVAL_NEAR_S) {
    const settled = (oldPoints || []).filter( (p) => (p.status === 'approved') || (p.status === 'hand') );
    return newPoints.map( (p) => {
        const match = settled.find( (o) => (o.kind === p.kind) && (Math.abs(o.at - p.at) <= nearS) );
        return match ? { ...p, approvedBy: match.approvedBy } : p;
    } );
}

/*
 * file: { path, ratingKey, size, mtimeMs, durationS, chapters }
 * scanResult: break-scan.js's scanFile() result, { points, timings }
 * Saves and returns the new record.
 */
function recordFor(breaksDir, key, file, scanResult, now = Date.now) {
    const show = loadShow(breaksDir, key);
    const old = show.files[file.path];
    const points = carryApprovals(old ? old.points : [], scanResult.points);
    const record = {
        ratingKey: file.ratingKey,
        size: file.size,
        mtimeMs: file.mtimeMs,
        durationMs: Math.round(file.durationS * 1000),
        scannedAt: now(),
        scanner: CURRENT_SCANNER_VERSION,
        chapters: (file.chapters || []).map( (c) => [c.s, c.e, c.t] ),
        points,
        noBreaks: false,
        error: null,
    };
    show.files[file.path] = record;
    saveShow(breaksDir, key, show);
    return record;
}

function recordError(breaksDir, key, file, error, now = Date.now) {
    const show = loadShow(breaksDir, key);
    const old = show.files[file.path];
    show.files[file.path] = {
        ...(old || { ratingKey: file.ratingKey, size: file.size, mtimeMs: file.mtimeMs, points: [] }),
        error: { message: String((error && error.message) || error), at: now() },
    };
    saveShow(breaksDir, key, show);
    return show.files[file.path];
}

module.exports = {
    showFile, sanitizeKey, desanitizeKey, emptyShow, loadShow, saveShow, listShowKeys, findRecord,
    fingerprintOf, sameFingerprint, needsScan, carryApprovals,
    recordFor, recordError,
    CURRENT_SCANNER_VERSION, CARRY_APPROVAL_NEAR_S,
};
