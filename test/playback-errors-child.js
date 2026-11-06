/*
 * One playback failure, run in a process of its own for test/playback-errors.js:
 * an error that escapes (a throw in an fs callback, a rejected promise nothing
 * awaits, an 'error' event nobody listens to) kills this process, not the test
 * runner, and the parent sees the exit code. Prints one line,
 * `RESULT <json>`, once the failure has played out, and exits 0.
 *
 *   node test/playback-errors-child.js <scenario> <temp dir>
 *
 * No real ffmpeg and no real Plex: "ffmpeg" is this node binary, which exits
 * at once on ffmpeg's arguments, and "Plex" is a local server answering 500.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');

const scenario = process.argv[2];
const dir = process.argv[3];
const result = {};
const logged = [];
for (const name of ['log', 'error', 'warn']) {
    const real = console[name];
    console[name] = function () {
        logged.push(Array.from(arguments).map((a) => (a instanceof Error) ? a.stack : (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        if (process.env.PLAYBACK_ERRORS_VERBOSE) real.apply(console, arguments);
    };
}
function finish() {
    result.logged = logged.join('\n');
    process.stdout.write('RESULT ' + JSON.stringify(result) + '\n');
    process.exit(0);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A Plex that answers every request with a 500, at once.
function failingPlex() {
    return new Promise((resolve) => {
        const s = http.createServer((req, res) => { res.statusCode = 500; res.end('no'); });
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
}

const FFMPEG_SETTINGS = {
    ffmpegPath: process.execPath, threads: 1, concatMuxDelay: '0', logFfmpeg: false, enableFFMPEGTranscoding: true,
    audioVolumePercent: 100, videoEncoder: 'mpeg2video', audioEncoder: 'aac', targetResolution: '640x360',
    videoBitrate: 1000, videoBufSize: 2000, audioBitrate: 128, audioBufSize: 256, audioSampleRate: 48,
    audioChannels: 2, errorScreen: 'testsrc', errorAudio: 'silent', normalizeVideoCodec: true,
    normalizeAudioCodec: true, normalizeResolution: true, normalizeAudio: true, maxFPS: 30,
    scalingAlgorithm: 'bicubic', deinterlaceFilter: 'none', disablePreludes: true, disableChannelOverlay: true,
};
const CHANNEL = { number: 7, name: 'Test', transcoding: {}, watermark: { enabled: false } };
function plexSettings(over) {
    return Object.assign({ streamPath: 'direct', debugLogging: false, updatePlayStatus: false, pathReplace: '', pathReplaceWith: '',
        maxPlayableResolution: '1920x1080', maxTranscodeResolution: '1920x1080', videoCodecs: 'h264', audioCodecs: 'aac',
        maxAudioChannels: '2', audioBoost: '100', enableSubtitles: false, subtitleSize: '100', streamProtocol: 'http',
        directStreamBitrate: '20000', transcodeBitrate: '2000', mediaBufferSize: 1000, transcodeMediaBufferSize: 20000,
        forceDirectPlay: false }, over || {});
}
function plexItem(file) {
    return { type: 'commercial', title: 'Clip', key: '/library/metadata/1', ratingKey: '1', plexFile: '/library/parts/1/file.mp4',
        file: file, serverKey: 'srv', start: 0, duration: 10000, streamDuration: 10000 };
}
function context(lineupItem, server, ffmpegOver, plexOver) {
    const db = {
        'client-id': { find: () => [{ clientId: 'test' }] },
        'plex-servers': { find: () => [{ name: 'srv', uri: `http://127.0.0.1:${server.address().port}`, accessToken: 't' }] },
        'plex-settings': { find: () => [plexSettings(plexOver)] },
    };
    return { lineupItem, ffmpegSettings: Object.assign({}, FFMPEG_SETTINGS, ffmpegOver || {}), channel: CHANNEL, db, audioOnly: false };
}
// Plays through ProgramPlayer and lets every exit, retry and error screen play out.
async function playThrough(ctx, settleMs) {
    const ProgramPlayer = require('../src/program-player');
    const player = new ProgramPlayer(ctx);
    const out = new PassThrough();
    out.resume();
    try {
        const emitter = await player.play(out);
        result.played = (emitter != null);
    } catch (err) {
        result.rejected = err.message;
    }
    await wait(settleMs || 2500);
    try { player.cleanUp(); } catch (e) { result.cleanUpThrew = e.message; }
    await wait(300);
}

const scenarios = {
    // plexTranscoder.js: the file a direct-path program plays from is missing.
    'transcoder-missing-file': async () => {
        const server = await failingPlex();
        const PlexTranscoder = require('../src/plexTranscoder');
        const missing = path.join(dir, 'gone', 'Missing clip [Hippie].mp4');
        const t = new PlexTranscoder('test', { uri: `http://127.0.0.1:${server.address().port}`, accessToken: 't' },
            plexSettings(), CHANNEL, plexItem(missing));
        try {
            await t.getStream(false);
            result.resolved = true;
        } catch (err) {
            result.rejected = err.message;
        }
        await wait(500);
        server.close();
    },
    // plexTranscoder.js: telling Plex what's playing, while Plex is failing.
    'plex-status-update': async () => {
        const server = await failingPlex();
        const PlexTranscoder = require('../src/plexTranscoder');
        const t = new PlexTranscoder('test', { uri: `http://127.0.0.1:${server.address().port}`, accessToken: 't' },
            plexSettings({ updatePlayStatus: true }), CHANNEL, plexItem(path.join(dir, 'x.mp4')));
        t.startUpdatingPlex();
        await wait(300);
        t.stopUpdatingPlex();
        await wait(500);
        server.close();
    },
    // plex-player.js: ffmpeg fails, and the error screen is set to "kill".
    'plex-error-screen-kill': async () => {
        const server = await failingPlex();
        await playThrough(context(plexItem(path.join(dir, 'real.mp4')), server, { errorScreen: 'kill' }));
        server.close();
    },
    // plex-player.js: ffmpeg fails, and so does the error screen after it.
    'plex-error-screen-fails': async () => {
        const server = await failingPlex();
        await playThrough(context(plexItem(path.join(dir, 'real.mp4')), server));
        server.close();
    },
    // card-player.js: a card's ffmpeg fails, and the error screen is set to "kill".
    'card-error-screen-kill': async () => {
        const server = await failingPlex();
        const card = { type: 'transition', title: 'Next Time: B', generatedFile: path.join(dir, 'real.mp4'), start: 0,
            duration: 10000, streamDuration: 10000, streamStats: { videoWidth: 640, videoHeight: 360 } };
        await playThrough(context(card, server, { errorScreen: 'kill' }));
        server.close();
    },
    // offline-player.js: the offline screen's ffmpeg fails, error screen "kill".
    'offline-error-screen-kill': async () => {
        const server = await failingPlex();
        await playThrough(context({ type: 'offline', title: 'Offline', start: 0, duration: 10000, streamDuration: 10000 },
            server, { errorScreen: 'kill' }));
        server.close();
    },
    // video.js: every route that plays, when deciding what to play throws.
    'routes-throw': async () => {
        const express = require('express');
        const video = require('../src/video');
        const channelService = Object.assign(new EventEmitter(), {
            getChannel: async () => { throw new Error('channel store unreadable'); },
        });
        const db = { 'ffmpeg-settings': { find: () => [FFMPEG_SETTINGS] } };
        const app = express();
        app.use(video.router(channelService, {}, db, {}, {}, {}, null));
        const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        process.env.PORT = String(server.address().port);
        result.status = {};
        for (const route of ['/stream?channel=1', '/playlist?channel=1', '/m3u8?channel=1', '/video?channel=1']) {
            result.status[route] = await new Promise((resolve) => {
                const req = http.get({ host: '127.0.0.1', port: server.address().port, path: route }, (res) => {
                    res.resume();
                    res.on('end', () => resolve(res.statusCode));
                });
                req.on('error', (e) => resolve('request error: ' + e.message));
                req.setTimeout(3000, () => { req.destroy(); resolve('no answer'); });
            });
        }
        await wait(300);
        server.close();
    },
    // file-cache-service.js: the channels.m3u cache can't be written.
    'm3u-cache-write': async () => {
        const FileCacheService = require('../src/services/file-cache-service');
        const cache = new FileCacheService(path.join(dir, 'no-such-folder'));
        try {
            await cache.setCache('channels.m3u', '#EXTM3U\n');
            result.resolved = true;
        } catch (err) {
            result.rejected = err.message;
        }
        await wait(300);
    },
};

if (typeof(scenarios[scenario]) !== 'function') {
    console.error(`no scenario "${scenario}"`);
    process.exit(2);
}
scenarios[scenario]().then(finish, (err) => {
    result.scenarioThrew = err && err.stack;
    finish();
});
