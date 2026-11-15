/*
 * Saved frames (docs/blocks-spec.md, Stage 6, build order 5c, DarkManX16 Nov 15): the scanner
 * saves the two frames of each point waiting on the list to check, in a folder of their own,
 * so the Breaks page rarely reads a drive. Kept while the point is on the list; deleted once
 * it is approved, rejected or moved, the episode leaves the list, or the file changes; the
 * page's own cache pruning never touches them. A real scan service and store in a temporary
 * folder; ffmpeg is a stand-in that writes the picture.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Suite } = require('./support');
const store = require('../src/breaks-store');
const edit = require('../src/break-edit');
const BreakScanService = require('../src/services/break-scan-service');

const MIN = 60 * 1000;
function pt(at, kind, strength = 0.75) {
    return { at, black: [ at - 1, at + 1 ], silence: [ at - 1, at + 1 ], kind, sources: [ 'blackSilence' ], strength, keyframe: null, status: 'found', approvedBy: null };
}
function rec(points, extra = {}) {
    return Object.assign( { ratingKey: '1', size: 1000, mtimeMs: 5, durationMs: 25.5 * MIN, scannedAt: 1, scanner: 1, chapters: [], points, noBreaks: false, error: null }, extra );
}
function program(title, file) {
    return { type: 'episode', showTitle: title, title: 'Ep', file, duration: 30 * MIN, ratingKey: String(file.length) };
}

// Happy Days: five episodes that fit its pattern, and e6, on the list to check with a stray point.
function happy() {
    const files = {};
    [ 0, 8, -12, 15, -5 ].forEach( (j, i) => {
        files[`G:\\HD\\e${i + 1}.mkv`] = rec( [ pt(74 + j, 'opening'), pt(706 + j, 'act'), pt(1380 + j, 'act') ] );
    } );
    files['G:\\HD\\e6.mkv'] = rec( [ pt(74, 'opening'), pt(300, 'act', 0.4), pt(706, 'act') ] );
    return { theatrical: false, pattern: null, files };
}

async function rig(tmp) {
    const folder = path.join(tmp, 'data');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'break-scanner.json'), JSON.stringify( { midrolls: true } ));
    store.saveShow(path.join(folder, 'breaks'), 'tv.Happy Days', happy());
    const state = { runs: [], live: [] };
    const now = Date.UTC(2026, 10, 15, 12, 0, 0);
    const ch = { number: 1, startTime: new Date(now).toISOString(), programs: [ program('Happy Days', 'G:\\HD\\e6.mkv'), program('Happy Days', 'G:\\HD\\e1.mkv') ] };
    const service = new BreakScanService( {
        folder,
        channelService: { getAllChannels: async () => [ ch ] },
        getFfmpegSettings: () => ({ ffmpegPath: 'ffmpeg' }),
        meter: { live: () => state.live },
        cpu: { sample: () => 0.1 },
        now: () => now,
        log: () => {},
        stat: async () => ({ size: 1000, mtimeMs: 5 }),
        sleep: async () => {},
        force: null,
        diskPriority: { start() {}, stop() {}, lower: async () => {}, status: () => ({}) },
        runner: async (cmd, args) => {
            state.runs.push(args);
            fs.writeFileSync(args[args.length - 1], 'jpeg');
            return { code: 0, stderr: '' };
        },
    } );
    await service.init();
    await service.buildOnce();
    return { service, state, folder, savedDir: path.join(folder, 'breaks-saved-frames') };
}

const jpgs = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter( (f) => String(f).endsWith('.jpg') && ! String(f).endsWith('.part.jpg') ) : [];

module.exports = async () => {
    const suite = new Suite('saved frames');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'break-saved-frames-'));
    try {
        const { service, state, savedDir } = await rig(path.join(tmp, 'a'));
        if (typeof(service.saveListedFrames) !== 'function') {
            suite.check('the scanner can save the list\'s frames (saveListedFrames)', false);
            return suite;
        }
        await service.saveListedFrames('tv.Happy Days', 'G:\\HD\\e6.mkv');
        const e6waiting = 3;
        suite.check('a scanned episode on the list to check: two frames saved for each point waiting',
            (jpgs(savedDir).length === 2 * e6waiting) && (state.runs.length === 2 * e6waiting), `${jpgs(savedDir).length} saved, ${state.runs.length} cuts`);
        suite.check('...in a folder of their own, apart from the page\'s cache',
            ! fs.existsSync(service.frames.dir) || (jpgs(service.frames.dir).length === 0));
        await service.saveListedFrames('tv.Happy Days', 'G:\\HD\\e1.mkv');
        suite.check('an episode that fits its pattern (not on the list) gets none', state.runs.length === 2 * e6waiting, `${state.runs.length} cuts`);

        // the page asks for one of them on a drive a viewer is playing from: answered from the saved ones
        const detail = require('../src/breaks-page').detail('tv.Happy Days', store.loadShow(service.breaksDir, 'tv.Happy Days'), 'Happy Days');
        const p = detail.episodes.find( (e) => e.path === 'G:\\HD\\e6.mkv' ).points.find( (x) => x.status === 'found' );
        state.live = [ { id: 1, channel: 1, title: 'x', drive: 'G:', pace: 1, held: false } ];
        service.tick();
        const runs = state.runs.length;
        const got = await service.frames.grab('G:\\HD\\e6.mkv', p.frames.before).then( (f) => f, (e) => e );
        suite.check('the page gets a saved frame without reading the drive, a busy drive included',
            (typeof(got) === 'string') && got.startsWith(savedDir) && (state.runs.length === runs), String(got && (got.message || got)));
        state.live = [];
        service.tick();

        // his say on a point: its frames go
        const before = jpgs(savedDir).length;
        service.updateShow('tv.Happy Days', (show) => edit.editPoint(show.files['G:\\HD\\e6.mkv'], p.index, 'approve'));
        suite.check('approving a point deletes its two saved frames', jpgs(savedDir).length === before - 2, `${before} -> ${jpgs(savedDir).length}`);
        const show1 = store.loadShow(service.breaksDir, 'tv.Happy Days');
        const q = show1.files['G:\\HD\\e6.mkv'].points.findIndex( (x) => x.status === 'found' );
        service.updateShow('tv.Happy Days', (show) => edit.editPoint(show.files['G:\\HD\\e6.mkv'], q, 'reject'));
        suite.check('...and so does rejecting one', jpgs(savedDir).length === before - 4, `${jpgs(savedDir).length}`);
        service.updateShow('tv.Happy Days', (show) => edit.setNoBreaks(show.files['G:\\HD\\e6.mkv'], true));
        suite.check('an episode that leaves the list (marked "no breaks") loses the rest', jpgs(savedDir).length === 0, `${jpgs(savedDir).length}`);
        service.updateShow('tv.Happy Days', (show) => edit.setNoBreaks(show.files['G:\\HD\\e6.mkv'], false));

        // the file changed: its old frames go, the new record's are saved
        await service.saveListedFrames('tv.Happy Days', 'G:\\HD\\e6.mkv');
        const old = jpgs(savedDir);
        service.updateShow('tv.Happy Days', (show) => { show.files['G:\\HD\\e6.mkv'] = Object.assign( {}, happy().files['G:\\HD\\e6.mkv'], { size: 2000, mtimeMs: 9 } ); });
        suite.check('a file that changed loses its old frames', (old.length > 0) && old.every( (f) => ! fs.existsSync(path.join(savedDir, f)) ), `${old.length} before`);

        // the page's cache is pruned on its own; saved frames are not part of it
        await service.saveListedFrames('tv.Happy Days', 'G:\\HD\\e6.mkv');
        const saved = jpgs(savedDir).length;
        fs.mkdirSync(service.frames.dir, { recursive: true });
        for (let i = 0; i < 4010; i++) {
            fs.writeFileSync(path.join(service.frames.dir, `cache${i}.jpg`), 'x');
        }
        await service.frames.prune();
        suite.check('pruning the page\'s 4,000-frame cache never touches a saved frame', (saved > 0) && (jpgs(savedDir).length === saved), `${saved} -> ${jpgs(savedDir).length}`);

        // files scanned before this: theirs in the scanner's idle time
        const fresh = await rig(path.join(tmp, 'b'));
        let steps = 0;
        while (steps < 20 && await fresh.service.backfillFrames()) {
            steps++;
        }
        suite.check('the files scanned before get theirs in the scanner\'s idle time, one frame a step',
            (jpgs(fresh.savedDir).length === 2 * e6waiting) && (steps === 2 * e6waiting), `${jpgs(fresh.savedDir).length} saved in ${steps} steps`);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    return suite;
};
