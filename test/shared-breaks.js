/*
 * Two viewers of one channel took turns with the offline screen during
 * commercial breaks (NOTES.md, "Two viewers of a channel took turns with the
 * offline screen"). These are the three fixes' checks:
 *
 *   B  a list whose clip is still on the air is not cooling down
 *   A  one list of Flex picks per break, per channel, shared by its viewers
 *   C  a leftover too short for any clip ends the break, under 30 seconds
 *
 * Fixtures only: createLineup with a stub play-time store, and the real
 * video.js router on a fake clock for the viewer-level checks.
 */
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');
const express = require('express');
const { helperFuncs, channelCache, freshStore, Suite } = require('./support');
const sharedBreaks = require('../src/shared-breaks');
const lineupCursor = require('../src/lineup-cursor');

const SEC = 1000;

function breakObj(leftMs) {
    return { program: { isOffline: true, duration: leftMs }, timeElapsed: 0, programIndex: 0 };
}
function listChannel() {
    return { number: 7, name: 'B', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0, fillerCollections: [] };
}
function clips(prefix, n, secs) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ title: `${prefix}${i}`, key: `/f/${prefix}${i}`, duration: secs * SEC, serverKey: 'srv' });
    return out;
}
const listKey = (id) => '!fillerList!|' + id;
const clipKey = (c) => 'plex|' + c.serverKey + '|' + c.key;

function checkB(suite) {
    const content = clips('Ad', 3, 30);
    const fillers = (cooldown) => [{ id: 'L', content, weight: 100, cooldown }];

    // A clip from the list on the air for another viewer, 25 seconds to go.
    let offline = 0, sawOnAir = 0;
    for (let k = 0; k < 60; k++) {
        const store = freshStore();
        const now = Date.now();
        store.update(7, listKey('L'), now + 25 * SEC);
        store.update(7, clipKey(content[0]), now + 25 * SEC);
        const item = helperFuncs.createLineup(store, breakObj(120 * SEC), listChannel(), fillers(0), false)[0];
        if (item.type !== 'commercial') offline++;
        if (item.title === content[0].title) sawOnAir++;
    }
    suite.check('B: a list with no cooldown whose clip is on the air elsewhere for 25s more still plays (60 of 60)',
        offline === 0, `${offline} offline`);
    suite.check('B: ... and never the clip that is on the air', sawOnAir === 0, `${sawOnAir} times`);

    {
        const store = freshStore();
        const now = Date.now();
        store.update(7, listKey('L'), now + 5 * SEC);
        const item = helperFuncs.createLineup(store, breakObj(120 * SEC), listChannel(), fillers(0), false)[0];
        suite.check('B: one ending within 10s plays, as before', item.type === 'commercial', item.type);
    }
    {
        // A configured cooldown still runs from the end of the clip.
        const store = freshStore();
        const now = Date.now();
        store.update(7, listKey('L'), now + 25 * SEC);
        const item = helperFuncs.createLineup(store, breakObj(300 * SEC), listChannel(), fillers(60 * SEC), false)[0];
        suite.check('B: a list with a 60s cooldown whose clip ends in 25s is still refused',
            item.type === 'offline', item.type);
        suite.check('B: ... and the wait is counted from the end of that clip: 25s + 60s',
            Math.abs(item.streamDuration - 85 * SEC) < 200, `${item.streamDuration}ms`);
    }
    {
        const store = freshStore();
        const now = Date.now();
        store.update(7, listKey('L'), now - 70 * SEC);
        const item = helperFuncs.createLineup(store, breakObj(120 * SEC), listChannel(), fillers(60 * SEC), false)[0];
        suite.check('B: the same list 70s after its clip ended plays', item.type === 'commercial', item.type);
    }
}

// ------------------------------------------------------------------ A, pure

function checkDecide(suite) {
    const item = (title, secs, start) => ({ type: 'commercial', title, key: '/f/' + title, serverKey: 'srv',
        start: start || 0, duration: secs * SEC, streamDuration: secs * SEC - (start || 0), fillerId: 'L' });
    const log = { picks: [{ at: 1000 * SEC, item: item('P0', 30) }, { at: 1030 * SEC, item: item('P1', 60) }] };
    let d = sharedBreaks.decide(null, 0, 120 * SEC, 0, false);
    suite.check('A: the first viewer of a break makes pick 0', d.kind === 'new' && d.index === 0 && d.next === 1, JSON.stringify(d));
    d = sharedBreaks.decide(log, 0, 100 * SEC, 1001 * SEC, false);
    suite.check('A: a viewer at pick 0 replays it from its start, marked as already counted',
        d.kind === 'replay' && d.item.title === 'P0' && d.item.start === 0 && d.item.streamDuration === 30 * SEC
            && d.item.sharedPick === true && d.next === 1, JSON.stringify(d));
    suite.check('A: ... and the list itself is left as it was', log.picks[0].item.sharedPick === undefined);
    d = sharedBreaks.decide(log, 2, 100 * SEC, 1091 * SEC, false);
    suite.check('A: past the end of the list it makes the next pick', d.kind === 'new' && d.index === 2 && d.next === 3, JSON.stringify(d));
    d = sharedBreaks.decide(log, 1, 45 * SEC, 1031 * SEC, false);
    suite.check('A: a 60s pick with 45s left (more than SLACK short) is not replayed: a pick of its own, off the list',
        d.kind === 'own' && d.next === -1, JSON.stringify(d));
    d = sharedBreaks.decide(log, 1, 52 * SEC, 1031 * SEC, false);
    suite.check('A: ... with 52s left it fits, as any clip within SLACK does', d.kind === 'replay', d.kind);
    d = sharedBreaks.decide(log, -1, 100 * SEC, 1031 * SEC, false);
    suite.check('A: off the list stays off it for the rest of the entry', d.kind === 'own' && d.next === -1, d.kind);
    d = sharedBreaks.decide(log, undefined, 100 * SEC, 1040 * SEC, true);
    suite.check('A: tuning in joins the pick on the air, 10s into it',
        d.kind === 'join' && d.item.title === 'P1' && d.item.start === 10 * SEC && d.item.streamDuration === 50 * SEC
            && d.item.sharedPick === true && d.next === 2, JSON.stringify(d));
    d = sharedBreaks.decide(log, undefined, 100 * SEC, 1085 * SEC, true);
    suite.check('A: with under SLACK of it left, a tune-in picks its own (it starts partway) and then follows the list',
        d.kind === 'own' && d.next === 2, JSON.stringify(d));
    d = sharedBreaks.decide(log, undefined, 100 * SEC, 1095 * SEC, false);
    suite.check('A: with nothing on the air, a request with no cursor makes the next pick', d.kind === 'new' && d.index === 2, JSON.stringify(d));

    const programs = [{ title: 'A', key: '/p/A', duration: 600 * SEC }, { isOffline: true, duration: 180 * SEC }];
    const ch = { number: 1, programs };
    const flexObj = { program: programs[1], programIndex: 1, timeElapsed: 5 * SEC, startsIn: 0 };
    suite.check('A: a Flex entry of the lineup is shareable', sharedBreaks.shareable(ch, flexObj));
    suite.check('A: a show is not', !sharedBreaks.shareable(ch, { program: programs[0], programIndex: 0, timeElapsed: 0 }));
    suite.check('A: a transition step is not', !sharedBreaks.shareable(ch, Object.assign({ transition: { durationMs: 1 } }, flexObj)));
    suite.check('A: Flex made up by video.js (not the lineup\'s own entry) is not',
        !sharedBreaks.shareable(ch, { program: { isOffline: true, duration: 1 }, programIndex: 1, timeElapsed: 0 }));
    suite.check('A: an on-demand channel is not',
        !sharedBreaks.shareable(Object.assign({ onDemand: { isOnDemand: true } }, ch), flexObj));
    suite.check('A: the cursor and the clock name an entry the same way',
        sharedBreaks.keyOf(flexObj, 2005 * SEC) === sharedBreaks.keyOf({ program: programs[1], programIndex: 1, lineupStart: 2000 * SEC }, 0),
        `${sharedBreaks.keyOf(flexObj, 2005 * SEC)}`);
}

// ---------------------------------------------------- A, through the router

const RealDate = Date;
let fakeNow = null;
class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0 && fakeNow !== null) super(fakeNow); else super(...args); }
    static now() { return (fakeNow !== null) ? fakeNow : RealDate.now(); }
}
let lastItem = null;
class FakePlayer {
    constructor(context) { lastItem = context.lineupItem; }
    cleanUp() {}
    async play(res) {
        const e = new EventEmitter();
        setImmediate(() => { res.write(Buffer.from('x')); e.emit('end'); });
        return e;
    }
}
function loadVideo() {
    const srcDir = path.join(__dirname, '..', 'src') + path.sep;
    const before = new Set(Object.keys(require.cache));
    const pp = require.resolve('../src/program-player');
    const savedPP = require.cache[pp];
    require.cache[pp] = { id: pp, filename: pp, loaded: true, exports: FakePlayer, children: [], paths: [] };
    const vp = require.resolve('../src/video');
    const savedVideo = require.cache[vp];
    delete require.cache[vp];
    try {
        return require('../src/video');
    } finally {
        delete require.cache[vp];
        if (savedVideo) require.cache[vp] = savedVideo;
        if (savedPP) require.cache[pp] = savedPP; else delete require.cache[pp];
        for (const key of Object.keys(require.cache)) {
            if (key.startsWith(srcDir) && !before.has(key) && key !== require.resolve('../src/channel-cache')
                && key !== require.resolve('../src/helperFuncs')) delete require.cache[key];
        }
    }
}

async function checkRouter(suite) {
    const realSetTimeout = global.setTimeout;
    global.setTimeout = function () { const t = realSetTimeout.apply(this, arguments); if (t && t.unref) t.unref(); return t; };
    const realLog = console.log;
    console.log = function (first) { if (typeof first === 'string' && /^ {2}(PASS|FAIL) /.test(first)) realLog.apply(console, arguments); };
    let server = null;
    const savedPort = process.env.PORT;
    try {
        const T = RealDate.now() - (RealDate.now() % (60 * SEC)) + 3600 * SEC;   // a round minute an hour ahead
        // A 10 minute show, a 4 minute break, another show; and the same with a
        // 10s out step and a 10s in step around the break (channel 12).
        const mkPrograms = (tag) => [
            { title: 'A' + tag, key: '/p/A' + tag, duration: 600 * SEC, serverKey: 'srv' },
            { isOffline: true, duration: 240 * SEC },
            { title: 'B' + tag, key: '/p/B' + tag, duration: 600 * SEC, serverKey: 'srv' },
        ];
        const ads = clips('Ad', 12, 30).concat(clips('Short', 4, 12));
        const OUT = clips('Out', 2, 10), IN = clips('In', 2, 10);
        const anyStep = (id, listId) => ({ id, kind: 'list', listId, match: 'any', keyedOn: 'next', fallbackListId: null, onlyIfNoMatch: null });
        const base = (number, programs) => ({
            number, name: 'Shared ' + number, offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0,
            fillerCollections: [{ id: 'ADS', weight: 100, cooldown: 0 }], programs,
            duration: programs.reduce((a, p) => a + p.duration, 0), startTime: new RealDate(T).toISOString(), transcoding: {},
        });
        const plain = base(11, mkPrograms('11'));
        const stepped = base(12, mkPrograms('12'));
        stepped.dayParts = [{ name: 'All week', fillerCollections: [{ id: 'ADS', weight: 100, cooldown: 0 }],
            starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 0 }],
            transitions: { betweenShows: { out: [anyStep('o', 'OUT')], in: [anyStep('i', 'IN')] } } }];
        const channels = { 11: plain, 12: stepped };
        const lists = { ADS: ads, OUT, IN };
        const channelService = Object.assign(new EventEmitter(), { getChannel: async (n) => channels[n] || null });
        const fillerService = { getFillersFromCollections: async (ch, cols) => cols.map((c) => ({
            id: c.id, content: lists[c.id] || [], weight: c.weight, cooldown: c.cooldown })) };
        const settings = { ffmpegPath: process.execPath, enableFFMPEGTranscoding: true, disablePreludes: true };
        const db = { 'ffmpeg-settings': { find: () => [settings] } };
        const programmingService = { getCurrentProgramAndTimeElapsed: helperFuncs.getCurrentProgramAndTimeElapsed };
        const activeChannelService = { peekChannel() {}, registerChannelActive() {}, registerChannelStopped() {} };
        let requester = null;
        const writes = [];   // [requester, key] for every play time recorded
        const store = freshStore();
        const realUpdate = store.update;
        store.update = (c, k, v) => { writes.push([requester, k]); return realUpdate(c, k, v); };

        const video = loadVideo();
        const app = express();
        app.use(video.router(channelService, fillerService, db, programmingService, activeChannelService, store));
        server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        process.env.PORT = String(server.address().port);
        const get = (p) => new Promise((resolve, reject) => {
            const r = http.get({ host: '127.0.0.1', port: server.address().port, path: p, agent: false }, (res) => { res.resume(); res.on('end', resolve); });
            r.on('error', reject);
        });
        global.Date = FakeDate;

        // Viewers on a fake clock: each asks again when its item has played,
        // plus a fixed start-up delay. Returns each viewer's items in order.
        let session = 500;
        const watch = async (number, viewers, until) => {
            const seen = {};
            for (const v of viewers) { seen[v.name] = []; v.session = session++; }
            while (true) {
                viewers.sort((a, b) => a.at - b.at);
                const v = viewers[0];
                if (v.at >= until) break;
                fakeNow = v.at;
                lastItem = null;
                requester = v.name;
                await get(`/stream?channel=${number}&session=${v.session}&stream=${v.name}` + (v.first ? '&first=1' : ''));
                v.first = false;
                const it = lastItem;
                it.$at = fakeNow;   // when it was asked for
                seen[v.name].push(it);
                v.at = fakeNow + it.streamDuration + (v.delay || 300);
            }
            requester = null;
            return seen;
        };
        const flexOf = (items) => items.filter((i) => i.type === 'commercial' || i.type === 'offline' || i.type === 'transition')
            .map((i) => (i.type === 'offline' ? '[offline]' : i.title));
        const follow = (name, number, at, delay) => {
            const ch = channels[number];
            fakeNow = at;   // the cursor store sweeps cursors idle for an hour, by this clock
            channelCache.setCursor(name, { channel: number, index: 0, end: T + 600 * SEC, inBreak: false,
                fingerprint: lineupCursor.fingerprint(ch.programs[0]) });
            return { name, at, delay };
        };

        // Two viewers 3s apart through the break.
        let seen = await watch(11, [follow('one', 11, T + 600 * SEC, 300), follow('two', 11, T + 603 * SEC, 300)], T + 860 * SEC);
        const a = flexOf(seen.one), b = flexOf(seen.two);
        // The leader may end its break on a clip that runs into SLACK; 3s
        // behind, that one may not fit, and the follower picks its own.
        const twoAds = seen.two.filter((i) => i.type === 'commercial');
        suite.check('A: two viewers 3s apart see the same commercials in the same order, all but at most the break\'s last',
            a.length > 4 && a.slice(0, -1).join('|') === b.slice(0, -1).join('|')
                && twoAds.slice(0, -1).every((i) => i.sharedPick === true), `${a.join(', ')}\n        vs ${b.join(', ')}`);
        suite.check('A: ... and neither gets the offline screen', !a.includes('[offline]') && !b.includes('[offline]'));
        suite.check('A: ... and both go on to the show after the break, from its start',
            seen.one[seen.one.length - 1].title === 'B11' && seen.two[seen.two.length - 1].title === 'B11'
                && seen.two[seen.two.length - 1].start === 0);
        const ownByTwo = new Set(twoAds.filter((i) => i.sharedPick !== true).map((i) => 'plex|' + i.serverKey + '|' + i.key));
        const byTwo = writes.filter(([who, k]) => who === 'two' && k !== 'plex|srv|/p/B11'
            && !(k === listKey('ADS') && ownByTwo.size > 0) && !ownByTwo.has(k));
        suite.check('A: play times are recorded once per pick: the second viewer records none for the picks it shares',
            byTwo.length === 0 && twoAds.length > 4, byTwo.slice(0, 3).map((w) => w[1]).join(', '));
        suite.check('A: ... while the first recorded every one', writes.some(([who, k]) => who === 'one' && k === listKey('ADS')));

        // The second viewer 25s behind: the break's last shared pick may not
        // fit what it has left, and it then picks its own - never the offline screen.
        channelCache.clear();
        seen = await watch(11, [follow('lead', 11, T + 600 * SEC, 300), follow('late', 11, T + 625 * SEC, 300)], T + 870 * SEC);
        const lead = flexOf(seen.lead), late = flexOf(seen.late);
        let same = 0;
        while (same < Math.min(lead.length, late.length) && lead[same] === late[same]) same++;
        suite.check('A: a viewer 25s behind shares every pick that still fits it, and only the end differs',
            same >= late.length - 1 && same >= 4, `${same} shared of ${late.length}: ${lead.join(', ')}\n        vs ${late.join(', ')}`);
        suite.check('A: ... and gets no offline screen', !late.includes('[offline]'), late.join(', '));
        const lastLate = seen.late.filter((i) => i.type === 'commercial').pop();
        suite.check('A: ... and its break still ends on time: its last clip fits what it had left',
            seen.late[seen.late.length - 1].title === 'B11', lastLate && `${lastLate.title} ${lastLate.streamDuration}`);

        // Tuning in mid-break with no replay cache: joins the pick on the air, partway.
        channelCache.clear();
        seen = await watch(11, [follow('host', 11, T + 600 * SEC, 300)], T + 700 * SEC);
        channelCache.clearPlayback(11);
        // 5s into the host's last commercial of 20s or more, so it is plainly on the air
        const hostAds = seen.host.filter((i) => i.type === 'commercial');
        const onAirIndex = hostAds.map((i) => i.streamDuration >= 20 * SEC).lastIndexOf(true);
        const onAir = hostAds[onAirIndex];
        fakeNow = onAir.$at + 5 * SEC;
        lastItem = null;
        await get(`/stream?channel=11&session=${session++}&first=1&stream=tuner`);
        suite.check('A: a viewer tuning in mid-break joins the commercial on the air, partway, as on TV',
            lastItem && lastItem.title === onAir.title && lastItem.start > 0, lastItem && `${lastItem.title} from ${lastItem.start}`);
        const tunerCursor = channelCache.getCursor('tuner');
        suite.check('A: ... and its cursor follows the list from there', tunerCursor && tunerCursor.pick === onAirIndex + 1,
            JSON.stringify(tunerCursor));

        // A save drops the lists, like the plans.
        const key = sharedBreaks.keyOf({ programIndex: 1, lineupStart: T + 600 * SEC }, 0);
        suite.check('A: the break has a list', channelCache.getFlexLog(11, key) !== null);
        channelCache.saveChannelConfig(11, plain);
        suite.check('A: saving the channel drops it', channelCache.getFlexLog(11, key) === null);

        // A break with transition steps: the same steps and the same Flex.
        channelCache.clear();
        seen = await watch(12, [follow('s1', 12, T + 600 * SEC, 300), follow('s2', 12, T + 602 * SEC, 300)], T + 845 * SEC);
        const s1 = flexOf(seen.s1), s2 = flexOf(seen.s2);
        suite.check('A: in a break with steps, both viewers get the same out step, Flex and in step',
            s1.length > 4 && s1[0].startsWith('Out') && s1[s1.length - 1].startsWith('In') && s1.join('|') === s2.join('|'),
            `${s1.join(', ')}\n        vs ${s2.join(', ')}`);

        // One viewer: every Flex request makes the next pick, as the picker always did.
        channelCache.clear();
        seen = await watch(11, [follow('alone', 11, T + 600 * SEC, 300)], T + 845 * SEC);
        const log = channelCache.getFlexLog(11, key);
        const alone = seen.alone.filter((i) => i.type === 'commercial');
        suite.check('A: a lone viewer makes every pick itself, and nothing it plays is marked as shared',
            log && log.picks.length === alone.length && alone.every((i) => i.sharedPick !== true),
            `${log && log.picks.length} picks, ${alone.length} clips`);
    } catch (err) {
        suite.check('A: the router checks ran', false, err && err.stack);
    } finally {
        global.Date = RealDate;
        fakeNow = null;
        console.log = realLog;
        global.setTimeout = realSetTimeout;
        process.env.PORT = savedPort;
        if (server) server.close();
        channelCache.clear();
    }
}

module.exports = async function run() {
    const suite = new Suite('shared-breaks');
    checkB(suite);
    checkDecide(suite);
    await checkRouter(suite);
    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
