/*
 * How fast each live item is playing (docs/blocks-spec.md, Stage 6, "The
 * scanner, and live streams"). Every ffmpeg Syndicast runs for a program,
 * filler item or screen reports its progress on a separate pipe (fd 3) every
 * 2 s; the stream it sends on stdout is not touched. An item's pace is media
 * time advanced over wall time across the last 10 s, ignoring its first 3 s.
 * Under -re a healthy item reads 1.00.
 *
 * Also the whole PC's CPU, sampled from os.cpus(), which the scanner uses for
 * the load it cannot measure directly (another streaming server's streams).
 */

const os = require('os');
const EventEmitter = require('events');

const PROGRESS_EVERY_S = 2;
const PACE_WINDOW_MS = 10 * 1000;
const IGNORE_FIRST_MS = 3 * 1000;
const MIN_SPAN_MS = 4 * 1000;

function progressArgs() {
    return [ '-progress', 'pipe:3', '-stats_period', String(PROGRESS_EVERY_S) ];
}

// ffmpeg's -progress output: key=value lines, each block ending in
// progress=continue or progress=end.
class ProgressParser {
    constructor(onBlock) {
        this.onBlock = onBlock;
        this.buf = '';
        this.block = {};
    }

    feed(chunk) {
        this.buf += chunk.toString();
        let i;
        while ( (i = this.buf.indexOf('\n')) >= 0 ) {
            const line = this.buf.slice(0, i).trim();
            this.buf = this.buf.slice(i + 1);
            const eq = line.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            const key = line.slice(0, eq);
            const value = line.slice(eq + 1);
            this.block[key] = value;
            if (key === 'progress') {
                const outUs = Number(this.block.out_time_us);
                this.onBlock( {
                    mediaS: Number.isFinite(outUs) ? outUs / 1e6 : null,
                    end: value === 'end',
                } );
                this.block = {};
            }
        }
    }
}

class ItemPace {
    constructor(startedAt) {
        this.startedAt = startedAt;
        this.samples = [];
    }

    add(wallMs, mediaS) {
        if ( (mediaS === null) || (wallMs - this.startedAt < IGNORE_FIRST_MS) ) {
            return;
        }
        this.samples.push( { wallMs, mediaS } );
        while ( (this.samples.length > 2) && (this.samples[1].wallMs <= wallMs - PACE_WINDOW_MS) ) {
            this.samples.shift();
        }
    }

    pace() {
        const n = this.samples.length;
        if (n < 2) {
            return null;
        }
        const first = this.samples[0];
        const last = this.samples[n - 1];
        const span = last.wallMs - first.wallMs;
        if (span < MIN_SPAN_MS) {
            return null;
        }
        return (last.mediaS - first.mediaS) / (span / 1000);
    }
}

// "G:" for a drive letter (with or without the \\?\ long-path prefix),
// "\\server\share" for a share, the first two segments of a POSIX path.
function driveOf(file) {
    if ( (typeof(file) !== 'string') || (file === '') ) {
        return null;
    }
    let f = file.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
    let m = /^([A-Za-z]):/.exec(f);
    if (m) {
        return m[1].toUpperCase() + ':';
    }
    m = /^\\\\([^\\]+)\\([^\\]+)/.exec(f);
    if (m) {
        return ('\\\\' + m[1] + '\\' + m[2]).toLowerCase();
    }
    m = /^\/[^/]+(\/[^/]+)?/.exec(f);
    return m ? m[0] : null;
}

class PaceMeter extends EventEmitter {
    constructor(options = {}) {
        super();
        this.now = options.now || ( () => Date.now() );
        this.items = new Map();
        this.nextId = 1;
    }

    /*
     * info: { channel, channelName, title, file }. Returns the handle the
     * ffmpeg's fd 3 is fed into, and ended when the process closes.
     */
    start(info = {}) {
        const id = this.nextId++;
        const item = {
            id,
            channel: info.channel,
            channelName: info.channelName,
            title: info.title || '',
            file: info.file || null,
            drive: driveOf(info.file),
            startedAt: this.now(),
        };
        item.meter = new ItemPace(item.startedAt);
        item.parser = new ProgressParser( (block) => {
            // the last report comes when ffmpeg flushes, not in time with playback
            if (block.end) {
                return;
            }
            item.meter.add(this.now(), block.mediaS);
            this.emit('sample', { id, pace: item.meter.pace() });
        } );
        this.items.set(id, item);
        return {
            id,
            feed: (chunk) => item.parser.feed(chunk),
            end: () => this.items.delete(id),
        };
    }

    live() {
        return Array.from(this.items.values()).map( (it) => ({
            id: it.id,
            channel: it.channel,
            channelName: it.channelName,
            title: it.title,
            file: it.file,
            drive: it.drive,
            startedAt: it.startedAt,
            pace: it.meter.pace(),
        }) );
    }
}

// The whole PC's busy fraction since the previous call (0..1).
class CpuSampler {
    constructor(options = {}) {
        this.cpus = options.cpus || os.cpus;
        this.last = this.totals();
    }

    totals() {
        let idle = 0;
        let total = 0;
        for (const c of this.cpus()) {
            const t = c.times;
            idle += t.idle;
            total += t.user + t.nice + t.sys + t.idle + t.irq;
        }
        return { idle, total };
    }

    sample() {
        const now = this.totals();
        const dTotal = now.total - this.last.total;
        const dIdle = now.idle - this.last.idle;
        this.last = now;
        return (dTotal > 0) ? Math.max(0, Math.min(1, 1 - dIdle / dTotal)) : 0;
    }
}

const meter = new PaceMeter();

module.exports = {
    progressArgs, ProgressParser, ItemPace, PaceMeter, CpuSampler, driveOf, meter,
    constants: { PROGRESS_EVERY_S, PACE_WINDOW_MS, IGNORE_FIRST_MS, MIN_SPAN_MS },
};
