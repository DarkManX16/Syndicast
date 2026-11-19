/*
 * A copied part's cuts on keyframes (src/part-cuts.js; docs/blocks-spec.md, Stage 6, "A break
 * point"): the first keyframe inside the point's black, else the one before the point; the
 * part before a midroll stops there and the part after starts there. Then src/ffmpeg.js's
 * spawn, with child_process.spawn swapped for a recorder as test/ffmpeg-encoder-flags.js does:
 * a copied part's -ss and -t move to the keyframes, an encoded one's never do and nothing is
 * probed, nor for an audio-only stream, and a probe that finds nothing leaves the cut as asked.
 */
const cp = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { Suite } = require('./support');
const partCuts = require('../src/part-cuts');

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

const SETTINGS = {
    threads: 4, concatMuxDelay: '0', logFfmpeg: false, enableFFMPEGTranscoding: true, audioVolumePercent: 100,
    videoEncoder: 'mpeg2video', audioEncoder: 'aac', targetResolution: '1920x1080', videoBitrate: 5000, videoBufSize: 10000,
    audioBitrate: 192, audioBufSize: 384, audioSampleRate: 48, audioChannels: 2, errorScreen: 'testsrc', errorAudio: 'silent',
    normalizeVideoCodec: true, normalizeAudioCodec: true, normalizeResolution: true, normalizeAudio: true, maxFPS: 29.97,
    scalingAlgorithm: 'bicubic', deinterlaceFilter: 'none', disableChannelOverlay: true, ffmpegPath: 'ffmpeg',
};
const CHANNEL = { name: 'Part cuts test', number: 901, transcoding: { targetResolution: '' } };
// An MPEG-2 source at the channel's own size: mpeg2video copies it (test/ffmpeg-encoder-flags.js)
const MPEG2 = { videoWidth: 1920, videoHeight: 1080, anamorphic: false, pixelP: 1, pixelQ: 1, videoCodec: 'mpeg2video', videoFramerate: 29.97,
    videoScanType: 'progressive', audioCodec: 'aac', audioIndex: 1, duration: 620000 };

// Family Guy's two points: the first's black has a keyframe at 327.4; the second's black has none.
const IN = { at: 328, black: [ 326.8, 328.8 ] };
const OUT = { at: 948, black: [ 947.0, 949.0 ] };
const KEYS = { 328: [ 318.0, 321.5, 327.4, 330.1 ], 948: [ 940.0, 944.0, 950.2 ] };

function valueOf(args, flag) {
    const i = args.indexOf(flag);
    return (i === -1) ? null : args[i + 1];
}

async function argsFor( { settings = {}, stats = MPEG2, cuts = { cutIn: IN, cutOut: OUT }, start = 328, duration = 620, audioOnly = false, keys = KEYS } = {}) {
    recorded = null;
    const probed = [];
    FFMPEG.keyframesFor = async (path, input, point) => {
        probed.push(point.at);
        return keys[point.at] || [];
    };
    const ff = new FFMPEG(Object.assign( {}, SETTINGS, settings ), CHANNEL);
    ff.setAudioOnly(audioOnly);
    ff.setPartCuts(cuts);
    await ff.spawnStream('input.mkv', stats, start, duration, null, 'episode');
    return { args: recorded.args, probed };
}

module.exports = async function () {
    const s = new Suite('a copied part\'s cuts on keyframes');
    const realProbe = FFMPEG.keyframesFor;
    try {
        s.check('the first keyframe inside the black: 327.4', partCuts.keyframeAt(KEYS[328], IN) === 327.4);
        s.check('none inside the black: the last at or before the point, 944.0', partCuts.keyframeAt(KEYS[948], OUT) === 944.0);
        s.check('no black known: the last at or before the point', partCuts.keyframeAt( [ 320, 327.9, 328.0, 331 ], { at: 328, black: null } ) === 328.0);
        s.check('no keyframe at all: none', (partCuts.keyframeAt( [], IN ) === null) && (partCuts.keyframeAt( [ 340 ], { at: 328, black: null } ) === null));
        s.check('the window read: 10 s before the black to 1 s after it',
            JSON.stringify(partCuts.windowOf(IN)) === JSON.stringify( { fromS: 316.8, toS: 329.8 } ), JSON.stringify(partCuts.windowOf(IN)));

        const both = await partCuts.moveCuts( { startS: 328, durationS: 620, cuts: { cutIn: IN, cutOut: OUT } }, async (p) => KEYS[p.at] );
        s.check('part 2 copied: from 327.4 to 944.0 - its start on the black\'s keyframe, its end on the one before the next point',
            (both !== null) && (both.startS === 327.4) && (Math.abs(both.durationS - (944.0 - 327.4)) < 1e-9), JSON.stringify(both));
        const partway = await partCuts.moveCuts( { startS: 400, durationS: 548, cuts: { cutIn: IN, cutOut: OUT } }, async (p) => KEYS[p.at] );
        s.check('a tune-in partway through it: its start as asked, its end still on the keyframe',
            (partway !== null) && (partway.startS === 400) && (Math.abs(partway.durationS - 544) < 1e-9), JSON.stringify(partway));
        const last = await partCuts.moveCuts( { startS: 948, durationS: undefined, cuts: { cutIn: OUT, cutOut: null } }, async (p) => KEYS[p.at] );
        s.check('the last part copied: from 944.0, where the part before stopped, to the end of the file',
            (last !== null) && (last.startS === 944.0) && (last.durationS === undefined), JSON.stringify(last));
        const none = await partCuts.moveCuts( { startS: 328, durationS: 620, cuts: { cutIn: IN, cutOut: OUT } }, async () => [] );
        s.check('no keyframe found either side: nothing moves', none === null, JSON.stringify(none));

        {
            const { args, probed } = await argsFor();
            s.check('spawn, MPEG-2 copied: -c:v copy, -ss 327.4 and -t 616.6',
                (valueOf(args, '-c:v') === 'copy') && (valueOf(args, '-ss') === '327.4') && (Math.abs(Number(valueOf(args, '-t')) - 616.6) < 1e-6),
                `-ss ${valueOf(args, '-ss')} -t ${valueOf(args, '-t')} -c:v ${valueOf(args, '-c:v')}`);
            s.check('...both points probed', JSON.stringify(probed) === '[328,948]', JSON.stringify(probed));
        }
        {
            const { args, probed } = await argsFor( { settings: { videoEncoder: 'h264_nvenc' } } );
            s.check('spawn, H.264 encoder (every item encoded, as on 18000): -ss 328 and -t 620 as asked, nothing probed',
                (valueOf(args, '-ss') === '328') && (valueOf(args, '-t') === '620') && (probed.length === 0),
                `-ss ${valueOf(args, '-ss')} -t ${valueOf(args, '-t')} probed ${JSON.stringify(probed)}`);
        }
        {
            const { args, probed } = await argsFor( { audioOnly: true } );
            s.check('spawn, audio only: as asked, nothing probed', (valueOf(args, '-ss') === '328') && (valueOf(args, '-t') === '620') && (probed.length === 0));
        }
        {
            const { args } = await argsFor( { keys: {} } );
            s.check('spawn, copied but no keyframe found: as asked', (valueOf(args, '-ss') === '328') && (valueOf(args, '-t') === '620'),
                `-ss ${valueOf(args, '-ss')} -t ${valueOf(args, '-t')}`);
        }
        {
            const { args, probed } = await argsFor( { cuts: null } );
            s.check('spawn, not a part: as asked, nothing probed', (valueOf(args, '-ss') === '328') && (valueOf(args, '-t') === '620') && (probed.length === 0));
        }
    } finally {
        FFMPEG.keyframesFor = realProbe;
    }
    return s;
};

if (require.main === module) {
    module.exports().then( (suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    } );
}
