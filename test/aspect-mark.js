/*
 * "Let the viewer's player decide" (docs/blocks-spec.md's Media handling
 * roadmap line in NOTES.md, and its "Build plan" section). channel.transcoding
 * .aspect = 'mark' scales a source narrower than the channel to fill the full
 * frame and marks it with a sample aspect ratio, instead of padding it with
 * black bars, so a player that reads the marking can add its own bars or let
 * the viewer stretch.
 *
 * Drives the real src/ffmpeg.js, unmodified - not a transcription of its
 * filter-building logic, which is exactly the class of thing NOTES.md's
 * "enumerate every writer" lesson warns is easy to get subtly wrong by hand.
 * child_process.spawn is swapped for a recorder before ffmpeg.js is required,
 * the same technique the aaspect-mark investigation's scratch test-stream
 * builder used to make the real player test streams. No other test file in
 * this directory requires ../src/ffmpeg, so this is the only place that
 * module enters the process's module cache; the swap is undone afterwards
 * regardless, since dst-fall-back.js (later in test/run.js's list) also
 * touches child_process.
 *
 * Every shape checked here was first confirmed against the real ffmpeg 7.1
 * building the real player test streams (see NOTES.md's roadmap entry): the
 * SAR 3:4 for a 1440x1080 4:3 source and for a 720x576 anamorphic (16:15) one
 * that also reduces to 4:3, and the item-by-item shape switch in the joined
 * stream.
 */
const cp = require('child_process');

let recorded = null;
const realSpawn = cp.spawn;
cp.spawn = (cmd, args) => {
    recorded = { cmd, args: args.map(String) };
    const { EventEmitter } = require('events');
    const { PassThrough } = require('stream');
    const e = new EventEmitter();
    e.stdout = new PassThrough();
    e.kill = () => {};
    return e;
};

const FFMPEG = require('../src/ffmpeg');
const { Suite } = require('./support');

cp.spawn = realSpawn;   // restore immediately; the recorder above is only
                        // needed while FFMPEG's constructor-time `require`
                        // resolves - the actual per-call swap happens below.

// Settings shaped like the real .dizquetv-dev/ffmpeg-settings.json (the file
// the aspect-mark investigation ran the player test streams against), so
// these checks exercise the same code paths a real install does.
const BASE_SETTINGS = {
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

const BASE_CHANNEL = { name: 'Aspect test', number: 900, transcoding: { targetResolution: '' } };

// Real files' probed shapes (see NOTES.md's roadmap entry) - not synthetic
// numbers, so the SAR this produces is one that was also rendered and
// ffprobed for real.
const BATMAN = { videoWidth: 1440, videoHeight: 1080, anamorphic: false, pixelP: 1, pixelQ: 1, videoCodec: 'h264', videoFramerate: 24, videoScanType: 'progressive', audioCodec: 'ac3', audioIndex: 1 };
const COW    = { videoWidth: 720, videoHeight: 576, anamorphic: true, pixelP: 16, pixelQ: 15, videoCodec: 'h264', videoFramerate: 25, videoScanType: 'progressive', audioCodec: 'ac3', audioIndex: 1 };
const AOT    = { videoWidth: 1920, videoHeight: 1080, anamorphic: false, pixelP: 1, pixelQ: 1, videoCodec: 'h264', videoFramerate: 24, videoScanType: 'progressive', audioCodec: 'aac', audioIndex: 1 };
const WIDESCREEN_FILM = { videoWidth: 1920, videoHeight: 800, anamorphic: false, pixelP: 1, pixelQ: 1, videoCodec: 'h264', videoFramerate: 24, videoScanType: 'progressive', audioCodec: 'ac3', audioIndex: 1 };

const WATERMARK = {
    url: 'http://localhost:18000/images/dizquetv.png',
    width: 10,
    horizontalMargin: 1,
    verticalMargin: 1,
    position: 'bottom-right',
    duration: 0,
    fixedSize: false,
    animated: false,
};

async function itemArgs(settingsOverrides, channelOverrides, srcStats, watermark) {
    recorded = null;
    cp.spawn = (cmd, args) => {
        recorded = { cmd, args: args.map(String) };
        const { EventEmitter } = require('events');
        const { PassThrough } = require('stream');
        const e = new EventEmitter();
        e.stdout = new PassThrough();
        e.kill = () => {};
        return e;
    };
    try {
        const settings = Object.assign({}, BASE_SETTINGS, settingsOverrides);
        const channel = Object.assign({}, BASE_CHANNEL, channelOverrides, {
            transcoding: Object.assign({}, BASE_CHANNEL.transcoding, (channelOverrides || {}).transcoding),
        });
        const ff = new FFMPEG(settings, channel);
        ff.setAudioOnly(false);
        const stats = Object.assign({}, srcStats, { duration: 30000 });
        await ff.spawnStream('input.mkv', stats, 0, 30, watermark || null, 'episode');
        return recorded.args;
    } finally {
        cp.spawn = realSpawn;
    }
}

async function offlineArgs(aspect) {
    recorded = null;
    cp.spawn = (cmd, args) => {
        recorded = { cmd, args: args.map(String) };
        const { EventEmitter } = require('events');
        const { PassThrough } = require('stream');
        const e = new EventEmitter();
        e.stdout = new PassThrough();
        e.kill = () => {};
        return e;
    };
    try {
        const channel = Object.assign({}, BASE_CHANNEL, {
            transcoding: Object.assign({}, BASE_CHANNEL.transcoding, { aspect }),
            offlinePicture: 'http://localhost:18000/images/generic-offline-screen.png',
        });
        const ff = new FFMPEG(Object.assign({}, BASE_SETTINGS), channel);
        ff.setAudioOnly(false);
        await ff.spawnOffline(420);
        return recorded.args;
    } finally {
        cp.spawn = realSpawn;
    }
}

function filterOf(args) {
    const i = args.indexOf('-filter_complex');
    return i === -1 ? null : args[i + 1];
}

// The pre-change filter shape for a source that needs fitting and padding -
// today's default, and what 'mark' must fall back to whenever its condition
// (isFullyNormalized, narrower source) does not hold.
function fitFilter(cw, ch, wantedW, wantedH, audioIndex, durationMs) {
    return `[0:v]null[video];[video]scale=${cw}:${ch}:flags=bicubic[scaled]`
        + `;[scaled]pad=${wantedW}:${wantedH}:(ow-iw)/2:(oh-ih)/2[blackpadded]`
        + `;[blackpadded]setsar=1[siz]`
        + `;[0:${audioIndex}]anull[audio];[audio]apad=whole_dur=${durationMs}ms[padded]`;
}

function markFilter(wantedW, wantedH, sarNum, sarDen, audioIndex, durationMs) {
    return `[0:v]null[video];[video]scale=${wantedW}:${wantedH}:flags=bicubic[scaled]`
        + `;[scaled]setsar=${sarNum}/${sarDen}[siz]`
        + `;[0:${audioIndex}]anull[audio];[audio]apad=whole_dur=${durationMs}ms[padded]`;
}

// The literal formula /playlist used before it was moved into
// FFMPEG.isFullyNormalized - kept here, separately, so the comparison below
// is against an independent statement of the rule, not the same code twice.
function oldInlineFormula(o) {
    return (o.enableFFMPEGTranscoding === true)
        && (o.normalizeVideoCodec === true)
        && (o.normalizeAudioCodec === true)
        && (o.normalizeResolution === true)
        && (o.normalizeAudio === true);
}

module.exports = async function () {
    const s = new Suite('aspect-mark');

    // 1. Field absent -> exactly today's fit-and-pad command for a 4:3 source.
    {
        const args = await itemArgs({}, {}, BATMAN);
        const got = filterOf(args);
        const want = fitFilter(1440, 1080, 1920, 1080, 1, 30000);
        s.check('absent aspect: Batman TAS gets today\'s fit-and-pad filter', got === want, got !== want ? `got: ${got}` : '');
    }

    // 2. 'mark': Batman TAS (1440x1080, square pixels) fills the frame and is
    // marked 3:4 - the exact SAR the real ffmpeg run in TiviMate showed 4:3.
    {
        const args = await itemArgs({}, { transcoding: { aspect: 'mark' } }, BATMAN);
        const got = filterOf(args);
        const want = markFilter(1920, 1080, 3, 4, 1, 30000);
        s.check('mark: Batman TAS scales to full frame, setsar=3/4, no pad', got === want, got !== want ? `got: ${got}` : '');
    }

    // 3. 'mark': Cow and Chicken (720x576, anamorphic 16:15) reduces to the
    // same 4:3 display shape, so it must land on the same SAR.
    {
        const args = await itemArgs({}, { transcoding: { aspect: 'mark' } }, COW);
        const got = filterOf(args);
        const want = markFilter(1920, 1080, 3, 4, 1, 30000);
        s.check('mark: anamorphic Cow and Chicken also reduces to setsar=3/4', got === want, got !== want ? `got: ${got}` : '');
    }

    // 4. A source already at the channel's own shape needs no scaler at all,
    // marked or not.
    {
        const args = await itemArgs({}, { transcoding: { aspect: 'mark' } }, AOT);
        const got = filterOf(args);
        const want = `[0:${AOT.audioIndex}]anull[audio];[audio]apad=whole_dur=30000ms[padded]`;
        s.check('mark: a 1920x1080 source gets no video filter', got === want, got !== want ? `got: ${got}` : '');
    }

    // 5. A source already the channel's width but a different (letterboxed)
    // height is not "narrower" - ch != wantedH - so it still pads even when
    // marking is on.
    {
        const args = await itemArgs({}, { transcoding: { aspect: 'mark' } }, WIDESCREEN_FILM);
        const got = filterOf(args);
        const want = fitFilter(1920, 800, 1920, 1080, WIDESCREEN_FILM.audioIndex, 30000);
        s.check('mark: a 1920x800 widescreen film still pads top and bottom', got === want, got !== want ? `got: ${got}` : '');
    }

    // 6. 'mark' with any one of the five normalize flags off falls back to
    // padding - the isFullyNormalized() gate, shared with /playlist's loading
    // screen, must actually gate the filter change. normalizeAudio off also
    // drops the apad clause (this.apad follows it directly), so the expected
    // filter here is the video-only half of today's shape, not the full
    // fitFilter() string built for the other cases.
    {
        const args = await itemArgs({ normalizeAudio: false }, { transcoding: { aspect: 'mark' } }, BATMAN);
        const got = filterOf(args);
        const want = `[0:v]null[video];[video]scale=1440:1080:flags=bicubic[scaled]`
            + `;[scaled]pad=1920:1080:(ow-iw)/2:(oh-ih)/2[blackpadded]`
            + `;[blackpadded]setsar=1[siz]`;
        s.check('mark: falls back to pad when normalizeAudio is off', got === want, got !== want ? `got: ${got}` : '');
    }

    // 7. The offline and loading screens are unaffected either way: they are
    // already built at the channel's own frame size before the scaler block
    // in spawn() runs, so aspect='mark' cannot change them - proved here by
    // measurement, not by re-reading the code.
    {
        const withMark = await offlineArgs('mark');
        const withoutMark = await offlineArgs('');
        s.check('offline screen: aspect has no effect on the command', JSON.stringify(withMark) === JSON.stringify(withoutMark));
    }

    // 8. The watermark still overlays after the marked frame, at the same
    // [siz] label the padded path uses.
    {
        const args = await itemArgs({}, { transcoding: { aspect: 'mark' } }, BATMAN, WATERMARK);
        const got = filterOf(args);
        s.check('mark: watermark scales from the overlay input', got != null && got.includes('scale=192:-1[icn]'), got);
        s.check('mark: watermark overlays onto [siz], not a padded frame', got != null && got.includes('[siz][icn]overlay='), got);
        s.check('mark: the combined stream is what gets mapped', args.includes('[comb]'));
    }

    // 9. FFMPEG.isFullyNormalized agrees with the formula /playlist used to
    // duplicate inline, across every combination of the five flags.
    {
        const flags = ['enableFFMPEGTranscoding', 'normalizeVideoCodec', 'normalizeAudioCodec', 'normalizeResolution', 'normalizeAudio'];
        let allMatch = true;
        let mismatch = '';
        for (let bits = 0; bits < 32; bits++) {
            const o = {};
            flags.forEach((f, i) => { o[f] = ((bits >> i) & 1) === 1; });
            const a = FFMPEG.isFullyNormalized(o);
            const b = oldInlineFormula(o);
            if (a !== b) {
                allMatch = false;
                mismatch = JSON.stringify(o);
                break;
            }
        }
        s.check('isFullyNormalized matches the old inline formula in every combination', allMatch, mismatch);
    }

    return s;
};

if (require.main === module) {
    module.exports().then((suite) => {
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
