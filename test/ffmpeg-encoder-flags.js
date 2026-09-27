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

    return s;
};

if (require.main === module) {
    module.exports().then((suite) => {
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
