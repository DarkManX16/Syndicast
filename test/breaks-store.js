/*
 * The break-point store (src/breaks-store.js): one JSON file per show key
 * under `<data>/breaks/`, a record per file found wherever it's stored, and
 * old approvals carried over as `found` when a file changes
 * (docs/blocks-spec.md, Stage 6, "The store").
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Suite } = require('./support');
const store = require('../src/breaks-store');

function tmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breaks-store-'));
    return dir;
}

module.exports = async () => {
    const suite = new Suite('breaks store');
    const dir = tmpDir();
    const breaksDir = path.join(dir, 'breaks');

    try {
        suite.check('an unscanned show starts empty, not theatrical, no pattern',
            JSON.stringify(store.loadShow(breaksDir, 'tv.Happy Days')) === JSON.stringify( { theatrical: false, pattern: null, files: {} } ));

        const file1 = { path: 'G:/HD/s01e01.mkv', ratingKey: '111', size: 900, mtimeMs: 1000, durationS: 1400, chapters: [] };
        const scanResult1 = { points: [ { at: 74, black: [74, 75], silence: [73.8, 75.2], kind: 'opening', sources: ['blackSilence'], strength: 0.6, keyframe: null, status: 'found', approvedBy: null } ] };
        const record1 = store.recordFor(breaksDir, 'tv.Happy Days', file1, scanResult1, () => 5000);

        suite.check('a fresh scan is saved under the show\'s key, keyed by the file\'s path',
            fs.existsSync(store.showFile(breaksDir, 'tv.Happy Days')));
        suite.check('the record keeps the fingerprint, the duration in ms, and when it was scanned',
            (record1.ratingKey === '111') && (record1.size === 900) && (record1.mtimeMs === 1000) && (record1.durationMs === 1400000) && (record1.scannedAt === 5000));
        suite.check('a record read back matches what was saved',
            JSON.stringify(store.loadShow(breaksDir, 'tv.Happy Days').files[file1.path]) === JSON.stringify(record1));

        suite.check('an unchanged file needs no rescan',
            store.needsScan(record1, file1) === false);
        suite.check('a file with a different size needs a rescan',
            store.needsScan(record1, { ...file1, size: 901 }) === true);
        suite.check('a file never scanned needs one',
            store.needsScan(null, file1) === true);

        suite.check('found by its path, without naming the show key',
            (() => {
                const found = store.findRecord(breaksDir, file1.path);
                return found && (found.key === 'tv.Happy Days') && (found.record.ratingKey === '111');
            })());
        suite.check('a path no show holds comes back empty',
            store.findRecord(breaksDir, 'G:/nope.mkv') === null);

        // Ron approves the opening by hand, then the file changes (re-ripped, same break).
        const approved = store.loadShow(breaksDir, 'tv.Happy Days');
        approved.files[file1.path].points[0].status = 'approved';
        approved.files[file1.path].points[0].approvedBy = 'pattern';
        store.saveShow(breaksDir, 'tv.Happy Days', approved);

        const file1Changed = { ...file1, size: 950, mtimeMs: 2000 };
        const scanResult2 = { points: [ { at: 75, black: [75, 76], silence: [74.8, 76.2], kind: 'opening', sources: ['blackSilence'], strength: 0.6, keyframe: null, status: 'found', approvedBy: null } ] };
        const record2 = store.recordFor(breaksDir, 'tv.Happy Days', file1Changed, scanResult2, () => 9000);

        suite.check('the changed file\'s fingerprint is the new one',
            (record2.size === 950) && (record2.mtimeMs === 2000));
        suite.check('the matching new point comes back marked as approved before the file changed',
            (record2.points.length === 1) && (record2.points[0].status === 'found') && (record2.points[0].approvedBy === 'pattern'));

        // Ron clicks approve again on the carried-over point, settling it for real...
        const settled = store.loadShow(breaksDir, 'tv.Happy Days');
        settled.files[file1Changed.path].points[0].status = 'approved';
        store.saveShow(breaksDir, 'tv.Happy Days', settled);

        // ...then the file changes once more, with a point nowhere near it.
        const scanResult3 = { points: [ { at: 400, black: [400, 401], silence: [399.8, 401.2], kind: 'act', sources: ['blackSilence'], strength: 0.6, keyframe: null, status: 'found', approvedBy: null } ] };
        const record3 = store.recordFor(breaksDir, 'tv.Happy Days', { ...file1Changed, size: 960 }, scanResult3, () => 9500);
        suite.check('a point far from any old approval, or a different kind, stays plainly found',
            (record3.points[0].status === 'found') && (record3.points[0].approvedBy === null));

        // A file reached under a custom show too still has one record.
        store.recordFor(breaksDir, 'custom.friday-dcom', { path: 'G:/movies/dcom1.mkv', ratingKey: '222', size: 10, mtimeMs: 1, durationS: 5400, chapters: [] }, { points: [] }, () => 1);
        suite.check('listShowKeys sees every show that has ever been scanned',
            store.listShowKeys(breaksDir).sort().join(',') === 'custom.friday-dcom,tv.Happy Days');

        const recordError = store.recordError(breaksDir, 'tv.Happy Days', file1Changed, new Error('timed out after 15 minutes'), () => 9600);
        suite.check('a failed scan is recorded without losing the file\'s last good points',
            (recordError.error.message === 'timed out after 15 minutes') && (recordError.points.length === 1));

        // A real show title can hold almost anything, including characters
        // Windows forbids in a filename ("Are You Afraid of the Dark?",
        // "Click: The Calendar Girl Christmas").
        const trickyKey = 'tv.Are You Afraid of the Dark? / Click: "The Calendar Girl" <Christmas>';
        suite.check('a title with Windows-forbidden characters never reaches the filesystem unescaped',
            !/[<>:"|?*]/.test(path.basename(store.showFile(breaksDir, trickyKey))));
        store.recordFor(breaksDir, trickyKey, { path: 'G:/x.mkv', ratingKey: '9', size: 1, mtimeMs: 1, durationS: 60, chapters: [] }, { points: [] }, () => 1);
        suite.check('...and is saved and read back with the exact same key',
            store.listShowKeys(breaksDir).includes(trickyKey));
        suite.check('...findRecord still locates its file by path',
            store.findRecord(breaksDir, 'G:/x.mkv').key === trickyKey);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    return suite;
};
