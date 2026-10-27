/*
 * Running ffmpeg, read-only, to find one file's break points
 * (docs/blocks-spec.md, Stage 6, "Detection"). break-detect.js decides what
 * the numbers mean; this module only runs ffmpeg and hands it the raw
 * intervals, in absolute file seconds.
 *
 * Two passes:
 *   1. silencedetect on the audio alone, in SILENCE_CHUNK_S pieces, so
 *      whatever calls scanSilence can check between pieces (the scanner
 *      service's live-stream back-off hooks in here, not in this module).
 *   2. blackdetect, only in the windows break-detect.windowsForSilences asks
 *      for, on the picture scaled down first.
 * Every ffmpeg process runs at idle priority (os.setPriority), one thread,
 * and is never asked to decode audio and video at once.
 */

const os = require('os');
const childProcess = require('child_process');
const breakDetect = require('./break-detect');

const SILENCE_CHUNK_S = 5 * 60;
const SILENCE_FILTER = 'silencedetect=n=-45dB:d=0.2';
const BLACK_FILTER = 'scale=w=192:h=-2:flags=fast_bilinear,blackdetect=d=0.05:pix_th=0.10:pic_th=0.95';

function defaultRunner(ffmpegPath, args) {
    return new Promise( (resolve) => {
        let child;
        try {
            child = childProcess.spawn(ffmpegPath, args, { windowsHide: true });
        } catch (err) {
            resolve( { code: 1, stderr: String(err.message) } );
            return;
        }
        try {
            os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
        } catch (err) {
            // not fatal: this run just goes at normal priority
        }
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (err) => resolve( { code: 1, stderr: String(err.message) } ));
        child.on('close', (code) => resolve( { code, stderr } ));
    } );
}

/*
 * options: { ffmpegPath, run, beforeChunk }
 * beforeChunk(), awaited before every chunk including the first, is where a
 * caller pauses or slows down for a live stream; it throws to stop the scan
 * partway (scanSilence returns what it found so far, via the thrown value's
 * `.partial`, or simply propagates for the caller to catch).
 */
async function scanSilence(file, durationS, options = {}) {
    const ffmpegPath = options.ffmpegPath || 'ffmpeg';
    const run = options.run || defaultRunner;
    const silence = [];
    for (let start = 0; start < durationS; start += SILENCE_CHUNK_S) {
        if (options.beforeChunk) {
            await options.beforeChunk();
        }
        const len = Math.min(SILENCE_CHUNK_S, durationS - start);
        const args = [
            '-hide_banner', '-nostats', '-threads', '1',
            '-ss', start.toFixed(3), '-i', file, '-t', len.toFixed(3),
            '-vn', '-map', '0:a:0', '-af', SILENCE_FILTER, '-f', 'null', '-',
        ];
        const { stderr } = await run(ffmpegPath, args);
        for (const [s, e] of breakDetect.parseSilence(stderr, len)) {
            silence.push([start + s, start + e]);
        }
    }
    return silence;
}

/*
 * windows: absolute [start, end] pairs, as from
 * breakDetect.windowsForSilences. Each is its own idle-priority ffmpeg run,
 * one at a time; beforeChunk works the same as scanSilence's.
 */
async function scanBlackWindows(file, windows, options = {}) {
    const ffmpegPath = options.ffmpegPath || 'ffmpeg';
    const run = options.run || defaultRunner;
    const black = [];
    for (const [ws, we] of windows) {
        if (options.beforeChunk) {
            await options.beforeChunk();
        }
        if (we <= ws) {
            continue;
        }
        const args = [
            '-hide_banner', '-nostats', '-threads', '1',
            '-ss', ws.toFixed(3), '-i', file, '-t', (we - ws).toFixed(3),
            '-an', '-vf', BLACK_FILTER, '-f', 'null', '-',
        ];
        const { stderr } = await run(ffmpegPath, args);
        for (const [s, e] of breakDetect.parseBlack(stderr)) {
            black.push([ws + s, ws + e]);
        }
    }
    return black;
}

/*
 * file: { path, durationS, title, chapters } - chapters as read elsewhere
 * (ffprobe or Plex's copy of them); this module does not read them itself.
 * Returns { points, timings: { silenceMs, blackMs, nSilenceGroups, nWindows } },
 * the shape breaks-store.js's recordFor expects for `points`.
 */
async function scanFile(file, options = {}) {
    const t0 = Date.now();
    const silence = await scanSilence(file.path, file.durationS, options);
    const t1 = Date.now();
    const groups = breakDetect.mergeSilences(breakDetect.significantSilences(silence));
    const windows = breakDetect.windowsForSilences(groups, { duration: file.durationS });
    const black = await scanBlackWindows(file.path, windows, options);
    const t2 = Date.now();
    const points = breakDetect.detectBreaks( {
        duration: file.durationS,
        title: file.title,
        silence,
        black,
        chapters: file.chapters || [],
    } );
    return {
        points,
        timings: {
            silenceMs: t1 - t0,
            blackMs: t2 - t1,
            nSilenceGroups: groups.length,
            nWindows: windows.length,
        },
    };
}

module.exports = {
    scanSilence, scanBlackWindows, scanFile,
    defaultRunner,
    constants: { SILENCE_CHUNK_S, SILENCE_FILTER, BLACK_FILTER },
};
