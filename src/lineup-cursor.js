/*
 * Where a viewer's stream is in the lineup, and what it plays next.
 *
 * /stream used to work every item out from the clock alone. The stream and
 * the clock drift apart by design - a break can be handed over up to SLACK
 * early, a filler clip can run up to SLACK past its break, and a program asked
 * for in its first 30 seconds plays from the start - and an item shorter than
 * that drift could be chosen again (the clock still inside it after it
 * played) or jumped over (the clock already past it). Very short items next to
 * Flex played two or three times, or not at all. See NOTES.md, "Fix very short
 * items repeating or being skipped next to Flex".
 *
 * So a stream remembers what it has just played - a cursor - and plays the
 * next entry in the lineup, from its start, however early or late it is. Only
 * breaks bend: their time left is measured from the clock to their real end,
 * so a late stream gets a shorter break and an early one a longer one, and a
 * break with too little left for a clip is passed over, its lateness carried
 * to the next one. A stream more than TOLERANCE off the clock, or anything
 * this can't follow (an on-demand channel, a redirect, a lineup changed under
 * it), gets null and works its position out from the clock as before.
 *
 * Pure and free of I/O, like day-parts.js. video.js keeps one cursor per
 * viewer connection in channel-cache.js.
 *
 * A break with transition steps (stage 5, docs/blocks-spec.md, "Playing
 * through the lineup cursor") is played in three phases carried on the
 * cursor: its out steps, then Flex, then its in steps, then the show after it
 * from its start. Steps play whole and in order however early or late the
 * stream is; only the Flex bends, ending where the in steps begin. So a break
 * is passed over only when it has no steps and too little left; one with steps
 * and no room keeps its steps and drops its Flex, and the lateness the steps
 * add carries on to the next break. The plan - which clip each step plays - is
 * built once, when the stream enters the break, by the `planFor` function
 * video.js passes in; without one (a channel with no steps) every break plays
 * exactly as before.
 */
const SLACK = require('./constants').SLACK;
const transitions = require('./transitions');

const TOLERANCE = 60 * 1000;

function isOnDemand(channel) {
    return (typeof(channel.onDemand) !== 'undefined')
        && (channel.onDemand !== null)
        && (channel.onDemand.isOnDemand === true);
}

function isRedirect(program) {
    return (program.isOffline === true) && (program.type === 'redirect');
}

// What a cursor checks its entry against, so a lineup changed under it is
// noticed rather than followed.
function fingerprint(program) {
    let what = (program.isOffline === true) ? 'flex' : (program.key || program.title);
    return `${what}|${program.duration}`;
}

/*
 * Entry `index`, which starts at `start` on the lineup, as /stream asks at t0 -
 * shaped like getCurrentProgramAndTimeElapsed's answer, plus lineupStart for
 * cursorAfter. A program always starts from the beginning. A break says how
 * much of it is gone, or how far ahead of it the stream is.
 */
function entry(programs, index, start, t0) {
    let program = programs[index];
    if (program.isOffline === true) {
        let elapsed = t0 - start;
        return {
            program: program,
            programIndex: index,
            timeElapsed: Math.max(0, elapsed),
            startsIn: Math.max(0, -elapsed),
            lineupStart: start,
        };
    }
    return {
        program: program,
        programIndex: index,
        timeElapsed: 0,
        startsIn: Math.max(0, start - t0),
        lineupStart: start,
    };
}

function hasPlanSteps(plan) {
    return (plan != null) && Array.isArray(plan.out) && Array.isArray(plan.in)
        && ( (plan.out.length > 0) || (plan.in.length > 0) );
}

/*
 * What a cursor carries through a break with steps: the steps buildPlan chose,
 * and where the break - its whole run of Flex entries - sits on the lineup.
 */
function phasePlan(plan, brk) {
    return {
        situation: plan.situation,
        out: plan.out,
        in: plan.in,
        outMs: plan.outMs,
        inMs: plan.inMs,
        firstFlex: brk.firstFlex,
        lastFlex: brk.lastFlex,
        runStart: brk.startTime,
        runEnd: brk.endTime,
    };
}

function validPlan(plan, programs) {
    return (plan != null) && (typeof(plan) === 'object') && hasPlanSteps(plan)
        && (typeof(plan.runStart) === 'number') && (typeof(plan.runEnd) === 'number')
        && (typeof(plan.firstFlex) === 'number') && (typeof(plan.lastFlex) === 'number')
        && (plan.firstFlex >= 0) && (plan.firstFlex < programs.length)
        && (plan.lastFlex >= 0) && (plan.lastFlex < programs.length);
}

// Where Flex entry `index` of the plan's run starts on the lineup.
function entryStartOf(programs, plan, index) {
    let at = plan.runStart;
    for (let i = plan.firstFlex, k = 0; (i !== index) && (k < programs.length); i = (i + 1) % programs.length, k++) {
        at += programs[i].duration;
    }
    return at;
}

/*
 * Step k of a side, played now and from its start. It stands at the Flex
 * entry its side attaches to - out steps at the run's first, in steps at its
 * last - so the cursor still names a real entry of the lineup.
 */
function stepEntry(programs, plan, side, k) {
    let index = (side === 'out') ? plan.firstFlex : plan.lastFlex;
    return {
        program: programs[index],
        programIndex: index,
        timeElapsed: 0,
        startsIn: 0,
        lineupStart: entryStartOf(programs, plan, index),
        phase: side,
        step: k,
        transition: plan[side][k],
        plan: plan,
    };
}

/*
 * Flex from entry `index` of the run on, at t0. Each entry's Flex ends at the
 * entry's own end or where the in steps begin, whichever is first; the time
 * taken off for the in steps rides on the entry as reserveMs, which
 * helperFuncs.timeLeft subtracts. An entry with too little left hands on to
 * the next, and after the last come the in steps.
 */
function flexFrom(programs, plan, index, t0) {
    let start = entryStartOf(programs, plan, index);
    let flexEnd = plan.runEnd - plan.inMs;
    for (let k = 0; k < programs.length; k++) {
        let program = programs[index];
        if ( (program.isOffline !== true) || isRedirect(program) ) {
            return null;
        }
        let end = start + program.duration;
        let until = Math.min(end, flexEnd);
        if (until - t0 > SLACK + 1) {
            let flex = entry(programs, index, start, t0);
            flex.reserveMs = end - until;
            flex.phase = 'flex';
            flex.step = null;
            flex.plan = plan;
            return flex;
        }
        if (index === plan.lastFlex) {
            break;
        }
        start = end;
        index = (index + 1) % programs.length;
    }
    return inFrom(programs, plan, 0, t0);
}

// In step k, or once they have all played, the show after the break from its start.
function inFrom(programs, plan, k, t0) {
    if (k < plan.in.length) {
        return stepEntry(programs, plan, 'in', k);
    }
    let index = (plan.lastFlex + 1) % programs.length;
    if (isRedirect(programs[index])) {
        return null;
    }
    return entry(programs, index, plan.runEnd, t0);
}

function startBreak(programs, plan, t0) {
    if (plan.out.length > 0) {
        return stepEntry(programs, plan, 'out', 0);
    }
    return flexFrom(programs, plan, plan.firstFlex, t0);
}

/*
 * The minute's tolerance, measured at the Flex: how far t0 is from where the
 * Flex sits in the schedule, after the out steps and before the in steps. The
 * steps' own time is not drift. A break too short for its steps has an empty
 * window, at the end of its out steps.
 */
function offTheFlex(plan, t0) {
    let from = plan.runStart + plan.outMs;
    let to = Math.max(from, plan.runEnd - plan.inMs);
    let drift = (t0 < from) ? (t0 - from) : ( (t0 > to) ? (t0 - to) : 0 );
    return Math.abs(drift) > TOLERANCE;
}

// The next thing a stream in a break with steps plays, from its cursor.
function continueBreak(programs, cursor, t0) {
    let plan = cursor.plan;
    if (! validPlan(plan, programs) ) {
        return null;
    }
    if ( (cursor.phase === 'out') && (typeof(cursor.step) === 'number') ) {
        if (cursor.step + 1 < plan.out.length) {
            return stepEntry(programs, plan, 'out', cursor.step + 1);
        }
        return offTheFlex(plan, t0) ? null : flexFrom(programs, plan, plan.firstFlex, t0);
    }
    if (cursor.phase === 'flex') {
        return offTheFlex(plan, t0) ? null : flexFrom(programs, plan, cursor.index, t0);
    }
    if ( (cursor.phase === 'in') && (typeof(cursor.step) === 'number') ) {
        return inFrom(programs, plan, cursor.step + 1, t0);
    }
    return null;
}

/*
 * What a stream whose cursor is `cursor` plays at t0, or null for "work it out
 * from the clock". `planFor(brk)` builds a break's plan when the stream enters
 * it; video.js passes one only for a channel that has steps.
 */
function nextEntry(channel, cursor, t0, planFor) {
    if ( (cursor === null) || (typeof(cursor) !== 'object') || isOnDemand(channel) ) {
        return null;
    }
    let programs = channel.programs;
    if (! Array.isArray(programs) || (programs.length === 0) || (cursor.channel !== channel.number) ) {
        return null;
    }
    let index = cursor.index;
    if ( (typeof(index) !== 'number') || (index < 0) || (index >= programs.length)
        || (fingerprint(programs[index]) !== cursor.fingerprint) ) {
        return null;
    }
    if (typeof(cursor.phase) === 'string') {
        return continueBreak(programs, cursor, t0);
    }
    let end = cursor.end;
    if (cursor.inBreak) {
        let start = end - programs[index].duration;
        let drift = (t0 < start) ? (t0 - start) : ( (t0 > end) ? (t0 - end) : 0 );
        if (Math.abs(drift) > TOLERANCE) {
            return null;
        }
        if (end - t0 > SLACK + 1) {
            return entry(programs, index, start, t0);
        }
    } else if (Math.abs(t0 - end) > TOLERANCE) {
        return null;
    }
    // The stream is at `end`, where the entry after `index` starts.
    for (let k = 0; k < programs.length; k++) {
        index = (index + 1) % programs.length;
        let program = programs[index];
        if (isRedirect(program)) {
            return null;
        }
        let before = programs[(index - 1 + programs.length) % programs.length];
        if ( (typeof(planFor) === 'function') && (program.isOffline === true) && (before.isOffline !== true) ) {
            // entering a break: its plan is built now, once
            let brk = transitions.findBreak(channel, index, end);
            let plan = planFor(brk);
            if (hasPlanSteps(plan)) {
                return startBreak(programs, phasePlan(plan, brk), t0);
            }
        }
        if ( (program.isOffline !== true) || (end + program.duration - t0 > SLACK + 1) ) {
            return entry(programs, index, end, t0);
        }
        // too little of this break is left for a clip: pass over it
        end += program.duration;
    }
    return null;
}

/*
 * The cursor once a stream has started playing obj's entry at t0, obj being
 * what nextEntry or getCurrentProgramAndTimeElapsed answered. It sits at the
 * entry's scheduled end. null when there is nothing to follow: before the
 * channel starts, a redirect, a program video.js made up, an on-demand channel.
 */
function cursorAfter(channel, obj, t0) {
    if ( (obj === null) || (typeof(obj) !== 'object') || isOnDemand(channel) ) {
        return null;
    }
    let programs = channel.programs;
    let index = obj.programIndex;
    if (! Array.isArray(programs) || (typeof(index) !== 'number') || (index < 0) || (index >= programs.length) ) {
        return null;
    }
    let program = programs[index];
    if ( (obj.program !== program) || isRedirect(program) ) {
        return null;
    }
    let start = (typeof(obj.lineupStart) === 'number')
        ? obj.lineupStart
        : t0 + (obj.startsIn || 0) - obj.timeElapsed;
    let cursor = {
        channel: channel.number,
        index: index,
        end: start + program.duration,
        inBreak: (program.isOffline === true),
        fingerprint: fingerprint(program),
    };
    if (typeof(obj.phase) === 'string') {
        // in a break with steps: which phase, which step, and the plan itself
        cursor.phase = obj.phase;
        cursor.step = obj.step;
        cursor.plan = obj.plan;
    }
    return cursor;
}

/*
 * Where a stream with no cursor lands in a break with steps - the clock path:
 * tuning in, a stream the cursor gave up on, and /m3u8, which has no cursor at
 * all. `obj` is what getCurrentProgramAndTimeElapsed answered at t0; anything
 * that is not in or next to a break with steps comes back as it was.
 *
 *   - mid-break: Flex up to where the in steps begin; the out steps are in
 *     the past, as on real TV
 *   - within the in steps' length (plus SLACK) of the break's end: the in
 *     step on the air at t0, from its start. That includes the last seconds
 *     of a break, which the clock has already handed to the show after it.
 *   - before the break begins (the clock hands a break over up to SLACK
 *     early): the out steps, which are still ahead
 */
function placeByClock(channel, obj, t0, planFor) {
    if ( (typeof(planFor) !== 'function') || (obj == null) || isOnDemand(channel) ) {
        return obj;
    }
    let programs = channel.programs;
    let n = Array.isArray(programs) ? programs.length : 0;
    let index = obj.programIndex;
    if ( (typeof(index) !== 'number') || (index < 0) || (index >= n) || (obj.program !== programs[index]) ) {
        return obj;
    }
    let start = t0 + (obj.startsIn || 0) - obj.timeElapsed;
    let flexIndex = index;
    let flexStart = start;
    if (programs[index].isOffline !== true) {
        // a show handed over before it starts: t0 is in the end of the entry before it
        let before = (index - 1 + n) % n;
        if ( ! (obj.startsIn > 0) || (programs[before].isOffline !== true) ) {
            return obj;
        }
        flexIndex = before;
        flexStart = start - programs[before].duration;
    }
    if (isRedirect(programs[flexIndex])) {
        return obj;
    }
    let brk = transitions.findBreak(channel, flexIndex, flexStart);
    let built = planFor(brk);
    if (! hasPlanSteps(built) ) {
        return obj;
    }
    let plan = phasePlan(built, brk);
    if (t0 < plan.runStart) {
        return startBreak(programs, plan, t0);
    }
    if ( (plan.in.length > 0) && (plan.runEnd - t0 <= plan.inMs + SLACK + 1) ) {
        let k = 0;
        let stepStart = plan.runEnd - plan.inMs;
        while ( (k < plan.in.length - 1) && (t0 >= stepStart + plan.in[k].durationMs) ) {
            stepStart += plan.in[k].durationMs;
            k++;
        }
        return stepEntry(programs, plan, 'in', k);
    }
    if (programs[index].isOffline !== true) {
        // the break has no in steps: the show, handed over as the clock said
        return obj;
    }
    return flexFrom(programs, plan, flexIndex, t0);
}

module.exports = {
    TOLERANCE: TOLERANCE,
    nextEntry: nextEntry,
    cursorAfter: cursorAfter,
    placeByClock: placeByClock,
    fingerprint: fingerprint,
};
