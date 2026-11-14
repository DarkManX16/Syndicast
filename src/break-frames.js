/*
 * The pictures on the Breaks page (docs/blocks-spec.md, Stage 6, step 4): one frame
 * of a file at a time, cut by ffmpeg to a small JPEG and kept, so the page can show
 * what is on either side of a break point.
 *
 * It reads the real drives the viewers play from, so it is as gentle as the scanner:
 *   - one frame at a time, at idle CPU priority and Very Low disk priority (the
 *     scanner's own runner), never more than 30 s on one;
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

class FrameError extends Error {
    constructor(reason, message) {
        super(message);
        this.reason = reason;   // 'unknown' | 'skipped' | 'paused' | 'failed'
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
        this.chain = Promise.resolve();
        this.written = 0;
    }

    nameFor(file, record, t) {
        const key = [ file, record.size, record.mtimeMs, t.toFixed(1) ].join('|');
        return crypto.createHash('sha1').update(key).digest('hex') + '.jpg';
    }

    /*
     * The frame of `file` at `t` seconds: the path of a JPEG, cut now or kept from before.
     * Throws a FrameError saying why not.
     */
    async grab(file, t) {
        const found = this.service.index.get(file);
        if ( (found == null) || ! Number.isFinite(t) || (t < 0) ) {
            throw new FrameError('unknown', 'that is not a file the scanner knows');
        }
        const out = path.join(this.dir, this.nameFor(file, found.record, t));
        if (fs.existsSync(out)) {
            return out;
        }
        const drive = paceMeter.driveOf(file);
        if (this.service.isSkipped(drive)) {
            throw new FrameError('skipped', `${drive} is skipped`);
        }
        if (this.service.governor.isPaused()) {
            throw new FrameError('paused', 'paused while a viewer catches up');
        }
        const run = this.chain.then( () => this.cut(file, t, out, drive) );
        this.chain = run.catch( () => {} );
        return run;
    }

    async cut(file, t, out, drive) {
        if (fs.existsSync(out)) {
            return out;
        }
        // the checks again: this one waited its turn
        if (this.service.isSkipped(drive)) {
            throw new FrameError('skipped', `${drive} is skipped`);
        }
        await fs.promises.mkdir(this.dir, { recursive: true });
        const temp = out + '.part.jpg';
        const ffmpegPath = (this.service.options.getFfmpegSettings() || {}).ffmpegPath || 'ffmpeg';
        const args = [
            '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
            '-ss', t.toFixed(3), '-i', file, '-frames:v', '1',
            '-vf', `scale=${FRAME_WIDTH}:-2`, '-q:v', '5', '-y', temp,
        ];
        const controller = new AbortController();
        const limit = setTimeout( () => controller.abort(), LIMIT_MS );
        let result;
        try {
            result = await this.service.baseRunner(ffmpegPath, args, { signal: controller.signal, onSpawn: (pid) => this.service.disk.lower(pid) });
        } finally {
            clearTimeout(limit);
        }
        if ( ! result || result.aborted || (result.code !== 0) || ! fs.existsSync(temp) ) {
            await fs.promises.rm(temp, { force: true }).catch( () => {} );
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

module.exports = { FrameGrabber, FrameError, FRAME_WIDTH, LIMIT_MS, KEEP_FRAMES, PRUNE_TO };
