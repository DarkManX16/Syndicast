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
 *            are skipped; so is a file with a current record. Files airing
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
 * The hand switch and the skipped drives are kept in
 * <data>/break-scanner.json, so a restart does not undo them. BREAK_SCAN_FORCE_MODE (normal|gentle) pins the mode for a proof.
 */

const fs = require('fs');
const path = require('path');
const store = require('../breaks-store');
const breakScan = require('../break-scan');
const transitions = require('../transitions');
const paceMeter = require('../pace-meter');
const { ScanGovernor } = require('../break-scan-governor');
const { DiskPriority } = require('../io-priority');

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
        this.skipDrives = [];
        this.drivesSetByHand = false;
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
        if (! this.drivesSetByHand) {
            this.skipDrives = BreakScanService.driveList(saved.skipDrives);
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
        await fs.promises.writeFile(this.settingsFile, JSON.stringify( { paused: this.governor.manualPaused === true, skipDrives: this.skipDrives } ), 'utf8');
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
        const entries = [];
        for (const [file, { program, nextAt }] of byPath) {
            const key = transitions.showKey(program);
            if ( (key === null) || this.isTheatrical(key) ) {
                continue;
            }
            entries.push( {
                path: file,
                key,
                nextAt,
                inWeek: nextAt < now + WEEK_MS,
                drive: paceMeter.driveOf(file),
                title: (program.type === 'episode') ? `${program.showTitle} - ${program.title}` : program.title,
                ratingKey: (program.ratingKey != null) ? String(program.ratingKey) : null,
            } );
        }
        entries.sort( (a, b) => (a.inWeek === b.inWeek) ? (a.nextAt - b.nextAt) : (a.inWeek ? -1 : 1) );
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
    }

    // ---- the worker --------------------------------------------------------------------------

    pickNext(mode) {
        if (mode !== 'gentle') {
            return this.queue[0] || null;
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
                await this.sleep(IDLE_POLL_MS);
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
                const saved = store.recordFor(this.breaksDir, entry.key, Object.assign( {}, file, { durationS, chapters } ), result, this.now);
                this.index.set(entry.path, { key: entry.key, record: saved });
                this.verifiedAt.set(entry.path, this.now());
                this.bumpCounts(entry);
                this.log(`Breaks: scanned ${entry.title} (${result.points.length} points, ${Math.round(this.fileRunMs / 100) / 10}s of ffmpeg)`);
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
        this.log(`Breaks: could not scan ${entry.title}: ${err && err.message ? err.message : err}; trying again tomorrow`);
    }

    bumpCounts(entry) {
        this.counts.library.scanned = Math.min(this.counts.library.files, this.counts.library.scanned + 1);
        if (entry.inWeek) {
            this.counts.week.scanned = Math.min(this.counts.week.files, this.counts.week.scanned + 1);
        }
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
            working: g.working,
            current: this.current,
            queued: this.queue.length,
            counts: this.counts,
            skipDrives: this.skipDrives.slice(),
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
