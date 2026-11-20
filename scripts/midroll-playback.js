/*
 * Playing midrolls on a copy of the real data (docs/blocks-spec.md, Stage 6, build order step 6's
 * proof), for scripts/midroll-week.js: the decisions /stream makes in src/video.js - the cursor,
 * then the clock placed by midroll-cursor.js, the skips past a break with too little left,
 * createLineup, the cursor moved on - over every channel's coming days, with the copy's own
 * filler lists, step lists, card lengths and break store, and nothing played.
 *
 *   --frozen  the layout walk again through layoutAt and a frozen store, each airing first asked
 *             for at its start as a stream asks: every row where the lineup has it
 *   --clock   every row tuned into by the clock at its start (it, from 0:00), and 11 s before it
 *             (never a part or a midroll of the airing before)
 *   --sweep   every second of every airing with midrolls tuned into by the clock: a part lands on
 *             the second of the file the layout says (the rewinds aside), a midroll or the end
 *             break where the layout has them; and the same part or midroll as a viewer
 *             following its cursor from 10 minutes before the airing, away from the boundaries
 *   --viewer  one viewer per channel through every day, the switch off and then on, the same
 *             jitter (each item its length plus 0.42 s, 0.1-0.8 s, and 2% of them 2-5.5 s more):
 *             when it starts every row against the lineup, and on against off, row by row
 *
 * Read-only: the copy's store is read through the scan service, its channels from memory.
 */
const fs = require('fs');
const path = require('path');
const helperFuncs = require('../src/helperFuncs');
const channelCache = require('../src/channel-cache');
const dayParts = require('../src/day-parts');
const transitions = require('../src/transitions');
const midrollPlan = require('../src/midroll-plan');
const midrollCursor = require('../src/midroll-cursor');
const constants = require('../src/constants');

const SLACK = constants.SLACK;
const TINY = constants.TINY_LEFTOVER;
const SEC = 1000;
const HOUR = 60 * 60 * SEC;

function freshStore() {
    const t = {};
    return {
        getProgramLastPlayTime: (c, k) => t[c + '|' + k] || 0,
        update: (c, k, v) => { t[c + '|' + k] = v; },
    };
}
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

// A filler list's file on the copy: { content, clipsFeatureShows } or null.
function readList(dataDir, id) {
    const p = path.join(dataDir, 'filler', `${id}.json`);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

/*
 * What video.js builds for a channel: the env (stepEnvFor and midrollsFor), the break planner
 * with its per-channel plans, the midroll context, and the loaded filler lists createLineup
 * picks from. `store` is the play-time store, `on` the switch.
 */
function playbackFor(channel, { dataDir, service, envFor }, store, on) {
    const lists = {};
    const featuring = {};
    for (const id of transitions.stepListIds(channel)) {
        const f = readList(dataDir, id);
        lists[id] = (f != null) ? f.content : null;
        featuring[id] = (f != null) && (f.clipsFeatureShows === true);
    }
    const hasSteps = transitions.hasSteps(channel);
    const base = envFor(channel, true);
    const env = {
        on,
        pointsFor: (p) => service.pointsFor(p),
        getList: (id) => (hasSteps && Array.isArray(lists[id])) ? lists[id] : null,
        featuresShows: (id) => featuring[id] === true,
        lastPlayed: (clip) => channelCache.getProgramLastPlayTime(store, channel.number, clip),
        card: () => null,
        cardMs: base.cardMs,
        frozen: channelCache.frozenLayouts,
    };
    const planFor = hasSteps ? (brk) => {
        let plan = channelCache.getPlan(channel.number, brk);
        if (plan === null) {
            plan = transitions.buildPlan(channel, brk, env);
            channelCache.setPlan(channel.number, brk, plan, brk.startTime);
        }
        return plan;
    } : null;
    const mctx = midrollCursor.context(env, { getPlan: channelCache.getPlan, setPlan: channelCache.setPlan });
    const fillers = [];
    for (const c of (dayParts.allFillerCollections(channel) || [])) {
        const f = readList(dataDir, c.id);
        if ( (f != null) && Array.isArray(f.content) ) {
            fillers.push( { id: c.id, content: f.content, weight: c.weight, cooldown: c.cooldown } );
        }
    }
    return { env, planFor, mctx, fillers };
}

/*
 * getCurrentProgramAndTimeElapsed's answer, found by a binary search instead of its walk over
 * the ~37,000 entries (the sweep asks hundreds of thousands of times). Checked against the real
 * one at the start of the sweep.
 */
function clockOf(channel) {
    const programs = channel.programs;
    const starts = [];
    let at = 0;
    for (const p of programs) {
        starts.push(at);
        at += p.duration;
    }
    const lineupStart = new Date(channel.startTime).getTime();
    return (t) => {
        let elapsed = (t - lineupStart) % channel.duration;
        let lo = 0;
        let hi = programs.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= elapsed) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        const y = lo;
        const program = programs[y];
        elapsed -= starts[y];
        if ( (program.duration > 2 * SLACK) && (elapsed > program.duration - SLACK) ) {
            const next = (y + 1) % programs.length;
            return { program: programs[next], timeElapsed: 0, programIndex: next, startsIn: program.duration - elapsed };
        }
        return { program, timeElapsed: elapsed, programIndex: y, startsIn: 0 };
    };
}

// The clock path, then the skip past a break with too little left, as /stream does.
function byClock(channel, t, pb, current) {
    const place = (at) => midrollCursor.placeByClock(channel, current(at), at, pb.planFor, pb.mctx);
    let at = t;
    let obj = place(at);
    if ( (obj.transition == null) && (obj.program.isOffline === true) && (helperFuncs.timeLeft(obj) <= SLACK + 1) ) {
        at = at + helperFuncs.timeLeft(obj) + 1;
        obj = place(at);
    }
    return { obj, at };
}

/*
 * One viewer from `from` to `to`, making /stream's decisions; each item lasts its streamDuration
 * plus jitter(). Returns the items played ({ at, end, obj, item }), the instant it started each
 * row from 0:00 (by "index|lineup start"), and how often the cursor gave it back to the clock.
 */
function watch(channel, pb, store, from, to, jitter, current) {
    const played = [];
    const rows = new Map();
    let cursor = null;
    let fallbacks = 0;
    let t = from;
    let first = true;
    let guard = 0;
    while ( (t < to) && (guard++ < 2000000) ) {
        let obj = (cursor !== null) ? midrollCursor.nextEntry(channel, cursor, t, pb.planFor, pb.mctx) : null;
        let at = t;
        if ( (cursor !== null) && (obj === null) ) {
            fallbacks++;
        }
        if (obj === null) {
            ({ obj, at } = byClock(channel, t, pb, current));
        }
        const item = helperFuncs.createLineup(store, obj, channel, pb.fillers, first, at)[0];
        if ( (item.type === 'offline') && (item.err === undefined) && (obj.program.isOffline === true) && (obj.transition == null)
            && (helperFuncs.timeLeft(obj) < TINY) ) {
            // nothing to fill the last seconds: the break ends here (video.js)
            t = at + helperFuncs.timeLeft(obj) + 1;
            continue;
        }
        channelCache.recordPlayback(store, channel.number, at, item);
        if ( (obj.program.isOffline !== true) && (item.start === 0) && ( (obj.part == null) || (obj.part.k === 0) ) ) {
            const start = (typeof(obj.lineupStart) === 'number') ? obj.lineupStart : at + (obj.startsIn || 0) - obj.timeElapsed;
            const key = `${obj.programIndex}|${start}`;
            if (! rows.has(key)) {
                rows.set(key, at);
            }
        }
        cursor = midrollCursor.cursorAfter(channel, obj, at);
        const end = at + item.streamDuration;
        played.push( { at, end, obj, item } );
        t = end + jitter();
        first = false;
    }
    return { played, rows, fallbacks };
}

// Where the airing at `index` from `start` hands over: its layout's end, or the end of its Flex run.
function airingEnd(channel, index, start, layout) {
    if (layout !== null) {
        return layout.end;
    }
    const programs = channel.programs;
    let t = start + programs[index].duration;
    for (let i = (index + 1) % programs.length, k = 0; (programs[i].isOffline === true) && (k < programs.length); i = (i + 1) % programs.length, k++) {
        t += programs[i].duration;
    }
    return t;
}

// What an entry is, to compare a viewer's with the clock's: a part (and its second of the file), a midroll, or neither.
function kindOf(obj) {
    if (obj.part != null) {
        return `part ${obj.part.k}`;
    }
    if (obj.midroll != null) {
        return `midroll ${obj.midroll.k}`;
    }
    return 'other';
}

async function run( { args, channels, service, envFor, rowsOf, label, when, from, to, dataDir } ) {
    const ctx = { dataDir, service, envFor };
    console.log('\nPlaying them (step 6):');

    // ---- --frozen ---------------------------------------------------------------------------------
    const airings = [];   // every airing with midrolls, for --sweep
    if (args.frozen || args.sweep) {
        channelCache.clear();
        channelCache.forgetFrozenLayouts();
        let rowsAll = 0;
        let differ = 0;
        let held = 0;
        let withMidrolls = 0;
        for (const channel of channels) {
            const pb = playbackFor(channel, ctx, freshStore(), true);
            let chained = null;
            for (const row of rowsOf(channel, from, to)) {
                rowsAll++;
                const start = (chained === null) ? row.start : chained;
                if (start !== row.start) {
                    differ++;
                }
                const layout = midrollPlan.layoutAt(channel, row.index, start, pb.env, start);
                const again = midrollPlan.layoutAt(channel, row.index, start, pb.env, start + 60 * SEC);
                if ( (layout !== null) && (again === layout) ) {
                    held++;
                }
                if ( (layout !== null) && (layout.midrolls.length > 0) ) {
                    withMidrolls++;
                    airings.push( { channel, index: row.index, start, layout } );
                }
                chained = airingEnd(channel, row.index, start, layout);
            }
        }
        if (args.frozen) {
            console.log(`--frozen: ${rowsAll} rows walked through layoutAt, each first asked for at its start: ${differ === 0 ? 'every row where the lineup has it' : `${differ} DIFFER`}; `
                + `${held} layouts held when asked again a minute in; ${withMidrolls} airings with midrolls`);
        }
    }

    // ---- --clock ----------------------------------------------------------------------------------
    if (args.clock) {
        channelCache.clear();
        channelCache.forgetFrozenLayouts();
        let rowsAll = 0;
        const wrongAt = [];
        const wrongBefore = [];
        for (const channel of channels) {
            const store = freshStore();
            const pb = playbackFor(channel, ctx, store, true);
            const current = (t) => helperFuncs.getCurrentProgramAndTimeElapsed(t, channel);
            for (const row of rowsOf(channel, from, to)) {
                if (row.start <= from) {
                    continue;
                }
                rowsAll++;
                const { obj, at } = byClock(channel, row.start, pb, current);
                const item = (obj.program.isOffline === true) ? null : helperFuncs.createLineup(store, obj, channel, pb.fillers, false, at)[0];
                if ( (item === null) || (obj.programIndex !== row.index) || (item.start !== 0) || ( (obj.part != null) && (obj.part.k !== 0) ) ) {
                    wrongAt.push(`${channel.number} ${when(row.start)} ${label(channel.programs[row.index])}: ${item ? `${item.title} from ${item.start}` : 'Flex'}`);
                }
                const before = byClock(channel, row.start - 11 * SEC, pb, current).obj;
                if ( (before.part != null) || (before.midroll != null) ) {
                    wrongBefore.push(`${channel.number} ${when(row.start)} ${label(channel.programs[row.index])}: 11 s before, ${kindOf(before)}`);
                }
            }
        }
        console.log(`--clock: ${rowsAll} rows tuned into at their start: ${wrongAt.length === 0 ? 'every one from 0:00' : `${wrongAt.length} WRONG: ${wrongAt.slice(0, 5).join(' | ')}`}; `
            + `11 s before each: ${wrongBefore.length === 0 ? 'never a part or a midroll of the airing before' : `${wrongBefore.length} WRONG: ${wrongBefore.slice(0, 5).join(' | ')}`}`);
    }

    // ---- --sweep ----------------------------------------------------------------------------------
    if (args.sweep) {
        // the fast clock checked against the real one
        let replicaChecked = 0;
        let replicaDiffers = 0;
        for (const channel of channels) {
            const fast = clockOf(channel);
            const random = rng(channel.number);
            for (let i = 0; i < 400; i++) {
                const t = from + Math.floor(random() * (to - from));
                const a = fast(t);
                const b = helperFuncs.getCurrentProgramAndTimeElapsed(t, channel);
                replicaChecked++;
                if ( (a.programIndex !== b.programIndex) || (a.timeElapsed !== b.timeElapsed) || (a.startsIn !== b.startsIn) || (a.program !== b.program) ) {
                    replicaDiffers++;
                }
            }
        }
        channelCache.clear();
        channelCache.forgetFrozenLayouts();
        let tuneIns = 0;
        const layoutWrong = [];
        const viewerWrong = [];
        let compared = 0;
        let fallbacks = 0;
        const fasts = new Map(channels.map( (c) => [ c.number, clockOf(c) ] ));
        for (const a of airings) {
            const { channel, layout } = a;
            const store = freshStore();
            const pb = playbackFor(channel, ctx, store, true);
            const current = fasts.get(channel.number);
            // a viewer following its cursor from 10 minutes before the airing, no jitter, so it reaches it as a
            // settled viewer does (a tune-in inside the break before can start that break's in step late)
            const seen = watch(channel, pb, store, layout.start - 10 * 60 * SEC, layout.end + 30 * SEC, () => 0, current);
            fallbacks += seen.fallbacks;
            const bounds = [ layout.start, layout.end ];
            layout.parts.forEach( (p) => bounds.push(p.start, p.start + p.toMs - p.fromMs) );
            layout.midrolls.forEach( (m) => bounds.push(m.start, m.start + m.lengthMs) );
            const nearBound = (t) => bounds.some( (b) => Math.abs(t - b) <= SLACK + 2 * SEC );
            let v = 0;
            for (let t = layout.start; t < layout.end; t += SEC) {
                tuneIns++;
                const { obj, at } = byClock(channel, t, pb, current);
                const where = midrollPlan.whereAt(layout, t);
                // the layout: a part on its second of the file, the rest where the layout has them
                if ( (obj.part != null) && (obj.part.airing !== layout.start) ) {
                    // handed over to the next row, itself an airing with midrolls: its part 1, from 0:00
                    const item = helperFuncs.createLineup(store, obj, channel, pb.fillers, false, at)[0];
                    if ( (t < layout.end - SLACK - 1) || (obj.part.k !== 0) || (item.start !== 0) ) {
                        layoutWrong.push(`${channel.number} ${when(t)} ${label(channel.programs[layout.index])}: another airing's part ${obj.part.k + 1} from ${item.start}`);
                    }
                } else if (obj.part != null) {
                    const item = helperFuncs.createLineup(store, obj, channel, pb.fillers, false, at)[0];
                    const part = layout.parts[obj.part.k];
                    const fileMs = part.fromMs + (at - part.start);
                    const want = (obj.part.k === 0) ? ( (fileMs < 30000) ? 0 : fileMs ) : ( (fileMs - part.fromMs < SLACK) ? part.fromMs : fileMs );
                    if ( (item.start !== want) || (item.start + item.streamDuration !== part.toMs) ) {
                        layoutWrong.push(`${channel.number} ${when(t)} ${label(channel.programs[layout.index])}: part ${obj.part.k + 1} from ${item.start} to ${item.start + item.streamDuration}, the layout says ${want} to ${part.toMs}`);
                    }
                } else {
                    const handedOver = (where.phase === 'part') && (where.fileMs - layout.parts[where.k].fromMs > (layout.parts[where.k].toMs - layout.parts[where.k].fromMs) - SLACK);
                    const ok = (obj.midroll != null)
                        ? ( (where.phase === 'midroll') && (where.k === obj.midroll.k) ) || (handedOver && (where.k === obj.midroll.k))
                        : (where.phase === 'end') || (handedOver && (where.k === layout.parts.length - 1)) || (t >= layout.end - SLACK);
                    if (! ok) {
                        layoutWrong.push(`${channel.number} ${when(t)} ${label(channel.programs[layout.index])}: ${kindOf(obj)}, the layout says ${where.phase} ${where.k}`);
                    }
                }
                // the viewer: what it was playing at t
                while ( (v < seen.played.length - 1) && (seen.played[v].end <= t) ) {
                    v++;
                }
                const p = seen.played[v];
                if ( (p != null) && (p.at <= t) && (t < p.end) && ! nearBound(t) ) {
                    compared++;
                    const mine = kindOf(p.obj);
                    const clocks = kindOf(obj);
                    let fileOff = 0;
                    if ( (p.obj.part != null) && (obj.part != null) ) {
                        // where each is in the file at t: the viewer's item, and the clock's second before any rewind
                        const theirs = p.item.start + (t - p.at);
                        fileOff = Math.abs(theirs - (obj.timeElapsed + (t - at)));
                    }
                    if ( (mine !== clocks) || (fileOff > SLACK + SEC) ) {
                        viewerWrong.push(`${channel.number} ${when(t)} ${label(channel.programs[layout.index])}: the viewer ${mine}, the clock ${clocks}${fileOff ? ` (${secs(fileOff)} apart in the file)` : ''}`);
                    }
                }
            }
        }
        console.log(`--sweep: the fast clock agrees with getCurrentProgramAndTimeElapsed at ${replicaChecked - replicaDiffers} of ${replicaChecked} random instants`);
        console.log(`  ${airings.length} airings with midrolls, ${tuneIns} tune-ins, one a second: `
            + `${layoutWrong.length === 0 ? 'every part on the layout\'s second of the file, every midroll and end break where the layout has it' : `${layoutWrong.length} WRONG: ${layoutWrong.slice(0, 5).join(' | ')}`}`);
        console.log(`  against a viewer following its cursor from 10 minutes before (${fallbacks} fallbacks to the clock), ${compared} seconds away from the boundaries: `
            + `${viewerWrong.length === 0 ? 'the same part or midroll every second, parts within 11 s in the file' : `${viewerWrong.length} DIFFER: ${viewerWrong.slice(0, 5).join(' | ')}`}`);
    }

    // ---- --viewer ---------------------------------------------------------------------------------
    if (args.viewer) {
        const results = {};
        // off twice: commercials are picked at random, so off against off is today's own spread
        for (const [ run, on ] of [ [ 'off', false ], [ 'on', true ], [ 'off2', false ] ]) {
            channelCache.clear();
            channelCache.forgetFrozenLayouts();
            const out = { rows: new Map(), fallbacks: 0, items: 0, parts: 0, midrollItems: 0 };
            for (const channel of channels) {
                const store = freshStore();
                const pb = playbackFor(channel, ctx, store, on);
                const random = rng(4242 + channel.number);
                const jitter = () => 420 + 100 + Math.round(random() * 700) + ( (random() < 0.02) ? Math.round(2000 + random() * 3500) : 0 );
                const current = (t) => helperFuncs.getCurrentProgramAndTimeElapsed(t, channel);
                const seen = watch(channel, pb, store, from, to, jitter, current);
                out.fallbacks += seen.fallbacks;
                out.items += seen.played.length;
                out.parts += seen.played.filter( (p) => p.obj.part != null ).length;
                out.midrollItems += seen.played.filter( (p) => p.obj.midroll != null ).length;
                for (const [key, at] of seen.rows) {
                    out.rows.set(`${channel.number}|${key}`, at);
                }
            }
            results[run] = out;
        }
        // the rows, away from the run's first and last two hours
        const lineupRows = [];
        const afterMidrolls = new Set();
        for (const channel of channels) {
            const pb = playbackFor(channel, ctx, freshStore(), true);
            channelCache.forgetFrozenLayouts();
            let prev = null;
            for (const row of rowsOf(channel, from + 2 * HOUR, to - 2 * HOUR)) {
                if (row.start < from + 2 * HOUR) {
                    prev = row;
                    continue;
                }
                const key = `${channel.number}|${row.index}|${row.start}`;
                lineupRows.push( { key, channel, row } );
                if (prev !== null) {
                    const layout = midrollPlan.midrollLayout(channel, prev.index, prev.start, pb.env);
                    if ( (layout !== null) && (layout.midrolls.length > 0) ) {
                        afterMidrolls.add(key);
                    }
                }
                prev = row;
            }
        }
        const stats = (name) => {
            const r = results[name];
            let missing = 0;
            let early = 0;
            let late = 0;
            let earlyBeyond = 0;
            let lateBeyond = 0;
            for (const { key, row } of lineupRows) {
                const at = r.rows.get(key);
                if (at === undefined) {
                    missing++;
                    continue;
                }
                const d = at - row.start;
                early = Math.min(early, d);
                late = Math.max(late, d);
                if (d < -TINY) {
                    earlyBeyond++;
                }
                if (d > SLACK + 6 * SEC) {
                    lateBeyond++;
                }
            }
            return { missing, early, late, earlyBeyond, lateBeyond };
        };
        const off = stats('off');
        const onS = stats('on');
        // row by row, `second` against `first`: the largest early and late differences, and which rows
        const versus = (first, second, only) => {
            const v = { early: 0, late: 0, earlyKey: null, lateKey: null, beyond: 0, compared: 0 };
            for (const { key } of lineupRows) {
                const a = results[first].rows.get(key);
                const b = results[second].rows.get(key);
                if ( (a === undefined) || (b === undefined) || ( (only != null) && ! only.has(key) ) ) {
                    continue;
                }
                v.compared++;
                const delta = b - a;
                if (delta < v.early) {
                    v.early = delta;
                    v.earlyKey = key;
                }
                if (delta > v.late) {
                    v.late = delta;
                    v.lateKey = key;
                }
                if (delta < -TINY) {
                    v.beyond++;
                }
            }
            return v;
        };
        const onOff = versus('off', 'on');
        const offOff = versus('off', 'off2');
        const onOffAfter = versus('off', 'on', afterMidrolls);
        let afterEarly = 0;
        let afterLate = 0;
        for (const key of afterMidrolls) {
            const b = results.on.rows.get(key);
            const row = lineupRows.find( (r) => r.key === key ).row;
            if (b !== undefined) {
                afterEarly = Math.min(afterEarly, b - row.start);
                afterLate = Math.max(afterLate, b - row.start);
            }
        }
        const name = (key) => {
            if (key === null) {
                return '';
            }
            const [ch, index, start] = key.split('|').map(Number);
            const channel = channels.find( (c) => c.number === ch );
            return `${ch} ${when(start)} ${label(channel.programs[index])}`;
        };
        console.log(`--viewer: a viewer per channel, ${lineupRows.length} rows away from the run's first and last two hours`);
        for (const [n, s, r] of [ [ 'off', off, results.off ], [ 'on ', onS, results.on ], [ 'off again', stats('off2'), results.off2 ] ]) {
            console.log(`  switch ${n}: ${r.items} items (${r.parts} parts, ${r.midrollItems} in midrolls), ${r.fallbacks} fallbacks to the clock; `
                + `rows started ${secs(s.early)} to ${secs(s.late)} against the lineup, ${s.earlyBeyond} more than 30 s early, ${s.lateBeyond} more than 16 s late, ${s.missing} never started from 0:00`);
        }
        const line = (title, v) => console.log(`  ${title}, row by row (${v.compared}): the largest early difference ${secs(v.early)} (${name(v.earlyKey)}), `
            + `the largest late ${secs(v.late)} (${name(v.lateKey)}); ${v.beyond} rows earlier by more than 30 s`);
        line('on against off', onOff);
        line('off against off again (commercials picked at random, as today)', offOff);
        line('on against off, the rows after an airing with midrolls', onOffAfter);
        console.log(`  the ${afterMidrolls.size} rows after an airing with midrolls started ${secs(afterEarly)} to ${secs(afterLate)} against the lineup`);
    }
}

module.exports = { run, clockOf, watch, playbackFor };
