/*
 * The lineup cursor: what a viewer's stream plays next, worked out from what
 * it has just played instead of from the clock. See NOTES.md, "Fix very short
 * items repeating or being skipped next to Flex".
 *
 * The first half drives src/lineup-cursor.js directly. The second half is a
 * simulated viewer: it asks for one item at a time the way the concat does,
 * each item lasting its length give or take what was measured live, and
 * makes the same calls /stream makes in src/video.js (cursor first, then the
 * clock, the short-break skip, createLineup, then the cursor's update) - the
 * same arrangement test/save-resume.js has with its startStream helper, so
 * keep the two in step. Every program must play exactly once, in order,
 * from its start. The same viewer without the cursor is the control: it has
 * to show the repeat, or this file proves nothing.
 */
const { helperFuncs, dayParts, freshStore, mix, Suite } = require('./support');
const lineupCursor = require('../src/lineup-cursor');
const SLACK = require('../src/constants').SLACK;

const SEC = 1000;

function prog(title, sec) {
    return { title, key: '/p/' + title, duration: sec * SEC, serverKey: 'srv' };
}
function brk(sec) {
    return { isOffline: true, duration: sec * SEC };
}
// A channel whose lineup starts at `start` and runs `programs` round and round.
function channelOf(programs, start, extra) {
    return Object.assign({
        number: 9, name: 'Cursor', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0,
        fillerCollections: mix([['Fill', 100]]),
        programs,
        duration: programs.reduce((a, p) => a + p.duration, 0),
        startTime: new Date(start).toISOString(),
    }, extra || {});
}
// Where entry `index` starts in the first cycle.
function startOf(channel, index) {
    let at = new Date(channel.startTime).getTime();
    for (let i = 0; i < index; i++) at += channel.programs[i].duration;
    return at;
}

// Filler clips of 10-60s, the spread of Ron's CN Powerhouse list.
const FILL = [];
[10, 15, 15, 20, 20, 30, 30, 30, 30, 30, 45, 60].forEach((s, i) => {
    for (let v = 0; v < 3; v++) FILL.push({ title: `Fill#${i}.${v}`, key: `/f/${i}.${v}`, duration: s * SEC + v * 137, serverKey: 'srv' });
});
const FILLERS = [{ id: 'Fill', content: FILL, weight: 100, cooldown: 0 }];

// A seeded generator, so a failing run can be replayed.
function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/*
 * One viewer. Mirrors streamFunction in src/video.js: the cursor first; when
 * it has no answer, the clock, with the skip past a break that has too little
 * left; createLineup; then the cursor moves on. Each item lasts its
 * streamDuration, plus or minus 0.4s, plus 0.2-0.8s before the next request,
 * which is what was measured on the real server path.
 */
function watch(channel, fillers, from, until, seed, useCursor) {
    const random = rng(seed);
    const store = freshStore();
    const played = [];
    let cursor = null;
    let fallbacks = 0;
    let t = from;
    let first = true;
    while (t < until) {
        let obj = (useCursor && cursor !== null) ? lineupCursor.nextEntry(channel, cursor, t) : null;
        if (useCursor && cursor !== null && obj === null) fallbacks++;
        let at = t;
        if (obj === null) {
            obj = helperFuncs.getCurrentProgramAndTimeElapsed(at, channel);
            if (obj.program.isOffline && helperFuncs.timeLeft(obj) <= SLACK + 1) {
                at = at + helperFuncs.timeLeft(obj) + 1;
                obj = helperFuncs.getCurrentProgramAndTimeElapsed(at, channel);
            }
        }
        const item = helperFuncs.createLineup(store, obj, channel, fillers, first, at)[0];
        cursor = lineupCursor.cursorAfter(channel, obj, at);
        if (obj.program.isOffline !== true) {
            // how late (+) or early (-) the program starts against the lineup
            const scheduled = (typeof obj.lineupStart === 'number') ? obj.lineupStart : at + (obj.startsIn || 0) - obj.timeElapsed;
            played.push({ index: obj.programIndex, start: item.start, t, first, late: t + item.start - scheduled });
        }
        t += item.streamDuration + Math.round((random() - 0.5) * 800) + 200 + Math.round(random() * 600);
        first = false;
    }
    return { played, fallbacks };
}

// The next real program after `index`, round the lineup.
function nextProgram(channel, index) {
    const n = channel.programs.length;
    for (let k = 1; k <= n; k++) {
        const j = (index + k) % n;
        if (channel.programs[j].isOffline !== true) return j;
    }
    return -1;
}
// Repeats, skips and late starts in a viewer's run.
function faults(channel, played) {
    const out = { repeats: 0, skips: 0, partial: 0 };
    for (let i = 1; i < played.length; i++) {
        const prev = played[i - 1].index, cur = played[i].index;
        if (cur === prev) out.repeats++;
        else if (cur !== nextProgram(channel, prev)) out.skips++;
        if (played[i].start !== 0) out.partial++;
    }
    return out;
}

module.exports = async function run() {
    const suite = new Suite('lineup-cursor');
    const T = new Date('2026-10-01T18:00:00').getTime();

    // ------------------------------------------------------------ the rules
    // A 10 minute show, a 3 minute break, a 10s NEXT bumper, another show -
    // channel 1's own opening, shortened.
    const ch = channelOf([prog('A', 600), brk(180), prog('Next', 10), prog('B', 600)], T);
    const breakStart = startOf(ch, 1), itemStart = startOf(ch, 2);
    {
        const t0 = itemStart - 2800;
        const cursor = { channel: 9, index: 1, end: itemStart, inBreak: true, fingerprint: lineupCursor.fingerprint(ch.programs[1]) };
        const obj = lineupCursor.nextEntry(ch, cursor, t0);
        suite.check('2.8s before the break ends, a stream in it gets the 10s item, from its start',
            obj !== null && obj.programIndex === 2 && obj.timeElapsed === 0,
            obj ? `index ${obj.programIndex}, elapsed ${obj.timeElapsed}` : 'null');
        const after = obj && lineupCursor.cursorAfter(ch, obj, t0);
        suite.check('... and the cursor then sits at the item\'s scheduled end',
            after !== null && after.index === 2 && after.end === itemStart + 10 * SEC && after.inBreak === false,
            JSON.stringify(after));
        const t1 = t0 + 9770;
        const old = helperFuncs.getCurrentProgramAndTimeElapsed(t1, ch);
        suite.check('control: 9.77s later the clock still points at the item (the repeat)',
            old.programIndex === 2, `index ${old.programIndex}`);
        const next = after && lineupCursor.nextEntry(ch, after, t1);
        suite.check('9.77s later the cursor plays the show after it, from its start',
            next !== null && next.programIndex === 3 && next.timeElapsed === 0,
            next ? `index ${next.programIndex}, elapsed ${next.timeElapsed}` : 'null');
    }
    {
        const cursor = { channel: 9, index: 1, end: itemStart, inBreak: true, fingerprint: lineupCursor.fingerprint(ch.programs[1]) };
        const t0 = itemStart + 12 * SEC;
        const old = helperFuncs.getCurrentProgramAndTimeElapsed(t0, ch);
        suite.check('control: a stream 12s late, by the clock, is already past the 10s item (the skip)',
            old.programIndex === 3, `index ${old.programIndex}`);
        const obj = lineupCursor.nextEntry(ch, cursor, t0);
        suite.check('the cursor still plays the 10s item, from its start',
            obj !== null && obj.programIndex === 2 && obj.timeElapsed === 0,
            obj ? `index ${obj.programIndex}, elapsed ${obj.timeElapsed}` : 'null');
    }
    {
        const afterA = { channel: 9, index: 0, end: breakStart, inBreak: false, fingerprint: lineupCursor.fingerprint(ch.programs[0]) };
        const late = lineupCursor.nextEntry(ch, afterA, breakStart + 25 * SEC);
        suite.check('a stream 25s late into a 180s break gets 155s of it',
            late !== null && late.programIndex === 1 && helperFuncs.timeLeft(late) === 155 * SEC,
            late ? `index ${late.programIndex}, time left ${helperFuncs.timeLeft(late)}` : 'null');
        const early = lineupCursor.nextEntry(ch, afterA, breakStart - 8 * SEC);
        suite.check('a stream 8s early into it gets 188s, starting in 8s',
            early !== null && early.programIndex === 1 && helperFuncs.timeLeft(early) === 188 * SEC && early.startsIn === 8 * SEC,
            early ? `time left ${helperFuncs.timeLeft(early)}, startsIn ${early.startsIn}` : 'null');
        const inBreak = { channel: 9, index: 1, end: itemStart, inBreak: true, fingerprint: lineupCursor.fingerprint(ch.programs[1]) };
        const more = lineupCursor.nextEntry(ch, inBreak, itemStart - 60 * SEC);
        suite.check('a minute before the break ends, more break: 60s of it',
            more !== null && more.programIndex === 1 && helperFuncs.timeLeft(more) === 60 * SEC,
            more ? `index ${more.programIndex}, time left ${helperFuncs.timeLeft(more)}` : 'null');
        const offA = lineupCursor.nextEntry(ch, afterA, breakStart + 61 * SEC);
        const offB = lineupCursor.nextEntry(ch, afterA, breakStart - 61 * SEC);
        suite.check('more than a minute off the clock, either way, the cursor has no answer',
            offA === null && offB === null, `${offA && offA.programIndex} ${offB && offB.programIndex}`);
    }
    {
        // a 15s break between two shows
        const c = channelOf([prog('A', 600), brk(15), prog('B', 600)], T);
        const afterA = { channel: 9, index: 0, end: startOf(c, 1), inBreak: false, fingerprint: lineupCursor.fingerprint(c.programs[0]) };
        const behind = lineupCursor.nextEntry(c, afterA, startOf(c, 1) + 30 * SEC);
        suite.check('30s late into a 15s break: the break is dropped, the next show plays from its start',
            behind !== null && behind.programIndex === 2 && behind.timeElapsed === 0,
            behind ? `index ${behind.programIndex}, elapsed ${behind.timeElapsed}` : 'null');
        const short = lineupCursor.nextEntry(c, afterA, startOf(c, 1) + 5 * SEC);
        suite.check('5s late into it, 10s left - too little for a clip, as before: dropped too',
            short !== null && short.programIndex === 2, short ? `index ${short.programIndex}` : 'null');
    }
    {
        const afterA = { channel: 9, index: 0, end: breakStart, inBreak: false, fingerprint: lineupCursor.fingerprint(ch.programs[0]) };
        const onDemand = channelOf(ch.programs, T, { onDemand: { isOnDemand: true } });
        suite.check('an on-demand channel: no answer', lineupCursor.nextEntry(onDemand, afterA, breakStart) === null);
        const redirect = channelOf([prog('A', 600), { isOffline: true, type: 'redirect', channel: 3, duration: 180 * SEC }, prog('B', 600)], T);
        const afterRA = { channel: 9, index: 0, end: breakStart, inBreak: false, fingerprint: lineupCursor.fingerprint(redirect.programs[0]) };
        suite.check('a redirect next: no answer', lineupCursor.nextEntry(redirect, afterRA, breakStart) === null);
        const edited = channelOf([prog('C', 600), brk(180), prog('Next', 10), prog('B', 600)], T);
        suite.check('the entry it was on is no longer there (a save renumbered the lineup): no answer',
            lineupCursor.nextEntry(edited, afterA, breakStart) === null);
        suite.check('another channel\'s cursor: no answer',
            lineupCursor.nextEntry(channelOf(ch.programs, T, { number: 10 }), afterA, breakStart) === null);
    }
    {
        const mid = helperFuncs.getCurrentProgramAndTimeElapsed(T + 300 * SEC, ch);
        const c1 = lineupCursor.cursorAfter(ch, mid, T + 300 * SEC);
        suite.check('tuning in mid-show, the cursor sits at the show\'s scheduled end',
            c1 !== null && c1.index === 0 && c1.end === breakStart, JSON.stringify(c1));
        const rewound = helperFuncs.getCurrentProgramAndTimeElapsed(T + 20 * SEC, ch);
        const c2 = lineupCursor.cursorAfter(ch, rewound, T + 20 * SEC);
        suite.check('20s into a show (played from its start), still its scheduled end - the stream is 20s late',
            c2 !== null && c2.end === breakStart, JSON.stringify(c2));
        const before = helperFuncs.getCurrentProgramAndTimeElapsed(T - 60 * SEC, ch);
        suite.check('before the channel starts: no cursor', lineupCursor.cursorAfter(ch, before, T - 60 * SEC) === null);
        const synthetic = { program: { isOffline: true, duration: 365 * 24 * 3600 * SEC }, programIndex: 1, timeElapsed: 0 };
        suite.check('a program video.js made up (the year-long offline one): no cursor',
            lineupCursor.cursorAfter(ch, synthetic, T) === null);
    }
    {
        // The look-ahead, through the cursor: a boundary at the next show's
        // start (6:13pm, 13 minutes after T), and a stream 8s early into the
        // break before it.
        const b = channelOf([prog('A', 600), brk(180), prog('B', 600)], T, {
            dayParts: [
                { name: 'Out', fillerCollections: mix([['Fill', 100]]), starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 0 }] },
                { name: 'In', fillerCollections: mix([['Fill', 100]]),
                  starts: [{ days: [new Date(T).getDay()], time: (18 * 60 + 13) * 60 * SEC }] },
            ],
        });
        const afterA = { channel: 9, index: 0, end: startOf(b, 1), inBreak: false, fingerprint: lineupCursor.fingerprint(b.programs[0]) };
        const t0 = startOf(b, 1) - 8 * SEC;
        const obj = lineupCursor.nextEntry(b, afterA, t0);
        const next = obj && dayParts.findNextProgram(b, t0, obj);
        suite.check('8s early into a break, its next show is placed at its real start',
            next !== null && next !== undefined && next.startTime === startOf(b, 2),
            next ? `${next.startTime - startOf(b, 2)}ms off` : 'null');
    }

    // ------------------------------------------------- the simulated viewer
    //
    // Every combination of a 5, 10 or 15s item on both sides of a 60, 150 or
    // 300s break, plus a 15s break a late stream has to drop, between
    // 90s shows - about 45 minutes a lap.
    const lineup = [];
    let n = 0;
    for (const b of [60, 150, 300]) {
        for (const d of [5, 10, 15]) {
            lineup.push(prog(`Show${n}`, 90), prog(`Before${n}`, d), brk(b), prog(`After${n}`, d));
            n++;
        }
    }
    lineup.push(prog('Show-short-break', 40), brk(15), prog('After-short-break', 5));
    const sim = channelOf(lineup, T);
    let total = { repeats: 0, skips: 0, partial: 0, programs: 0, fallbacks: 0, early: 0, late: 0 };
    let control = { repeats: 0, skips: 0 };
    for (let seed = 1; seed <= 6; seed++) {
        const from = T + seed * 977 * SEC;       // tune in somewhere different each time
        const run = watch(sim, FILLERS, from, from + 3 * 3600 * SEC, seed, true);
        const f = faults(sim, run.played);
        for (const p of run.played) {
            if (!p.first) { total.early = Math.min(total.early, p.late); total.late = Math.max(total.late, p.late); }
        }
        total.repeats += f.repeats; total.skips += f.skips; total.partial += f.partial;
        total.programs += run.played.length; total.fallbacks += run.fallbacks;
        const old = watch(sim, FILLERS, from, from + 3 * 3600 * SEC, seed, false);
        const g = faults(sim, old.played);
        control.repeats += g.repeats; control.skips += g.skips;
    }
    suite.log(`control, without the cursor: ${control.repeats} repeats, ${control.skips} skips`);
    suite.log(`with it, programs started from ${(total.early / SEC).toFixed(1)}s early to ${(total.late / SEC).toFixed(1)}s late`);
    suite.check('control: without the cursor the same viewers see repeats', control.repeats > 0, `${control.repeats}`);
    suite.check(`with the cursor, 18 hours of viewing: every program once, in order (${total.programs} programs)`,
        total.repeats === 0 && total.skips === 0, `repeats ${total.repeats}, skips ${total.skips}`);
    suite.check('... every one from its start, after tuning in', total.partial === 0, `${total.partial} started partway`);
    suite.check('... and the stream never drifted a minute off the clock', total.fallbacks === 0, `${total.fallbacks} fallbacks`);

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
