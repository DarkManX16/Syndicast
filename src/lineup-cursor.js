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
 */
const SLACK = require('./constants').SLACK;

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

/*
 * What a stream whose cursor is `cursor` plays at t0, or null for "work it out
 * from the clock".
 */
function nextEntry(channel, cursor, t0) {
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
    return {
        channel: channel.number,
        index: index,
        end: start + program.duration,
        inBreak: (program.isOffline === true),
        fingerprint: fingerprint(program),
    };
}

module.exports = {
    TOLERANCE: TOLERANCE,
    nextEntry: nextEntry,
    cursorAfter: cursorAfter,
    fingerprint: fingerprint,
};
