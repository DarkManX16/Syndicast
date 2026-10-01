/*
 * The video encoder flags spawn() adds per encoder. mpeg2video gets -b:v and
 * no longer -qscale:v 1, which made every item 4-8x the CPU work for no better
 * quality (worse at the worst frames) - see "Heavy buffering during playback"
 * in NOTES.md.
 *
 * Drives the real src/ffmpeg.js with child_process.spawn swapped for a
 * recorder, as test/aspect-mark.js does. ffmpeg.js takes its `spawn` when it
 * is first required, so this file loads its own copy of the module and
 * removes it from the require cache again afterwards: whichever of the two
 * files runs first, each keeps the recorder it installed.
 */
const cp = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { Suite } = require('./support');

let recorded = null;
function recorder(cmd, args) {
    recorded = { cmd, args: args.map(String) };
    const e = new EventEmitter();
    e.stdout = new PassThrough();
    e.kill = () => {};
    return e;
}

const modPath = require.resolve('../src/ffmpeg');
const cached = require.cache[modPath];
delete require.cache[modPath];
const realSpawn = cp.spawn;
cp.spawn = recorder;
const FFMPEG = require('../src/ffmpeg');
cp.spawn = realSpawn;
if (cached) {
    require.cache[modPath] = cached;
} else {
    delete require.cache[modPath];
}

// Shaped like .dizquetv-dev/ffmpeg-settings.json, the dev install's settings.
const SETTINGS = {
    threads: 10,
    concatMuxDelay: '0',
    logFfmpeg: false,
    enableFFMPEGTranscoding: true,
    audioVolumePercent: 100,
    videoEncoder: 'mpeg2video',
    audioEncoder: 'aac',
    targetResolution: '1920x1080',
    videoBitrate: 5000,
    videoBufSize: 10000,
    audioBitrate: 192,
    audioBufSize: 384,
    audioSampleRate: 48,
    audioChannels: 2,
    errorScreen: 'testsrc',
    errorAudio: 'silent',
    normalizeVideoCodec: true,
    normalizeAudioCodec: true,
    normalizeResolution: true,
    normalizeAudio: true,
    maxFPS: 29.97,
    scalingAlgorithm: 'bicubic',
    deinterlaceFilter: 'none',
    disableChannelOverlay: true,
    ffmpegPath: 'ffmpeg',
};

const CHANNEL = { name: 'Encoder flags test', number: 900, transcoding: { targetResolution: '' } };

// Cowboy Bebop S01E09's shape, the item the buffering measurements used.
const BEBOP = { videoWidth: 1920, videoHeight: 1080, anamorphic: false, pixelP: 1, pixelQ: 1, videoCodec: 'hevc', videoFramerate: 23.976, videoScanType: 'progressive', audioCodec: 'aac', audioIndex: 1 };

async function itemArgs(settingsOverrides) {
    recorded = null;
    const ff = new FFMPEG(Object.assign({}, SETTINGS, settingsOverrides), CHANNEL);
    ff.setAudioOnly(false);
    await ff.spawnStream('input.mkv', Object.assign({}, BEBOP, { duration: 30000 }), 0, 30, null, 'episode');
    return recorded.args;
}

async function offlineArgs(settingsOverrides) {
    recorded = null;
    const ff = new FFMPEG(Object.assign({}, SETTINGS, settingsOverrides), CHANNEL);
    ff.setAudioOnly(false);
    await ff.spawnOffline(420);
    return recorded.args;
}

function valueOf(args, flag) {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
}

module.exports = async function () {
    const s = new Suite('ffmpeg-encoder-flags');

    {
        const args = await itemArgs({});
        s.check('mpeg2video item: no -qscale:v', !args.includes('-qscale:v'), args.join(' '));
        s.check('mpeg2video item: -b:v is the channel bitrate', valueOf(args, '-b:v') === '5000k', `-b:v ${valueOf(args, '-b:v')}`);
        s.check('mpeg2video item: -maxrate:v and -bufsize:v unchanged', valueOf(args, '-maxrate:v') === '5000k' && valueOf(args, '-bufsize:v') === '10000k');
    }
    {
        const args = await offlineArgs({});
        s.check('mpeg2video offline screen: no -qscale:v, still -b:v', !args.includes('-qscale:v') && valueOf(args, '-b:v') === '5000k', args.join(' '));
    }
    {
        const args = await itemArgs({ videoEncoder: 'libx264' });
        s.check('libx264 item: neither -qscale:v nor -b:v (mpeg2-only branch)', !args.includes('-qscale:v') && !args.includes('-b:v'), args.join(' '));
    }

    // Every H.264 encoder is handed 8-bit 4:2:0. h264_nvenc refuses 10-bit
    // outright (Ampere can't encode it), and libx264 would write High 10, which
    // most TV-box decoders can't play. mpeg2video only takes 8-bit, so ffmpeg
    // has always converted for it and its commands must stay exactly as they were.
    for (const encoder of ['h264_nvenc', 'libx264']) {
        const item = await itemArgs({ videoEncoder: encoder });
        s.check(`${encoder} item: -pix_fmt yuv420p, exactly once`, valueOf(item, '-pix_fmt') === 'yuv420p' && item.filter((a) => a === '-pix_fmt').length === 1, item.join(' '));
        const offline = await offlineArgs({ videoEncoder: encoder });
        s.check(`${encoder} offline screen: -pix_fmt yuv420p, exactly once`, valueOf(offline, '-pix_fmt') === 'yuv420p' && offline.filter((a) => a === '-pix_fmt').length === 1, offline.join(' '));
    }
    {
        const args = await itemArgs({});
        s.check('mpeg2video item: no -pix_fmt added', !args.includes('-pix_fmt'), args.join(' '));
    }
    // Under an H.264 encoder every source is encoded, never copied. A copied
    // 1080p H.264 item carries its own profile, level and reference frames
    // (High@4.0 or High@5.1 against the encoder's Main@4.0), so a stream mixing
    // copied and encoded items makes a TV box's decoder reconfigure at each
    // join, and a copied 10-bit file would pass straight through. mpeg2video
    // keeps copying what is already MPEG-2, as it always has.
    const COPYABLE = Object.assign({}, BEBOP, { videoCodec: 'h264', videoFramerate: 24, duration: 30000 });
    async function copyableArgs(encoder, stats) {
        recorded = null;
        const ff = new FFMPEG(Object.assign({}, SETTINGS, { videoEncoder: encoder }), CHANNEL);
        ff.setAudioOnly(false);
        await ff.spawnStream('input.mkv', stats, 0, 30, null, 'episode');
        return recorded.args;
    }
    for (const encoder of ['h264_nvenc', 'libx264']) {
        const args = await copyableArgs(encoder, COPYABLE);
        s.check(`${encoder}: a 1080p 24fps H.264 source is encoded, not copied`, valueOf(args, '-c:v') === encoder && valueOf(args, '-pix_fmt') === 'yuv420p', args.join(' '));
    }
    {
        const args = await copyableArgs('mpeg2video', Object.assign({}, COPYABLE, { videoCodec: 'mpeg2video' }));
        s.check('mpeg2video: an MPEG-2 source is still copied', valueOf(args, '-c:v') === 'copy', args.join(' '));
    }
    {
        const args = await copyableArgs('h264_nvenc', COPYABLE);
        const off = await (async () => {
            recorded = null;
            const ff = new FFMPEG(Object.assign({}, SETTINGS, { videoEncoder: 'h264_nvenc', normalizeVideoCodec: false }), CHANNEL);
            ff.setAudioOnly(false);
            await ff.spawnStream('input.mkv', COPYABLE, 0, 30, null, 'episode');
            return recorded.args;
        })();
        s.check('h264_nvenc with "normalize video codec" off: still copied (the setting is respected)', valueOf(off, '-c:v') === 'copy' && valueOf(args, '-c:v') === 'h264_nvenc', off.join(' '));
    }

    // h264_nvenc targets its own 2000 kb/s default unless it is given -b:v, so
    // it takes the channel's bitrate as mpeg2video does. It ignores -crf and
    // -sc_threshold (ffmpeg logs both as "not used for any stream"), so it no
    // longer gets them. libx264 and mpeg2video keep both.
    for (const [label, args] of [['item', await itemArgs({ videoEncoder: 'h264_nvenc' })], ['offline screen', await offlineArgs({ videoEncoder: 'h264_nvenc' })]]) {
        s.check(`h264_nvenc ${label}: -b:v is the channel bitrate`, valueOf(args, '-b:v') === '5000k', `-b:v ${valueOf(args, '-b:v')}`);
        s.check(`h264_nvenc ${label}: -maxrate:v and -bufsize:v kept`, valueOf(args, '-maxrate:v') === '5000k' && valueOf(args, '-bufsize:v') === '10000k');
        s.check(`h264_nvenc ${label}: no -crf, no -sc_threshold`, !args.includes('-crf') && !args.includes('-sc_threshold'), args.join(' '));
    }
    {
        const args = await itemArgs({ videoEncoder: 'h264_nvenc', videoBitrate: 3500 });
        s.check('h264_nvenc item: -b:v follows the setting (3500)', valueOf(args, '-b:v') === '3500k', `-b:v ${valueOf(args, '-b:v')}`);
    }
    for (const encoder of ['mpeg2video', 'libx264']) {
        const args = await itemArgs({ videoEncoder: encoder });
        s.check(`${encoder} item: still has -crf 22 and -sc_threshold`, valueOf(args, '-crf') === '22' && valueOf(args, '-sc_threshold') === '1000000000', args.join(' '));
    }

    return s;
};

if (require.main === module) {
    module.exports().then((suite) => {
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
