/*
 * Playing midrolls (docs/blocks-spec.md, Stage 6, "Playing it"; build order step 6): where a
 * viewer's stream is inside a program that has midrolls, and what it plays next.
 *
 * 5f's layout (midroll-plan.js) says where each part of an airing, each midroll and its end
 * break sit; this plays it. A program with midrolls plays as parts: the program's own entry
 * with a start in the file and a place to stop, the shape a tune-in partway through already
 * uses, so the players are unchanged. After part k comes midroll k - its out steps, then
 * commercials, then its in steps - and then part k+1 from where part k stopped. Steps play
 * whole; only the commercials bend, ending where the in steps begin, measured from the clock,
 * so a stream that arrives late gets fewer and one that arrives early more. Whatever is left
 * carries into the next part, and after the last part comes the end break: the Flex run
 * behind the program, played by lineup-cursor.js at its real place in the lineup, so it ends
 * where the next row starts.
 *
 * This wraps lineup-cursor.js. Anything that is not inside a program with midrolls gets what
 * lineup-cursor.js answers, the very same object, so a program with no midrolls - the switch
 * off, nothing frozen, no approved point, too little Flex - plays exactly as it did before.
 *
 * The program on air keeps the layout it was first asked for while on (midroll-plan.js's
 * layoutAt), so every viewer of an airing follows the same one. A stream reaching a program
 * asks for its layout even with the switch off (DarkManX16, Nov 19), so turning the switch on
 * during an episode cannot give a new tune-in midrolls the viewer already watching never sees.
 *
 * Tuning in by the clock lands where the layout says: in a part, at the second of the file
 * the clock is at (the 30 s rewind is part 1's only, as a program's is today); in a midroll,
 * its commercials up to where its in steps begin, or within those steps (plus SLACK) the in
 * step on the air, from its start - its out steps are in the past, as in a break; in a part's
 * last SLACK, what follows it, as the clock hands a program over.
 *
 * Pure. video.js passes `mctx` (context() below): an airing's layout, frozen for the program
 * on air, and midroll k's step plan, built once per channel so every viewer plays the same.
 */
const SLACK = require('./constants').SLACK;
const lineupCursor = require('./lineup-cursor');
const midrollPlan = require('./midroll-plan');
const transitions = require('./transitions');

const TOLERANCE = lineupCursor.TOLERANCE;

function isOnDemand(channel) {
    return (channel.onDemand != null) && (channel.onDemand.isOnDemand === true);
}

function isRedirect(program) {
    return (program.isOffline === true) && (program.type === 'redirect');
}

function hasPlanSteps(plan) {
    return (plan != null) && Array.isArray(plan.out) && Array.isArray(plan.in) && ( (plan.out.length > 0) || (plan.in.length > 0) );
}

// The airing's layout when it has midrolls, else null. Asking freezes it while the program is on.
function midrollsOf(channel, index, start, now, mctx) {
    if ( (mctx == null) || (typeof(mctx.layoutAt) !== 'function') ) {
        return null;
    }
    const layout = mctx.layoutAt(channel, index, start, now);
    return ( (layout != null) && Array.isArray(layout.midrolls) && (layout.midrolls.length > 0) ) ? layout : null;
}

function partEnd(part) {
    return part.start + (part.toMs - part.fromMs);
}

/*
 * Part k of the airing, from fileMs on: the program's entry, timeElapsed being where in the
 * file it starts (createLineup's start) and `part` where it stops. startsIn is how far ahead
 * of the layout the stream is; lineupStart is the airing's start.
 */
function partEntry(channel, layout, k, fileMs, t0) {
    const part = layout.parts[k];
    const at = part.start + (fileMs - part.fromMs);
    // the break points it starts and stops at, for a copied item's cuts (part-cuts.js)
    const pointOf = (m) => (m == null) ? null : { at: m.atMs / 1000, black: Array.isArray(m.black) ? m.black : null };
    return {
        program: channel.programs[layout.index],
        programIndex: layout.index,
        timeElapsed: fileMs,
        startsIn: Math.max(0, at - t0),
        lineupStart: layout.start,
        part: { k, of: layout.parts.length, fromMs: part.fromMs, toMs: part.toMs, end: partEnd(part), airing: layout.start,
            cutIn: pointOf(layout.midrolls[k - 1]), cutOut: pointOf(layout.midrolls[k]) },
    };
}

/*
 * Midroll k as the cursor carries it: where it sits, and the steps its plan chose (none for a
 * context with no midroll steps: then it is commercials alone).
 */
function midrollOf(channel, layout, k, mctx, now) {
    const m = layout.midrolls[k];
    const plan = (typeof(mctx.planFor) === 'function') ? mctx.planFor(channel, layout, k, now) : null;
    const steps = hasPlanSteps(plan) ? plan : { out: [], in: [], outMs: 0, inMs: 0 };
    return {
        k, start: m.start, end: m.start + m.lengthMs, lengthMs: m.lengthMs, airing: layout.start,
        out: steps.out, in: steps.in, outMs: steps.outMs, inMs: steps.inMs,
    };
}

// A midroll's entries stand on a Flex of its own length: it is no entry of the lineup.
function midrollProgram(mid) {
    return { isOffline: true, duration: mid.lengthMs };
}

function midStep(layout, mid, side, j) {
    return {
        program: midrollProgram(mid),
        programIndex: layout.index,
        timeElapsed: 0,
        startsIn: 0,
        lineupStart: mid.start,
        transition: mid[side][j],
        midroll: Object.assign( {}, mid, { phase: side, step: j } ),
    };
}

// The midroll's in step j, or once they have all played, the next part from where it starts.
function midIn(channel, layout, mid, j, t0) {
    if (j < mid.in.length) {
        return midStep(layout, mid, 'in', j);
    }
    return partEntry(channel, layout, mid.k + 1, layout.parts[mid.k + 1].fromMs, t0);
}

/*
 * The midroll's commercials at t0, up to where its in steps begin: timeLeft (helperFuncs)
 * comes to exactly that, the in steps riding on the entry as reserveMs. With too little left
 * for a clip, the in steps. `pick` is the cursor's place in the midroll's shared list of
 * picks (shared-breaks.js): 0 on entering it, undefined on the clock path.
 */
function midFlex(channel, layout, mid, t0, pick) {
    if ( (mid.end - mid.inMs) - t0 > SLACK + 1) {
        const elapsed = t0 - mid.start;
        const obj = {
            program: midrollProgram(mid),
            programIndex: layout.index,
            timeElapsed: Math.max(0, elapsed),
            startsIn: Math.max(0, -elapsed),
            lineupStart: mid.start,
            reserveMs: mid.inMs,
            midroll: Object.assign( {}, mid, { phase: 'flex', step: null } ),
        };
        if (typeof(pick) === 'number') {
            obj.pick = pick;
        }
        return obj;
    }
    return midIn(channel, layout, mid, 0, t0);
}

function startMidroll(channel, layout, k, t0, mctx) {
    const mid = midrollOf(channel, layout, k, mctx, t0);
    if (mid.out.length > 0) {
        return midStep(layout, mid, 'out', 0);
    }
    return midFlex(channel, layout, mid, t0, 0);
}

// The minute's tolerance, measured at the midroll's commercials, as a break's is at its Flex.
function offTheMidroll(mid, t0) {
    const from = mid.start + mid.outMs;
    const to = Math.max(from, mid.end - mid.inMs);
    const drift = (t0 < from) ? (t0 - from) : ( (t0 > to) ? (t0 - to) : 0 );
    return Math.abs(drift) > TOLERANCE;
}

/*
 * A program entry from its start, made part 1 when its airing has midrolls. Its layout is
 * asked for here whether or not it has any, which freezes it for the airing on air.
 */
function asParts(channel, obj, t0, mctx) {
    if ( (obj == null) || (mctx == null) || (obj.transition != null) || (obj.part != null) || (obj.midroll != null) ) {
        return obj;
    }
    const programs = channel.programs;
    const index = obj.programIndex;
    if ( (typeof(index) !== 'number') || (index < 0) || (index >= programs.length) || (obj.program !== programs[index])
        || (obj.program.isOffline === true) || (obj.timeElapsed !== 0) ) {
        return obj;
    }
    const start = (typeof(obj.lineupStart) === 'number') ? obj.lineupStart : t0 + (obj.startsIn || 0);
    const layout = midrollsOf(channel, index, start, Math.max(t0, start), mctx);
    return (layout === null) ? obj : partEntry(channel, layout, 0, 0, t0);
}

// What follows part k: midroll k, or after the last part, the end break where the lineup has it.
function afterPart(channel, layout, k, t0, planFor, mctx) {
    if (k < layout.midrolls.length) {
        return startMidroll(channel, layout, k, t0, mctx);
    }
    const program = channel.programs[layout.index];
    return asParts(channel, lineupCursor.afterEntry(channel, layout.index, layout.start + program.duration, t0, planFor), t0, mctx);
}

function continueMidrolls(channel, cursor, t0, planFor, mctx) {
    const programs = channel.programs;
    if (isOnDemand(channel) || ! Array.isArray(programs) || (cursor.channel !== channel.number) ) {
        return null;
    }
    const index = cursor.index;
    if ( (typeof(index) !== 'number') || (index < 0) || (index >= programs.length)
        || (lineupCursor.fingerprint(programs[index]) !== cursor.fingerprint) ) {
        return null;
    }
    const mid = cursor.mid;
    const layout = midrollsOf(channel, index, mid.airing, t0, mctx);
    if (layout === null) {
        return null;
    }
    if (mid.phase === 'part') {
        const part = layout.parts[mid.k];
        if ( (part == null) || (Math.abs(t0 - partEnd(part)) > TOLERANCE) ) {
            return null;
        }
        return afterPart(channel, layout, mid.k, t0, planFor, mctx);
    }
    // the midroll it is in must still be where it was
    const m = layout.midrolls[mid.k];
    if ( (m == null) || (m.start !== mid.start) || (m.start + m.lengthMs !== mid.end) ) {
        return null;
    }
    if ( (mid.phase === 'out') && (typeof(mid.step) === 'number') ) {
        if (mid.step + 1 < mid.out.length) {
            return midStep(layout, mid, 'out', mid.step + 1);
        }
        return offTheMidroll(mid, t0) ? null : midFlex(channel, layout, mid, t0, 0);
    }
    if (mid.phase === 'flex') {
        return offTheMidroll(mid, t0) ? null : midFlex(channel, layout, mid, t0, cursor.pick);
    }
    if ( (mid.phase === 'in') && (typeof(mid.step) === 'number') ) {
        return midIn(channel, layout, mid, mid.step + 1, t0);
    }
    return null;
}

/*
 * What a stream whose cursor is `cursor` plays at t0, or null for "work it out from the
 * clock" - lineup-cursor.js's nextEntry, inside a program with midrolls as well.
 */
function nextEntry(channel, cursor, t0, planFor, mctx) {
    if ( (cursor != null) && (typeof(cursor) === 'object') && (cursor.mid != null) && (typeof(cursor.mid) === 'object') ) {
        return (mctx == null) ? null : continueMidrolls(channel, cursor, t0, planFor, mctx);
    }
    return asParts(channel, lineupCursor.nextEntry(channel, cursor, t0, planFor), t0, mctx);
}

/*
 * The cursor once a stream has started playing obj at t0. A part's or a midroll's carries
 * `mid`: which part, or which phase and step of which midroll (its steps with it, as a
 * break's cursor carries its plan), and the airing; anything else is lineup-cursor.js's.
 */
function cursorAfter(channel, obj, t0) {
    if ( (obj == null) || (typeof(obj) !== 'object') || ( (obj.part == null) && (obj.midroll == null) ) ) {
        return lineupCursor.cursorAfter(channel, obj, t0);
    }
    if (isOnDemand(channel) || ! Array.isArray(channel.programs) ) {
        return null;
    }
    const index = obj.programIndex;
    const program = (typeof(index) === 'number') ? channel.programs[index] : undefined;
    if (program == null) {
        return null;
    }
    const cursor = { channel: channel.number, index, inBreak: false, fingerprint: lineupCursor.fingerprint(program) };
    if (obj.part != null) {
        if (obj.program !== program) {
            return null;
        }
        cursor.end = obj.part.end;
        cursor.mid = { phase: 'part', k: obj.part.k, airing: obj.part.airing };
        return cursor;
    }
    cursor.end = obj.midroll.end;
    cursor.mid = obj.midroll;
    if ( (obj.midroll.phase === 'flex') && (typeof(obj.pickNext) === 'number') ) {
        cursor.pick = obj.pickNext;
    }
    return cursor;
}

// Where the layout puts the clock, as an entry: a part, or a midroll's out step, commercials or in step.
function inLayout(channel, layout, where, t0, planFor, mctx) {
    if (where.phase === 'part') {
        const part = layout.parts[where.k];
        const length = part.toMs - part.fromMs;
        if ( (length > 2 * SLACK) && (where.fileMs - part.fromMs > length - SLACK) ) {
            // its last seconds: what follows it, as the clock hands a program over
            return afterPart(channel, layout, where.k, t0, planFor, mctx);
        }
        return partEntry(channel, layout, where.k, where.fileMs, t0);
    }
    const mid = midrollOf(channel, layout, where.k, mctx, t0);
    if ( (mid.in.length > 0) && (mid.end - t0 <= mid.inMs + SLACK + 1) ) {
        let j = 0;
        let stepStart = mid.end - mid.inMs;
        while ( (j < mid.in.length - 1) && (t0 >= stepStart + mid.in[j].durationMs) ) {
            stepStart += mid.in[j].durationMs;
            j++;
        }
        return midStep(layout, mid, 'in', j);
    }
    if ( (mid.out.length > 0) && (t0 < mid.start + mid.outMs) ) {
        // within its out steps, the out step on the air from its start, as with the in steps:
        // the tune-in then reaches the commercials with whoever is watching, not ahead of them
        let j = 0;
        let stepStart = mid.start;
        while ( (j < mid.out.length - 1) && (t0 >= stepStart + mid.out[j].durationMs) ) {
            stepStart += mid.out[j].durationMs;
            j++;
        }
        return midStep(layout, mid, 'out', j);
    }
    return midFlex(channel, layout, mid, t0);
}

/*
 * Where a stream with no cursor lands - tuning in, a cursor given up on, /m3u8. `obj` is what
 * getCurrentProgramAndTimeElapsed answered at t0. The airing is the program on air, or the
 * program before the Flex the clock is in (its parts run on into the lineup's Flex); in its
 * parts or midrolls the layout decides, and anywhere else - the end break included - it is
 * lineup-cursor.js's placeByClock, a program from its start then made part 1 if it has
 * midrolls.
 */
function placeByClock(channel, obj, t0, planFor, mctx) {
    if ( (obj == null) || (mctx == null) || isOnDemand(channel) || ! Array.isArray(channel.programs) ) {
        return lineupCursor.placeByClock(channel, obj, t0, planFor);
    }
    const programs = channel.programs;
    const index = obj.programIndex;
    const asToday = () => asParts(channel, lineupCursor.placeByClock(channel, obj, t0, planFor), t0, mctx);
    if ( (typeof(index) !== 'number') || (index < 0) || (index >= programs.length) || (obj.program !== programs[index]) ) {
        return asToday();
    }
    let airing = null;
    if (programs[index].isOffline !== true) {
        if (! (obj.startsIn > 0) ) {
            airing = { index, start: t0 - obj.timeElapsed };
        }
    } else if (! isRedirect(programs[index])) {
        const brk = transitions.findBreak(channel, index, t0 + (obj.startsIn || 0) - obj.timeElapsed);
        if ( (brk.prev != null) && (brk.prev.program.isOffline !== true) ) {
            airing = { index: brk.prev.index, start: brk.prev.startTime };
        }
    }
    if (airing !== null) {
        const layout = midrollsOf(channel, airing.index, airing.start, t0, mctx);
        const where = (layout !== null) ? midrollPlan.whereAt(layout, t0) : null;
        if ( (where !== null) && (where.phase !== 'end') ) {
            return inLayout(channel, layout, where, t0, planFor, mctx);
        }
    }
    return asToday();
}

/*
 * What video.js hands the functions above: an airing's layout through midroll-plan.js's
 * layoutAt with `env` (its frozen store included), and midroll k's step plan, built once
 * per channel and kept in `cache` (channel-cache.js's getPlan / setPlan, as a break's is)
 * so every viewer plays the same steps. `hooks.onLayout(channel, layout)` is told of each
 * layout with midrolls as it is frozen, and `hooks.onPlan(channel, layout, k, plan)` of each
 * plan built: video.js logs them.
 */
function context(env, cache, hooks = {}) {
    const onPlan = hooks.onPlan;
    return {
        layoutAt: (channel, index, start, now) => {
            const frozen = (env != null) ? env.frozen : null;
            const before = (frozen != null) ? frozen.get(channel.number, index, start) : null;
            const layout = midrollPlan.layoutAt(channel, index, start, env, now);
            if ( (typeof(hooks.onLayout) === 'function') && (frozen != null) && (layout != null) && (layout.midrolls.length > 0) ) {
                const after = frozen.get(channel.number, index, start);
                if ( (after != null) && (after !== before) && (after.layout === layout) ) {
                    hooks.onLayout(channel, layout);
                }
            }
            return layout;
        },
        planFor: (channel, layout, k, now) => {
            const brk = midrollPlan.midrollBreak(channel, layout, k);
            let plan = (cache != null) ? cache.getPlan(channel.number, brk) : null;
            if (plan === null) {
                plan = transitions.buildPlan(channel, brk, env);
                if (cache != null) {
                    cache.setPlan(channel.number, brk, plan, now);
                }
                if (typeof(onPlan) === 'function') {
                    onPlan(channel, layout, k, plan);
                }
            }
            return plan;
        },
    };
}

module.exports = {
    nextEntry, cursorAfter, placeByClock, context,
};
