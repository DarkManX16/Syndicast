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
 *
 * Stage 5 step 4 adds transition steps (docs/blocks-spec.md, "Playing
 * through the lineup cursor"): the phases a break with steps goes through -
 * out steps, Flex, in steps - where a tune-in lands in one, and a viewer
 * watching breaks that carry steps: every step once and whole, the Flex
 * shrinking first, a break too short for its steps still playing them all.
 */
const { helperFuncs, dayParts, freshStore, mix, Suite } = require('./support');
const lineupCursor = require('../src/lineup-cursor');
const transitions = require('../src/transitions');
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
 * it has no answer, the clock - placed in a break's phases when the channel
 * has steps - with the skip past a break that has too little left; then
 * createLineup; then the cursor moves on. Each item lasts its streamDuration,
 * plus or minus 0.4s, plus 0.2-0.8s before the next request, which is what was
 * measured on the real server path. `planFor` is video.js's plan-builder: null
 * for a channel with no steps, as video.js passes it.
 */
function watch(channel, fillers, from, until, seed, useCursor, planFor) {
    const random = rng(seed);
    const store = freshStore();
    const played = [];
    const items = [];
    let cursor = null;
    let fallbacks = 0;
    let t = from;
    let first = true;
    const byClock = (at) => {
        const obj = helperFuncs.getCurrentProgramAndTimeElapsed(at, channel);
        return planFor ? lineupCursor.placeByClock(channel, obj, at, planFor) : obj;
    };
    while (t < until) {
        let obj = (useCursor && cursor !== null) ? lineupCursor.nextEntry(channel, cursor, t, planFor || null) : null;
        if (useCursor && cursor !== null && obj === null) fallbacks++;
        let at = t;
        if (obj === null) {
            obj = byClock(at);
            if (!obj.transition && obj.program.isOffline && helperFuncs.timeLeft(obj) <= SLACK + 1) {
                at = at + helperFuncs.timeLeft(obj) + 1;
                obj = byClock(at);
            }
        }
        const item = helperFuncs.createLineup(store, obj, channel, fillers, first, at)[0];
        cursor = lineupCursor.cursorAfter(channel, obj, at);
        if (obj.program.isOffline !== true) {
            // how late (+) or early (-) the program starts against the lineup
            const scheduled = (typeof obj.lineupStart === 'number') ? obj.lineupStart : at + (obj.startsIn || 0) - obj.timeElapsed;
            played.push({ index: obj.programIndex, start: item.start, t, first, late: t + item.start - scheduled });
        }
        items.push({ type: item.type, title: item.title, index: obj.programIndex, start: item.start,
            streamDuration: item.streamDuration, duration: item.duration, first });
        t += item.streamDuration + Math.round((random() - 0.5) * 800) + 200 + Math.round(random() * 600);
        first = false;
    }
    return { played, fallbacks, items };
}

// --- Stage 5 step 4: steps. One-clip lists, so which clip a step plays never
// depends on idleness; `any` steps, so they play at every break.
function stepClip(title, sec) {
    return { title, key: '/t/' + title, duration: sec * SEC, serverKey: 'srv' };
}
function anyStep(id, listId) {
    return { id, kind: 'list', listId, match: 'any', keyedOn: 'next', fallbackListId: null, onlyIfNoMatch: null };
}
// The channel with an all-week day-part carrying `sequence` on both
// between-shows and between-episodes, so every break inside it gets it.
function withSteps(channel, sequence) {
    return Object.assign({}, channel, {
        dayParts: [{ name: 'All week', fillerCollections: mix([['Fill', 100]]),
            starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 0 }],
            transitions: { betweenShows: sequence, betweenEpisodes: sequence } }],
    });
}
// video.js's plan-builder, without its per-channel sharing: buildPlan on the
// real step lists.
function plannerFor(channel, lists) {
    const env = { getList: (id) => lists[id] || null, lastPlayed: () => 0 };
    return (brk) => transitions.buildPlan(channel, brk, env);
}
function afterProgram(channel, index, end) {
    return { channel: channel.number, index, end, inBreak: false, fingerprint: lineupCursor.fingerprint(channel.programs[index]) };
}
function titleOf(obj) {
    if (obj === null) return 'null';
    if (obj.transition) return `step ${obj.transition.clip.title}`;
    return obj.program.isOffline ? `Flex[${obj.programIndex}]` : `${obj.program.title}`;
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

    // ------------------------------------------------------ the phases (stage 5)
    // A 10 minute show, a 3 minute break with a 15s out step and a 10s in
    // step, another show.
    const LISTS = { OUT: [stepClip('Out', 15)], IN: [stepClip('In', 10)] };
    const SEQ = { out: [anyStep('o', 'OUT')], in: [anyStep('i', 'IN')] };
    const sc = withSteps(channelOf([prog('A', 600), brk(180), prog('B', 600)], T), SEQ);
    const plan = plannerFor(sc, LISTS);
    const S = startOf(sc, 1), E = startOf(sc, 2);
    const store = freshStore();
    const play = (obj, t0) => helperFuncs.createLineup(store, obj, sc, FILLERS, false, t0)[0];
    {
        const out = lineupCursor.nextEntry(sc, afterProgram(sc, 0, S), S, plan);
        const item = out && play(out, S);
        suite.check('out of the show on time: the out step, as a transition, whole and from its start',
            out !== null && out.transition && out.transition.clip.title === 'Out' && item.type === 'transition'
                && item.start === 0 && item.streamDuration === 15 * SEC && helperFuncs.timeLeft(out) === 15 * SEC,
            out ? `${titleOf(out)}, ${item.type} ${item.start}+${item.streamDuration}` : 'null');
        const c1 = lineupCursor.cursorAfter(sc, out, S);
        const flexObj = c1 && lineupCursor.nextEntry(sc, c1, S + 15 * SEC, plan);
        suite.check('... then Flex, with room up to the in step: 180 - 15 - 10 = 155s',
            flexObj !== null && !flexObj.transition && flexObj.programIndex === 1 && helperFuncs.timeLeft(flexObj) === 155 * SEC,
            flexObj ? `${titleOf(flexObj)}, time left ${helperFuncs.timeLeft(flexObj)}` : 'null');
        const fill = flexObj && play(flexObj, S + 15 * SEC);
        suite.check('... a Flex clip never runs into the in step by more than SLACK',
            fill !== null && fill.type === 'commercial' && fill.streamDuration <= 155 * SEC + SLACK, fill && `${fill.streamDuration}`);
        const c2 = flexObj && lineupCursor.cursorAfter(sc, flexObj, S + 15 * SEC);
        const more = c2 && lineupCursor.nextEntry(sc, c2, E - 40 * SEC, plan);
        suite.check('40s before the break ends, more Flex: 30s of it',
            more !== null && !more.transition && helperFuncs.timeLeft(more) === 30 * SEC,
            more ? `${titleOf(more)}, time left ${helperFuncs.timeLeft(more)}` : 'null');
        const inStep = c2 && lineupCursor.nextEntry(sc, c2, E - 15 * SEC, plan);
        suite.check('15s before it ends, 5s of Flex is too little: the in step',
            inStep !== null && inStep.transition && inStep.transition.clip.title === 'In', titleOf(inStep));
        const c3 = inStep && lineupCursor.cursorAfter(sc, inStep, E - 15 * SEC);
        const b = c3 && lineupCursor.nextEntry(sc, c3, E - 5 * SEC, plan);
        suite.check('... then the show after the break, from its start',
            b !== null && b.programIndex === 2 && b.timeElapsed === 0, titleOf(b));
        const flexAgain = c2 && lineupCursor.nextEntry(sc, c2, E + 30 * SEC, plan);
        suite.check('a stream past the end of the Flex still gets the in step, not the show',
            flexAgain !== null && flexAgain.transition && flexAgain.transition.clip.title === 'In', titleOf(flexAgain));
    }
    {
        const late = lineupCursor.nextEntry(sc, afterProgram(sc, 0, S), S + 20 * SEC, plan);
        const c1 = late && lineupCursor.cursorAfter(sc, late, S + 20 * SEC);
        const flexObj = c1 && lineupCursor.nextEntry(sc, c1, S + 35 * SEC, plan);
        suite.check('20s late: the out step still plays whole, and the Flex gets 20s less (135s)',
            late !== null && late.transition && helperFuncs.timeLeft(late) === 15 * SEC
                && flexObj !== null && helperFuncs.timeLeft(flexObj) === 135 * SEC,
            `${titleOf(late)}; ${flexObj ? helperFuncs.timeLeft(flexObj) : 'null'}`);
        const early = lineupCursor.nextEntry(sc, afterProgram(sc, 0, S), S - 8 * SEC, plan);
        const ce = early && lineupCursor.cursorAfter(sc, early, S - 8 * SEC);
        const flexEarly = ce && lineupCursor.nextEntry(sc, ce, S + 7 * SEC, plan);
        suite.check('8s early: the out step from its start, and the Flex gets 8s more (163s)',
            early !== null && early.transition && flexEarly !== null && helperFuncs.timeLeft(flexEarly) === 163 * SEC,
            `${titleOf(early)}; ${flexEarly ? helperFuncs.timeLeft(flexEarly) : 'null'}`);
        const c2 = lineupCursor.cursorAfter(sc, late, S + 20 * SEC);
        const at59 = lineupCursor.nextEntry(sc, c2, E - 10 * SEC + 59 * SEC, plan);
        suite.check('the minute\'s tolerance is measured at the Flex: 59s past where it ends, the in step',
            at59 !== null && at59.transition && at59.transition.clip.title === 'In', titleOf(at59));
        suite.check('... 61s past it, no answer: the clock decides',
            lineupCursor.nextEntry(sc, c2, E - 10 * SEC + 61 * SEC, plan) === null);
        suite.check('... and 61s before it starts, no answer either',
            lineupCursor.nextEntry(sc, c2, S + 15 * SEC - 61 * SEC, plan) === null);
        const c3 = lineupCursor.cursorAfter(sc, late, S + 20 * SEC);
        const f = lineupCursor.nextEntry(sc, c3, S + 40 * SEC, plan);
        const cf = f && lineupCursor.cursorAfter(sc, f, S + 40 * SEC);
        const i = cf && lineupCursor.nextEntry(sc, cf, E - 15 * SEC, plan);
        const ci = i && lineupCursor.cursorAfter(sc, i, E - 15 * SEC);
        const b = ci && lineupCursor.nextEntry(sc, ci, E + 120 * SEC, plan);
        suite.check('the tolerance is not applied after a step: 2 minutes late out of the in step, the show still plays from its start',
            i && i.transition && b && b.programIndex === 2 && b.timeElapsed === 0, `${titleOf(i)}; ${titleOf(b)}`);
    }
    {
        // A 30s break, shorter than its 25s of steps plus a clip: a stream
        // 50s late gets no Flex, both steps, then the show from its start.
        const short = withSteps(channelOf([prog('A', 600), brk(30), prog('B', 600)], T), SEQ);
        const p = plannerFor(short, LISTS);
        const s = startOf(short, 1);
        const seen = [];
        let cursor = afterProgram(short, 0, s);
        let t = s + 50 * SEC;
        for (let k = 0; k < 4; k++) {
            const obj = lineupCursor.nextEntry(short, cursor, t, p);
            seen.push(titleOf(obj));
            if (obj === null || obj.program.isOffline !== true) break;
            const item = helperFuncs.createLineup(freshStore(), obj, short, FILLERS, false, t)[0];
            cursor = lineupCursor.cursorAfter(short, obj, t);
            t += item.streamDuration;
        }
        suite.check('later than the whole break: no Flex, both steps, then the show from its start',
            seen.join(', ') === 'step Out, step In, B', seen.join(', '));
        const without = channelOf([prog('A', 600), brk(30), prog('B', 600)], T);
        const dropped = lineupCursor.nextEntry(without, afterProgram(without, 0, s), s + 50 * SEC);
        suite.check('control: the same break with no steps is dropped, as in stage 4',
            dropped !== null && dropped.programIndex === 2, titleOf(dropped));
    }
    {
        // A break the generator left as two Flex entries: one sequence, the
        // out step at the first, the in step taken off the second.
        const two = withSteps(channelOf([prog('A', 600), brk(100), brk(80), prog('B', 600)], T), SEQ);
        const p = plannerFor(two, LISTS);
        const s = startOf(two, 1), e = startOf(two, 3);
        const out = lineupCursor.nextEntry(two, afterProgram(two, 0, s), s, p);
        const c1 = out && lineupCursor.cursorAfter(two, out, s);
        const f1 = c1 && lineupCursor.nextEntry(two, c1, s + 15 * SEC, p);
        const cf1 = f1 && lineupCursor.cursorAfter(two, f1, s + 15 * SEC);
        const f2 = cf1 && lineupCursor.nextEntry(two, cf1, s + 95 * SEC, p);
        const cf2 = f2 && lineupCursor.cursorAfter(two, f2, s + 95 * SEC);
        const i = cf2 && lineupCursor.nextEntry(two, cf2, e - 12 * SEC, p);
        suite.check('two Flex entries, one break: out step, Flex in the first (85s), Flex in the second up to the in step (75s), the in step',
            out && out.transition && f1 && f1.programIndex === 1 && helperFuncs.timeLeft(f1) === 85 * SEC
                && f2 && f2.programIndex === 2 && helperFuncs.timeLeft(f2) === 75 * SEC
                && i && i.transition && i.transition.clip.title === 'In',
            `${titleOf(out)}; ${titleOf(f1)} ${f1 && helperFuncs.timeLeft(f1)}; ${titleOf(f2)} ${f2 && helperFuncs.timeLeft(f2)}; ${titleOf(i)}`);
    }
    {
        // Steps configured somewhere, none for this break: the cursor answers
        // exactly as it does with no plan-builder at all.
        const plain = channelOf([prog('A', 600), brk(180), prog('B', 600)], T);
        const empty = withSteps(plain, { out: [], in: [] });
        const p = plannerFor(empty, LISTS);
        const cursors = [afterProgram(plain, 0, S), { channel: 9, index: 1, end: E, inBreak: true, fingerprint: lineupCursor.fingerprint(plain.programs[1]) }];
        let same = true;
        for (const c of cursors) {
            for (const dt of [-12, -3, 0, 5, 30, 170, 175, 185]) {
                const a = lineupCursor.nextEntry(plain, c, S + dt * SEC);
                const b = lineupCursor.nextEntry(empty, c, S + dt * SEC, p);
                if (JSON.stringify(a) !== JSON.stringify(b)) same = false;
                const ca = a && lineupCursor.cursorAfter(plain, a, S + dt * SEC);
                const cb = b && lineupCursor.cursorAfter(empty, b, S + dt * SEC);
                if (JSON.stringify(ca) !== JSON.stringify(cb)) same = false;
            }
        }
        suite.check('a break whose plan has no steps: the same answers and cursors as without steps', same);
    }
    {
        // Tuning in, from the clock.
        const at = (t0) => lineupCursor.placeByClock(sc, helperFuncs.getCurrentProgramAndTimeElapsed(t0, sc), t0, plan);
        const mid = at(S + 60 * SEC);
        suite.check('tuning in mid-break: Flex, up to the in step (110s); the out step is in the past',
            mid && !mid.transition && helperFuncs.timeLeft(mid) === 110 * SEC, `${titleOf(mid)} ${helperFuncs.timeLeft(mid)}`);
        const late8 = at(E - 8 * SEC);
        suite.check('tuning in 8s before the break ends (the clock has already handed over the show): the in step',
            late8 && late8.transition && late8.transition.clip.title === 'In', titleOf(late8));
        const c = late8 && lineupCursor.cursorAfter(sc, late8, E - 8 * SEC);
        const after = c && lineupCursor.nextEntry(sc, c, E + 2 * SEC, plan);
        suite.check('... then the show, from its start', after && after.programIndex === 2 && after.timeElapsed === 0, titleOf(after));
        const at105 = at(E - 10500);
        suite.check('10.5s before it ends (too little for Flex): the in step, not a skip to the show',
            at105 && at105.transition && at105.transition.clip.title === 'In', titleOf(at105));
        const handed = at(S - 5 * SEC);
        suite.check('5s before the show ends (the break handed over early): the out step',
            handed && handed.transition && handed.transition.clip.title === 'Out', titleOf(handed));
        const show = helperFuncs.getCurrentProgramAndTimeElapsed(T + 300 * SEC, sc);
        suite.check('mid-show: what the clock said, untouched', JSON.stringify(at(T + 300 * SEC)) === JSON.stringify(show));
        // Three in steps, 10s each (CCF's intros): a tune-in gets the one on
        // the air, not the first.
        const three = withSteps(channelOf([prog('A', 600), brk(180), prog('B', 600)], T),
            { out: [], in: [anyStep('i1', 'I1'), anyStep('i2', 'I2'), anyStep('i3', 'I3')] });
        const p3 = plannerFor(three, { I1: [stepClip('Intro 1', 10)], I2: [stepClip('Intro 2', 10)], I3: [stepClip('Intro 3', 10)] });
        const at3 = (t0) => lineupCursor.placeByClock(three, helperFuncs.getCurrentProgramAndTimeElapsed(t0, three), t0, p3);
        const titles = [35, 25, 15, 5].map((s) => titleOf(at3(E - s * SEC)));
        suite.check('three in steps: 35s, 25s, 15s and 5s before the end land on the first, first, second and third',
            titles.join(', ') === 'step Intro 1, step Intro 1, step Intro 2, step Intro 3', titles.join(', '));
        const od = Object.assign({}, sc, { onDemand: { isOnDemand: true } });
        const odObj = helperFuncs.getCurrentProgramAndTimeElapsed(S + 60 * SEC, od);
        suite.check('an on-demand channel: untouched', lineupCursor.placeByClock(od, odObj, S + 60 * SEC, plan) === odObj);
        const inDrop = at(E - 8 * SEC);
        const firstItem = inDrop && helperFuncs.createLineup(freshStore(), inDrop, sc, FILLERS, true, E - 8 * SEC)[0];
        suite.check('a step at tune-in plays from its start; the random start is for Flex only',
            firstItem && firstItem.type === 'transition' && firstItem.start === 0 && firstItem.streamDuration === 10 * SEC,
            firstItem && `${firstItem.start}+${firstItem.streamDuration}`);
    }
    {
        const ch2 = { disableFillerOverlay: true, watermark: { enabled: true, url: 'x.png' } };
        const settings = { enableFFMPEGTranscoding: true, disableChannelOverlay: false };
        suite.check('"hide watermark during filler" hides it during a step too',
            helperFuncs.getWatermark(settings, ch2, 'transition') === null && helperFuncs.getWatermark(settings, ch2, 'program') !== null);
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

    // ------------------------------------ the simulated viewer, with steps
    //
    // The same lineup and viewers with an 8s out step and a 5s in step on
    // every break, plus a 5s break: shorter than its own 13s of steps, so it
    // never has room for Flex and a stage 4 cursor would always drop it.
    const stepLineup = lineup.concat([prog('Show-tiny-break', 40), brk(5), prog('After-tiny-break', 10)]);
    const stepped = withSteps(channelOf(stepLineup, T), { out: [anyStep('o', 'OUT')], in: [anyStep('i', 'IN')] });
    const stepPlan = plannerFor(stepped, { OUT: [stepClip('Out', 8)], IN: [stepClip('In', 5)] });
    const st = { repeats: 0, skips: 0, partial: 0, programs: 0, fallbacks: 0, breaks: 0, wrong: [], cut: 0, tinyFlex: 0, tiny: 0 };
    for (let seed = 1; seed <= 6; seed++) {
        const from = T + seed * 977 * SEC;
        const run = watch(stepped, FILLERS, from, from + 3 * 3600 * SEC, seed, true, stepPlan);
        const f = faults(stepped, run.played);
        st.repeats += f.repeats; st.skips += f.skips; st.partial += f.partial;
        st.programs += run.played.length; st.fallbacks += run.fallbacks;
        // What played between two programs: nothing when the lineup has no
        // Flex between them; otherwise Out, Flex, In.
        let prev = null;
        let between = [];
        for (const it of run.items) {
            if (it.type === 'transition' && it.streamDuration !== it.duration) st.cut++;
            if (it.type !== 'program') {
                between.push(it);
                continue;
            }
            if (prev !== null) {
                const hasBreak = stepped.programs[(prev + 1) % stepped.programs.length].isOffline === true;
                const shape = between.map((b) => (b.type === 'transition' ? b.title : 'Flex'))
                    .filter((b, k, all) => !(b === 'Flex' && all[k - 1] === 'Flex')).join(' ');
                const want = hasBreak ? ['Out Flex In', 'Out In'] : [''];
                if (hasBreak) st.breaks++;
                if (!want.includes(shape) && st.wrong.length < 5) st.wrong.push(`${stepped.programs[prev].title}: "${shape}"`);
                if (stepped.programs[prev].title === 'Show-tiny-break') {
                    st.tiny++;
                    if (shape !== 'Out In') st.tinyFlex++;
                }
            }
            prev = it.index;
            between = [];
        }
    }
    suite.log(`with steps: ${st.programs} programs, ${st.breaks} breaks followed, ${st.tiny} of them the 5s one`);
    suite.check('with steps, 18 hours of viewing: every program once, in order, from its start',
        st.repeats === 0 && st.skips === 0 && st.partial === 0, `repeats ${st.repeats}, skips ${st.skips}, partial ${st.partial}`);
    suite.check('... every break played its out step, Flex, then its in step - each step once', st.wrong.length === 0 && st.breaks > 100,
        st.wrong.join('; '));
    suite.check('... no step ever cut short', st.cut === 0, `${st.cut} cut`);
    suite.check('... the 5s break, shorter than its steps, kept both steps and never had Flex', st.tiny > 0 && st.tinyFlex === 0,
        `${st.tinyFlex} of ${st.tiny}`);
    suite.check('... and the stream never drifted a minute off the clock', st.fallbacks === 0, `${st.fallbacks} fallbacks`);

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
