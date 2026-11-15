/*
 * The pictures on the Breaks page (docs/blocks-spec.md, Stage 6, step 4): one frame
 * of a file at a time, cut by ffmpeg to a small JPEG and kept, so the page can show
 * what is on either side of a break point.
 *
 * It reads the real drives the viewers play from, so it is as gentle as the scanner:
 *   - at most two frames at a time (step 5c: the page shows two; it used to be one, and
 *     the page's requests queued behind it), at idle CPU priority and Very Low disk
 *     priority (the scanner's own runner), never more than 30 s on one;
 *   - a request the page cancels (it moved on to another point) leaves the queue, or has
 *     its ffmpeg stopped if it is running;
 *   - a drive a viewer is playing from is not read for a frame not cut before: the page
 *     says "drive busy" at once instead of waiting on it (a frame cut before still shows);
 *   - a file the scanner does not know is never read (the page cannot be made to read
 *     any file on the PC), nor is one on a drive DarkManX16 skips ("E:");
 *   - while the scanner is paused because a viewer is falling behind (not when it is
 *     paused by hand), no frame is cut, and the page says so.
 * Frames are named by what they show, so the same point is cut once.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paceMeter = require('./pace-meter');

const FRAME_WIDTH = 480;
const LIMIT_MS = 30 * 1000;
const KEEP_FRAMES = 4000;
const PRUNE_TO = 3000;
const PRUNE_EVERY = 200;
const MAX_CUTS = 2;

// A frame's file name: what it shows (the file, its size and date, the time), so the same point is cut once.
function frameName(file, record, t) {
    const key = [ file, record.size, record.mtimeMs, t.toFixed(1) ].join('|');
    return crypto.createHash('sha1').update(key).digest('hex') + '.jpg';
}

// ffmpeg's arguments for one frame of `file` at `t`, written to `out` (the saved frames use the same).
function frameArgs(file, t, out) {
    return [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
        '-ss', t.toFixed(3), '-i', file, '-frames:v', '1',
        '-vf', `scale=${FRAME_WIDTH}:-2`, '-q:v', '5', '-y', out,
    ];
}

class FrameError extends Error {
    constructor(reason, message) {
        super(message);
        this.reason = reason;   // 'unknown' | 'skipped' | 'paused' | 'busy' | 'cancelled' | 'failed'
    }
}

class FrameGrabber {
    /*
     * service: the break scan service, for what it knows of the files, the skipped drives,
     * its runner, its disk priority and its pause. options.dir overrides the folder.
     */
    constructor(service, options = {}) {
        this.service = service;
        this.dir = path.resolve(options.dir || path.join(service.options.folder, 'breaks-frames'));
        this.waiting = [];
        this.running = 0;
        this.written = 0;
    }

    nameFor(file, record, t) {
        return frameName(file, record, t);
    }

    /*
     * The frame of `file` at `t` seconds: the path of a JPEG, cut now or kept from before.
     * Throws a FrameError saying why not. `signal`: the page's request; aborted, the frame is
     * no longer wanted.
     */
    async grab(file, t, { signal = null } = {}) {
        const found = this.service.index.get(file);
        if ( (found == null) || ! Number.isFinite(t) || (t < 0) ) {
            throw new FrameError('unknown', 'that is not a file the scanner knows');
        }
        const out = path.join(this.dir, this.nameFor(file, found.record, t));
        if (fs.existsSync(out)) {
            return out;
        }
        // one the scanner saved for the list to check: no drive read at all, a busy one included
        const saved = (this.service.savedFrames != null) ? this.service.savedFrames.existing(found.key, file, found.record, t) : null;
        if (saved !== null) {
            return saved;
        }
        const drive = paceMeter.driveOf(file);
        if (this.service.isSkipped(drive)) {
            throw new FrameError('skipped', `${drive} is skipped`);
        }
        if (this.service.governor.isPaused()) {
            throw new FrameError('paused', 'paused while a viewer catches up');
        }
        this.checkBusy(drive);
        if ( (signal !== null) && signal.aborted ) {
            throw new FrameError('cancelled', 'no longer wanted');
        }
        return new Promise( (resolve, reject) => {
            const job = { file, t, out, drive, resolve, reject, controller: null, cancelled: false };
            if (signal !== null) {
                signal.addEventListener('abort', () => this.cancel(job), { once: true });
            }
            this.waiting.push(job);
            this.next();
        } );
    }

    checkBusy(drive) {
        const busy = (typeof(this.service.governor.busyDrives) === 'function') ? this.service.governor.busyDrives() : new Set();
        if ( (drive != null) && busy.has(drive) ) {
            throw new FrameError('busy', `drive busy: a viewer is playing from ${drive}`);
        }
    }

    next() {
        while ( (this.running < MAX_CUTS) && (this.waiting.length > 0) ) {
            const job = this.waiting.shift();
            this.running++;
            this.cut(job).then(job.resolve, job.reject).finally( () => {
                this.running--;
                this.next();
            } );
        }
    }

    // The page let go: out of the queue, or its ffmpeg stopped.
    cancel(job) {
        job.cancelled = true;
        const i = this.waiting.indexOf(job);
        if (i >= 0) {
            this.waiting.splice(i, 1);
            job.reject(new FrameError('cancelled', 'no longer wanted'));
        } else if (job.controller !== null) {
            job.controller.abort();
        }
    }

    async cut(job) {
        const { file, t, out, drive } = job;
        if (fs.existsSync(out)) {
            return out;
        }
        // the checks again: this one waited its turn
        if (this.service.isSkipped(drive)) {
            throw new FrameError('skipped', `${drive} is skipped`);
        }
        this.checkBusy(drive);
        await fs.promises.mkdir(this.dir, { recursive: true });
        if (job.cancelled) {
            throw new FrameError('cancelled', 'no longer wanted');
        }
        // two cuts of the same frame may run at once: each writes its own part file
        const temp = `${out}.${crypto.randomBytes(4).toString('hex')}.part.jpg`;
        const ffmpegPath = (this.service.options.getFfmpegSettings() || {}).ffmpegPath || 'ffmpeg';
        const args = frameArgs(file, t, temp);
        const controller = new AbortController();
        job.controller = controller;
        const limit = setTimeout( () => controller.abort(), LIMIT_MS );
        let result;
        try {
            result = await this.service.baseRunner(ffmpegPath, args, { signal: controller.signal, onSpawn: (pid) => this.service.disk.lower(pid) });
        } finally {
            clearTimeout(limit);
        }
        if ( ! result || result.aborted || (result.code !== 0) || ! fs.existsSync(temp) ) {
            await fs.promises.rm(temp, { force: true }).catch( () => {} );
            if (job.cancelled) {
                throw new FrameError('cancelled', 'no longer wanted');
            }
            const why = (result && result.aborted) ? 'it took too long' : String((result && result.stderr) || 'ffmpeg failed').trim().split(/\r?\n/).slice(-1)[0];
            throw new FrameError('failed', why);
        }
        await fs.promises.rename(temp, out);
        this.written++;
        if (this.written % PRUNE_EVERY === 0) {
            this.prune().catch( () => {} );
        }
        return out;
    }

    // Old frames go once there are a lot of them.
    async prune() {
        const names = (await fs.promises.readdir(this.dir)).filter( (f) => f.endsWith('.jpg') && ! f.endsWith('.part.jpg') );
        if (names.length <= KEEP_FRAMES) {
            return 0;
        }
        const stats = await Promise.all(names.map( async (f) => ({ f, m: (await fs.promises.stat(path.join(this.dir, f))).mtimeMs }) ));
        stats.sort( (a, b) => a.m - b.m );
        const drop = stats.slice(0, names.length - PRUNE_TO);
        await Promise.all(drop.map( (x) => fs.promises.rm(path.join(this.dir, x.f), { force: true }) ));
        return drop.length;
    }
}

module.exports = { FrameGrabber, FrameError, frameName, frameArgs, FRAME_WIDTH, LIMIT_MS, KEEP_FRAMES, PRUNE_TO };
