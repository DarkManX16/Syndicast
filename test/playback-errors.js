/*
 * A file that can't be opened never takes the server down, and is skipped.
 *
 * Nov 5, 2026: DarkManX16's whole server crashed, every channel with it, when channel
 * 1's break reached a NEXT bumper on the USB drive that, for that moment,
 * couldn't be opened: plexTranscoder.js threw inside fs.access's callback,
 * where nothing can catch it. Two halves:
 *
 *   - Through the real /stream route (video.js, with the concat's ffmpeg and
 *     the player stood in for, as test/stream-cursor.js does): an item whose
 *     file can't be opened is never handed to the player. A Flex clip is
 *     skipped for the next pick, a transition step or a card for the next
 *     step, a program for the channel's Flex in its slot, and with nothing
 *     else to play, the channel's fallback. The log names the file and why.
 *
 *   - Every way an error escaped during playback, each run in a process of
 *     its own (test/playback-errors-child.js), so an escape kills that process
 *     and not this one: the process must live, and say what went wrong.
 */
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const childProcess = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const express = require('express');
const { channelCache, freshStore, mix, Suite } = require('./support');
const lineupCursor = require('../src/lineup-cursor');

const SEC = 1000;

const RealDate = Date;
let fakeNow = null;
class FakeDate extends RealDate {
    constructor(...args) {
        if ( (args.length === 0) && (fakeNow !== null) ) {
            super(fakeNow);
        } else {
            super(...args);
        }
    }
    static now() {
        return (fakeNow !== null) ? fakeNow : RealDate.now();
    }
}

const played = [];
class FakeFFMPEG extends EventEmitter {
    setAudioOnly() {}
    async spawnConcat() { return new PassThrough(); }
    kill() {}
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

function loadVideoWith(stubs) {
    const srcDir = path.join(__dirname, '..', 'src') + path.sep;
    const before = new Set(Object.keys(require.cache));
    const saved = {};
    try {
        FakeFFMPEG.isFullyNormalized = require('../src/ffmpeg').isFullyNormalized;
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
        return video;
    } finally {
        for (const [p, m] of Object.entries(saved)) {
            if (m) require.cache[p] = m; else delete require.cache[p];
        }
        for (const key of Object.keys(require.cache)) {
            if (key.startsWith(srcDir) && !before.has(key)) delete require.cache[key];
        }
    }
}

function get(port, pathAndQuery) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: pathAndQuery }, (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
    });
}

module.exports = async function run() {
    const suite = new Suite('playback errors');
    await routeChecks(suite);
    crashChecks(suite);
    return suite;
};

async function routeChecks(suite) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syndicast-playback-errors-'));
    const realSetTimeout = global.setTimeout;
    global.setTimeout = function () {
        const t = realSetTimeout.apply(this, arguments);
        if (t && typeof t.unref === 'function') t.unref();
        return t;
    };
    const realLog = console.log, realError = console.error;
    const logged = [];
    console.log = function (first) {
        if (typeof first === 'string' && /^ {2}(PASS|FAIL) /.test(first)) return realLog.apply(console, arguments);
        logged.push(Array.from(arguments).join(' '));
    };
    console.error = function () { logged.push(Array.from(arguments).join(' ')); };
    let server = null;
    try {
        const file = (name) => {
            const f = path.join(dir, name);
            fs.writeFileSync(f, 'x');
            return f;
        };
        // The clip from the crash, its folder gone.
        const missing = (name) => path.join(dir, 'CN NEXT Bumpers (Powerhouse)', name);
        const BAD = missing('Tom & Jerry Kids to Flintstones [Hippie].mp4');
        const clip = (title, f, secs) => ({ title, key: `/library/metadata/${title}`, file: f, duration: (secs || 30) * SEC, serverKey: 'srv' });
        const good = clip('Good', file('good.mp4'));
        const bad = clip('Tom & Jerry Kids to Flintstones [Hippie]', BAD);
        const LISTS = {
            Fill: [bad, good],
            OnlyBad: [bad],
            ManyBad: Array.from({ length: 15 }, (x, i) => clip(`Bad ${i}`, missing(`bad ${i}.mp4`))),
            OnlyGood: [good],
            OUT: [clip('Bad Out', missing('out.mp4'), 15)],
            IN: [clip('In', file('in.mp4'), 10)],
        };

        const base = RealDate.now() + 3600 * SEC;
        const S = base + 600 * SEC;   // where show A ends and the break begins
        const show = (title, f) => ({ title, key: `/p/${title}`, file: f, duration: 600 * SEC, serverKey: 'srv' });
        const A = show('A', file('a.mp4'));
        const B = show('B', file('b.mp4'));
        const plain = (number, listId, extra) => {
            const programs = [A, { isOffline: true, duration: 180 * SEC }, B];
            return Object.assign({
                number, name: `Ch ${number}`, offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0,
                fillerCollections: mix([[listId, 100]]), programs,
                duration: programs.reduce((a, p) => a + p.duration, 0),
                startTime: new RealDate(base).toISOString(), transcoding: {},
            }, extra || {});
        };
        const anyStep = (id, listId) => ({ id, kind: 'list', listId, match: 'any', keyedOn: 'next', fallbackListId: null, onlyIfNoMatch: null });
        const withSteps = (number, out) => plain(number, 'OnlyGood', {
            dayParts: [{ name: 'All week', fillerCollections: mix([['OnlyGood', 100]]),
                starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 0 }],
                transitions: { betweenShows: { out: [out], in: [anyStep('i', 'IN')] } } }],
        });
        const badShow = show('Lost Episode', missing('Lost Episode.mkv'));
        const channels = {
            21: plain(21, 'Fill'),
            22: withSteps(22, anyStep('o', 'OUT')),
            23: plain(23, 'OnlyGood', { programs: [badShow, { isOffline: true, duration: 180 * SEC }, B] }),
            24: withSteps(24, { id: 'c', kind: 'generated', templateId: 'tpl', keyedOn: 'next' }),
            25: plain(25, 'OnlyBad'),
            26: plain(26, 'ManyBad'),
        };
        const cardService = { cardFor: () => ({ file: missing('card.ts'), key: 'abc', title: 'Next Time: B', durationMs: 15 * SEC,
            streamStats: { videoWidth: 1920, videoHeight: 1080, videoCodec: 'mpeg2video', audioCodec: 'aac', audioIndex: 'a' } }) };
        const channelService = Object.assign(new EventEmitter(), { getChannel: async (n) => channels[n] || null });
        const fillerService = { getFillersFromCollections: async (ch, cols) => cols.map((c) => ({
            id: c.id, content: LISTS[c.id], weight: c.weight, cooldown: c.cooldown })) };
        const settings = {
            ffmpegPath: process.execPath, enableFFMPEGTranscoding: true, disablePreludes: true,
            normalizeVideoCodec: true, normalizeAudioCodec: true, normalizeResolution: true, normalizeAudio: true,
        };
        const db = {
            'ffmpeg-settings': { find: () => [settings] },
            'plex-settings': { find: () => [{ streamPath: 'direct', pathReplace: '', pathReplaceWith: '' }] },
        };
        const store = freshStore();
        const programmingService = { getCurrentProgramAndTimeElapsed: require('./support').helperFuncs.getCurrentProgramAndTimeElapsed };
        const activeChannelService = { peekChannel() {}, registerChannelActive() {}, registerChannelStopped() {} };

        const video = loadVideoWith({ '../src/ffmpeg': FakeFFMPEG, '../src/program-player': FakePlayer });
        const app = express();
        app.use(video.router(channelService, fillerService, db, programmingService, activeChannelService, store, cardService));
        server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        const port = server.address().port;
        const savedPort = process.env.PORT;
        process.env.PORT = String(port);
        global.Date = FakeDate;

        // A viewer whose stream just finished show A, asking for what's next.
        const describe = (i) => (i ? `${i.type} ${i.title} ${i.start}+${i.streamDuration}` : 'nothing');
        let session = 1000;
        const next = async (ch, streamId, at) => {
            fakeNow = at;
            channelCache.clearPlayback(ch);
            channelCache.setCursor(streamId, { channel: ch, index: 0, end: S, inBreak: false, fingerprint: lineupCursor.fingerprint(channels[ch].programs[0]) });
            const before = played.length;
            logged.length = 0;
            const status = await get(port, `/stream?channel=${ch}&session=${session++}&stream=${streamId}`);
            return { item: played[before], status, count: played.length - before };
        };
        const namesFileAndWhy = (f) => logged.some((l) => l.includes(f) && /ENOENT|no such file/i.test(l));

        // Good played a minute ago, Bad never: the picker takes Bad first.
        channelCache.recordPlayback(store, 21, S - 60 * SEC, { type: 'commercial', key: good.key, serverKey: good.serverKey, title: good.title,
            duration: good.duration, start: 0, streamDuration: good.duration });
        channelCache.clearPlayback(21);
        {
            const r = await next(21, 'v21', S + 2 * SEC);
            suite.check('a break whose next clip can\'t be opened plays the next pick instead',
                r.item && r.item.type === 'commercial' && r.item.title === 'Good' && r.count === 1, describe(r.item));
            suite.check('... and the log names the file and why', namesFileAndWhy(BAD), logged.join(' / '));
            // the rest of the break, a clip at a time: never the missing one
            const seen = [];
            for (let k = 0; k < 5; k++) {
                fakeNow = S + (10 + 31 * k) * SEC;
                const before = played.length;
                await get(port, `/stream?channel=21&session=${session++}&stream=walker`);
                seen.push(played[before]);
            }
            suite.check('... and through the rest of the break, the missing clip is never handed to the player',
                seen.every((i) => i && i.title !== bad.title), seen.map(describe).join(' | '));
        }
        {
            const r = await next(25, 'v25', S + 2 * SEC);
            suite.check('a break with nothing it can open plays the channel\'s fallback',
                r.item && r.item.type === 'offline' && typeof(r.item.err) === 'undefined', describe(r.item));
        }
        {
            const warnings = [];
            const onWarning = (w) => warnings.push(w.name);
            process.on('warning', onWarning);
            const r = await next(26, 'v26', S + 2 * SEC);
            await new Promise((resolve) => setImmediate(resolve));
            process.removeListener('warning', onWarning);
            suite.check('fifteen missing clips in a row: each skipped, then the channel\'s fallback',
                r.item && r.item.type === 'offline' && r.status === 200, `${describe(r.item)} (${r.status})`);
            suite.check('... and the response gets one error listener, not one per skip',
                !warnings.includes('MaxListenersExceededWarning'), warnings.join(', '));
        }
        {
            const r = await next(22, 'v22', S);
            suite.check('a transition step that can\'t be opened is skipped for what follows it: the Flex',
                r.item && r.item.type === 'commercial' && r.item.title === 'Good', describe(r.item));
            suite.check('... and the log names the step\'s file', namesFileAndWhy(LISTS.OUT[0].file), logged.join(' / '));
        }
        {
            const r = await next(24, 'v24', S);
            suite.check('a generated card that can\'t be opened is skipped the same way',
                r.item && r.item.type === 'commercial' && r.item.title === 'Good', describe(r.item));
        }
        {
            // tuning in a minute into the episode, from the clock
            fakeNow = base + 60 * SEC;
            channelCache.clearPlayback(23);
            const before = played.length;
            logged.length = 0;
            await get(port, `/stream?channel=23&session=${session++}&first=1`);
            const item = played[before];
            suite.check('a program that can\'t be opened: its slot plays the channel\'s Flex instead',
                item && item.type === 'commercial' && item.title === 'Good' && item.streamDuration <= 540 * SEC + 2 * SEC, describe(item));
            suite.check('... and the log names the episode\'s file', namesFileAndWhy(badShow.file), logged.join(' / '));
        }
        process.env.PORT = savedPort;
    } catch (err) {
        suite.check('the route checks ran', false, err && err.stack);
    } finally {
        global.Date = RealDate;
        fakeNow = null;
        console.log = realLog;
        console.error = realError;
        global.setTimeout = realSetTimeout;
        if (server) server.close();
        channelCache.clear();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function crashChecks(suite) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syndicast-playback-crash-'));
    fs.writeFileSync(path.join(dir, 'real.mp4'), 'x');
    const runScenario = (name) => {
        const r = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'playback-errors-child.js'), name, dir],
            { encoding: 'utf8', timeout: 30000 });
        const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
        let result = null;
        try { result = line ? JSON.parse(line.slice(7)) : null; } catch (e) { result = null; }
        const tail = `exit ${r.status}: ` + (r.stderr || '').split('\n').filter((l) => /Error|at /.test(l)).slice(0, 3).join(' / ');
        return { alive: (r.status === 0) && (result !== null), result: result || {}, tail };
    };
    try {
        {
            const r = runScenario('transcoder-missing-file');
            suite.check('plexTranscoder: a missing direct-path file no longer kills the server', r.alive, r.tail);
            suite.check('... it fails that one stream instead, naming the file and why',
                /Missing clip \[Hippie\]\.mp4/.test(r.result.rejected || '') && /ENOENT/.test(r.result.rejected || ''),
                r.result.rejected || JSON.stringify(r.result).slice(0, 300));
        }
        {
            const r = runScenario('plex-status-update');
            suite.check('plexTranscoder: telling a failing Plex what\'s playing no longer kills the server', r.alive, r.tail);
        }
        for (const name of ['plex-error-screen-kill', 'plex-error-screen-fails', 'card-error-screen-kill', 'offline-error-screen-kill']) {
            const r = runScenario(name);
            suite.check(`players: ${name.replace(/-/g, ' ')} no longer kills the server`, r.alive, r.tail);
        }
        {
            const r = runScenario('routes-throw');
            suite.check('video.js: a throw while deciding what to play no longer kills the server', r.alive, r.tail);
            const st = r.result.status || {};
            suite.check('... each route answers 500 instead',
                ['/stream?channel=1', '/playlist?channel=1', '/m3u8?channel=1', '/video?channel=1'].every((k) => st[k] === 500), JSON.stringify(st));
        }
        {
            const r = runScenario('m3u-cache-write');
            suite.check('file cache: a channels.m3u that can\'t be written no longer kills the server', r.alive, r.tail);
            suite.check('... the write is refused instead', typeof(r.result.rejected) === 'string', JSON.stringify(r.result).slice(0, 300));
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
        setTimeout(() => process.exit(), 200).unref();
    });
}
