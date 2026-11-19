/*
 * Playing midrolls (docs/blocks-spec.md, Stage 6, "Playing it"; build order step 6), pure:
 * a program with midrolls played as parts, each midroll's out steps, commercials and in steps
 * between them, the end break after the last part, and every row still starting when the
 * lineup says.
 *
 * The first part is a hand oracle: the spec's Family Guy table (12:30am, acts at 5:28 and
 * 15:48, 7:23 of Flex before Robot Chicken), each midroll a 5 s WBRB and a 6 s BTTS around its
 * commercials. Tuning in at every second from 12:29:30 to 1:00:30, and a millisecond either
 * side of every boundary, each landing is checked against times written below by hand - not
 * against midroll-plan.js's whereAt, which the code under test uses.
 *
 * Then a viewer following its cursor, without and with jitter; the switch off, which must give
 * exactly what lineup-cursor.js gives; and the layout frozen for the airing on air, the switch
 * turned on or off during it.
 *
 * Each call here makes the decisions /stream makes in src/video.js, in the same order: the
 * cursor first, then the clock (placed in a midroll or a break), the skip past a break with
 * too little left, createLineup, then the cursor moves on.
 */
const { helperFuncs, freshStore, mix, Suite } = require('./support');
const lineupCursor = require('../src/lineup-cursor');
const midrollCursor = require('../src/midroll-cursor');
const transitions = require('../src/transitions');
const channelCache = require('../src/channel-cache');
const SLACK = require('../src/constants').SLACK;

const SEC = 1000;
const MIN = 60 * SEC;
const ms = (m, s = 0) => (m * MIN) + (s * SEC);

// Family Guy airs at 12:30am on Fri Nov 20, 2026; the lineup's cycle is 45 minutes and starts one cycle before.
const S = new Date(2026, 10, 20, 0, 30, 0).getTime();
const FG = { type: 'episode', showTitle: 'Family Guy', title: 'Death Is a Bitch', key: '/p/fg', file: 'D:/Family Guy/S02E06.mkv', duration: ms(22, 37), serverKey: 'srv' };
const RC = { type: 'episode', showTitle: 'Robot Chicken', title: 'Robot Chicken', key: '/p/rc', file: 'D:/Robot Chicken/S01E01.mkv', duration: ms(11), serverKey: 'srv' };

const FILL = [];
[10, 15, 20, 30, 30, 30, 45, 60].forEach( (s, i) => {
    for (let v = 0; v < 3; v++) {
        FILL.push( { title: `Fill#${i}.${v}`, key: `/f/${i}.${v}`, duration: (s * SEC) + (v * 137), serverKey: 'srv' } );
    }
} );
const LISTS = {
    Fill: FILL,
    WB: [ { title: 'WBRB', key: '/t/wb', duration: 5 * SEC, serverKey: 'srv' } ],
    BT: [ { title: 'BTTS', key: '/t/bt', duration: 6 * SEC, serverKey: 'srv' } ],
};
const FILLERS = [ { id: 'Fill', content: FILL, weight: 100, cooldown: 0 } ];
const step = (id, listId) => ({ id, kind: 'list', listId, match: 'any', keyedOn: 'next', fallbackListId: null, onlyIfNoMatch: null });

function channelWith(extra = {}) {
    const programs = [ FG, { isOffline: true, duration: ms(7, 23) }, RC, { isOffline: true, duration: ms(4) } ];
    return Object.assign( {
        number: 7, name: 'Midrolls', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0,
        fillerCollections: mix( [ [ 'Fill', 100 ] ] ),
        dayParts: [ { name: 'All week', fillerCollections: mix( [ [ 'Fill', 100 ] ] ), starts: [ { days: [0, 1, 2, 3, 4, 5, 6], time: 0 } ],
            midrolls: { count: 2 },
            transitions: { midroll: { out: [ step('w', 'WB') ], in: [ step('b', 'BT') ] } } } ],
        programs, duration: programs.reduce( (a, p) => a + p.duration, 0 ), startTime: new Date(S - ms(45)).toISOString(),
    }, extra );
}

// What video.js hands midroll-cursor.js: the switch, the store's points, the lists, the frozen layouts.
function envWith(on, points = [ 328, 948 ]) {
    return {
        on,
        pointsFor: (p) => (p.file === FG.file) ? { durationMs: FG.duration, points: points.map( (at, index) => ({ index, at, kind: 'act', by: 'auto', strength: 0.8 }) ) } : null,
        getList: (id) => LISTS[id] || null,
        cardMs: () => null,
        lastPlayed: () => 0,
        frozen: channelCache.frozenLayouts,
    };
}
function contextOf(env) {
    return midrollCursor.context(env, { getPlan: channelCache.getPlan, setPlan: channelCache.setPlan });
}
// video.js's break planner: null for a channel with no steps.
function breakPlanner(channel, env) {
    return transitions.hasSteps(channel) ? (brk) => transitions.buildPlan(channel, brk, env) : null;
}
function fresh() {
    channelCache.clear();
    channelCache.forgetFrozenLayouts();
}

// The clock path, then the skip past a break with too little left, as /stream does.
function byClock(channel, t, planFor, mctx) {
    const clock = (at) => midrollCursor.placeByClock(channel, helperFuncs.getCurrentProgramAndTimeElapsed(at, channel), at, planFor, mctx);
    let at = t;
    let obj = clock(at);
    if ( (obj.transition == null) && (obj.program.isOffline === true) && (helperFuncs.timeLeft(obj) <= SLACK + 1) ) {
        at = at + helperFuncs.timeLeft(obj) + 1;
        obj = clock(at);
    }
    return { obj, at };
}

// What one decision plays: { kind: 'program', title, start, streamDuration } | { kind: 'step', title } | { kind: 'flex', left }.
function landing(channel, obj, at, store) {
    if (obj.transition != null) {
        return { kind: 'step', title: obj.transition.clip.title };
    }
    const item = helperFuncs.createLineup(store, obj, channel, FILLERS, false, at)[0];
    if (obj.program.isOffline === true) {
        return { kind: 'flex', left: helperFuncs.timeLeft(obj), fits: (item.type === 'commercial') && (item.streamDuration <= helperFuncs.timeLeft(obj) + SLACK) };
    }
    return { kind: 'program', title: item.title, start: item.start, streamDuration: item.streamDuration };
}

/*
 * The hand oracle: what tuning in r ms after 12:30:00 plays. The table, worked out by hand:
 *   part 1   0:00-5:28  12:30:00-12:35:28
 *   midroll  12:35:28-12:37:56   WBRB to :33, commercials to 12:37:50, BTTS
 *   part 2   5:28-15:48 12:37:56-12:48:16
 *   midroll  12:48:16-12:50:44   WBRB to :21, commercials to 12:50:38, BTTS
 *   part 3   15:48-22:37 12:50:44-12:57:33   (the lineup's Family Guy ends at 12:52:37)
 *   end break 12:57:33-1:00:00, commercials only
 *   Robot Chicken at 1:00:00
 * A tune-in in a part's last 10 s (SLACK) is handed what follows, as the clock hands over a
 * program; in a midroll its out steps are in the past, and within its in steps plus 10 s it
 * plays the in step; the first 30 s of part 1 play from 0:00, and no other part rewinds.
 */
function oracle(r) {
    const prog = (title, start, end) => ({ kind: 'program', title, start, streamDuration: end - start });
    const flex = (left) => ({ kind: 'flex', left });
    const part = (from, to, startsAt, next) => {
        const into = r - startsAt;
        if (into > (to - from) - SLACK) {
            return next;
        }
        return prog('Death Is a Bitch', from + into, to);
    };
    if (r < 0) {
        return (-r <= SLACK + 1) ? prog('Death Is a Bitch', 0, 328000) : flex(-r);
    }
    if (r < 328000) {
        return (r < 30000) ? prog('Death Is a Bitch', 0, 328000) : part(0, 328000, 0, { kind: 'step', title: 'WBRB' });
    }
    if (r < 476000) {
        return (r >= 460000) ? { kind: 'step', title: 'BTTS' } : flex(470000 - r);
    }
    if (r < 1096000) {
        return part(328000, 948000, 476000, { kind: 'step', title: 'WBRB' });
    }
    if (r < 1244000) {
        return (r >= 1228000) ? { kind: 'step', title: 'BTTS' } : flex(1238000 - r);
    }
    if (r < 1653000) {
        return part(948000, 1357000, 1244000, flex(1800000 - r));
    }
    if (r < 1800000) {
        return (1800000 - r <= SLACK + 1) ? prog('Robot Chicken', 0, 660000) : flex(1800000 - r);
    }
    return prog('Robot Chicken', (r - 1800000 < 30000) ? 0 : r - 1800000, 660000);
}
const same = (a, b) => (a.kind === b.kind) && (a.kind === 'flex' ? (a.left === b.left) && (a.fits !== false) : JSON.stringify(a) === JSON.stringify(b));
const show = (x) => x.kind === 'flex' ? `flex ${x.left}` : (x.kind === 'step' ? `step ${x.title}` : `${x.title} ${x.start}+${x.streamDuration}`);

function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/*
 * One viewer from t until `until`: the cursor, else the clock, as /stream decides. Each item
 * lasts its streamDuration plus `jitter()` (ms). Returns what it played, with when.
 */
function watch(channel, env, from, until, jitter) {
    const mctx = contextOf(env);
    const planFor = breakPlanner(channel, env);
    const store = freshStore();
    const played = [];
    let cursor = null;
    let fallbacks = 0;
    let t = from;
    let first = true;
    while (t < until) {
        let obj = (cursor !== null) ? midrollCursor.nextEntry(channel, cursor, t, planFor, mctx) : null;
        let at = t;
        if ( (cursor !== null) && (obj === null) ) {
            fallbacks++;
        }
        if (obj === null) {
            ({ obj, at } = byClock(channel, t, planFor, mctx));
        }
        const item = helperFuncs.createLineup(store, obj, channel, FILLERS, first, at)[0];
        cursor = midrollCursor.cursorAfter(channel, obj, at);
        played.push( { at, type: item.type, title: item.title, start: item.start, streamDuration: item.streamDuration, part: (obj.part != null) ? obj.part.k : null } );
        t = at + item.streamDuration + jitter(item);
        first = false;
    }
    return { played, fallbacks };
}

module.exports = async () => {
    const suite = new Suite('playing midrolls (step 6)');
    const channel = channelWith();

    // ---- the hand oracle, every second -----------------------------------------------------
    {
        fresh();
        const env = envWith(true);
        const mctx = contextOf(env);
        const planFor = breakPlanner(channel, env);
        const store = freshStore();
        const boundaries = [ 0, 30000, 318001, 328000, 333000, 460000, 470000, 476000, 1086001, 1096000, 1228000, 1238000, 1244000,
            1347000, 1357000, 1643001, 1653000, 1789999, 1790001, 1800000 ];
        const moments = [];
        for (let r = -30000; r <= 1830000; r += SEC) {
            moments.push(r);
        }
        for (const b of boundaries) {
            moments.push(b - 1, b, b + 1);
        }
        const wrong = [];
        for (const r of moments) {
            const { obj, at } = byClock(channel, S + r, planFor, mctx);
            const got = landing(channel, obj, at, store);
            const want = oracle(r);
            if (! same(got, want)) {
                wrong.push(`${r}: got ${show(got)}, want ${show(want)}`);
            }
        }
        suite.check(`tuning in at every second from 12:29:30 to 1:00:30 and either side of every boundary (${moments.length}): each lands where the table says`,
            wrong.length === 0, `${wrong.length} wrong: ${wrong.slice(0, 6).join(' | ')}`);
    }
    {
        fresh();
        const env = envWith(true);
        const mctx = contextOf(env);
        const planFor = breakPlanner(channel, env);
        const at = (r) => landing(channel, byClock(channel, S + r, planFor, mctx).obj, S + r, freshStore());
        const p3 = at(ms(25));   // 12:55:00, after the lineup's Family Guy has ended
        suite.check('12:55:00, the lineup already in the Flex: part 3 at 20:04 exactly',
            (p3.kind === 'program') && (p3.start === ms(20, 4)) && (p3.streamDuration === ms(22, 37) - ms(20, 4)), show(p3));
        const p2 = at(ms(8, 10));   // 12:38:10
        suite.check('12:38:10, 14 s into part 2: 5:42 exactly, no rewind inside a later part', (p2.kind === 'program') && (p2.start === ms(5, 42)), show(p2));
        const p1 = at(ms(0, 20));
        suite.check('12:30:20, 20 s into part 1: from 0:00, today\'s 30 s rule', (p1.kind === 'program') && (p1.start === 0) && (p1.streamDuration === ms(5, 28)), show(p1));
    }

    // ---- a viewer following its cursor, no jitter ---------------------------------------------
    {
        fresh();
        const { played, fallbacks } = watch(channel, envWith(true), S - ms(0, 20), S + ms(31), () => 0);
        const shown = played.filter( (p) => p.type !== 'commercial' ).map( (p) => (p.type === 'program') ? `${p.title} ${p.start}+${p.streamDuration}` : p.title );
        suite.check('a viewer from 12:29:40: part 1, WBRB, BTTS, part 2, WBRB, BTTS, part 3, Robot Chicken from its start',
            JSON.stringify(shown) === JSON.stringify( [ 'Death Is a Bitch 0+328000', 'WBRB', 'BTTS', 'Death Is a Bitch 328000+620000', 'WBRB', 'BTTS', 'Death Is a Bitch 948000+409000', 'Robot Chicken 0+660000' ] ),
            shown.join(', '));
        suite.check('...following its cursor all the way, never the clock', fallbacks === 0, `${fallbacks} fallbacks`);
        const rc = played.find( (p) => p.title === 'Robot Chicken' );
        suite.check('...Robot Chicken starts between 30 s early and 10 s late of 1:00:00, as after any break today',
            (rc != null) && (rc.at >= S + ms(30) - 30 * SEC) && (rc.at <= S + ms(30) + SLACK), rc ? `${(rc.at - S - ms(30)) / 1000}s` : 'never');
        const parts = played.filter( (p) => p.title === 'Death Is a Bitch' );
        const starts = [ S, S + 476000, S + 1244000 ];
        suite.check('...each part starts within 10 s of its place in the layout (the commercials before it bend)',
            (parts.length === 3) && parts.every( (p, k) => Math.abs(p.at - starts[k]) <= SLACK + 1 ), parts.map( (p, k) => `${(p.at - starts[k]) / 1000}s` ).join(', '));
    }

    // ---- viewers tuning in all through the airing, with jitter --------------------------------
    {
        const problems = [];
        let viewers = 0;
        for (let r = -ms(1); r < ms(30); r += 37 * SEC) {
            fresh();
            viewers++;
            const random = rng(1000 + viewers);
            const jitter = () => 420 + Math.round(random() * 700) + ( (random() < 0.05) ? Math.round(2000 + random() * 3000) : 0 );
            const { played, fallbacks } = watch(channel, envWith(true), S + r, S + ms(31), jitter);
            if (fallbacks > 0) {
                problems.push(`${r}: ${fallbacks} fallbacks`);
            }
            const parts = played.filter( (p) => p.title === 'Death Is a Bitch' );
            for (let i = 1; i < parts.length; i++) {
                if (parts[i].start !== parts[i - 1].start + parts[i - 1].streamDuration) {
                    problems.push(`${r}: part ${i} starts at ${parts[i].start}, not where the last stopped`);
                }
            }
            if ( (parts.length > 0) && (parts[parts.length - 1].start + parts[parts.length - 1].streamDuration !== FG.duration) ) {
                problems.push(`${r}: Family Guy's last part does not end at the end`);
            }
            const steps = played.filter( (p) => p.type === 'transition' ).map( (p) => p.title ).join(',');
            if (/WBRB,WBRB|BTTS,BTTS/.test(steps)) {
                problems.push(`${r}: a step twice: ${steps}`);
            }
            const rc = played.find( (p) => p.title === 'Robot Chicken' );
            if ( (rc == null) || (rc.start !== 0) || (rc.at < S + ms(30) - 30 * SEC) || (rc.at > S + ms(30) + SLACK + 7000) ) {
                problems.push(`${r}: Robot Chicken ${rc ? `${(rc.at - S - ms(30)) / 1000}s off, from ${rc.start}` : 'never'}`);
            }
        }
        suite.check(`${viewers} viewers tuning in every 37 s from 12:29 on, with jitter: parts contiguous to the end, steps in order, no clock fallback, Robot Chicken from its start within 30 s early to 10 s late`,
            problems.length === 0, problems.slice(0, 5).join(' | '));
    }

    // ---- the switch off: exactly lineup-cursor.js ---------------------------------------------
    {
        fresh();
        const env = envWith(false);
        const mctx = contextOf(env);
        const planFor = breakPlanner(channel, env);
        let differ = 0;
        let compared = 0;
        let cursor = null;
        for (let r = -ms(2); r <= ms(46); r += 7 * SEC) {
            const t = S + r;
            const obj = helperFuncs.getCurrentProgramAndTimeElapsed(t, channel);
            const a = midrollCursor.placeByClock(channel, obj, t, planFor, mctx);
            const b = lineupCursor.placeByClock(channel, obj, t, planFor);
            compared++;
            if (a !== b) {
                differ++;
            }
        }
        // a viewer: every cursor decision both ways
        let t = S - ms(0, 20);
        while (t < S + ms(46)) {
            const a = (cursor !== null) ? midrollCursor.nextEntry(channel, cursor, t, planFor, mctx) : null;
            const b = (cursor !== null) ? lineupCursor.nextEntry(channel, cursor, t, planFor) : null;
            compared++;
            if (JSON.stringify(a) !== JSON.stringify(b)) {
                differ++;
            }
            const obj = (a !== null) ? a : midrollCursor.placeByClock(channel, helperFuncs.getCurrentProgramAndTimeElapsed(t, channel), t, planFor, mctx);
            const item = helperFuncs.createLineup(freshStore(), obj, channel, FILLERS, false, t)[0];
            const ca = midrollCursor.cursorAfter(channel, obj, t);
            const cb = lineupCursor.cursorAfter(channel, obj, t);
            compared++;
            if (JSON.stringify(ca) !== JSON.stringify(cb)) {
                differ++;
            }
            cursor = ca;
            t += Math.max(1000, item.streamDuration);
        }
        suite.check(`the switch off and nothing frozen: ${compared} decisions, every one exactly what lineup-cursor.js gives`, differ === 0, `${differ} differ`);
        const whole = byClock(channel, S + ms(10), planFor, mctx).obj;
        suite.check('...Family Guy plays whole, as today', (whole.part == null) && (whole.program === FG) && (whole.timeElapsed === ms(10)));
    }

    // ---- frozen for the airing on air -------------------------------------------------------------
    {
        fresh();
        const env = envWith(false);
        const mctx = contextOf(env);
        const planFor = breakPlanner(channel, env);
        // a viewer starts Family Guy with the switch off...
        const cursor = { channel: 7, index: 3, end: S, inBreak: true, fingerprint: lineupCursor.fingerprint(channel.programs[3]) };
        const startObj = midrollCursor.nextEntry(channel, cursor, S - 2 * SEC, planFor, mctx);
        suite.check('switch off: a viewer reaching Family Guy plays it whole', (startObj !== null) && (startObj.part == null) && (startObj.program === FG));
        // ...and it is turned on during it
        env.on = true;
        const later = byClock(channel, S + ms(10), planFor, mctx).obj;
        suite.check('...the switch turned on during it: a tune-in still gets it whole, as the first viewer has it', (later.part == null) && (later.timeElapsed === ms(10)));
        const next = byClock(channel, S + ms(45) + ms(10), planFor, mctx).obj;
        suite.check('...its next airing has its midrolls', (next.part != null) && (next.part.k === 1), JSON.stringify(next.part));
    }
    {
        fresh();
        const env = envWith(true);
        const mctx = contextOf(env);
        const planFor = breakPlanner(channel, env);
        const first = byClock(channel, S + ms(2), planFor, mctx).obj;
        env.on = false;
        const later = byClock(channel, S + ms(25), planFor, mctx).obj;
        suite.check('switch on at the first look, then off during it: the airing keeps its midrolls (part 3 at 12:55)',
            (first.part != null) && (later.part != null) && (later.part.k === 2) && (later.timeElapsed === ms(20, 4)), JSON.stringify(later.part));
        const next = byClock(channel, S + ms(45) + ms(10), planFor, mctx).obj;
        suite.check('...its next airing has none', (next.part == null) && (next.program === FG));
    }
    {
        // a restart forgets the frozen layout: the same data gives the same layout, so nothing moves
        fresh();
        const env = envWith(true);
        const mctx = contextOf(env);
        const planFor = breakPlanner(channel, env);
        const before = landing(channel, byClock(channel, S + ms(25), planFor, mctx).obj, S + ms(25), freshStore());
        channelCache.forgetFrozenLayouts();
        const after = landing(channel, byClock(channel, S + ms(25), planFor, mctx).obj, S + ms(25), freshStore());
        suite.check('a restart during the airing: the layout worked out again lands the same', same(before, after), `${show(before)} / ${show(after)}`);
    }

    // ---- a midroll's commercials come from the program's own context --------------------------------
    {
        fresh();
        const other = channelWith( { dayParts: [
            { name: 'Night', fillerCollections: mix( [ [ 'Fill', 100 ] ] ), starts: [ { days: [0, 1, 2, 3, 4, 5, 6], time: 0 } ], midrolls: { count: 2 } },
            { name: 'Late', fillerCollections: mix( [ [ 'Other', 100 ] ] ), starts: [ { days: [0, 1, 2, 3, 4, 5, 6], time: 40 * MIN } ] },
        ] } );
        const env = envWith(true);
        const mctx = contextOf(env);
        const planFor = breakPlanner(other, env);
        const fillers = FILLERS.concat( [ { id: 'Other', content: [ { title: 'Other#1', key: '/o/1', duration: 30 * SEC, serverKey: 'srv' } ], weight: 100, cooldown: 0 } ] );
        const t = S + ms(19);   // 12:49:00, midroll 2, inside "Late" by the clock but Family Guy began in "Night"
        const { obj, at } = byClock(other, t, planFor, mctx);
        const item = helperFuncs.createLineup(freshStore(), obj, other, fillers, false, at)[0];
        suite.check('a midroll at 12:49 of a program that began in another day-part plays that day-part\'s commercials',
            (obj.midroll != null) && (item.type === 'commercial') && item.title.startsWith('Fill#'), `${item.type} ${item.title}`);
    }

    fresh();
    return suite;
};

if (require.main === module) {
    module.exports().then( (suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    } );
}
