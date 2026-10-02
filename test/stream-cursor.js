/*
 * The lineup cursor's wiring in src/video.js, through the real router: each
 * viewer connection (/video or /radio) gets one stream id, /playlist puts it
 * on every /stream entry, a concat restart (the next 100-entry playlist)
 * keeps it, closing the connection or saving the channel forgets the
 * stream's cursor, and /stream follows a cursor instead of the clock.
 *
 * video.js is loaded fresh with two stand-ins in the require cache: the
 * concat's FFMPEG (records the playlist URL it was given, and can be told its
 * playlist ran out) and ProgramPlayer (records the item it was asked to play,
 * plays one byte, ends). Everything else is real: helperFuncs, channel-cache,
 * day-parts, lineup-cursor and express.
 */
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const express = require('express');
const { helperFuncs, channelCache, freshStore, mix, Suite } = require('./support');

const SEC = 1000;

const concats = [];   // { url, ff }
const played = [];    // lineup items handed to the player, in order
class FakeFFMPEG extends EventEmitter {
    constructor() { super(); this.out = null; }
    setAudioOnly() {}
    async spawnConcat(url) {
        this.out = new PassThrough();
        concats.push({ url, ff: this });
        return this.out;
    }
    kill() { if (this.out) this.out.end(); }
}
class FakePlayer {
    constructor(context) { played.push(context.lineupItem); }
    cleanUp() {}
    async play(res) {
        const e = new EventEmitter();
        setImmediate(() => { res.write(Buffer.from('x')); e.emit('end'); });
        return e;
    }
}

/*
 * Loads video.js with the stand-ins, then puts the require cache back as it
 * was for every module under src/ this pulled in - ffmpeg.js above all, which
 * other files here load their own copy of, with their own spawn.
 */
function loadVideoWith(stubs) {
    const srcDir = path.join(__dirname, '..', 'src') + path.sep;
    const before = new Set(Object.keys(require.cache));
    try {
        FakeFFMPEG.isFullyNormalized = require('../src/ffmpeg').isFullyNormalized;
        return loadWithStubs(stubs);
    } finally {
        for (const key of Object.keys(require.cache)) {
            if (key.startsWith(srcDir) && !before.has(key)) delete require.cache[key];
        }
    }
}
function loadWithStubs(stubs) {
    const saved = {};
    for (const [rel, exportsValue] of Object.entries(stubs)) {
        const p = require.resolve(rel);
        saved[p] = require.cache[p];
        require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsValue, children: [], paths: [] };
    }
    const videoPath = require.resolve('../src/video');
    const savedVideo = require.cache[videoPath];
    delete require.cache[videoPath];
    const video = require('../src/video');
    delete require.cache[videoPath];
    if (savedVideo) require.cache[videoPath] = savedVideo;
    for (const [p, m] of Object.entries(saved)) {
        if (m) require.cache[p] = m; else delete require.cache[p];
    }
    return video;
}

function get(port, pathAndQuery) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: pathAndQuery }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve(body));
        });
        req.on('error', reject);
    });
}
// Opens a viewer connection and leaves it open; returns a way to close it.
function open(port, pathAndQuery) {
    const req = http.get({ host: '127.0.0.1', port, path: pathAndQuery }, (res) => { res.resume(); });
    req.on('error', () => {});
    return () => req.destroy();
}
function waitFor(cond, ms) {
    return new Promise((resolve) => {
        const until = Date.now() + (ms || 2000);
        (function poll() {
            if (cond() || Date.now() > until) return resolve(cond());
            setTimeout(poll, 10);
        })();
    });
}
function streamIdOf(url) {
    const m = /[?&]stream=([^&']*)/.exec(url);
    return m ? m[1] : null;
}

module.exports = async function run() {
    const suite = new Suite('stream-cursor');

    // video.js arms 15s and 5s timers per item; don't let them hold the suite.
    const realSetTimeout = global.setTimeout;
    global.setTimeout = function () {
        const t = realSetTimeout.apply(this, arguments);
        if (t && typeof t.unref === 'function') t.unref();
        return t;
    };
    // Keep the suite's own lines, drop video.js's per-item chatter.
    const realLog = console.log;
    console.log = function (first) {
        if (typeof first === 'string' && /^ {2}(PASS|FAIL) /.test(first)) realLog.apply(console, arguments);
    };
    let server = null;
    try {
        // A 10 minute show, a 3 minute break, a 10s NEXT bumper, another show,
        // with "now" 2.8s before the break ends.
        const now = Date.now();
        const programs = [
            { title: 'A', key: '/p/A', duration: 600 * SEC, serverKey: 'srv' },
            { isOffline: true, duration: 180 * SEC },
            { title: 'Next', key: '/p/Next', duration: 10 * SEC, serverKey: 'srv' },
            { title: 'B', key: '/p/B', duration: 600 * SEC, serverKey: 'srv' },
        ];
        const channel = {
            number: 9, name: 'Cursor', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0,
            fillerCollections: mix([['Fill', 100]]),
            programs,
            duration: programs.reduce((a, p) => a + p.duration, 0),
            startTime: new Date(now + 2800 - 780 * SEC).toISOString(),
            transcoding: {},
        };
        const fill = [{ title: 'Fill#1', key: '/f/1', duration: 30 * SEC, serverKey: 'srv' }];
        const channelService = Object.assign(new EventEmitter(), {
            getChannel: async (n) => (n === 9 ? channel : null),
        });
        const fillerService = { getFillersFromCollections: async () => [{ id: 'Fill', content: fill, weight: 100, cooldown: 0 }] };
        const settings = {
            ffmpegPath: process.execPath, enableFFMPEGTranscoding: true, disablePreludes: true,
            normalizeVideoCodec: true, normalizeAudioCodec: true, normalizeResolution: true, normalizeAudio: true,
        };
        const db = { 'ffmpeg-settings': { find: () => [settings] } };
        const programmingService = { getCurrentProgramAndTimeElapsed: helperFuncs.getCurrentProgramAndTimeElapsed };
        const activeChannelService = { peekChannel() {}, registerChannelActive() {}, registerChannelStopped() {} };

        const video = loadVideoWith({ '../src/ffmpeg': FakeFFMPEG, '../src/program-player': FakePlayer });
        const app = express();
        app.use(video.router(channelService, fillerService, db, programmingService, activeChannelService, freshStore()));
        server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        const port = server.address().port;
        const savedPort = process.env.PORT;
        process.env.PORT = String(port);

        // ------------------------------------------------------ /playlist
        for (const step of [0, 1]) {
            const body = await get(port, `/playlist?channel=9&audioOnly=false&stepNumber=${step}&stream=abc123`);
            const entries = body.split('\n').filter((l) => l.includes('/stream?'));
            suite.check(`playlist step ${step}: every one of its ${entries.length} entries carries the stream id`,
                entries.length > 0 && entries.every((l) => streamIdOf(l) === 'abc123'),
                entries.filter((l) => streamIdOf(l) !== 'abc123').slice(0, 1).join(''));
        }
        {
            const body = await get(port, '/playlist?channel=9&audioOnly=false&stepNumber=0');
            suite.check('a playlist asked for without one names none', !body.includes('stream='));
            const bad = await get(port, `/playlist?channel=9&audioOnly=false&stepNumber=0&stream=${encodeURIComponent("x'y")}`);
            suite.check('a stream id that could break out of the playlist\'s quotes is dropped',
                bad.includes('/stream?') && !bad.includes("x'y") && !bad.includes('stream=x'));
        }

        // --------------------------------------------------------- /video
        const close1 = open(port, '/video?channel=9');
        await waitFor(() => concats.length >= 1);
        const close2 = open(port, '/video?channel=9');
        await waitFor(() => concats.length >= 2);
        const id1 = streamIdOf(concats[0].url), id2 = streamIdOf(concats[1].url);
        suite.check('each viewer connection gets its own stream id',
            id1 !== null && id2 !== null && id1 !== id2, `${id1} / ${id2}`);
        // the first viewer's concat ran through its 100 entries
        concats[0].ff.emit('end');
        await waitFor(() => concats.length >= 3);
        suite.check('the playlist restart asks for step 1 with the same stream id',
            id1 !== null && concats.length >= 3 && /stepNumber=1/.test(concats[2].url) && streamIdOf(concats[2].url) === id1,
            concats[2] ? concats[2].url : 'no restart');

        channelCache.setCursor(id1, { channel: 9, index: 0, end: now, inBreak: false, fingerprint: 'x' });
        channelCache.setCursor(id2, { channel: 9, index: 0, end: now, inBreak: false, fingerprint: 'x' });
        close1();
        const dropped = await waitFor(() => channelCache.getCursor(id1) === null);
        suite.check('closing a viewer connection forgets its cursor, and only its own',
            dropped && channelCache.getCursor(id2) !== null);
        close2();
        await waitFor(() => channelCache.getCursor(id2) === null);

        // -------------------------------------------------------- /stream
        played.length = 0;
        await get(port, '/stream?channel=9&session=101&stream=viewerA');
        await get(port, '/stream?channel=9&session=102&stream=viewerA');
        suite.check('a stream handed the 10s item early plays it, then the show after it - not the item again',
            played.length === 2 && played[0].title === 'Next' && played[1].title === 'B' && played[1].start === 0,
            played.map((i) => `${i.title}@${i.start}`).join(', '));
        // Tuning in on the channel's replay cache - the item the last viewer
        // was handed, continued - picks up that item's cursor with it.
        const cursorA = channelCache.getCursor('viewerA');
        played.length = 0;
        await get(port, '/stream?channel=9&session=103&first=1&stream=viewerC');
        suite.check('a viewer tuning in on the channel\'s cache gets the item the last viewer was handed, and its cursor',
            played.length === 1 && played[0].title === 'B'
                && JSON.stringify(channelCache.getCursor('viewerC')) === JSON.stringify(cursorA),
            `${played.map((i) => i.title).join(', ')}; ${JSON.stringify(channelCache.getCursor('viewerC'))}`);

        // With that cache out of the way, a viewer without a cursor gets the clock.
        channelCache.clearPlayback(9);
        played.length = 0;
        await get(port, '/stream?channel=9&session=104&stream=viewerB');
        suite.check('another viewer with no cursor of its own gets what the clock says: the item',
            played.length === 1 && played[0].title === 'Next', played.map((i) => i.title).join(', '));
        channelCache.clearPlayback(9);
        played.length = 0;
        await get(port, '/stream?channel=9&session=105');
        suite.check('a request with no stream id gets what the clock says, as before',
            played.length === 1 && played[0].title === 'Next', played.map((i) => i.title).join(', '));

        suite.check('the viewers\' cursors are kept while they play',
            channelCache.getCursor('viewerA') !== null && channelCache.getCursor('viewerB') !== null);
        channelCache.saveChannelConfig(9, channel);
        suite.check('saving the channel forgets every cursor on it',
            channelCache.getCursor('viewerA') === null && channelCache.getCursor('viewerB') === null);

        process.env.PORT = savedPort;
    } catch (err) {
        suite.check('the wiring test ran', false, err && err.stack);
    } finally {
        console.log = realLog;
        global.setTimeout = realSetTimeout;
        if (server) server.close();
        channelCache.clear();
    }
    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
        setTimeout(() => process.exit(), 200).unref();
    });
}
