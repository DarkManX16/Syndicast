/*
 * The libx264 fallback for an item whose h264_nvenc ffmpeg dies before sending
 * any data (no GPU, a driver gone, an NVENC error nobody predicted). See "Fix
 * NVIDIA / h264_nvenc encoder issues" in NOTES.md for why it must be libx264,
 * never mpeg2video: /video joins items with `-c copy`, and an MPEG-2 item
 * between H.264 ones comes out as H.264 garbage.
 *
 * Drives the real src/ffmpeg.js with child_process.spawn swapped for a script
 * (as test/ffmpeg-encoder-flags.js does with a recorder). ffmpeg.js takes its
 * `spawn` when first required, so this file loads its own copy of the module
 * and removes it from the require cache again afterwards.
 */
const cp = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { Suite } = require('./support');

let spawns = [];          // every ffmpeg spawned: { cmd, args, child }
let scripts = [];         // what each successive spawn does
function fakeSpawn(cmd, args) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => finish(child, null, null)); };
    spawns.push({ cmd, args: args.map(String), child });
    const script = scripts.shift() || {};
    setImmediate(() => script.run && script.run(child));
    return child;
}
function finish(child, code, signal) {
    if (child.finished) return;
    child.finished = true;
    child.stdout.end();
    setImmediate(() => { child.emit('exit', code, signal); child.emit('close', code, signal); });
}
const FAIL_NO_DATA = { run: (c) => { c.stderr.write('[h264_nvenc @ 0x1] 10 bit encode not supported\nError while opening encoder\n'); finish(c, 3752568763, null); } };
const SUCCEED = { run: (c) => { c.stdout.write(Buffer.from('mpegts-bytes')); setImmediate(() => finish(c, 0, null)); } };
const FAIL_AFTER_DATA = { run: (c) => { c.stdout.write(Buffer.from('some-bytes')); setImmediate(() => finish(c, 3752568763, null)); } };
const HANG = { run: () => {} };

const modPath = require.resolve('../src/ffmpeg');
const cached = require.cache[modPath];
delete require.cache[modPath];
const realSpawn = cp.spawn;
cp.spawn = fakeSpawn;
const FFMPEG = require('../src/ffmpeg');
cp.spawn = realSpawn;
if (cached) { require.cache[modPath] = cached; } else { delete require.cache[modPath]; }

const SETTINGS = {
    threads: 10, concatMuxDelay: '0', logFfmpeg: false, enableFFMPEGTranscoding: true,
    audioVolumePercent: 100, videoEncoder: 'h264_nvenc', audioEncoder: 'aac',
    targetResolution: '1920x1080', videoBitrate: 5000, videoBufSize: 10000,
    audioBitrate: 192, audioBufSize: 384, audioSampleRate: 48, audioChannels: 2,
    errorScreen: 'testsrc', errorAudio: 'silent', normalizeVideoCodec: true,
    normalizeAudioCodec: true, normalizeResolution: true, normalizeAudio: true,
    maxFPS: 29.97, scalingAlgorithm: 'bicubic', deinterlaceFilter: 'none',
    disableChannelOverlay: true, ffmpegPath: 'ffmpeg',
};
const CHANNEL = { name: 'Fallback test', number: 900, transcoding: { targetResolution: '' } };
const SAMURAI = { videoWidth: 1440, videoHeight: 1080, anamorphic: false, pixelP: 1, pixelQ: 1, videoCodec: 'hevc', videoFramerate: 24, videoScanType: 'progressive', audioCodec: 'ac3', audioIndex: 1, duration: 30000 };

const valueOf = (args, flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
const tick = () => new Promise((r) => setTimeout(r, 25));

// Plays one item through `settings`' encoder with the next spawns scripted,
// and reports what reached the viewer and which events fired.
async function playItem(settingsOverrides, nextScripts, { kind = 'item', killAfterMs = null } = {}) {
    spawns = []; scripts = nextScripts.slice();
    const ff = new FFMPEG(Object.assign({}, SETTINGS, settingsOverrides), CHANNEL);
    ff.setAudioOnly(false);
    const events = [];
    for (const e of ['end', 'close', 'error']) ff.on(e, (x) => events.push(e + (x && x.code !== undefined ? ':' + x.code : '')));
    let stream;
    if (kind === 'item') stream = await ff.spawnStream('input.mkv', Object.assign({}, SAMURAI), 0, 30, null, 'episode');
    else if (kind === 'offline') stream = await ff.spawnOffline(420);
    else if (kind === 'concat') stream = await ff.spawnConcat('http://localhost:18000/playlist?channel=900');
    let received = '';
    let ended = false;
    stream.on('data', (c) => { received += c.toString(); });
    stream.on('end', () => { ended = true; });
    if (killAfterMs !== null) { await new Promise((r) => setTimeout(r, killAfterMs)); ff.kill(); }
    await tick(); await tick(); await tick();
    return { spawns, events, received, ended, stream };
}

module.exports = async function () {
    const s = new Suite('ffmpeg-nvenc-fallback');
    const NV = 'h264_nvenc';

    // ---- the swapped command
    {
        FFMPEG.nvencFailure.reset();
        const { spawns: sp } = await playItem({}, [SUCCEED]);
        const first = sp[0].args;
        const fb = FFMPEG.libx264FallbackArgs(first);
        s.check('fallback command: -c:v is libx264, never nvenc and never mpeg2video', valueOf(fb, '-c:v') === 'libx264' && !fb.includes('h264_nvenc') && !fb.includes('mpeg2video'), fb.join(' '));
        s.check('fallback command: -preset superfast (measured: holds realtime for 3 streams of a 10-bit episode)', valueOf(fb, '-preset') === 'superfast', `-preset ${valueOf(fb, '-preset')}`);
        s.check('fallback command: nvenc\'s -b:v is gone; -crf 22 and -maxrate/-bufsize are what a libx264 channel gets', !fb.includes('-b:v') && valueOf(fb, '-crf') === '22' && valueOf(fb, '-maxrate:v') === '5000k' && valueOf(fb, '-bufsize:v') === '10000k', fb.join(' '));
        s.check('fallback command: no -sc_threshold (x264\'s scenecut, which cost it every B-frame)', !fb.includes('-sc_threshold'), fb.join(' '));
        s.check('fallback command: still 8-bit 4:2:0, and the same filters, maps, audio and output as the nvenc one', valueOf(fb, '-pix_fmt') === 'yuv420p' && valueOf(fb, '-filter_complex') === valueOf(first, '-filter_complex') && valueOf(fb, '-c:a') === valueOf(first, '-c:a') && fb[fb.length - 1] === 'pipe:1', fb.join(' '));
        s.check('fallback command: -profile:v main, the profile the nvenc items come out as (so a mid-session switch keeps the profile)', valueOf(fb, '-profile:v') === 'main', fb.join(' '));
        const drop = (a) => a.filter((x, i) => !(['-c:v', '-b:v', '-preset', '-crf', '-profile:v'].includes(a[i - 1]) || ['-b:v', '-preset', '-crf', '-c:v', '-profile:v'].includes(x)));
        s.check('fallback command: nothing else differs from the nvenc command', JSON.stringify(drop(first)) === JSON.stringify(drop(fb)), `${drop(first).join(' ')}\n${drop(fb).join(' ')}`);
    }

    // ---- NVENC fails before any data: this item is retried with libx264
    {
        FFMPEG.nvencFailure.reset();
        const r = await playItem({}, [FAIL_NO_DATA, SUCCEED]);
        s.check('nvenc dies with no data: the item is spawned again, once', r.spawns.length === 2, `${r.spawns.length} spawns`);
        s.check('  the retry is libx264 (not mpeg2video), the first was nvenc', valueOf(r.spawns[0].args, '-c:v') === NV && valueOf(r.spawns[1].args, '-c:v') === 'libx264', r.spawns.map((x) => valueOf(x.args, '-c:v')).join(' -> '));
        s.check('  the viewer gets the retry\'s bytes, and the stream ends after them', r.received === 'mpegts-bytes' && r.ended, `received "${r.received}" ended ${r.ended}`);
        s.check('  the failed attempt is never reported: one "end", no "error"', r.events.filter((e) => e === 'end').length === 1 && !r.events.some((e) => e.startsWith('error')), r.events.join(','));
    }
    // ---- and the rescue is remembered, so the next item skips the failing attempt
    {
        const r = await playItem({}, [SUCCEED]);
        s.check('after a rescue: the next item goes straight to libx264, one spawn', r.spawns.length === 1 && valueOf(r.spawns[0].args, '-c:v') === 'libx264', r.spawns.map((x) => valueOf(x.args, '-c:v')).join(' -> '));
        s.check('  (and nothing is reported as an error)', !r.events.some((e) => e.startsWith('error')), r.events.join(','));
        FFMPEG.nvencFailure.expireNow();
        const r2 = await playItem({}, [SUCCEED]);
        s.check('once the 5 minutes are up: nvenc is tried again first', r2.spawns.length === 1 && valueOf(r2.spawns[0].args, '-c:v') === NV, r2.spawns.map((x) => valueOf(x.args, '-c:v')).join(' -> '));
        s.check('the window is 5 minutes', FFMPEG.NVENC_RETRY_AFTER_MS === 5 * 60 * 1000, String(FFMPEG.NVENC_RETRY_AFTER_MS));
    }
    // ---- screens use the same encoder, so they fall back too
    {
        FFMPEG.nvencFailure.reset();
        const r = await playItem({}, [FAIL_NO_DATA, SUCCEED], { kind: 'offline' });
        s.check('an offline screen falls back to libx264 as well', r.spawns.length === 2 && valueOf(r.spawns[1].args, '-c:v') === 'libx264' && r.received === 'mpegts-bytes' && !r.events.some((e) => e.startsWith('error')), r.spawns.map((x) => valueOf(x.args, '-c:v')).join(' -> ') + ' | ' + r.events.join(','));
    }
    // ---- what must NOT be retried
    {
        FFMPEG.nvencFailure.reset();
        const r = await playItem({}, [FAIL_NO_DATA, FAIL_NO_DATA]);
        s.check('if libx264 fails too: exactly one retry, then the error goes up (the error screen takes over)', r.spawns.length === 2 && r.events.filter((e) => e.startsWith('error')).length === 1 && r.ended, r.spawns.length + ' spawns | ' + r.events.join(','));
        const r2 = await playItem({}, [SUCCEED]);
        s.check('  and a failed rescue does not start the 5-minute window (nvenc is still tried first)', valueOf(r2.spawns[0].args, '-c:v') === NV, valueOf(r2.spawns[0].args, '-c:v'));
    }
    {
        FFMPEG.nvencFailure.reset();
        const r = await playItem({}, [FAIL_AFTER_DATA, SUCCEED]);
        s.check('nvenc dying AFTER sending data is not retried (it would repeat what was sent)', r.spawns.length === 1 && r.received === 'some-bytes' && r.events.some((e) => e.startsWith('error')), r.spawns.length + ' spawns | ' + r.events.join(','));
    }
    {
        FFMPEG.nvencFailure.reset();
        const r = await playItem({}, [HANG, SUCCEED], { killAfterMs: 20 });
        s.check('killed while the first attempt runs: no retry is started', r.spawns.length === 1 && !r.events.some((e) => e.startsWith('error')), r.spawns.length + ' spawns | ' + r.events.join(','));
    }
    for (const encoder of ['libx264', 'mpeg2video']) {
        FFMPEG.nvencFailure.reset();
        const r = await playItem({ videoEncoder: encoder }, [FAIL_NO_DATA, SUCCEED]);
        s.check(`${encoder} channel: a failure is NOT retried and reports an error, as before`, r.spawns.length === 1 && r.events.some((e) => e.startsWith('error')), r.spawns.length + ' spawns | ' + r.events.join(','));
    }
    {
        FFMPEG.nvencFailure.reset();
        const r = await playItem({}, [FAIL_NO_DATA, SUCCEED], { kind: 'concat' });
        s.check('the concat process (-c copy) is never retried', r.spawns.length === 1 && valueOf(r.spawns[0].args, '-c') === 'copy' && r.events.some((e) => e.startsWith('error')), r.spawns.length + ' spawns | ' + r.events.join(','));
    }
    {
        // A channel whose encoder is mpeg2video, or libx264, must keep getting the child's own stdout, not a wrapper:
        // the saved channels' behaviour stays exactly as it was.
        for (const encoder of ['libx264', 'mpeg2video']) {
            FFMPEG.nvencFailure.reset();
            const r = await playItem({ videoEncoder: encoder }, [SUCCEED]);
            s.check(`${encoder} channel: the stream handed back is the ffmpeg's own stdout (no wrapper)`, r.stream === r.spawns[0].child.stdout);
        }
    }
    FFMPEG.nvencFailure.reset();

    return s;
};

if (require.main === module) {
    module.exports().then((suite) => {
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
