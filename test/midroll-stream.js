/*
 * Playing midrolls through the real router (src/video.js), as test/stream-cursor.js does for
 * breaks: the concat's FFMPEG and the ProgramPlayer are stand-ins that record what they were
 * asked to play; everything else is real - midroll-cursor.js, lineup-cursor.js, createLineup,
 * channel-cache.js's cursors, plans, shared picks and frozen layouts, and a stand-in break scan
 * service that answers the switch and Family Guy's two approved points.
 *
 * On a fake clock that each viewer's next request reads: two viewers through the spec's Family
 * Guy airing, one from 12:29:40 and one tuning in during its first midroll (same steps, same
 * commercials), a save during part 2, the switch turned off during the airing, /m3u8 walking the
 * airing by the clock alone, and the log lines a midroll leaves.
 */
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const express = require('express');
const { helperFuncs, channelCache, freshStore, mix, Suite } = require('./support');

const SEC = 1000;
const MIN = 60 * SEC;
const ms = (m, s = 0) => (m * MIN) + (s * SEC);
const SLACK = require('../src/constants').SLACK;

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
        setImmediate( () => { res.write(Buffer.from('x')); e.emit('end'); } );
        return e;
    }
}
function loadVideoWith(stubs) {
    const srcDir = path.join(__dirname, '..', 'src') + path.sep;
    const before = new Set(Object.keys(require.cache));
    const saved = {};
    try {
        FakeFFMPEG.isFullyNormalized = require('../src/ffmpeg').isFullyNormalized;
        for (const [rel, value] of Object.entries(stubs)) {
            const p = require.resolve(rel);
            saved[p] = require.cache[p];
            require.cache[p] = { id: p, filename: p, loaded: true, exports: value, children: [], paths: [] };
        }
        const videoPath = require.resolve('../src/video');
        const savedVideo = require.cache[videoPath];
        delete require.cache[videoPath];
        const video = require('../src/video');
        delete require.cache[videoPath];
        if (savedVideo) {
            require.cache[videoPath] = savedVideo;
        }
        return video;
    } finally {
        for (const [p, m] of Object.entries(saved)) {
            if (m) {
                require.cache[p] = m;
            } else {
                delete require.cache[p];
            }
        }
        for (const key of Object.keys(require.cache)) {
            if (key.startsWith(srcDir) && ! before.has(key)) {
                delete require.cache[key];
            }
        }
    }
}
function get(port, pathAndQuery) {
    return new Promise( (resolve, reject) => {
        const req = http.get( { host: '127.0.0.1', port, path: pathAndQuery }, (res) => {
            res.on('data', () => {});
            res.on('end', resolve);
        } );
        req.on('error', reject);
    } );
}

const S = new RealDate(2026, 10, 20, 0, 30, 0).getTime();
const FG = { type: 'episode', showTitle: 'Family Guy', title: 'Death Is a Bitch', key: '/p/fg', file: 'D:/Family Guy/S02E06.mkv', duration: ms(22, 37), serverKey: 'srv' };
const RC = { type: 'episode', showTitle: 'Robot Chicken', title: 'Robot Chicken', key: '/p/rc', file: 'D:/Robot Chicken/S01E01.mkv', duration: ms(11), serverKey: 'srv' };
const FILL = [];
[15, 20, 30, 30, 45].forEach( (s, i) => {
    for (let v = 0; v < 4; v++) {
        FILL.push( { title: `Fill#${i}.${v}`, key: `/f/${i}.${v}`, duration: (s * SEC) + (v * 211), serverKey: 'srv' } );
    }
} );
const LISTS = {
    Fill: FILL,
    WB: [ { title: 'WBRB', key: '/t/wb', duration: 5 * SEC, serverKey: 'srv' } ],
    BT: [ { title: 'BTTS', key: '/t/bt', duration: 6 * SEC, serverKey: 'srv' } ],
};
const step = (id, listId) => ({ id, kind: 'list', listId, match: 'any', keyedOn: 'next', fallbackListId: null, onlyIfNoMatch: null });
const programs = [ FG, { isOffline: true, duration: ms(7, 23) }, RC, { isOffline: true, duration: ms(4) } ];
const channel = {
    number: 7, name: 'Midrolls', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0,
    fillerCollections: mix( [ [ 'Fill', 100 ] ] ),
    dayParts: [ { name: 'All week', fillerCollections: mix( [ [ 'Fill', 100 ] ] ), starts: [ { days: [0, 1, 2, 3, 4, 5, 6], time: 0 } ],
        midrolls: { count: 2 }, transitions: { midroll: { out: [ step('w', 'WB') ], in: [ step('b', 'BT') ] } } } ],
    programs, duration: programs.reduce( (a, p) => a + p.duration, 0 ), startTime: new RealDate(S - ms(45)).toISOString(), transcoding: {},
};

module.exports = async function run() {
    const suite = new Suite('midrolls through the router');
    const realSetTimeout = global.setTimeout;
    global.setTimeout = function () {
        const t = realSetTimeout.apply(this, arguments);
        if (t && (typeof(t.unref) === 'function')) {
            t.unref();
        }
        return t;
    };
    const logged = [];
    const realLog = console.log;
    console.log = function (first) {
        if ( (typeof(first) === 'string') && /^ {2}(PASS|FAIL) /.test(first) ) {
            realLog.apply(console, arguments);
        } else if (typeof(first) === 'string') {
            logged.push(first);
        }
    };
    let server = null;
    const savedPort = process.env.PORT;
    try {
        let switchOn = true;
        const scan = {
            midrollsOn: () => switchOn,
            pointsFor: (p) => (p.file === FG.file)
                ? { durationMs: FG.duration, points: [ { index: 0, at: 328, kind: 'act', by: 'auto', strength: 0.8 }, { index: 1, at: 948, kind: 'act', by: 'auto', strength: 0.8 } ] }
                : null,
        };
        const channelService = Object.assign(new EventEmitter(), { getChannel: async (n) => (n === 7 ? channel : null) });
        const fillerService = { getFillersFromCollections: async (ch, cols) => cols.map( (c) => ({ id: c.id, content: LISTS[c.id] || [], weight: c.weight, cooldown: c.cooldown }) ) };
        const settings = { ffmpegPath: process.execPath, enableFFMPEGTranscoding: true, disablePreludes: true, normalizeVideoCodec: true, normalizeAudioCodec: true, normalizeResolution: true, normalizeAudio: true };
        const db = { 'ffmpeg-settings': { find: () => [ settings ] } };
        const programmingService = { getCurrentProgramAndTimeElapsed: helperFuncs.getCurrentProgramAndTimeElapsed };
        const activeChannelService = { peekChannel() {}, registerChannelActive() {}, registerChannelStopped() {} };
        const video = loadVideoWith( { '../src/ffmpeg': FakeFFMPEG, '../src/program-player': FakePlayer } );
        const app = express();
        app.use(video.router(channelService, fillerService, db, programmingService, activeChannelService, freshStore(), null, scan));
        server = await new Promise( (resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); } );
        const port = server.address().port;
        process.env.PORT = String(port);
        global.Date = FakeDate;

        const S1 = S;
        const describe = (i) => (i ? `${i.type} ${i.title} ${i.start}+${i.streamDuration}` : 'nothing');
        let session = 1000;
        // Viewers, each with its next request's time; the earliest goes next, the clock set to it.
        const run = async (viewers, until, onEach) => {
            while (true) {
                const next = viewers.filter( (v) => v.at < until ).sort( (a, b) => a.at - b.at )[0];
                if (next == null) {
                    return;
                }
                fakeNow = next.at;
                const before = played.length;
                await get(port, `/stream?channel=7&session=${session++}${next.id ? `&stream=${next.id}` : ''}${next.first ? '&first=1' : ''}`);
                const item = played[before];
                next.first = false;
                next.items.push(Object.assign( { at: fakeNow }, item ));
                next.nextAt = null;
                if (onEach) {
                    await onEach(next, item);
                }
                next.at = (next.nextAt != null) ? next.nextAt : fakeNow + Math.max(1, item.streamDuration);
            }
        };
        const names = (v) => v.items.filter( (i) => i.type !== 'commercial' ).map( (i) => (i.type === 'program') ? `${i.title} ${i.start}+${i.streamDuration}` : i.title );
        // the commercials a viewer started after `from` and before `to`
        const commercialsIn = (v, from, to) => v.items.filter( (i) => (i.type === 'commercial') && (i.at > from) && (i.at < to) ).map( (i) => i.title );

        // ---- two viewers ------------------------------------------------------------------------
        {
            const A = { id: 'viewerA', at: S - 20 * SEC, items: [] };
            // A into midroll 1 until it has a commercial of 25 s or more on the air; B tunes in 12 s
            // into it, past the replay cache's 10 s "reconnect" window, with 10 s still to go, so
            // it joins that commercial partway (channel-cache.js, shared-breaks.js)
            let onAir = null;
            for (let until = S + 333000; onAir === null; ) {
                until = A.at + 1;
                await run( [ A ], until );
                const last = A.items[A.items.length - 1];
                if ( (last.type === 'commercial') && (last.at >= S + 333000) && (last.streamDuration >= 25 * SEC) ) {
                    onAir = last;
                }
            }
            const B = { id: 'viewerB', at: onAir.at + 12 * SEC, items: [], first: true };
            await run( [ A, B ], S + ms(30, 20) );
            suite.check('viewer A from 12:29:40: part 1, WBRB, BTTS, part 2, WBRB, BTTS, part 3, Robot Chicken from its start',
                JSON.stringify(names(A)) === JSON.stringify( [ 'Death Is a Bitch 0+328000', 'WBRB', 'BTTS', 'Death Is a Bitch 328000+620000', 'WBRB', 'BTTS', 'Death Is a Bitch 948000+409000', 'Robot Chicken 0+660000' ] ),
                names(A).join(', '));
            const rc = A.items.find( (i) => i.title === 'Robot Chicken' );
            suite.check('...Robot Chicken at 1:00:00, within today\'s 30 s early / 10 s late', (rc != null) && (rc.at >= S + ms(30) - 30 * SEC) && (rc.at <= S + ms(30) + SLACK),
                rc ? `${(rc.at - S - ms(30)) / 1000}s` : 'never');
            const bFirst = B.items[0];
            const aThen = onAir;
            suite.check("viewer B tuning in during midroll 1: the commercial on the air, joined 12 s in",
                (bFirst != null) && (bFirst.type === 'commercial') && (aThen.type === 'commercial') && (aThen.at > S + 328000) && (bFirst.title === aThen.title) && (bFirst.start === aThen.start + 12 * SEC),
                `${describe(bFirst)} / A's ${describe(aThen)} at ${aThen ? aThen.at - S : ''}`);
            suite.check('...then the same as A: BTTS, part 2, WBRB, BTTS, part 3, Robot Chicken',
                JSON.stringify(names(B)) === JSON.stringify(names(A).slice(2)), names(B).join(', '));
            const m1a = commercialsIn(A, B.items[0].at, S + 476000);
            const m1b = commercialsIn(B, B.items[0].at, S + 476000);
            const m2a = commercialsIn(A, S + 1096000, S + 1244000);
            const m2b = commercialsIn(B, S + 1096000, S + 1244000);
            suite.check('...and the same commercials in both midrolls', (m1a.length > 0) && (JSON.stringify(m1a) === JSON.stringify(m1b)) && (m2a.length > 0) && (JSON.stringify(m2a) === JSON.stringify(m2b)),
                `M1 ${m1a.join(',')} / ${m1b.join(',')}; M2 ${m2a.join(',')} / ${m2b.join(',')}`);
            const bParts = B.items.filter( (i) => i.type === 'program' && i.title === FG.title );
            const aParts = A.items.filter( (i) => i.type === 'program' && i.title === FG.title );
            suite.check('...B\'s parts start within a second of A\'s', bParts.every( (p, k) => Math.abs(p.at - aParts[k + 1].at) <= SEC ),
                bParts.map( (p, k) => p.at - aParts[k + 1].at ).join(', '));
            const layoutLines = logged.filter( (l) => l.startsWith('Midroll layout, channel 7') );
            const planLines = logged.filter( (l) => l.startsWith('Midroll plan, channel 7') );
            suite.check('the log: one "Midroll layout" line for the airing, one "Midroll plan" per midroll',
                (layoutLines.length === 1) && (planLines.length === 2) && planLines[0].includes('WBRB -> commercials -> BTTS'), layoutLines.concat(planLines).join(' || '));
            suite.check('...and a "! Part" line for each part played (A three, B two)', logged.filter( (l) => /^! Part : [123] of 3$/.test(l) ).length === 5);
        }

        // ---- a save during part 2, the next airing (the clock only moves forward, as play times expect)
        {
            const S = S1 + ms(45);
            channelCache.clear();
            channelCache.forgetFrozenLayouts();
            const A = { id: 'saver', at: S + ms(7, 0), items: [] };
            let saved = false;
            await run( [ A ], S + ms(30, 20), async (v, item) => {
                if (! saved && (item.type === 'program') && (item.start === 328000)) {
                    saved = true;
                    channelCache.saveChannelConfig(7, channel);
                    // the stream stopped by the save reconnects 3 minutes in
                    v.nextAt = fakeNow + ms(3);
                    v.items.push( { reconnect: true } );
                    return;
                }
            } );
            const after = A.items.slice(A.items.findIndex( (i) => i.reconnect === true ) + 1);
            const first = after[0];
            suite.check('a save 3 minutes into part 2: the stream comes back in part 2 at its own second, from the save\'s resume hint',
                (first != null) && (first.type === 'program') && (first.start >= 328000 + ms(3)) && (first.start < 328000 + ms(3) + SLACK) && (first.start + first.streamDuration === 948000),
                describe(first));
            suite.check('...and goes on: WBRB, BTTS, part 3, Robot Chicken from its start',
                JSON.stringify(names( { items: after } ).slice(1)) === JSON.stringify( [ 'WBRB', 'BTTS', 'Death Is a Bitch 948000+409000', 'Robot Chicken 0+660000' ] ), names( { items: after } ).join(', '));

            // A hint 12 s old from an item playing Family Guy whole (15:40 then, 20 s ahead of the clock),
            // the clock now in part 2's last 16 s: the hint lies past the part, so the clock decides -
            // the part's own last 16 s, never a second beyond it. (A part's own hint cannot: the
            // channel cache drops a hint that would land past the end of its item.)
            const t1 = S + ms(45) + 1080000;   // the next airing's part 2, 16 s before it ends (file 15:32)
            channelCache.clear();
            channelCache.forgetFrozenLayouts();
            channelCache.recordPlayback(freshStore(), 7, t1 - 12 * SEC, { type: 'program', title: FG.title, key: FG.key, serverKey: FG.serverKey,
                start: 940000, streamDuration: FG.duration - 940000, duration: FG.duration, redirectChannels: [ { number: 7 } ] });
            channelCache.saveChannelConfig(7, channel);
            fakeNow = t1;
            const before = played.length;
            await get(port, `/stream?channel=7&session=${session++}&stream=hinted`);
            const back = played[before];
            suite.check('a save\'s resume hint past the end of the part is not used: the clock\'s second of part 2, to its end',
                (back != null) && (back.start === 932000) && (back.streamDuration === 16000), describe(back));
        }

        // ---- the switch turned off during the airing, the one after ---------------------------------------
        {
            const S = S1 + ms(90);
            channelCache.clear();
            channelCache.forgetFrozenLayouts();
            switchOn = true;
            const A = { id: 'offer', at: S - 5 * SEC, items: [] };
            await run( [ A ], S + ms(30, 20), async (v, item) => {
                if ( (item.type === 'program') && (item.start === 0) && (item.title === FG.title) ) {
                    switchOn = false;
                }
            } );
            suite.check('the switch turned off during part 1: this airing still plays its midrolls',
                JSON.stringify(names(A)) === JSON.stringify( [ 'Death Is a Bitch 0+328000', 'WBRB', 'BTTS', 'Death Is a Bitch 328000+620000', 'WBRB', 'BTTS', 'Death Is a Bitch 948000+409000', 'Robot Chicken 0+660000' ] ),
                names(A).join(', '));
            const C = { id: 'nextAiring', at: S + ms(45) - 5 * SEC, items: [] };
            await run( [ C ], S + ms(46) );
            suite.check('...and its next airing plays Family Guy whole', (C.items.find( (i) => i.title === FG.title ) || {}).streamDuration === FG.duration,
                describe(C.items.find( (i) => i.title === FG.title )));
            switchOn = true;
        }

        // ---- the switch turned on during an airing that started without midrolls ---------------------
        {
            const S = S1 + ms(225);
            channelCache.clear();
            channelCache.forgetFrozenLayouts();
            switchOn = false;
            const A = { id: 'offFirst', at: S - 5 * SEC, items: [] };
            await run( [ A ], S + ms(1) );
            switchOn = true;
            const B = { id: 'onLater', at: S + ms(10), items: [], first: true };
            channelCache.clearPlayback(7);   // B by the clock, not A's replay cache
            await run( [ B ], S + ms(10) + 1 );
            const a = A.items.find( (i) => i.title === FG.title );
            const b = B.items[0];
            suite.check('switch off when Family Guy starts, then on: a viewer tuning in 10 minutes in gets it whole, as the first viewer has it',
                (a != null) && (a.streamDuration === FG.duration) && (b != null) && (b.type === 'program') && (b.start === ms(10)) && (b.part == null),
                `${describe(a)} / ${describe(b)}`);
        }

        // ---- /m3u8: no stream id, every item by the clock, two airings on ----------------------------------
        {
            const S = S1 + ms(270);
            channelCache.clear();
            channelCache.forgetFrozenLayouts();
            const M = { id: null, at: S - 5 * SEC, items: [] };
            await run( [ M ], S + ms(30, 20), async () => {
                channelCache.clearPlayback(7);
            } );
            const parts = M.items.filter( (i) => i.title === FG.title );
            const covered = parts.reduce( (acc, p) => acc + p.streamDuration, 0 );
            suite.check('/m3u8 by the clock alone: Family Guy\'s three parts in order, all of it once',
                (parts.length === 3) && (parts[0].start === 0) && (parts[1].start === 328000) && (parts[2].start === 948000) && (covered === FG.duration),
                parts.map(describe).join(' | '));
            const rc = M.items.find( (i) => i.title === 'Robot Chicken' );
            suite.check('...Robot Chicken from its start, within 30 s early and 10 s late, as after any break today', (rc != null) && (rc.start === 0) && (rc.at >= S + ms(30) - 30 * SEC) && (rc.at <= S + ms(30) + SLACK), rc ? `${(rc.at - S - ms(30)) / 1000}s` : 'never');
        }

        // ---- a tune-in during a midroll's out step, before any commercial of it is picked ----------
        // (seen live Nov 19: the tune-in took a commercial of its own, partway, and A then picked another)
        {
            const S = S1 + ms(315);
            channelCache.clear();
            channelCache.forgetFrozenLayouts();
            // A tunes in 1 s into part 1, which the 30 s rewind plays from 0: its WBRB at 5:29, a
            // second behind the layout's midroll (5:28). C tunes in at 5:30, by the clock in the
            // midroll's out step, while A is in its WBRB and no commercial has been picked yet.
            const A = { id: 'watching', at: S + 1 * SEC, items: [], first: true };
            let wb = null;
            while (wb === null) {
                await run( [ A ], A.at + 1 );
                const last = A.items[A.items.length - 1];
                if (last.title === 'WBRB') {
                    wb = last;
                }
            }
            const C = { id: 'tunedFirst', at: S + 330 * SEC, items: [], first: true };
            await run( [ A, C ], S + 500 * SEC );
            const ma = commercialsIn(A, wb.at, S + 476 * SEC);
            const mc = commercialsIn(C, wb.at, S + 476 * SEC);
            const cFirst = C.items[0];
            suite.check('a tune-in 2 s into midroll 1, A still in its WBRB: the WBRB from its start, not commercials ahead of A',
                (wb.at === S + 329 * SEC) && (cFirst != null) && (cFirst.title === 'WBRB') && (cFirst.start === 0),
                `A's WBRB at ${(wb.at - S) / 1000}s; C ${describe(cFirst)}`);
            // C is about a second behind A: the commercials end where the in step begins by the clock,
            // so C may stop one short of A at the end (the spec's "a late stream gets fewer")
            const cCommercial = C.items.find( (i) => i.type === 'commercial' );
            suite.check('...then the midroll\'s commercials from the first, A\'s in the same order (at most one fewer at the end)',
                (mc.length > 0) && (cCommercial != null) && (cCommercial.start === 0) && (JSON.stringify(mc) === JSON.stringify(ma.slice(0, mc.length)))
                    && (ma.length - mc.length <= 1),
                `A ${ma.join(',')} / C ${mc.join(',')}`);
            suite.check('...then BTTS and part 2, as A', JSON.stringify(names(C)) === JSON.stringify(names(A).slice(1, names(C).length + 1))
                && names(C).includes('Death Is a Bitch 328000+620000'), `A ${names(A).join(', ')} / C ${names(C).join(', ')}`);
        }

        // ---- a tune-in in a midroll's commercials before the viewer watching (9 s late) reaches them ----
        {
            const S = S1 + ms(360);
            channelCache.clear();
            channelCache.forgetFrozenLayouts();
            // A tunes in 9 s into part 1, played from 0: its WBRB at 5:37, its commercials from 5:42.
            // C tunes in at 5:34, by the clock 1 s into the midroll's commercials, none picked yet.
            const A = { id: 'lateViewer', at: S + 9 * SEC, items: [], first: true };
            const C = { id: 'tunedEarly', at: S + 334 * SEC, items: [], first: true };
            await run( [ A, C ], S + 500 * SEC );
            const wb = A.items.find( (i) => i.title === 'WBRB' );
            const ma = commercialsIn(A, S + 328 * SEC, S + 476 * SEC);
            const mc = commercialsIn(C, S + 328 * SEC, S + 476 * SEC);
            const cFirst = C.items[0];
            suite.check('a tune-in 1 s into midroll 1\'s commercials, the viewer watching 9 s behind: a commercial from its start, which A then plays',
                (wb != null) && (wb.at === S + 337 * SEC) && (cFirst != null) && (cFirst.type === 'commercial') && (cFirst.start === 0) && (cFirst.title === ma[0]),
                `A's WBRB at ${wb ? (wb.at - S) / 1000 : '-'}s; C ${describe(cFirst)}; A's first ${ma[0]}`);
            suite.check('...and A plays C\'s commercials in the same order (at most one fewer at the end, 8 s behind)',
                (ma.length > 0) && (JSON.stringify(ma) === JSON.stringify(mc.slice(0, ma.length))) && (mc.length - ma.length <= 1),
                `A ${ma.join(',')} / C ${mc.join(',')}`);
        }
    } catch (err) {
        suite.check('the router test ran', false, err && err.stack);
    } finally {
        global.Date = RealDate;
        fakeNow = null;
        console.log = realLog;
        global.setTimeout = realSetTimeout;
        process.env.PORT = savedPort;
        if (server) {
            server.close();
        }
        channelCache.clear();
        channelCache.forgetFrozenLayouts();
    }
    return suite;
};

if (require.main === module) {
    module.exports().then( (suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
        setTimeout( () => process.exit(), 200).unref();
    } );
}
