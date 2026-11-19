/*
 * The background break scanner (docs/blocks-spec.md, Stage 6, "The scanner,
 * and live streams"), in the shape of the card service: a minute after boot,
 * every 30 minutes, and 10 seconds after a channel is saved, it works out what
 * needs scanning; a single worker scans one file at a time, one ffmpeg at a
 * time, at idle priority and Very Low disk priority (io-priority.js), and
 * saves each file's result when it finishes, so a restart picks up where it
 * left off.
 *
 *   order    every file airing in the next 7 days on any channel, soonest
 *            first, then the rest by next airing. Theatrical shows and movies
 *            (a movie marked by itself, in a custom show or not) are skipped;
 *            so is a file with a current record. Files airing
 *            this week are checked against their size and date (at most once a
 *            day); the rest are trusted until they come into the week.
 *   modes    break-scan-governor.js, fed every 2 s from the pace meter and the
 *            PC's CPU. A pause stops the running ffmpeg at once; that piece
 *            runs again from its start when the pause ends.
 *   drives   in Gentle, a file on a drive no live stream is reading goes first;
 *            when every file left is on such a drive, it is read anyway, at
 *            Very Low disk priority, the pace check still watching (measured
 *            Nov 10: no slower for the viewers than their usual blips; before,
 *            G: and F: went unscanned for days). A drive DarkManX16 skips ("E:") is
 *            not read at all until he turns it back on.
 *   limits   a file whose ffmpeg runs add up to 15 minutes is stopped and tried
 *            again a day later, as is one that fails.
 *
 * The Midrolls switch, the hand switch and the skipped drives are kept in
 * <data>/break-scanner.json, so a restart does not undo them. Midrolls are off on a
 * new install (no file, or one from before the switch): the scanner then reads
 * nothing at all, whatever the hand switch says (DarkManX16, Nov 14). BREAK_SCAN_FORCE_MODE (normal|gentle) pins the mode for a proof.
 */

const fs = require('fs');
const path = require('path');
const store = require('../breaks-store');
const patterns = require('../break-patterns');
const { airablePoints } = require('../break-airable');
const breakScan = require('../break-scan');
const transitions = require('../transitions');
const paceMeter = require('../pace-meter');
const { ScanGovernor } = require('../break-scan-governor');
const { DiskPriority } = require('../io-priority');
const { FrameGrabber, frameArgs } = require('../break-frames');
const { SavedFrames } = require('../break-saved-frames');
const { MOVIE_MIN_MS } = require('../clip-names');

const FIRST_QUEUE_MS = 60 * 1000;
const QUEUE_EVERY_MS = 30 * 60 * 1000;
const AFTER_SAVE_MS = 10 * 1000;
const TICK_MS = 2000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const FILE_LIMIT_MS = 15 * 60 * 1000;
const IDLE_POLL_MS = 5000;

function ffprobeOf(ffmpegPath) {
    return String(ffmpegPath || 'ffmpeg').replace(/ffmpeg(\.exe)?$/i, (m, ext) => 'ffprobe' + (ext || ''));
}

// "E:" from "e", "E:", "E:\" or a path on the drive; null for anything else.
function driveName(d) {
    if (typeof(d) !== 'string') {
        return null;
    }
    const s = d.trim();
    return /^[A-Za-z]$/.test(s) ? (s.toUpperCase() + ':') : paceMeter.driveOf(s);
}

// A movie of 40 minutes or more: shorter "movies" in a custom show are its shorts and episodes.
function isMovie(program) {
    return (program.type === 'movie') && (typeof(program.duration) === 'number') && (program.duration >= MOVIE_MIN_MS);
}

function scannable(program) {
    return (program != null)
        && (program.isOffline !== true)
        && ( (program.type === 'episode') || (program.type === 'movie') )
        && (typeof(program.file) === 'string') && (program.file !== '');
}

/*
 * Every program entry of a channel with the next time it starts at or after
 * `now` (or when it started, if it is on now), walking the lineup the way
 * transitions.breaksBetween does: from channel.startTime, round and round.
 */
function airingsOf(channel, now) {
    const programs = (channel && Array.isArray(channel.programs)) ? channel.programs : [];
    let total = 0;
    for (const p of programs) {
        total += p.duration;
    }
    const lineupStart = new Date(channel ? channel.startTime : NaN).getTime();
    if ( ! (total > 0) || ! Number.isFinite(lineupStart) ) {
        return [];
    }
    let offset = (now - lineupStart) % total;
    if (offset < 0) {
        offset += total;
    }
    const out = [];
    let at = 0;
    for (const program of programs) {
        let next;
        if ( (at <= offset) && (offset < at + program.duration) ) {
            next = now - (offset - at);
        } else {
            next = now + ( ( (at - offset) % total ) + total ) % total;
        }
        out.push( { program, nextAt: next } );
        at += program.duration;
    }
    return out;
}

class BreakScanService {
    /*
     * options: { folder, channelService, getFfmpegSettings(), meter?, cpu?,
     *            now?, log?, runner?, stat?, sleep?, force?, diskPriority? }
     */
    constructor(options) {
        this.options = options;
        this.breaksDir = path.join(options.folder, 'breaks');
        this.settingsFile = path.join(options.folder, 'break-scanner.json');
        this.now = options.now || ( () => Date.now() );
        this.log = options.log || ( (line) => console.log(line) );
        this.meter = options.meter || paceMeter.meter;
        this.cpu = options.cpu || new paceMeter.CpuSampler();
        this.baseRunner = options.runner || breakScan.defaultRunner;
        this.stat = options.stat || ( (p) => fs.promises.stat(p) );
        this.sleep = options.sleep || ( (ms) => new Promise( (r) => setTimeout(r, ms) ) );
        this.fileLimitMs = options.fileLimitMs || FILE_LIMIT_MS;
        const force = (options.force !== undefined) ? options.force : (process.env.BREAK_SCAN_FORCE_MODE || null);
        this.governor = new ScanGovernor( { now: this.now, force: force } );
        this.queue = [];
        this.index = new Map();
        this.verifiedAt = new Map();
        this.theatrical = new Map();
        this.showsRead = new Map();
        this.counts = { week: { files: 0, scanned: 0 }, library: { files: 0, scanned: 0 } };
        this.current = null;
        this.controller = null;
        this.abortReason = null;
        this.lastRunMs = 0;
        this.fileRunMs = 0;
        this.restUntil = null;
        this.timers = [];
        this.stopping = false;
        this.worker = null;
        this.building = null;
        this.rebuildRequested = false;
        this.indexByPath = options.indexByPath || store.indexByPath;
        this.ready = false;
        this.switchedByHand = false;
        this.midrolls = false;
        this.midrollsSetByHand = false;
        this.governor.midrollsOff = true;
        this.skipDrives = [];
        this.drivesSetByHand = false;
        this.scanFirstSetByHand = false;
        this.scanFirst = [];
        this.airing = { builtAt: null, files: new Map(), shows: new Map(), byKey: new Map() };
        this.frames = new FrameGrabber(this);
        this.savedFrames = new SavedFrames(options.folder);
        this.backfillJobs = [];
        this.backfillStale = true;
        this.disk = options.diskPriority || new DiskPriority( { log: this.log } );
    }

    /*
     * The store and the hand switch are read before the first scan, not at
     * boot: a boot can run out of file handles for a minute (measured: the
     * play-time store opens every file at once), and a failed read here must
     * neither stop the scanner for good nor forget a pause by hand.
     */
    async load() {
        await fs.promises.mkdir(this.breaksDir, { recursive: true });
        let saved = {};
        try {
            saved = JSON.parse(await fs.promises.readFile(this.settingsFile, 'utf8'));
        } catch (err) {
            if (err.code !== 'ENOENT') {
                throw err;
            }
        }
        const index = this.indexByPath(this.breaksDir);
        if (! this.switchedByHand) {
            this.governor.manualPaused = (saved.paused === true);
        }
        if (! this.midrollsSetByHand) {
            this.midrolls = (saved.midrolls === true);
            this.governor.midrollsOff = ! this.midrolls;
        }
        if (! this.drivesSetByHand) {
            this.skipDrives = BreakScanService.driveList(saved.skipDrives);
        }
        if (! this.scanFirstSetByHand) {
            this.scanFirst = Array.isArray(saved.scanFirst) ? saved.scanFirst.filter( (k) => typeof(k) === 'string' ) : [];
        }
        this.index = index;
        this.ready = true;
    }

    async init() {
        try {
            await this.load();
        } catch (err) {
            this.log(`Breaks: the store could not be read yet (${err.message}); trying again before the first scan`);
        }
    }

    start() {
        if (this.baseRunner === breakScan.defaultRunner) {
            // ready before the first scan, so its first reads are already Very Low
            this.disk.start();
        }
        const rebuild = () => this.rebuildQueue().catch( (err) => {
            this.log(`Breaks: could not work out what to scan: ${err.stack || err}`);
            if (! this.ready) {
                this.timers.push(setTimeout(rebuild, FIRST_QUEUE_MS));
            }
        } );
        this.timers.push(setTimeout(rebuild, FIRST_QUEUE_MS));
        this.timers.push(setInterval(rebuild, QUEUE_EVERY_MS));
        this.timers.push(setInterval( () => this.tick(), TICK_MS ));
        let pending = null;
        if (typeof(this.options.channelService.on) === 'function') {
            this.options.channelService.on('channel-update', () => {
                clearTimeout(pending);
                pending = setTimeout(rebuild, AFTER_SAVE_MS);
            } );
        }
        this.worker = this.workLoop().catch( (err) => this.log(`Breaks: the scanner stopped: ${err.stack || err}`) );
    }

    async stop() {
        this.stopping = true;
        for (const t of this.timers) {
            clearTimeout(t);
            clearInterval(t);
        }
        this.timers = [];
        clearTimeout(this.soonTimer);
        this.abort('stop');
        if (this.worker) {
            await this.worker;
        }
        this.disk.stop();
    }

    tick() {
        const result = this.governor.observe( { live: this.meter.live(), cpu: this.cpu.sample() } );
        if (result.pauseNow) {
            this.abort('pause');
        }
    }

    abort(reason) {
        if (this.controller !== null) {
            this.abortReason = reason;
            this.controller.abort();
        }
    }

    async setPaused(paused) {
        this.switchedByHand = true;
        this.governor.setManualPaused(paused === true);
        if (paused === true) {
            this.abort('pause');
        }
        await this.saveSettings();
    }

    // The Midrolls switch: off stops a scan at once (it waits, like a pause) and reads nothing more.
    async setMidrolls(on) {
        this.midrollsSetByHand = true;
        this.midrolls = (on === true);
        this.governor.setMidrollsOff(! this.midrolls);
        if (! this.midrolls) {
            this.abort('pause');
        }
        await this.saveSettings();
    }

    /*
     * Drives the scanner must not read ("E:"): their files leave the queue, a
     * scan on one stops at once without counting as a failure, and nothing is
     * read there until the drive is taken off the list.
     */
    async setSkipDrives(drives) {
        this.drivesSetByHand = true;
        this.skipDrives = BreakScanService.driveList(drives);
        const skipped = new Set(this.skipDrives);
        this.queue = this.queue.filter( (e) => ! skipped.has(e.drive) );
        if ( (this.current !== null) && skipped.has(this.current.drive) ) {
            this.abort('skip');
        }
        this.governor.addLog('drive', (this.skipDrives.length > 0) ? `Skipping ${this.skipDrives.join(', ')}` : 'Scanning every drive');
        await this.saveSettings();
        if (this.ready) {
            this.rebuildQueue().catch( (err) => this.log(`Breaks: could not work out what to scan: ${err.stack || err}`) );
        }
    }

    async saveSettings() {
        await fs.promises.writeFile(this.settingsFile, JSON.stringify( { midrolls: this.midrolls === true, paused: this.governor.manualPaused === true, skipDrives: this.skipDrives, scanFirst: this.scanFirst } ), 'utf8');
    }

    isSkipped(drive) {
        return (drive != null) && this.skipDrives.includes(drive);
    }

    // ---- what to scan ------------------------------------------------------------------------

    rebuildQueue() {
        if (this.building !== null) {
            this.rebuildRequested = true;
            return this.building;
        }
        this.rebuildRequested = false;
        this.building = this.buildOnce().finally( () => {
            this.building = null;
            if (this.rebuildRequested) {
                this.rebuildQueue().catch( (err) => this.log(`Breaks: could not work out what to scan: ${err.stack || err}`) );
            }
        } );
        return this.building;
    }

    isTheatrical(key) {
        if (! this.theatrical.has(key)) {
            this.theatrical.set(key, store.loadShow(this.breaksDir, key).theatrical === true);
        }
        return this.theatrical.get(key);
    }

    usable(record) {
        return (record != null) && (record.error == null) && (record.scanner === store.CURRENT_SCANNER_VERSION);
    }

    /*
     * Records scanned before they carried `movie` (every one before Nov 13) are marked
     * now, without a rescan, so a movie inside a custom show is read as a movie: one
     * write per show file that has any.
     */
    markMovies(entries) {
        const byKey = new Map();
        for (const e of entries) {
            const found = this.index.get(e.path);
            if (e.movie && (found != null) && (found.record.movie !== true)) {
                byKey.set(found.key, (byKey.get(found.key) || []).concat( [ e.path ] ));
            }
        }
        for (const [key, paths] of byKey) {
            try {
                const show = store.loadShow(this.breaksDir, key);
                for (const p of paths) {
                    if (show.files[p] != null) {
                        show.files[p].movie = true;
                        this.index.set(p, { key, record: show.files[p] });
                    }
                }
                store.saveShow(this.breaksDir, key, show);
                this.showsRead.delete(key);
            } catch (err) {
                this.log(`Breaks: could not mark the movies of ${key}: ${err.message || err}`);
            }
        }
    }

    needsWork(entry, now) {
        const found = this.index.get(entry.path);
        const record = found ? found.record : null;
        if (record == null) {
            return true;
        }
        if (record.error != null) {
            return ! ( (record.error.retryAt != null) && (record.error.retryAt > now) );
        }
        if (record.scanner !== store.CURRENT_SCANNER_VERSION) {
            return true;
        }
        if (entry.inWeek) {
            const checked = this.verifiedAt.get(entry.path);
            return ! ( (checked != null) && (now - checked < DAY_MS) );
        }
        return false;
    }

    async buildOnce() {
        if (! this.ready) {
            await this.load();
        }
        this.backfillStale = true;   // the saved frames still missing are worked out again
        const now = this.now();
        this.theatrical = new Map();
        const byPath = new Map();
        for (const channel of await this.options.channelService.getAllChannels()) {
            for (const { program, nextAt } of airingsOf(channel, now)) {
                if (! scannable(program)) {
                    continue;
                }
                const had = byPath.get(program.file);
                if ( (had == null) || (nextAt < had.nextAt) ) {
                    byPath.set(program.file, { program, nextAt });
                }
            }
        }
        this.markMovies( [ ...byPath ].map( ([file, { program }]) => ({ path: file, movie: isMovie(program) }) ) );
        this.airing = this.airingOf(byPath, now);
        const entries = [];
        for (const [file, { program, nextAt }] of byPath) {
            const key = transitions.showKey(program);
            const found = this.index.get(file);
            // A theatrical show, or a movie marked theatrical by itself (in a custom show or not).
            if ( (key === null) || this.isTheatrical(key) || ( (found != null) && (found.record.theatrical === true) ) ) {
                continue;
            }
            entries.push( {
                path: file,
                // A file reached under two show keys has one record, saved again where it is.
                key: (found != null) ? found.key : key,
                showKey: key,
                nextAt,
                inWeek: nextAt < now + WEEK_MS,
                drive: paceMeter.driveOf(file),
                title: (program.type === 'episode') ? `${program.showTitle} - ${program.title}` : program.title,
                ratingKey: (program.ratingKey != null) ? String(program.ratingKey) : null,
                movie: isMovie(program),
            } );
        }
        entries.sort( (a, b) => (a.inWeek === b.inWeek) ? (a.nextAt - b.nextAt) : (a.inWeek ? -1 : 1) );
        entries.sort( (a, b) => this.firstRank(a) - this.firstRank(b) );
        const counts = { week: { files: 0, scanned: 0 }, library: { files: 0, scanned: 0 }, skipped: { files: 0 } };
        for (const e of entries) {
            const found = this.index.get(e.path);
            const done = this.usable(found ? found.record : null);
            counts.library.files++;
            counts.library.scanned += done ? 1 : 0;
            if (e.inWeek) {
                counts.week.files++;
                counts.week.scanned += done ? 1 : 0;
            }
            if (this.isSkipped(e.drive) && ! done) {
                counts.skipped.files++;
            }
        }
        this.counts = counts;
        this.queue = entries.filter( (e) => ! this.isSkipped(e.drive) && this.needsWork(e, now) && ( (this.current === null) || (this.current.path !== e.path) ) );
        this.queuedAt = now;
        await this.dropFinishedFirst();
    }

    /*
     * What the Breaks page needs from the channels: each file's next airing and name, and per
     * show key (the program's, and the key its record is stored under, when they differ) how
     * many files air and when the first of them next does.
     */
    airingOf(byPath, now) {
        const files = new Map();
        const shows = new Map();
        const byKey = new Map();
        for (const [file, { program, nextAt }] of byPath) {
            const showKey = transitions.showKey(program);
            const found = this.index.get(file);
            const storeKey = (found != null) ? found.key : showKey;
            files.set(file, { showKey, storeKey, nextAt, type: program.type, title: program.title, showTitle: program.showTitle, season: program.season, episode: program.episode, movie: isMovie(program), durationMs: program.duration });
            for (const k of new Set( [ showKey, storeKey ] )) {
                if (k == null) {
                    continue;
                }
                const had = shows.get(k) || { total: 0, nextAt: null, movies: 0 };
                had.total++;
                if (isMovie(program)) {
                    had.movies++;
                }
                if (k.startsWith('movie.')) {
                    (had.paths = had.paths || []).push(file);
                }
                if ( ! byKey.has(k) ) {
                    byKey.set(k, []);
                }
                byKey.get(k).push(file);
                if ( (had.nextAt === null) || (nextAt < had.nextAt) ) {
                    had.nextAt = nextAt;
                }
                shows.set(k, had);
            }
        }
        return { builtAt: now, files, shows, byKey };
    }

    // ---- "scan this show next" ---------------------------------------------------------------

    // Where an entry stands in the list DarkManX16 asked for (newest request first); the rest after it.
    firstRank(entry) {
        const at = [ this.scanFirst.indexOf(entry.key), this.scanFirst.indexOf(entry.showKey) ].filter( (i) => i >= 0 );
        return (at.length > 0) ? Math.min(...at) : this.scanFirst.length;
    }

    async setScanFirst(key, on) {
        this.scanFirstSetByHand = true;
        this.scanFirst = this.scanFirst.filter( (k) => k !== key );
        if (on === true) {
            this.scanFirst.unshift(key);
        }
        // stable, so the order the rebuild gave is kept inside each rank
        this.queue = this.queue.map( (e, i) => ({ e, i }) ).sort( (a, b) => (this.firstRank(a.e) - this.firstRank(b.e)) || (a.i - b.i) ).map( (x) => x.e );
        await this.saveSettings();
    }

    // How many files of a show are waiting to be scanned.
    remaining(key) {
        return this.queue.filter( (e) => (e.key === key) || (e.showKey === key) ).length + ( (this.current !== null) && ( (this.current.key === key) || (this.current.showKey === key) ) ? 1 : 0 );
    }

    // A show whose files are all scanned (or can't be) is no longer waiting for its turn.
    async dropFinishedFirst() {
        const kept = this.scanFirst.filter( (k) => this.remaining(k) > 0 );
        if (kept.length !== this.scanFirst.length) {
            this.scanFirst = kept;
            await this.saveSettings();
        }
    }

    // A rebuild a moment from now (a show or movie marked theatrical and back should rejoin the queue).
    rebuildSoon() {
        clearTimeout(this.soonTimer);
        this.soonTimer = setTimeout( () => this.rebuildQueue().catch( (err) => this.log(`Breaks: could not work out what to scan: ${err.stack || err}`) ), AFTER_SAVE_MS );
    }

    // ---- DarkManX16's changes from the page ------------------------------------------------------

    /*
     * Changes one show's file in the store: `mutate(show)` edits it in place and may return
     * { ok: false } to change nothing. Load, change and save are one synchronous step, so
     * the scanner's own saves never interleave with it; the scanner's index follows.
     */
    updateShow(key, mutate) {
        const show = store.loadShow(this.breaksDir, key);
        const before = Object.keys(show.files);
        const result = mutate(show);
        if ( (result != null) && (result.ok === false) ) {
            return result;
        }
        store.saveShow(this.breaksDir, key, show);
        this.showsRead.delete(key);
        for (const p of Object.keys(show.files)) {
            this.index.set(p, { key, record: show.files[p] });
        }
        // a record the change took away (a theatrical mark that was all a movie had) goes from the index too,
        // or the scanner would still read the movie as marked
        for (const p of before) {
            const had = this.index.get(p);
            if ( (show.files[p] == null) && (had != null) && (had.key === key) ) {
                this.index.delete(p);
            }
        }
        this.theatrical.delete(key);
        // a show or movie marked theatrical leaves the queue at once; one marked back waits for the next rebuild
        this.queue = this.queue.filter( (e) => ! ( (e.key === key) && ( (show.theatrical === true) || ( (show.files[e.path] != null) && (show.files[e.path].theatrical === true) ) ) ) );
        // his say on a point, an episode off the list, a changed file: their saved frames go
        try {
            this.savedFrames.sweep(key, show);
        } catch (err) {
            this.log(`Breaks: could not tidy the saved frames of ${key}: ${err.message}`);
        }
        return result || { ok: true };
    }

    // ---- saved frames (step 5c) --------------------------------------------------------------

    /*
     * Cuts one saved frame through the scanner's own runner (idle CPU, Very Low disk, stopped at
     * once by a pause or Midrolls off). Returns true when it was cut.
     */
    async cutSaved(w, key) {
        const drive = paceMeter.driveOf(w.file);
        // as a scan's own pieces do: a pause or Midrolls off stops it, and in Gentle it waits out its rest
        for (;;) {
            const mode = this.governor.mode();
            if ( this.stopping || this.isSkipped(drive) || (mode === 'off') || (mode === 'paused') ) {
                return false;
            }
            if ( (mode === 'gentle') && (this.restUntil != null) && (this.now() < this.restUntil) ) {
                await this.sleep(Math.min(1000, this.restUntil - this.now()));
                continue;
            }
            break;
        }
        await fs.promises.mkdir(path.dirname(w.out), { recursive: true });
        const temp = `${w.out}.part.jpg`;
        const ffmpegPath = (this.options.getFfmpegSettings() || {}).ffmpegPath || 'ffmpeg';
        const hadCurrent = this.current;
        if (hadCurrent === null) {
            this.current = { path: w.file, title: 'a frame to check', key, drive, startedAt: this.now(), step: 'frames' };
            this.fileRunMs = 0;
        }
        let result = null;
        try {
            result = await this.run(ffmpegPath, frameArgs(w.file, w.t, temp));
        } catch (err) {
            result = null;
        } finally {
            if (hadCurrent === null) {
                this.current = null;
            }
        }
        if ( (result == null) || result.aborted || (result.code !== 0) || ! fs.existsSync(temp) ) {
            await fs.promises.rm(temp, { force: true }).catch( () => {} );
            return false;
        }
        await fs.promises.rename(temp, w.out);
        return true;
    }

    // After a file is scanned: the frames of its points waiting on the list to check.
    async saveListedFrames(key, file) {
        const show = store.loadShow(this.breaksDir, key);
        this.savedFrames.sweep(key, show);
        let n = 0;
        for (const w of this.savedFrames.missing(key, show, file)) {
            if (await this.cutSaved(w, key)) {
                n++;
            }
        }
        return n;
    }

    /*
     * The files scanned before saved frames existed get theirs in the scanner's idle time,
     * soonest airing first, one frame a call. Returns true when it cut one. The list of what is
     * missing is worked out again after each queue build.
     */
    async backfillFrames() {
        for (;;) {
            if (this.backfillJobs.length === 0) {
                if (! this.backfillStale) {
                    return false;
                }
                this.backfillStale = false;
                const keys = store.listShowKeys(this.breaksDir);
                const next = (k) => { const a = this.airing.shows.get(k); return (a && (a.nextAt != null)) ? a.nextAt : Infinity; };
                keys.sort( (a, b) => next(a) - next(b) );
                for (const key of keys) {
                    const show = store.loadShow(this.breaksDir, key);
                    for (const w of this.savedFrames.missing(key, show)) {
                        this.backfillJobs.push( { key, w } );
                    }
                }
                if (this.backfillJobs.length === 0) {
                    return false;
                }
            }
            const { key, w } = this.backfillJobs.shift();
            if (fs.existsSync(w.out) || this.isSkipped(paceMeter.driveOf(w.file))) {
                continue;
            }
            // still wanted? (he may have decided the point since the list was made)
            const show = store.loadShow(this.breaksDir, key);
            if (! this.savedFrames.missing(key, show, w.file).some( (x) => x.out === w.out )) {
                continue;
            }
            return this.cutSaved(w, key);
        }
    }

    // ---- the worker --------------------------------------------------------------------------

    pickNext(mode) {
        if (mode !== 'gentle') {
            return this.queue[0] || null;
        }
        // A show DarkManX16 asked to have scanned next goes first, on a busy drive too: at Very Low disk
        // priority, with the pace check still watching, that is what Gentle already does for a busy
        // drive's last files (Nov 10), and waiting for every free drive's files would be waiting for good.
        const asked = this.queue.find( (e) => this.firstRank(e) < this.scanFirst.length );
        if (asked !== undefined) {
            return asked;
        }
        // a drive no viewer is on first; failing that, a busy one, at Very Low
        const busy = this.governor.busyDrives();
        return this.queue.find( (e) => ! busy.has(e.drive) ) || this.queue[0] || null;
    }

    async workLoop() {
        while (! this.stopping) {
            const mode = this.governor.mode();
            if ( ! this.ready || (mode === 'off') || (mode === 'paused') ) {
                await this.sleep(1000);
                continue;
            }
            const entry = this.pickNext(mode);
            if (entry === null) {
                // nothing to scan: a saved frame the list still wants, if any
                const cut = await this.backfillFrames().catch( (err) => {
                    this.log(`Breaks: saved frames: ${err.message}`);
                    return false;
                } );
                if (! cut) {
                    await this.sleep(IDLE_POLL_MS);
                }
                continue;
            }
            this.queue = this.queue.filter( (e) => e !== entry );
            try {
                await this.scanOne(entry);
            } catch (err) {
                this.log(`Breaks: ${entry.path}: ${err.stack || err}`);
            }
            this.governor.fileDone();
        }
    }

    // Before each piece: wait out a pause, rest in Gentle.
    async beforeChunk(entry) {
        for (;;) {
            if (this.stopping) {
                throw Object.assign(new Error('the scanner is stopping'), { stopping: true });
            }
            if (this.isSkipped(entry.drive)) {
                throw Object.assign(new Error(`${entry.drive} is skipped`), { skipped: true });
            }
            const mode = this.governor.mode();
            if ( (mode === 'off') || (mode === 'paused') ) {
                await this.sleep(1000);
                continue;
            }
            if ( (mode === 'gentle') && (this.restUntil != null) && (this.now() < this.restUntil) ) {
                await this.sleep(Math.min(1000, this.restUntil - this.now()));
                continue;
            }
            if (this.fileRunMs >= this.fileLimitMs) {
                throw Object.assign(new Error(`stopped after ${Math.round(this.fileLimitMs / 60000)} minutes of scanning`), { timeLimit: true });
            }
            this.current.step = 'scanning';
            return;
        }
    }

    // One ffmpeg or ffprobe run, stoppable at once, inside the file's time limit.
    async run(cmd, args) {
        this.controller = new AbortController();
        this.abortReason = null;
        const limit = setTimeout( () => this.abort('limit'), Math.max(0, this.fileLimitMs - this.fileRunMs) );
        const started = this.now();
        this.governor.setWorking(true, this.current ? this.current.drive : null);
        let result;
        try {
            result = await this.baseRunner(cmd, args, { signal: this.controller.signal, onSpawn: (pid) => this.disk.lower(pid) });
        } finally {
            clearTimeout(limit);
            this.governor.setWorking(false);
            this.controller = null;
        }
        const ran = this.now() - started;
        this.fileRunMs += ran;
        this.lastRunMs = ran;
        this.restUntil = this.now() + this.governor.restMs(ran);
        if (result && result.aborted) {
            if (this.abortReason === 'limit') {
                throw Object.assign(new Error(`stopped after ${Math.round(this.fileLimitMs / 60000)} minutes of scanning`), { timeLimit: true });
            }
            if (this.abortReason === 'stop') {
                throw Object.assign(new Error('the scanner is stopping'), { stopping: true });
            }
            if (this.abortReason === 'skip') {
                throw Object.assign(new Error('its drive is skipped'), { skipped: true });
            }
        }
        return result;
    }

    async probe(entry, ffmpegPath) {
        const args = [ '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-show_chapters', '-of', 'json', entry.path ];
        const { stdout } = await breakScan.runPiece(ffprobeOf(ffmpegPath), args, {
            run: (cmd, a) => this.run(cmd, a),
            beforeChunk: () => this.beforeChunk(entry),
        } );
        const parsed = JSON.parse(stdout || '{}');
        const durationS = Number(parsed.format && parsed.format.duration);
        if (! (durationS > 0) ) {
            throw new Error('ffprobe found no duration');
        }
        const chapters = (parsed.chapters || []).map( (c) => ({
            s: Number(c.start_time),
            e: Number(c.end_time),
            t: (c.tags && c.tags.title) || '',
        }) );
        // false only when ffprobe listed the streams and none is audio
        const hasAudio = Array.isArray(parsed.streams) ? parsed.streams.some( (s) => s.codec_type === 'audio' ) : undefined;
        return { durationS, chapters, hasAudio };
    }

    async scanOne(entry) {
        const startedAt = this.now();
        this.current = { path: entry.path, title: entry.title, key: entry.key, drive: entry.drive, startedAt, step: 'checking' };
        this.fileRunMs = 0;
        try {
            let st;
            try {
                st = await this.stat(entry.path);
            } catch (err) {
                this.fail(entry, { path: entry.path, ratingKey: entry.ratingKey }, err);
                return 'failed';
            }
            const file = { path: entry.path, ratingKey: entry.ratingKey, size: st.size, mtimeMs: st.mtimeMs };
            const found = this.index.get(entry.path);
            const record = found ? found.record : null;
            if (this.usable(record) && ! store.needsScan(record, file)) {
                this.verifiedAt.set(entry.path, this.now());
                return 'current';
            }
            const ffmpegPath = (this.options.getFfmpegSettings() || {}).ffmpegPath || 'ffmpeg';
            try {
                const { durationS, chapters, hasAudio } = await this.probe(entry, ffmpegPath);
                const result = await breakScan.scanFile(
                    { path: entry.path, durationS, title: entry.title, chapters, hasAudio },
                    {
                        ffmpegPath,
                        run: (cmd, args) => this.run(cmd, args),
                        beforeChunk: () => this.beforeChunk(entry),
                    } );
                const saved = store.recordFor(this.breaksDir, entry.key, Object.assign( {}, file, { durationS, chapters, movie: entry.movie === true } ), result, this.now);
                this.index.set(entry.path, { key: entry.key, record: saved });
                this.showsRead.delete(entry.key);
                this.verifiedAt.set(entry.path, this.now());
                this.bumpCounts(entry);
                this.log(`Breaks: scanned ${entry.title} (${result.points.length} points, ${Math.round(this.fileRunMs / 100) / 10}s of ffmpeg)`);
                // while the file was just read: the frames of its points waiting on the list to check
                await this.saveListedFrames(entry.key, entry.path).catch( (err) => this.log(`Breaks: frames of ${entry.title}: ${err.message}`) );
                return 'scanned';
            } catch (err) {
                if (err && err.stopping) {
                    return 'stopped';
                }
                if (err && err.skipped) {
                    this.log(`Breaks: stopped ${entry.title}: ${entry.drive} is skipped`);
                    return 'skipped';
                }
                this.fail(entry, file, err);
                if (err && err.timeLimit) {
                    this.governor.addLog('limit', `${entry.title}: ${err.message}; trying again tomorrow`);
                }
                return 'failed';
            }
        } finally {
            this.current = null;
        }
    }

    fail(entry, file, err) {
        const record = store.recordError(this.breaksDir, entry.key, file, err, this.now, this.now() + DAY_MS);
        this.index.set(entry.path, { key: entry.key, record });
        this.showsRead.delete(entry.key);
        this.log(`Breaks: could not scan ${entry.title}: ${err && err.message ? err.message : err}; trying again tomorrow`);
    }

    bumpCounts(entry) {
        this.counts.library.scanned = Math.min(this.counts.library.files, this.counts.library.scanned + 1);
        if (entry.inWeek) {
            this.counts.week.scanned = Math.min(this.counts.week.files, this.counts.week.scanned + 1);
        }
    }

    // ---- for midrolls (midroll-plan.js's env) ---------------------------------------------------

    midrollsOn() {
        return this.midrolls === true;
    }

    /*
     * A program's airable points, for midroll-plan.js's env.pointsFor: { durationMs, points:
     * [{ index, at, kind, by, strength }] } (break-airable.js's answer, with each point's
     * strength), or null for a file with no usable record. Read through a per-show cache that
     * every write here clears and that also notices the show's file changing on disk (its size
     * and time), so an approval, a scan or a hand edit shows on the next read, and a stream
     * never reads every show's file.
     */
    pointsFor(program) {
        if (! scannable(program)) {
            return null;
        }
        const found = this.index.get(program.file);
        const read = (found != null) ? this.readShow(found.key) : null;
        if (read === null) {
            return null;
        }
        if (! read.airable.has(program.file)) {
            const record = read.show.files[program.file];
            let answer = null;
            if ( (record != null) && (record.error == null) && Array.isArray(record.points) && (typeof(record.durationMs) === 'number') ) {
                const isMovieKey = found.key.startsWith('movie.');
                if (read.auto === null) {
                    read.auto = patterns.autoApproval(read.show, { isMovie: isMovieKey });
                }
                answer = {
                    durationMs: record.durationMs,
                    points: airablePoints(read.show, program.file, { isMovie: isMovieKey, auto: read.auto })
                        .map( (p) => ({ index: p.index, at: p.at, kind: p.kind, by: p.by, strength: record.points[p.index].strength }) ),
                };
            }
            read.airable.set(program.file, answer);
        }
        return read.airable.get(program.file);
    }

    // One show's file, kept while its size and time stay the same: { sig, show, auto, airable }.
    readShow(key) {
        let sig;
        try {
            const st = fs.statSync(store.showFile(this.breaksDir, key));
            sig = `${st.size}:${st.mtimeMs}`;
        } catch (err) {
            return null;
        }
        const held = this.showsRead.get(key);
        if ( (held != null) && (held.sig === sig) ) {
            return held;
        }
        let show;
        try {
            show = store.loadShow(this.breaksDir, key);
        } catch (err) {
            return null;
        }
        const read = { sig, show, auto: null, airable: new Map() };
        this.showsRead.set(key, read);
        return read;
    }

    // ---- for the page ------------------------------------------------------------------------

    status() {
        const g = this.governor;
        return {
            ready: this.ready,
            mode: g.mode(),
            reason: this.ready ? g.reason() : 'Starting: the store is read before the first scan',
            pausedUntil: g.isPaused() ? g.pausedUntil : null,
            pausedByHand: g.manualPaused,
            midrolls: this.midrolls === true,
            working: g.working,
            current: this.current,
            queued: this.queue.length,
            counts: this.counts,
            skipDrives: this.skipDrives.slice(),
            scanFirst: this.scanFirst.map( (k) => ({ key: k, remaining: this.remaining(k) }) ),
            diskPriority: this.disk.status(),
            live: this.meter.live().map( (i) => ({ channel: i.channel, title: i.title, drive: i.drive, startedAt: i.startedAt, pace: i.pace, held: i.held }) ),
            pace: g.paceReport(),
            log: g.log.slice(-100),
        };
    }
}

BreakScanService.airingsOf = airingsOf;
BreakScanService.scannable = scannable;
BreakScanService.driveName = driveName;
BreakScanService.driveList = (drives) => Array.from(new Set( (Array.isArray(drives) ? drives : []).map(driveName).filter( (d) => d !== null ) )).sort();
BreakScanService.constants = { FIRST_QUEUE_MS, QUEUE_EVERY_MS, AFTER_SAVE_MS, TICK_MS, WEEK_MS, DAY_MS, FILE_LIMIT_MS };

module.exports = BreakScanService;
