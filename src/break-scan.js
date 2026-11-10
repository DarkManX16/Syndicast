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
 * and is never asked to decode audio and video at once. The scanner service
 * also lowers its disk priority to Very Low (io-priority.js) through the
 * runner's onSpawn.
 */

const os = require('os');
const childProcess = require('child_process');
const breakDetect = require('./break-detect');

const SILENCE_CHUNK_S = 5 * 60;
const SILENCE_FILTER = 'silencedetect=n=-45dB:d=0.2';
const BLACK_FILTER = 'scale=w=192:h=-2:flags=fast_bilinear,blackdetect=d=0.05:pix_th=0.10:pic_th=0.95';

/*
 * options.signal: an AbortSignal that stops the ffmpeg at once; the result is
 * then { aborted: true }. options.onSpawn(pid), if given, is called as soon as
 * the process exists (the scanner lowers its disk priority there).
 */
function defaultRunner(ffmpegPath, args, options = {}) {
    return new Promise( (resolve) => {
        const signal = options.signal;
        if (signal && signal.aborted) {
            resolve( { code: null, stderr: '', aborted: true } );
            return;
        }
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
        if ( (typeof(options.onSpawn) === 'function') && (child.pid != null) ) {
            try {
                Promise.resolve(options.onSpawn(child.pid)).catch( () => {} );
            } catch (err) {
                // not fatal either: this run keeps its normal disk priority
            }
        }
        let aborted = false;
        const onAbort = () => {
            aborted = true;
            child.kill('SIGKILL');
        };
        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
        }
        let stderr = '';
        let stdout = '';
        child.stderr.on('data', (d) => { stderr += d; });
        child.stdout.on('data', (d) => { stdout += d; });
        const done = (result) => {
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
            resolve(aborted ? { code: null, stderr, stdout, aborted: true } : result);
        };
        child.on('error', (err) => done( { code: 1, stderr: String(err.message), stdout } ));
        child.on('close', (code) => done( { code, stderr, stdout } ));
    } );
}

/*
 * One piece: beforeChunk() first (where a caller pauses or slows down for a
 * live stream, or throws to stop the scan), then the ffmpeg. A piece whose
 * ffmpeg was stopped (`aborted`, a pause) is run again from its start once
 * beforeChunk lets it; one that failed outright fails the scan.
 */
async function runPiece(ffmpegPath, args, options) {
    const run = options.run || defaultRunner;
    for (;;) {
        if (options.beforeChunk) {
            await options.beforeChunk();
        }
        const result = await run(ffmpegPath, args);
        if (result && result.aborted) {
            continue;
        }
        if (result && (typeof(result.code) === 'number') && (result.code !== 0)) {
            const last = String(result.stderr || '').trim().split(/\r?\n/).slice(-2).join(' | ');
            throw new Error(`ffmpeg exited with code ${result.code}: ${last}`);
        }
        return result;
    }
}

/*
 * options: { ffmpegPath, run, beforeChunk } - see runPiece.
 */
async function scanSilence(file, durationS, options = {}) {
    const ffmpegPath = options.ffmpegPath || 'ffmpeg';
    const silence = [];
    for (let start = 0; start < durationS; start += SILENCE_CHUNK_S) {
        const len = Math.min(SILENCE_CHUNK_S, durationS - start);
        const args = [
            '-hide_banner', '-nostats', '-threads', '1',
            '-ss', start.toFixed(3), '-i', file, '-t', len.toFixed(3),
            '-vn', '-map', '0:a:0', '-af', SILENCE_FILTER, '-f', 'null', '-',
        ];
        const { stderr } = await runPiece(ffmpegPath, args, options);
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
    const black = [];
    for (const [ws, we] of windows) {
        if (we <= ws) {
            continue;
        }
        const args = [
            '-hide_banner', '-nostats', '-threads', '1',
            '-ss', ws.toFixed(3), '-i', file, '-t', (we - ws).toFixed(3),
            '-an', '-vf', BLACK_FILTER, '-f', 'null', '-',
        ];
        const { stderr } = await runPiece(ffmpegPath, args, options);
        for (const [s, e] of breakDetect.parseBlack(stderr)) {
            black.push([ws + s, ws + e]);
        }
    }
    return black;
}

/*
 * file: { path, durationS, title, chapters, hasAudio? } - chapters as read
 * elsewhere (ffprobe or Plex's copy of them); this module does not read them
 * itself. hasAudio false (ffprobe found no audio stream) skips the silence
 * pass, which would fail on the missing stream; with no silences there are no
 * black windows either, so only the chapters can offer a point.
 * Returns { points, timings: { silenceMs, blackMs, nSilenceGroups, nWindows } },
 * plus noAudio: true for such a file; the shape breaks-store.js's recordFor
 * expects.
 */
async function scanFile(file, options = {}) {
    const t0 = Date.now();
    const noAudio = (file.hasAudio === false);
    const silence = noAudio ? [] : await scanSilence(file.path, file.durationS, options);
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
    const result = {
        points,
        timings: {
            silenceMs: t1 - t0,
            blackMs: t2 - t1,
            nSilenceGroups: groups.length,
            nWindows: windows.length,
        },
    };
    if (noAudio) {
        result.noAudio = true;
    }
    return result;
}

module.exports = {
    scanSilence, scanBlackWindows, scanFile,
    defaultRunner, runPiece,
    constants: { SILENCE_CHUNK_S, SILENCE_FILTER, BLACK_FILTER },
};
