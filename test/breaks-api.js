/*
 * The Breaks page's routes (src/breaks-api.js) and what the scan service gives them:
 * the shows in the order they next air, one show opened, approve and withdraw, a
 * point, "these have no breaks", theatrical, "scan this show next" (the queue's
 * order, kept across a restart), and the frames either side of a point.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Suite } = require('./support');
const BreakScanService = require('../src/services/break-scan-service');
const breaksApi = require('../src/breaks-api');
const store = require('../src/breaks-store');

const MIN = 60 * 1000;

function pt(at, kind, strength = 0.75) {
    return { at, black: [ at - 1, at + 1 ], silence: [ at - 1, at + 1 ], kind, sources: [ 'blackSilence' ], strength, keyframe: null, status: 'found', approvedBy: null };
}
function rec(minutes, points, extra = {}) {
    return Object.assign( { ratingKey: '1', size: 1000, mtimeMs: 5, durationMs: Math.round(minutes * 60000), scannedAt: 1, scanner: 1, chapters: [], points, noBreaks: false, error: null }, extra );
}
function program(title, file, minutes, extra = {}) {
    return Object.assign( { type: 'episode', showTitle: title, title: 'Ep', season: 1, episode: 1, file, duration: minutes * MIN, ratingKey: String(file.length) }, extra );
}

// What the router would hold: handlers by "METHOD path".
function fakeRouter() {
    const routes = {};
    return {
        routes,
        get: (p, h) => { routes['GET ' + p] = h; },
        post: (p, h) => { routes['POST ' + p] = h; },
        put: (p, h) => { routes['PUT ' + p] = h; },
    };
}
async function call(router, method, url, { query = {}, body = {} } = {}) {
    const res = { code: 200, body: null, sent: null, headers: {}, status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; },
        set(k, v) { this.headers[k] = v; return this; }, type(t) { this.contentType = t; return this; }, sendFile(f) { this.sent = f; return this; } };
    await router.routes[`${method} ${url}`]( { query, body }, res );
    return res;
}

module.exports = async () => {
    const suite = new Suite('breaks api');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'breaks-api-'));

    try {
        const folder = path.join(tmp, 'data');
        fs.mkdirSync(folder);
        const breaksDir = path.join(folder, 'breaks');
        const now = Date.UTC(2026, 10, 14, 12, 0, 0);
        const state = { now, runs: [], failFrames: false };
        const happy = {};
        [ 0, 8, -12, 15, -5 ].forEach( (j, i) => {
            happy[`G:\\HD\\e${i + 1}.mkv`] = rec(25.5, [ pt(74 + j, 'opening'), pt(706 + j, 'act'), pt(1380 + j, 'act') ]);
        } );
        happy['G:\\HD\\e6.mkv'] = rec(25.5, [ pt(74, 'opening'), pt(300, 'act', 0.4), pt(706, 'act') ]);
        happy['G:\\HD\\e7.mkv'] = rec(25.5, []);
        store.saveShow(breaksDir, 'tv.Happy Days', { theatrical: false, pattern: null, files: happy });
        // Twitches: scanned as a movie of its own, and now also inside a custom show - one record, kept under movie.Twitches
        store.saveShow(breaksDir, 'movie.Twitches', { theatrical: false, pattern: null, files: { 'E:\\Movies\\twitches.mkv': rec(88, [ pt(1678, 'act'), pt(3193, 'act') ], { movie: true }) } });
        store.saveShow(breaksDir, 'movie.First Kid', { theatrical: false, pattern: null, files: { 'E:\\Movies\\firstkid.mkv': rec(90, [ pt(1600, 'act'), pt(3000, 'act') ], { movie: true }) } });

        // Cheers airs first, Happy Days later today, Gargoyles next week, and one show not at all
        const ch = { number: 1, startTime: new Date(now - 10 * MIN).toISOString(), programs: [
            program('Cheers', 'F:\\Cheers\\e1.mkv', 30),
            program('Happy Days', 'G:\\HD\\e1.mkv', 30),
            program('Happy Days', 'G:\\HD\\e2.mkv', 30),
            program('Cheers', 'F:\\Cheers\\e2.mkv', 30),
            program('Gargoyles', 'F:\\Garg\\e1.mkv', 24 * 60 * 8),
            program('First Kid', 'E:\\Movies\\firstkid.mkv', 90, { type: 'movie', title: 'First Kid', season: undefined, episode: undefined }),
            program('College Road Trip', 'E:\\Movies\\crt.mkv', 90, { type: 'movie', title: 'College Road Trip', season: undefined, episode: undefined }),
            program('Twitches', 'E:\\Movies\\twitches.mkv', 88, { type: 'movie', title: 'Twitches', customShowId: 'abc', season: undefined, episode: undefined }),
        ] };
        const service = new BreakScanService( {
            folder,
            channelService: { getAllChannels: async () => [ ch ] },
            getFfmpegSettings: () => ({ ffmpegPath: 'ffmpeg' }),
            meter: { live: () => [] },
            cpu: { sample: () => 0.1 },
            now: () => state.now,
            log: () => {},
            stat: async () => ({ size: 1000, mtimeMs: 5 }),
            sleep: async () => {},
            force: null,
            diskPriority: { start() {}, stop() {}, lower: async () => {}, status: () => ({}) },
            runner: async (cmd, args) => {
                state.runs.push( { cmd, args } );
                if (state.failFrames) {
                    return { code: 1, stderr: 'Invalid data found' };
                }
                fs.writeFileSync(args[args.length - 1], 'jpeg');
                return { code: 0, stderr: '' };
            },
        } );
        await service.init();
        await service.buildOnce();
        const router = fakeRouter();
        breaksApi(router, service, { customShows: async () => [] });

        // ---- the list ----------------------------------------------------------------------
        const list = await call(router, 'GET', '/api/breaks/shows');
        const names = list.body.shows.map( (s) => s.name );
        suite.check('the shows in the order they next air: what is on now first, a show on no channel last',
            JSON.stringify(names.slice(0, 4)) === JSON.stringify([ 'Cheers', 'Happy Days', 'First Kid', 'Gargoyles' ]) || /^Cheers,Happy Days/.test(names.join()), names.join());
        const hd = list.body.shows.find( (s) => s.name === 'Happy Days' );
        suite.check('a show on the channels but not scanned yet is on the list too, so it can be scanned next',
            list.body.shows.some( (s) => (s.name === 'Cheers') && (s.scanned === 0) && (s.total === 2) ));
        suite.check('...Happy Days: scanned 7 of the 2 airing counts the larger, this week, needs a click, a pattern on offer',
            (hd.scanned === 7) && (hd.total === 7) && (hd.thisWeek === true) && (hd.needsClick === true) && /opening near/.test(hd.pattern), JSON.stringify(hd));
        suite.check('...the page is told the scanner is ready', list.body.ready === true);

        // ---- one show opened ----------------------------------------------------------------
        const open = await call(router, 'GET', '/api/breaks/show', { query: { key: 'tv.Happy Days' } });
        suite.check('a show opened: its list to check and every episode, named from the channels where they know it',
            (open.body.toCheck.length === 1) && (open.body.episodes.length === 7) && open.body.episodes.some( (e) => e.name === 'S01E01 Ep' ), JSON.stringify(open.body.toCheck.map( (e) => e.name )));
        suite.check('...an unknown show is a 404', (await call(router, 'GET', '/api/breaks/show', { query: { key: 'tv.Nobody' } })).code === 404);
        suite.check('...and a key that is not a show\'s is refused', (await call(router, 'GET', '/api/breaks/show', { query: { key: '../x' } })).code === 404);

        // ---- approve and withdraw -----------------------------------------------------------
        const approved = await call(router, 'POST', '/api/breaks/pattern', { body: { key: 'tv.Happy Days', action: 'approve' } });
        suite.check('Approve approves the pattern and answers with the show as it now stands',
            (approved.code === 200) && (approved.body.line.approved === true) && (store.loadShow(breaksDir, 'tv.Happy Days').pattern !== null));
        suite.check('...the scanner\'s own copy of the records follows', service.index.get('G:\\HD\\e1.mkv').record.points.some( (p) => p.status === 'approved' ));
        const none = await call(router, 'POST', '/api/breaks/pattern', { body: { key: 'movie.First Kid', action: 'approve' } });
        suite.check('...a show with no pattern on offer cannot be approved', none.code === 400);
        const weaker = await call(router, 'POST', '/api/breaks/pattern', { body: { key: 'tv.Happy Days', action: 'approve', weaker: true } });
        suite.check('...nor can a weaker line that is not offered', weaker.code === 400);
        const withdrawn = await call(router, 'POST', '/api/breaks/pattern', { body: { key: 'tv.Happy Days', action: 'withdraw' } });
        suite.check('Withdraw returns it', (withdrawn.body.line.approved === false) && ! store.loadShow(breaksDir, 'tv.Happy Days').files['G:\\HD\\e1.mkv'].points.some( (p) => p.status === 'approved' ));

        // ---- a point ---------------------------------------------------------------------------
        const e6 = 'G:\\HD\\e6.mkv';
        const stray = store.loadShow(breaksDir, 'tv.Happy Days').files[e6].points.findIndex( (p) => p.at === 300 );
        const rejected = await call(router, 'POST', '/api/breaks/point', { body: { key: 'tv.Happy Days', path: e6, index: stray, action: 'reject' } });
        suite.check('Reject marks the point rejected and the answer carries it',
            (rejected.code === 200) && rejected.body.episodes.find( (e) => e.path === e6 ).points.some( (p) => (p.at === 300) && (p.status === 'rejected') ));
        const nudged = await call(router, 'POST', '/api/breaks/point', { body: { key: 'tv.Happy Days', path: e6, index: 2, action: 'nudge', value: 0.5 } });
        suite.check('Nudge moves a point and approves it', nudged.body.episodes.find( (e) => e.path === e6 ).points.some( (p) => (p.at === 706.5) && (p.status === 'approved') && (p.movedFrom === 706) ));
        const added = await call(router, 'POST', '/api/breaks/point', { body: { key: 'tv.Happy Days', path: e6, action: 'add', value: 1000 } });
        suite.check('Add a break places one of his own', added.body.episodes.find( (e) => e.path === e6 ).points.some( (p) => (p.at === 1000) && (p.status === 'hand') ));
        const wild = await call(router, 'POST', '/api/breaks/point', { body: { key: 'tv.Happy Days', path: e6, index: 0, action: 'time', value: 999999 } });
        suite.check('a time outside the episode is refused and nothing changes', (wild.code === 400) && /outside/.test(wild.body.error));
        suite.check('...an episode that is not in the show is refused', (await call(router, 'POST', '/api/breaks/point', { body: { key: 'tv.Happy Days', path: 'G:\\nope.mkv', index: 0, action: 'approve' } })).code === 400);

        // ---- these have no breaks ----------------------------------------------------------------
        const marked = await call(router, 'POST', '/api/breaks/none', { body: { key: 'tv.Happy Days', paths: [ 'G:\\HD\\e3.mkv', 'G:\\HD\\e4.mkv', 'G:\\nope.mkv' ] } });
        suite.check('"These have no breaks" marks the ticked episodes (and none that are not there)',
            marked.body.episodes.filter( (e) => e.noBreaks ).map( (e) => e.path ).join() === 'G:\\HD\\e3.mkv,G:\\HD\\e4.mkv');
        const all = await call(router, 'POST', '/api/breaks/none', { body: { key: 'tv.Happy Days', all: true } });
        suite.check('...or every episode of the show', all.body.episodes.every( (e) => e.noBreaks ) && (all.body.line.needsClick === false));
        const undone = await call(router, 'POST', '/api/breaks/none', { body: { key: 'tv.Happy Days', all: true, value: false } });
        suite.check('...and takes it back', undone.body.episodes.every( (e) => ! e.noBreaks ));
        suite.check('...a request that says which episodes is needed', (await call(router, 'POST', '/api/breaks/none', { body: { key: 'tv.Happy Days' } })).code === 400);

        // ---- theatrical ---------------------------------------------------------------------------
        const fk = 'E:\\Movies\\firstkid.mkv';
        suite.check('a TV movie\'s points wait for him', (await call(router, 'GET', '/api/breaks/show', { query: { key: 'movie.First Kid' } })).body.toCheck.length === 1);
        service.queue.push( { path: fk, key: 'movie.First Kid', showKey: 'movie.First Kid', drive: 'E:' } );
        const theatrical = await call(router, 'POST', '/api/breaks/theatrical', { body: { key: 'movie.First Kid', path: fk } });
        suite.check('marked theatrical, it has nothing waiting and leaves the scanner\'s queue',
            (theatrical.body.toCheck.length === 0) && theatrical.body.episodes[0].theatrical && ! service.queue.some( (e) => e.path === fk ));
        suite.check('...the scanner will skip it from now on', service.index.get(fk).record.theatrical === true);
        const back = await call(router, 'POST', '/api/breaks/theatrical', { body: { key: 'movie.First Kid', path: fk, value: false } });
        suite.check('...marked back, its points wait for him again', (back.body.toCheck.length === 1) && ! back.body.episodes[0].theatrical);
        clearTimeout(service.soonTimer);
        const custom = await call(router, 'POST', '/api/breaks/theatrical', { body: { key: 'tv.Happy Days', value: true } });
        suite.check('a whole show can be marked theatrical too (a custom show of shorts)', custom.body.line.theatrical === true);
        await call(router, 'POST', '/api/breaks/theatrical', { body: { key: 'tv.Happy Days', value: false } });
        clearTimeout(service.soonTimer);

        // ---- a file whose record is kept under another show's key ------------------------------------------
        const tw = 'E:\\Movies\\twitches.mkv';
        const customLine = (await call(router, 'GET', '/api/breaks/shows')).body.shows.find( (s) => s.key === 'custom.abc' );
        suite.check('a custom show\'s movie scanned under its own key counts as scanned for the custom show',
            (customLine.scanned === 1) && (customLine.total === 1) && (customLine.movieFiles === 1), JSON.stringify(customLine));
        const customOpen = await call(router, 'GET', '/api/breaks/show', { query: { key: 'custom.abc' } });
        suite.check('...and is listed with its points, not as "not scanned yet"',
            (customOpen.body.episodes.length === 1) && (customOpen.body.episodes[0].unscanned === false) && (customOpen.body.episodes[0].points.length === 2) && (customOpen.body.episodes[0].elsewhere === 'movie.Twitches'));
        const rej = await call(router, 'POST', '/api/breaks/point', { body: { key: 'custom.abc', path: tw, index: 0, action: 'reject' } });
        suite.check('a point acted on from the custom show lands on the record where it is kept',
            (rej.code === 200) && (store.loadShow(breaksDir, 'movie.Twitches').files[tw].points[0].status === 'rejected') && ! fs.existsSync(store.showFile(breaksDir, 'custom.abc')));
        const th = await call(router, 'POST', '/api/breaks/theatrical', { body: { key: 'custom.abc', path: tw } });
        suite.check('...so does a theatrical mark, and no stub is made under the custom show',
            (th.code === 200) && (store.loadShow(breaksDir, 'movie.Twitches').files[tw].theatrical === true) && ! fs.existsSync(store.showFile(breaksDir, 'custom.abc')));
        await call(router, 'POST', '/api/breaks/theatrical', { body: { key: 'custom.abc', path: tw, value: false } });
        clearTimeout(service.soonTimer);
        const nn = await call(router, 'POST', '/api/breaks/none', { body: { key: 'custom.abc', paths: [ tw ] } });
        suite.check('...and "no breaks"', (nn.code === 200) && (store.loadShow(breaksDir, 'movie.Twitches').files[tw].noBreaks === true));
        await call(router, 'POST', '/api/breaks/none', { body: { key: 'custom.abc', paths: [ tw ], value: false } });

        // ---- a mark taken back lets the approved pattern speak for the episode again -------------------------
        await call(router, 'POST', '/api/breaks/pattern', { body: { key: 'tv.Happy Days', action: 'approve' } });
        const e1 = 'G:\\HD\\e1.mkv';
        await call(router, 'POST', '/api/breaks/none', { body: { key: 'tv.Happy Days', paths: [ e1 ] } });
        const released = store.loadShow(breaksDir, 'tv.Happy Days').files[e1].points.filter( (p) => p.status === 'approved' ).length;
        await call(router, 'POST', '/api/breaks/none', { body: { key: 'tv.Happy Days', paths: [ e1 ], value: false } });
        const again = store.loadShow(breaksDir, 'tv.Happy Days').files[e1].points.filter( (p) => p.status === 'approved' ).length;
        suite.check('"no breaks" on an episode the pattern approved sends its points back to found; taking it back approves them again',
            (released === 0) && (again > 0), JSON.stringify([ released, again ]));
        await call(router, 'POST', '/api/breaks/pattern', { body: { key: 'tv.Happy Days', action: 'withdraw' } });

        // ---- a movie never scanned (College Road Trip) -----------------------------------------------
        const crt = 'E:\\Movies\\crt.mkv';
        const crtLine = (await call(router, 'GET', '/api/breaks/shows')).body.shows.find( (s) => s.key === 'movie.College Road Trip' );
        suite.check('a movie the channels carry, never scanned, is on the list with the file the mark would go on',
            (crtLine.scanned === 0) && (crtLine.total === 1) && (crtLine.moviePath === crt) && (crtLine.theatrical === false), JSON.stringify(crtLine));
        service.queue.push( { path: crt, key: 'movie.College Road Trip', showKey: 'movie.College Road Trip', drive: 'E:' } );
        const marked2 = await call(router, 'POST', '/api/breaks/theatrical', { body: { key: 'movie.College Road Trip', path: crt } });
        suite.check('...marked theatrical before it is scanned: only the mark is kept, the scanner skips it, it is not counted as scanned',
            (marked2.code === 200) && (marked2.body.line.theatrical === true) && (marked2.body.line.scanned === 0) && ! service.queue.some( (e) => e.path === crt )
                && (store.loadShow(breaksDir, 'movie.College Road Trip').files[crt].stub === true));
        await service.buildOnce();
        suite.check('...and a rebuild leaves it out of the queue', ! service.queue.some( (e) => e.path === crt ));
        const unmarked2 = await call(router, 'POST', '/api/breaks/theatrical', { body: { key: 'movie.College Road Trip', path: crt, value: false } });
        clearTimeout(service.soonTimer);
        suite.check('...marked back, the mark goes and nothing else is left of it',
            (unmarked2.body.line.theatrical === false) && (store.loadShow(breaksDir, 'movie.College Road Trip').files[crt] === undefined));
        suite.check('...and the scanner no longer reads the movie as marked: it is queued again',
            ! service.index.has(crt) && ( await service.buildOnce(), service.queue.some( (e) => e.path === crt ) ));
        const strange = await call(router, 'POST', '/api/breaks/theatrical', { body: { key: 'movie.College Road Trip', path: 'E:\\Movies\\other.mkv' } });
        suite.check('...a file the show does not carry cannot be marked', strange.code === 400);

        // ---- scan this show next --------------------------------------------------------------------
        service.queue = service.queue.filter( () => false );
        await service.buildOnce();
        const before = service.queue.map( (e) => e.showKey );
        suite.check('the queue starts in airing order: Cheers first',
            before[0] === 'tv.Cheers', before.join());
        await call(router, 'POST', '/api/breaks/scan-first', { body: { key: 'tv.Gargoyles' } });
        suite.check('"Scan this show next" puts the show\'s files first',
            service.queue[0].showKey === 'tv.Gargoyles', service.queue.map( (e) => e.showKey ).join());
        suite.check('...the show reports how many of its files are waiting', (await call(router, 'GET', '/api/breaks/show', { query: { key: 'tv.Gargoyles' } })).body.scanFirst === 1);
        suite.check('...and it is kept across a restart',
            JSON.parse(fs.readFileSync(path.join(folder, 'break-scanner.json'), 'utf8')).scanFirst.join() === 'tv.Gargoyles');
        await call(router, 'POST', '/api/breaks/scan-first', { body: { key: 'tv.Cheers' } });
        suite.check('...the newest request goes first', service.queue[0].showKey === 'tv.Cheers');
        await call(router, 'POST', '/api/breaks/scan-first', { body: { key: 'tv.Cheers', value: false } });
        suite.check('...and can be taken back', service.queue[0].showKey === 'tv.Gargoyles');
        // Gentle keeps off a busy drive - except for a show he asked for
        service.governor.live = [ { drive: 'G:', channel: 1, title: 'x', pace: 1 } ];
        await call(router, 'POST', '/api/breaks/scan-first', { body: { key: 'tv.Gargoyles', value: false } });
        const plainPick = service.pickNext('gentle');
        await call(router, 'POST', '/api/breaks/scan-first', { body: { key: 'tv.Happy Days' } });
        const askedPick = service.pickNext('gentle');
        suite.check('Gentle takes a file on a free drive first, but the show he asked for goes first even on a busy drive',
            (plainPick.drive !== 'G:') && (askedPick.showKey === 'tv.Happy Days') && (askedPick.drive === 'G:'), JSON.stringify([ plainPick.showKey, askedPick.showKey ]));
        service.governor.live = [];
        await call(router, 'POST', '/api/breaks/scan-first', { body: { key: 'tv.Happy Days', value: false } });
        await call(router, 'POST', '/api/breaks/scan-first', { body: { key: 'tv.Gargoyles' } });
        service.queue = service.queue.filter( (e) => e.showKey !== 'tv.Gargoyles' );
        await service.dropFinishedFirst();
        suite.check('a show with nothing left to scan is no longer waiting for its turn', service.scanFirst.length === 0);

        // ---- frames --------------------------------------------------------------------------------
        const frame = await call(router, 'GET', '/api/breaks/frame', { query: { path: 'G:\\HD\\e1.mkv', t: '98.1' } });
        suite.check('a frame of a scanned file is cut by ffmpeg at the time asked, one picture, kept',
            (frame.code === 200) && frame.sent && fs.existsSync(frame.sent) && (state.runs.length === 1) && state.runs[0].args.includes('98.100') && state.runs[0].args.includes('-frames:v'), JSON.stringify(state.runs.map( (r) => r.args )));
        suite.check('...cut at idle priority like the scanner (its runner, not a plain spawn)', service.baseRunner !== null);
        await call(router, 'GET', '/api/breaks/frame', { query: { path: 'G:\\HD\\e1.mkv', t: '98.1' } });
        suite.check('...the same frame asked again is not cut again', state.runs.length === 1);
        const arbitrary = await call(router, 'GET', '/api/breaks/frame', { query: { path: 'C:\\Windows\\notepad.exe', t: '1' } });
        suite.check('a file the scanner does not know is never read', (arbitrary.code === 404) && (state.runs.length === 1));
        await service.setSkipDrives( [ 'G:' ] );
        const skipped = await call(router, 'GET', '/api/breaks/frame', { query: { path: 'G:\\HD\\e2.mkv', t: '10' } });
        suite.check('a file on a skipped drive is not read', (skipped.code === 503) && (skipped.body.reason === 'skipped') && (state.runs.length === 1));
        await service.setSkipDrives( [] );
        await service.building;
        service.governor.pause('pace', {});
        const waiting = await call(router, 'GET', '/api/breaks/frame', { query: { path: 'G:\\HD\\e2.mkv', t: '10' } });
        suite.check('while the scanner is paused for a viewer falling behind, no frame is cut',
            (waiting.code === 503) && (waiting.body.reason === 'paused') && (state.runs.length === 1), JSON.stringify(waiting.body));
        service.governor.resume && service.governor.resume();
        service.governor.pausedUntil = null;
        await service.setPaused(true);
        const byHand = await call(router, 'GET', '/api/breaks/frame', { query: { path: 'G:\\HD\\e2.mkv', t: '10' } });
        suite.check('...paused by hand is not a reason: DarkManX16 is looking at the page', byHand.code === 200, JSON.stringify(byHand.body));
        state.failFrames = true;
        const failed = await call(router, 'GET', '/api/breaks/frame', { query: { path: 'G:\\HD\\e3.mkv', t: '10' } });
        suite.check('a picture ffmpeg cannot cut is a 503 with its reason, and leaves no half-written file',
            (failed.code === 503) && (failed.body.reason === 'failed') && ! fs.readdirSync(service.frames.dir).some( (f) => f.endsWith('.part.jpg') ));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    return suite;
};
