/*
 * Three things that don't fit the acceptance table: a long break spanning a
 * day-part boundary keeps one mix throughout (open question 2), list
 * cooldowns survive a restart (open question 3), and no clip is credited to
 * the wrong list (the defect persisting them exposed - see NOTES.md's
 * Resolved section).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ProgramPlayTimeDB = require('../src/dao/program-play-time-db');
const { helperFuncs, channelCache, MIN, HOUR, at, freshStore, clip, show, Suite } = require('./support');

const owner = {};
function list(id, n, mins) {
    const content = [];
    for (let i = 1; i <= n; i++) {
        const title = `${id}#${i}`;
        owner[title] = id;
        content.push(clip(title, mins || 2));
    }
    return { id, content, weight: 100, cooldown: 0 };
}

// Replays the loop video.js actually runs: one createLineup call per filler
// clip, each with a fresh wall-clock t0, recording playback exactly as
// channelCache.recordPlayback does after every /stream request.
function replay(channel, fillers, breakStart, opts) {
    opts = opts || {};
    // channel-cache's playback cache is module-level and keyed by channel
    // number, so each replay of a channel number starts from a clean slate
    // regardless of what an earlier scenario in this process left behind.
    channelCache.clearPlayback(channel.number);
    const store = freshStore();
    const picks = [];
    let t0 = breakStart;
    const end = breakStart + (opts.breakMins || 60) * MIN;
    const index = opts.programIndex === undefined ? 1 : opts.programIndex;
    for (let step = 0; step < 300 && t0 < end; step++) {
        let item = channelCache.getCurrentLineupItem(channel.number, t0);
        if (item == null) {
            const obj = { program: channel.programs[index], timeElapsed: t0 - breakStart, programIndex: index };
            item = helperFuncs.createLineup(store, obj, channel, fillers, false, t0).shift();
            picks.push({ t0, from: owner[item.title] || `<${item.type}>` });
        }
        channelCache.recordPlayback(store, channel.number, t0, item);
        t0 += item.streamDuration;
    }
    return picks;
}

module.exports = async function run() {
    const suite = new Suite('blocks-persistence');

    // ------------------------------------------------------------ long break
    // Monday: day programming until 7:30pm, an hour of Flex, then Nick at
    // Nite starting 8:00pm. The break straddles that boundary.
    const nick = {
        number: 40, name: 'Nick Picks', offlineMode: 'pic', fallback: [],
        fillerRepeatCooldown: 3 * MIN,
        fillerCollections: [{ id: 'day', weight: 100, cooldown: 0 }],
        dayParts: [
            { name: '90s Nick', fillerCollections: [{ id: 'day', weight: 100, cooldown: 0 }],
              starts: [{ days: [1, 2, 3, 4], time: 6 * HOUR }] },
            { name: 'Nick at Nite', fillerCollections: [{ id: 'night', weight: 100, cooldown: 0 }],
              starts: [{ days: [1, 2, 3, 4], time: 20 * HOUR }] },
        ],
        programs: [show('Daytime', 90), { isOffline: true, duration: 60 * MIN }, show('Nite', 60)],
    };
    const fillers = [list('day', 6), list('night', 6)];
    const boundary = at('2026-01-05T20:00:00');
    const breakStart = at('2026-01-05T19:30:00');

    {
        const picks = replay(nick, fillers, breakStart);
        const before = picks.filter((p) => p.t0 < boundary);
        const after = picks.filter((p) => p.t0 >= boundary);
        const lists = [...new Set(picks.map((p) => p.from))];
        suite.check('long break: clips were drawn on both sides of the 8pm boundary',
            before.length > 3 && after.length > 3, `${before.length} before, ${after.length} after`);
        suite.check('long break spanning a boundary plays one mix throughout',
            lists.length === 1 && lists[0] === 'night', `${picks.length} picks, all from: ${lists.join(', ')}`);
    }

    {
        // Same window, no program neighbour: nothing anchors the break, so it
        // follows the clock and does change mix partway.
        const allFlex = Object.assign({}, nick, { programs: [{ isOffline: true, duration: 24 * HOUR }] });
        const picks = replay(allFlex, fillers, breakStart, { programIndex: 0 });
        const before = [...new Set(picks.filter((p) => p.t0 < boundary).map((p) => p.from))];
        const after = [...new Set(picks.filter((p) => p.t0 >= boundary).map((p) => p.from))];
        suite.check('all-Flex channel follows the clock across the same boundary',
            JSON.stringify(before) === '["day"]' && JSON.stringify(after) === '["night"]',
            `before ${before.join(',')} / after ${after.join(',')}`);
    }

    // ------------------------------------------------- list cooldown persistence
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-cache-'));
    try {
        const db = new ProgramPlayTimeDB(dir);
        const t = at('2026-01-05T12:00:00');

        channelCache.recordPlayback(db, 40, t, {
            title: 'night#1', key: '/f/night#1', serverKey: 'srv',
            fillerId: 'night', duration: 2 * MIN, start: 0, streamDuration: 2 * MIN,
        });
        // recordPlayback fires the write without the caller awaiting it, the
        // same way playback does - give it a moment to land on disk.
        await new Promise((resolve) => setTimeout(resolve, 200));

        const inMemory = channelCache.getFillerLastPlayTime(db, 40, 'night');
        suite.check('list play time is recorded', inMemory === t + 2 * MIN, `${inMemory}`);

        const restarted = new ProgramPlayTimeDB(dir);
        await restarted.load();
        const afterRestart = channelCache.getFillerLastPlayTime(restarted, 40, 'night');
        suite.check('list cooldown survives a restart', afterRestart === t + 2 * MIN,
            `was ${inMemory}, after reload ${afterRestart}`);
        suite.check('an unplayed list still reads 0',
            channelCache.getFillerLastPlayTime(restarted, 40, 'day') === 0);
        suite.check('the clip\'s own play time still round-trips too',
            restarted.getProgramLastPlayTime(40, 'plex|srv|/f/night#1') === t + 2 * MIN);

        const files = fs.readdirSync(path.join(dir, '40'))
            .map((f) => Buffer.from(f.slice(0, -5), 'base64').toString('utf-8')).sort();
        suite.check('the list key cannot collide with a program key',
            files.includes('!fillerList!|night') && files.includes('plex|srv|/f/night#1'),
            `keys on disk: ${files.map((k) => JSON.stringify(k)).join(', ')}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ------------------------------------------------------------- attribution
    // Regression for the fix in NOTES.md's Resolved section: before it, 54 of
    // 596 picks were credited to a list the clip does not belong to.
    {
        channelCache.clearPlayback(41);
        const ch = {
            number: 41, name: 'A', offlineMode: 'pic', fallback: [],
            fillerRepeatCooldown: 5 * MIN,
            fillerCollections: [{ id: 'listA', weight: 50, cooldown: 0 }, { id: 'listB', weight: 50, cooldown: 0 }],
            programs: [show('A', 30), { isOffline: true, duration: 600 * MIN }, show('B', 30)],
            startTime: at('2026-01-05T06:00:00'),
        };
        ch.duration = ch.programs.reduce((s, p) => s + p.duration, 0);
        const attributionFillers = [list('listA', 3), list('listB', 2, 3)];
        const store = freshStore();
        let total = 0;
        let wrong = 0;
        let t0 = at('2026-01-05T06:31:00');
        for (let i = 0; i < 2000; i++) {
            let item = channelCache.getCurrentLineupItem(ch.number, t0);
            if (item == null) {
                const obj = helperFuncs.getCurrentProgramAndTimeElapsed(t0, ch);
                item = helperFuncs.createLineup(store, obj, ch, attributionFillers, false, t0).shift();
                if (item.type === 'commercial') {
                    total++;
                    if (owner[item.title] !== item.fillerId) wrong++;
                }
            }
            channelCache.recordPlayback(store, ch.number, t0, item);
            t0 += item.streamDuration;
        }
        suite.check('every clip is credited to the list it belongs to',
            wrong === 0, `${wrong} wrong out of ${total} picks`);
    }

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
