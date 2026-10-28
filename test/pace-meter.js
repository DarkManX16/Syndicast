/*
 * The pace meter (src/pace-meter.js): each item ffmpeg's progress on fd 3,
 * turned into media time over wall time across the last 10 s, ignoring the
 * item's first 3 s (docs/blocks-spec.md, Stage 6, "The scanner, and live
 * streams"). The ffmpeg.js part drives the real src/ffmpeg.js with
 * child_process.spawn swapped for a recorder, as test/ffmpeg-encoder-flags.js
 * does, and puts the module cache back the way it found it.
 */
const cp = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { Suite } = require('./support');
const paceMeter = require('../src/pace-meter');

let recorded = null;
let lastChild = null;
function recorder(cmd, args, options) {
    recorded = { cmd, args: args.map(String), stdio: (options && options.stdio) || [] };
    const e = new EventEmitter();
    e.stdout = new PassThrough();
    e.stdio = [ null, e.stdout, null ];
    if (recorded.stdio.length > 3) {
        e.stdio[3] = new PassThrough();
    }
    e.kill = () => {};
    lastChild = e;
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
    threads: 10, concatMuxDelay: '0', logFfmpeg: false, enableFFMPEGTranscoding: true,
    audioVolumePercent: 100, videoEncoder: 'mpeg2video', audioEncoder: 'aac',
    targetResolution: '1920x1080', videoBitrate: 5000, videoBufSize: 10000, audioBitrate: 192,
    audioBufSize: 384, audioSampleRate: 48, audioChannels: 2, errorScreen: 'testsrc',
    errorAudio: 'silent', normalizeVideoCodec: true, normalizeAudioCodec: true,
    normalizeResolution: true, normalizeAudio: true, maxFPS: 29.97, scalingAlgorithm: 'bicubic',
    deinterlaceFilter: 'none', disableChannelOverlay: true, ffmpegPath: 'ffmpeg',
};
const CHANNEL = { name: 'Pace test', number: 902, transcoding: { targetResolution: '' } };
const STATS = { videoWidth: 1920, videoHeight: 1080, anamorphic: false, pixelP: 1, pixelQ: 1, videoCodec: 'hevc', videoFramerate: 23.976, videoScanType: 'progressive', audioCodec: 'aac', audioIndex: 1, duration: 30000 };

function block(outS, end) {
    return `frame=1\nout_time_us=${Math.round(outS * 1e6)}\nout_time=x\nspeed=1x\nprogress=${end ? 'end' : 'continue'}\n`;
}

module.exports = async () => {
    const suite = new Suite('pace meter');

    // -- reading ffmpeg's progress --
    const blocks = [];
    const parser = new paceMeter.ProgressParser( (b) => blocks.push(b) );
    const text = block(2.0) + 'out_time_us=N/A\nprogress=continue\n' + block(4.5, true);
    parser.feed(text.slice(0, 17));
    parser.feed(text.slice(17, 50));
    parser.feed(text.slice(50));
    suite.check('blocks are read whole, however the pipe splits them',
        (blocks.length === 3) && (blocks[0].mediaS === 2) && (blocks[2].mediaS === 4.5) && (blocks[2].end === true));
    suite.check('an out_time ffmpeg cannot give yet (N/A) is no time, not zero',
        blocks[1].mediaS === null);

    // -- pace --
    const healthy = new paceMeter.ItemPace(0);
    for (let t = 0; t <= 20000; t += 2000) {
        healthy.add(t, t / 1000 + 0.5);    // the initial burst puts it half a second ahead
    }
    suite.check('a healthy item under -re reads 1.00',
        Math.abs(healthy.pace() - 1) < 1e-9, healthy.pace());

    const early = new paceMeter.ItemPace(0);
    early.add(0, 0.9);
    early.add(2000, 2.6);
    early.add(4000, 4.5);
    suite.check('nothing from the first 3 s, and no reading until 4 s apart',
        (early.samples.length === 1) && (early.pace() === null));

    const slowing = new paceMeter.ItemPace(0);
    let media = 0;
    for (let t = 2000; t <= 40000; t += 2000) {
        media += (t <= 24000) ? 2 : 1.9;   // 0.95x from 24 s on
        slowing.add(t, media);
    }
    suite.check('only the last 10 s count: an item that slowed to 0.95 reads 0.95',
        Math.abs(slowing.pace() - 0.95) < 1e-9, slowing.pace());
    suite.check('...from a window of about 10 s',
        (slowing.samples[slowing.samples.length - 1].wallMs - slowing.samples[0].wallMs) === 10000);

    // -- drives --
    suite.check('drive letters, the long-path prefix, shares and POSIX paths',
        (paceMeter.driveOf('G:\\Shows\\a.mkv') === 'G:')
        && (paceMeter.driveOf('\\\\?\\f:\\1.Nick\\b.mkv') === 'F:')
        && (paceMeter.driveOf('\\\\NAS\\Media\\TV\\c.mkv') === '\\\\nas\\media')
        && (paceMeter.driveOf('\\\\?\\UNC\\NAS\\Media\\d.mkv') === '\\\\nas\\media')
        && (paceMeter.driveOf('/mnt/tv/e.mkv') === '/mnt/tv')
        && (paceMeter.driveOf(undefined) === null));

    // -- the registry --
    let clock = 0;
    const meter = new paceMeter.PaceMeter( { now: () => clock } );
    const handle = meter.start( { channel: 2, title: 'The Jeffersons', file: 'F:\\x.mkv' } );
    for (clock = 0; clock <= 16000; clock += 2000) {
        handle.feed(block(clock / 1000));
    }
    let live = meter.live();
    suite.check('a live item shows its channel, title, drive and pace',
        (live.length === 1) && (live[0].channel === 2) && (live[0].drive === 'F:') && (Math.abs(live[0].pace - 1) < 1e-9));
    handle.end();
    suite.check('...and is gone when its ffmpeg closes',
        meter.live().length === 0);

    // -- the whole PC's CPU --
    let times = [ { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 }, { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 } ];
    const cpu = new paceMeter.CpuSampler( { cpus: () => times.map( (t) => ({ times: t }) ) } );
    times = [ { user: 160, nice: 0, sys: 20, idle: 920, irq: 0 }, { user: 160, nice: 0, sys: 20, idle: 920, irq: 0 } ];
    suite.check('CPU is busy time over all time since the last sample, across every core',
        Math.abs(cpu.sample() - 0.8) < 1e-9);

    // -- the real ffmpeg.js --
    const realMeter = FFMPEG.meter;
    const testMeter = new paceMeter.PaceMeter();
    FFMPEG.meter = testMeter;
    try {
        const ff = new FFMPEG(Object.assign({}, SETTINGS), CHANNEL);
        ff.setMeterInfo( { title: 'Family Guy - Death Is a Bitch', file: '\\\\?\\G:\\FG\\s02e06.mkv' } );
        await ff.spawnStream('input.mkv', Object.assign({}, STATS), 0, 30, null, 'episode');
        suite.check('an item ffmpeg reports progress on fd 3 every 2 s',
            (recorded.args.slice(0, 4).join(' ') === '-progress pipe:3 -stats_period 2') && (recorded.stdio.length === 4) && (recorded.stdio[3] === 'pipe'));
        suite.check('...and still sends its stream on stdout, to pipe:1',
            (recorded.stdio[1] === 'pipe') && (recorded.args[recorded.args.length - 1] === 'pipe:1'));
        const child = lastChild;
        child.stdio[3].write(block(1));
        await new Promise( (r) => setImmediate(r) );
        const shown = testMeter.live();
        suite.check('the item appears in the meter with its channel, title and drive',
            (shown.length === 1) && (shown[0].channel === 902) && (shown[0].title === 'Family Guy - Death Is a Bitch') && (shown[0].drive === 'G:'));
        child.emit('close', 0);
        suite.check('...and leaves it when the process closes',
            testMeter.live().length === 0);

        const screen = new FFMPEG(Object.assign({}, SETTINGS), CHANNEL);
        await screen.spawnOffline(30000);
        suite.check('screens are items too, and are metered',
            recorded.args[0] === '-progress');

        const concat = new FFMPEG(Object.assign({}, SETTINGS), CHANNEL);
        await concat.spawnConcat('http://localhost/playlist');
        suite.check('the concat ffmpeg is not metered: no progress, three stdio entries',
            ! recorded.args.includes('-progress') && (recorded.stdio.length === 3));

        FFMPEG.meter = null;
        const off = new FFMPEG(Object.assign({}, SETTINGS), CHANNEL);
        await off.spawnStream('input.mkv', Object.assign({}, STATS), 0, 30, null, 'episode');
        const withMeter = new FFMPEG(Object.assign({}, SETTINGS), CHANNEL);
        const offArgs = recorded.args;
        FFMPEG.meter = testMeter;
        await withMeter.spawnStream('input.mkv', Object.assign({}, STATS), 0, 30, null, 'episode');
        suite.check('with no meter the item runs exactly as before; with it, only the four progress arguments differ',
            (offArgs[0] === '-threads') && (recorded.args.slice(4).join('\n') === offArgs.join('\n')));
        lastChild.emit('close', 0);
    } finally {
        FFMPEG.meter = realMeter;
    }

    return suite;
};
