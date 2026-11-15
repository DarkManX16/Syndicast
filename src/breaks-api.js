/*
 * The Breaks page's routes (docs/blocks-spec.md, Stage 6, step 4): the shows with their
 * lines, one show opened, DarkManX16's say on a pattern, a point, "these have no
 * breaks", theatrical and "scan this show next", and the frames either side of a
 * point. The scanner's own status and Pause switch are in break-scan-api.js.
 *
 * Every change goes through the scan service's updateShow(), which loads the show's
 * file, changes it and saves it in one synchronous step, so the scanner's own saves
 * never interleave with it.
 */
const fs = require('fs');
const store = require('./breaks-store');
const patterns = require('./break-patterns');
const edit = require('./break-edit');
const page = require('./breaks-page');
const { FrameError } = require('./break-frames');

const CUSTOM_NAMES_MS = 60 * 1000;
const KEY = /^(tv|movie|custom)\./;

module.exports = function breaksRoutes(router, service, options = {}) {
    const linesCache = new Map();   // key -> { sig, core }, kept until the show's file changes
    let customNames = { at: 0, names: {} };

    async function namesOfCustomShows() {
        if ( (options.customShows == null) || (Date.now() - customNames.at < CUSTOM_NAMES_MS) ) {
            return customNames.names;
        }
        try {
            const names = {};
            for (const s of await options.customShows()) {
                names[s.id] = s.name;
            }
            customNames = { at: Date.now(), names };
        } catch (err) {
            customNames = { at: Date.now(), names: customNames.names };
        }
        return customNames.names;
    }

    function sigOf(key) {
        try {
            const st = fs.statSync(store.showFile(service.breaksDir, key));
            return `${st.size}:${st.mtimeMs}`;
        } catch (err) {
            return null;
        }
    }

    function infoOf(key) {
        return service.airing.shows.get(key) || { total: 0, nextAt: null };
    }

    function coreOf(key, name) {
        const sig = sigOf(key);
        const info = infoOf(key);
        const had = linesCache.get(key);
        // the line's counts depend on how many files air as well as on the store's file
        const stamp = `${sig}|${info.total}`;
        if ( (had != null) && (had.sig === stamp) && (had.name === name) ) {
            return had.core;
        }
        const show = (sig == null) ? store.emptyShow() : store.loadShow(service.breaksDir, key);
        const core = page.lineCore(key, show, name, info.total);
        linesCache.set(key, { sig: stamp, name, core });
        return core;
    }

    const names = (file) => service.airing.files.get(file) || null;

    // A file's record is kept under the key it was first scanned under, which can be another show's
    // (an episode in a custom show and in its own show has one record): acting on a file goes there.
    const ownerOf = (file, key) => {
        const found = service.index.get(file);
        return (found != null) ? found.key : key;
    };
    // This show's files on the channels whose records are kept under another key.
    function elsewhereOf(key) {
        const out = [];
        for (const file of (service.airing.byKey.get(key) || [])) {
            const found = service.index.get(file);
            if ( (found != null) && (found.key !== key) ) {
                out.push( { path: file, key: found.key, record: found.record } );
            }
        }
        return out;
    }
    const bad = (res, code, error) => res.status(code).send( { error } );

    async function allLines() {
        const custom = await namesOfCustomShows();
        const keys = new Set( [ ...store.listShowKeys(service.breaksDir), ...service.airing.shows.keys() ] );
        const now = Date.now();
        const lines = [];
        for (const key of keys) {
            if ( ! KEY.test(key) ) {
                continue;
            }
            const elsewhere = elsewhereOf(key).filter( (f) => (f.record.error == null) && Array.isArray(f.record.points) && (f.record.stub !== true) ).length;
            lines.push(page.lineFor(coreOf(key, page.nameOf(key, custom)), Object.assign( {}, infoOf(key), { elsewhere } ), now));
        }
        return page.byNextAiring(lines);
    }

    router.get('/api/breaks/shows', async (req, res) => {
        try {
            const status = service.status();
            res.send( {
                ready: service.ready && (service.airing.builtAt != null),
                counts: service.counts,
                scanFirst: status.scanFirst,
                shows: await allLines(),
            } );
        } catch (err) {
            console.error(err);
            bad(res, 500, 'Something went wrong; see the server log.');
        }
    } );

    // One show as it stands now, with whether it is waiting for its turn at the scanner.
    async function detailOf(key) {
        const custom = await namesOfCustomShows();
        const show = store.loadShow(service.breaksDir, key);
        const files = (service.airing.byKey.get(key) || []).map( (path) => ({ path, movie: (names(path) || {}).movie === true, durationMs: (names(path) || {}).durationMs || 0 }) );
        const d = page.detail(key, show, page.nameOf(key, custom), names, Object.assign( {}, infoOf(key), { files, elsewhere: elsewhereOf(key) } ), Date.now());
        d.scanFirst = service.scanFirst.includes(key) ? service.remaining(key) : null;
        return d;
    }

    const knownKey = (key) => (typeof(key) === 'string') && KEY.test(key)
        && (store.listShowKeys(service.breaksDir).includes(key) || service.airing.shows.has(key));

    router.get('/api/breaks/show', async (req, res) => {
        try {
            const key = req.query.key;
            if ( ! knownKey(key) ) {
                return bad(res, 404, 'No such show.');
            }
            res.send(await detailOf(key));
        } catch (err) {
            console.error(err);
            bad(res, 500, 'Something went wrong; see the server log.');
        }
    } );

    // What every change answers with: the show as it stands now.
    async function answer(res, key, result) {
        if ( (result != null) && (result.ok === false) ) {
            return bad(res, 400, result.error || 'That did not work.');
        }
        res.send(await detailOf(key));
    }

    function guarded(handler) {
        return async (req, res) => {
            try {
                const b = req.body || {};
                if ( ! knownKey(b.key) ) {
                    return bad(res, 404, 'No such show.');
                }
                await handler(b, res);
            } catch (err) {
                console.error(err);
                bad(res, 500, 'Something went wrong; see the server log.');
            }
        };
    }

    // One click: the show's pattern approved (the weaker line's, with weaker: true) or withdrawn.
    router.post('/api/breaks/pattern', guarded( async (b, res) => {
        if ( (b.action !== 'approve') && (b.action !== 'withdraw') ) {
            return bad(res, 400, 'Approve or withdraw.');
        }
        const result = service.updateShow(b.key, (show) => {
            if (b.action === 'withdraw') {
                patterns.withdraw(show, Date.now());
                return { ok: true };
            }
            const offered = (b.weaker === true) ? (patterns.weakerLine('x', show) !== null) : patterns.showPatterns(show).groups.some( (g) => g.pattern !== null );
            if ( ! offered ) {
                return { ok: false, error: 'There is no such pattern to approve.' };
            }
            return { ok: true, approved: patterns.approve(show, Date.now(), { weaker: b.weaker === true }) };
        } );
        await answer(res, b.key, result);
    } ) );

    // A point: approve, reject, nudge (value: seconds), time (value: seconds from the start),
    // kind (value), or add (value: seconds, kind).
    router.post('/api/breaks/point', guarded( async (b, res) => {
        const result = service.updateShow(ownerOf(b.path, b.key), (show) => {
            const record = show.files[b.path];
            if (record == null) {
                return { ok: false, error: 'No such episode.' };
            }
            if (b.action === 'add') {
                return edit.addPoint(record, Number(b.value), b.kind || 'act');
            }
            return edit.editPoint(record, Number(b.index), b.action, (b.action === 'kind') ? b.value : Number(b.value));
        } );
        await answer(res, b.key, result);
    } ) );

    // "These have no breaks": the episodes in `paths`, or every one scanned (`all`); value false takes it back.
    router.post('/api/breaks/none', guarded( async (b, res) => {
        const value = (b.value !== false);
        if ( ! b.all && ! Array.isArray(b.paths) ) {
            return bad(res, 400, 'Say which episodes.');
        }
        // each file's mark goes on its own record, wherever it is kept; `all` is the show's own file
        const byOwner = new Map();
        if (b.all) {
            byOwner.set(b.key, null);
        } else {
            for (const p of b.paths) {
                const owner = ownerOf(p, b.key);
                byOwner.set(owner, (byOwner.get(owner) || []).concat( [ p ] ));
            }
        }
        for (const [owner, paths] of byOwner) {
            service.updateShow(owner, (show) => {
                if (paths === null) {
                    show.noBreaks = value;   // the whole show: files scanned later are marked as they arrive
                }
                for (const p of (paths || Object.keys(show.files).filter( (f) => show.files[f].stub !== true ))) {
                    if (show.files[p] != null) {
                        edit.setNoBreaks(show.files[p], value);
                        if ( ! value ) {
                            patterns.applyApproved(show, p);   // the approved pattern speaks for it again
                        }
                    }
                }
                return { ok: true };
            } );
        }
        await answer(res, b.key, { ok: true });
    } ) );

    // Theatrical: one movie (path), or a whole custom show (no path).
    router.post('/api/breaks/theatrical', guarded( async (b, res) => {
        const value = (b.value !== false);
        const result = service.updateShow((b.path == null) ? b.key : ownerOf(b.path, b.key), (show) => {
            if (b.path == null) {
                show.theatrical = value;
                return { ok: true };
            }
            if (show.files[b.path] == null) {
                // a movie the channels carry that was never scanned: only the mark is kept, until it is scanned
                const airing = service.airing.files.get(b.path);
                if ( (airing == null) || ( (airing.showKey !== b.key) && (airing.storeKey !== b.key) ) ) {
                    return { ok: false, error: 'No such movie.' };
                }
                show.files[b.path] = { stub: true, movie: true, points: [], error: null, durationMs: airing.durationMs || 0 };
            }
            const result = edit.setTheatrical(show.files[b.path], value);
            if ( (value === false) && (show.files[b.path].stub === true) ) {
                delete show.files[b.path];   // nothing but the mark: it goes with it
            } else if (value === false) {
                patterns.applyApproved(show, b.path);
            }
            return result;
        } );
        if ( (result.ok !== false) && (value === false) ) {
            service.rebuildSoon();   // a movie marked back rejoins the queue
        }
        await answer(res, b.key, result);
    } ) );

    router.post('/api/breaks/scan-first', guarded( async (b, res) => {
        await service.setScanFirst(b.key, b.value !== false);
        await answer(res, b.key, { ok: true });
    } ) );

    // A frame, as a JPEG: /api/breaks/frame?path=<a file the scanner knows>&t=<seconds>
    router.get('/api/breaks/frame', async (req, res) => {
        try {
            const file = await service.frames.grab(String(req.query.path || ''), Number(req.query.t));
            res.set('Cache-Control', 'private, max-age=86400');
            res.type('image/jpeg');
            res.sendFile(file);
        } catch (err) {
            if (err instanceof FrameError) {
                return res.status( (err.reason === 'unknown') ? 404 : 503 ).send( { reason: err.reason, error: err.message } );
            }
            console.error(err);
            bad(res, 500, 'Something went wrong; see the server log.');
        }
    } );
};
