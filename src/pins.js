/*
 * What's left of the clock-time pin path after "What you see is what airs"
 * (NOTES.md) moved swaps and inserts to kept rows (src/kept-rows.js): the
 * walk over a lineup by clock time, the slot and schedule readers built on
 * it, and the clock-word formatters, still used by the generator's own
 * clock-time pin rules (src/services/time-slots-service.js, kept for
 * `progress-check --pin` and test/pins-generator.js) and by the editor
 * around them. Pure, tested in Node, and bundled into the editor as
 * src/episode-start.js is.
 */

const slotProgress = require('./slot-progress');
const SLACK = require('./constants').SLACK;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Two starts this close are the same airing: saved lineups start a fraction
// of a second off the minute.
const SAME = 2 * SECOND;

function pad2(n) {
    return String(n).padStart(2, '0');
}

const mod = (a, n) => ( (a % n) + n ) % n;

// 24:06, 0:10, 1:16:40
function length(ms) {
    let s = Math.round(ms / SECOND);
    let h = Math.floor(s / 3600);
    let m = Math.floor( (s % 3600) / 60 );
    return (h > 0) ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}
const DAYS = [ 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat' ];
const MONTHS = [ 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec' ];
// Fri Oct 9, 7:30pm
function dayClock(t) {
    let d = new Date(t);
    let h = d.getHours() % 12 || 12;
    return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}, ${h}:${pad2(d.getMinutes())}${ (d.getHours() < 12) ? 'am' : 'pm' }`;
}

// The show an airing is of, as Ron names it.
function showName(program) {
    if (typeof(program.customShowName) === 'string') {
        return program.customShowName;
    }
    if ( (program.type === 'episode') && (typeof(program.showTitle) === 'string') ) {
        return program.showTitle;
    }
    return program.title;
}

// Every entry on air in [from, to), round the loop, with its start and, for
// a program, the Flex after it (not counting a pinned Flex).
function walk(programs, startTime, from, to) {
    let out = [];
    let n = programs.length;
    let total = programs.reduce( (a, p) => a + p.duration, 0 );
    if ( (n === 0) || ! (total > 0) ) {
        return out;
    }
    let t = startTime + Math.floor( (from - startTime) / total ) * total;
    let i = 0;
    while (t + programs[i].duration <= from) {
        t += programs[i].duration;
        i = (i + 1) % n;
    }
    while (t < to) {
        let p = programs[i];
        let flex = 0;
        for (let j = (i + 1) % n; (j !== i) && programs[j].isOffline && (programs[j].type !== 'redirect') && ! programs[j].pin; j = (j + 1) % n) {
            flex += programs[j].duration;
        }
        out.push({ start: t, program: p, flex: flex });
        t += p.duration;
        i = (i + 1) % n;
    }
    return out;
}

// The entry on air at an instant - a program or Flex - with its index in
// `programs` and its start, round the loop. For Go to.
function airingAt({ programs, startTime, at }) {
    // A saved lineup can run a fraction of a second behind the minute: an
    // airing starting just after `at` is the one meant.
    let next = walk(programs, startTime, at, at + SAME + 1).find( (x) => (x.start > at) && (x.start <= at + SAME) );
    if (typeof(next) !== 'undefined') {
        at = next.start;
    }
    let found = walk(programs, startTime, at, at + 1);
    if (found.length === 0) {
        return null;
    }
    let total = programs.reduce( (a, p) => a + p.duration, 0 );
    let into = mod(found[0].start - startTime, total);
    let index = 0;
    for (let t = 0; t < into; t += programs[index].duration, index++);
    return { index: index, start: found[0].start, program: found[0].program };
}

// The breaks - Flex after a program, not counting a pinned Flex - of at least
// `duration` that start within `within` of `near`, nearest first, at most
// five: where an insert too long for its own break would fit. `start` is
// where the break begins, the end of the program before it.
function breaksThatFit({ programs, startTime, near, within, duration, notBefore }) {
    let found = [];
    walk(programs, startTime, near - within - DAY, near + within).forEach( (x) => {
        if (x.program.isOffline || (x.flex < duration)) {
            return;
        }
        let start = x.start + x.program.duration;
        if ( (Math.abs(start - near) <= within) && ! (start < notBefore) ) {
            found.push({ after: { start: x.start, program: x.program }, start: start, length: x.flex });
        }
    } );
    found.sort( (a, b) => Math.abs(a.start - near) - Math.abs(b.start - near) );
    return found.slice(0, 5);
}

// The program a re-made lineup leaves where it is (time-slots-service's
// carry): the one on air, or the one whose break is on air - the last that
// started at or before `now`, within a day.
function carryAt({ programs, startTime, now, schedule }) {
    let last = null;
    walk(programs, startTime, now - DAY, now + 1).forEach( (x) => {
        if (! x.program.isOffline && (x.start <= now)) {
            last = { start: x.start, program: x.program };
        }
    } );
    // With the schedule: it is on air, or the slot it began in is still going - else
    // what is on air is some other slot's Flex, not its break.
    if ( (last !== null) && (typeof(schedule) === 'object') && (schedule !== null) && (last.start + last.program.duration <= now) ) {
        let slot = slotAround({ schedule: schedule, at: last.start });
        if ( (slot === null) || (slot.end <= now) ) {
            return null;
        }
    }
    return last;
}

/*
 * Why an airing can't have `what` done to it now - 'swap', 'remove', 'undo' or
 * 'insert' - in plain words, or null. The airing on air stays as it is while a
 * lineup is re-made around it (carry), so it can't be swapped, removed or
 * undone; one that has aired is over; an insert needs its break not yet begun.
 * Holiday and Never air ('leaveOut') work whenever: they act from then on.
 */
function whyNot({ airing, now, what }) {
    if (what === 'leaveOut') {
        return null;
    }
    let start = (airing.start instanceof Date) ? airing.start.getTime() : Number(airing.start);
    let end = start + airing.duration;
    let name = label(airing);
    if (what === 'insert') {
        return (end <= now) ? `The break after ${name} has already begun - insert after a later airing.` : null;
    }
    if (end <= now) {
        return `${name} has already aired.`;
    }
    if (start <= now) {
        let verb = ( { swap: 'swapped', remove: 'removed', undo: 'undone', move: 'moved' } )[what] || 'changed';
        return `${name} is on air now, so it can't be ${verb} - it finishes airing first. Pick an airing after it.`;
    }
    return null;
}

// A date ("2026-10-31") and a time ("16:00") on the local clock as an
// instant; on the fall-back night, the first of the two.
function localInstant(date, time) {
    return new Date(`${date}T${time.length === 5 ? time + ':00' : time}`).getTime();
}

// The slot occurrence holding `at`, by the wall clock.
function slotAround({ schedule, at }) {
    let slot = slotProgress.slotAt(schedule, at);
    if (slot === null) {
        return null;
    }
    let period = (typeof(schedule.period) === 'number') ? schedule.period : DAY;
    let times = schedule.slots.map( (s) => s.time ).filter( (x) => typeof(x) === 'number' ).sort( (a, b) => a - b );
    let index = times.indexOf(slot.time);
    let next = (index === times.length - 1) ? times[0] + period : times[index + 1];
    let local = at - (new Date(at)).getTimezoneOffset() * MINUTE;
    let start = at - mod(mod(local, period) - slot.time, period);
    let end = start + (next - slot.time);
    end += ( (new Date(end)).getTimezoneOffset() - (new Date(start)).getTimezoneOffset() ) * MINUTE;
    return { start: start, end: end, showId: slot.showId };
}

// Where a lineup's loop really ends. Callers stop two weeks before it: a
// lineup's last days sit off the slots and end in Flex, so they'd read as
// hand-placed, and they're a year out, beyond what a re-lay keeps. Since the
// editor rotates a lineup's start to now, the real end is found as its longest
// Flex (a day or more: generators end a lineup in days of it), not from its
// start.
function loopEnd(lineup, from) {
    let total = lineup.programs.reduce( (a, p) => a + p.duration, 0 );
    let base = Math.max(from, lineup.startTime);
    let end = base + total - mod(base - lineup.startTime, total);
    let longest = { start: null, length: 0 };
    let run = { start: null, length: 0 };
    walk(lineup.programs, lineup.startTime, base, base + total).forEach( (x) => {
        if (x.program.isOffline && (x.program.type !== 'redirect') && ! x.program.pin) {
            if (run.start === null) {
                run = { start: x.start, length: 0 };
            }
            run.length += x.program.duration;
            if (run.length > longest.length) {
                longest = { start: run.start, length: run.length };
            }
        } else {
            run = { start: null, length: 0 };
        }
    } );
    return (longest.length >= DAY) ? Math.min(end, longest.start) : end;
}

/*
 * What was put at the end of the list - the library's "Insert at the end of
 * list" - which handPlaced never reaches: it sits after the lineup's end
 * Flex, where handPlaced stops (two weeks before the loop's end). Read from
 * the list alone: the run of airings at its very end that no slot made, each
 * at its next airing from `from`.
 *
 * The editor rotates the list to start at now, so the end Flex is not at the
 * end of the array: after it come the loop's seam (the generator leaves an
 * airing or two off the slots there) and the lineup's first days, and what was
 * added follows those. So it is the run that ends the list, after the last
 * airing a slot made. And the generator makes a lineup a whole number of the
 * schedule's periods long, so only one that is not whole has had anything
 * added.
 */
function addedAtEnd({ programs, startTime, from, schedule, getShowData }) {
    let period = (schedule && schedule.period);
    if (! (Number.isFinite(period) && (period > 0)) || ! programs.some( (p) => typeof(p.slotPosition) === 'string' )) {
        return [];
    }
    let total = programs.reduce( (a, p) => a + p.duration, 0 );
    let left = mod(total, period);
    if ( (left <= 1) || (period - left <= 1) ) {
        return [];
    }
    // The end Flex: the longest run of a day or more.
    let isFlex = (p) => p.isOffline && (p.type !== 'redirect') && ! p.pin;
    let best = { end: -1, length: 0 };
    for (let i = 0; i < programs.length; ) {
        if (! isFlex(programs[i])) {
            i++;
            continue;
        }
        let length = 0;
        while ( (i < programs.length) && isFlex(programs[i]) ) {
            length += programs[i].duration;
            i++;
        }
        if (length > best.length) {
            best = { end: i, length: length };
        }
    }
    if ( (best.length < DAY) || (best.end >= programs.length) ) {
        return [];
    }
    let startOf = programs.slice(0, best.end).reduce( (a, p) => a + p.duration, 0 );
    // Its next airing: this cycle's, or the next when this one's has begun.
    let first = startTime + startOf;
    first += Math.max(0, Math.ceil( (from - SAME - first) / total )) * total;
    let found = slotProgress.airings({ programs, startTime, from: first, to: first + (total - startOf), schedule, getShowData });
    let byHand = (x) => (x.key === null) && ! x.program.pin && (x.program.slotPosition !== 'repeat');
    let n = found.length;
    while ( (n > 0) && byHand(found[n - 1]) ) {
        n--;
    }
    return found.slice(n).filter( (x) => x.start >= first - SAME )
        .map( (x) => ({ start: x.start, program: x.program }) );
}

/*
 * Airings in the list that no slot made - placed by hand: a clip put between
 * programs, or a show added from the library, from `from` to `to` (clipped
 * before the loop comes round).
 */
function handPlaced({ programs, startTime, from, to, schedule, getShowData }) {
    let lineup = { programs, startTime };
    to = Math.min(to, loopEnd(lineup, from) - 14 * DAY);
    return slotProgress.airings({ programs, startTime, from, to, schedule, getShowData })
        .filter( (x) => (x.start >= from - SAME) && ! x.program.pin && (x.key === null) && (x.program.slotPosition !== 'repeat') )
        .map( (x) => ({ start: x.start, program: x.program }) );
}

// Takes one airing out of the list, in place; every other airing stays where it is.
function removeAiring(programs, program) {
    let i = programs.indexOf(program);
    if (i === -1) {
        return false;
    }
    programs.splice(i, 1);
    return true;
}

// Whether Escape closes the asking prompt: 'undo', or null.
function escapeAction({ key, undoPrompt }) {
    if ( (key !== 'Escape') && (key !== 'Esc') ) {
        return null;
    }
    return undoPrompt ? 'undo' : null;
}

// "Hey Arnold! S03E23 Best Man / Cool Party"; a custom-show item by its place
// in the show; a movie or anything else by its title.
// The show a swap's "This show" lists: the airing's own (Ron, Oct 29: wherever it sits
// in the list now, not the show of the slot it's in), or the slot's for a movie or Flex.
function swapShow({ airing, slotShow, getShowData }) {
    let own = getShowData(airing);
    return (own.hasShow && /^(tv|custom)\./.test(own.showId)) ? own.showId : slotShow;
}

function label(program) {
    if (typeof(program.customShowId) !== 'undefined') {
        return `${program.customShowName} #${program.customOrder + 1} ${program.title}`;
    }
    if ( (program.type === 'episode') && (typeof(program.showTitle) === 'string') ) {
        return `${program.showTitle} S${pad2(program.season)}E${pad2(program.episode)} ${program.title}`;
    }
    return program.title;
}

// A pinned copy of `program`, carrying nothing of where it came from.
function makePin({ program, at, kind, then, was, slotShow, now }) {
    let copy = JSON.parse(JSON.stringify(program));
    delete copy.slotPosition;
    delete copy.shuffleOrder;
    delete copy.start;
    delete copy.stop;
    delete copy.$index;
    delete copy.pin;
    copy.pin = { at: at, kind: kind, then: then };
    if (typeof(was) === 'string') {
        copy.pin.was = was;
    }
    copy.pin.slotShow = slotShow;
    copy.pin.made = new Date(now).toISOString();
    return copy;
}

module.exports = {
    loopEnd: loopEnd,
    swapShow: swapShow,
    label: label,
    makePin: makePin,
    walk: walk,
    airingAt: airingAt,
    carryAt: carryAt,
    whyNot: whyNot,
    breaksThatFit: breaksThatFit,
    localInstant: localInstant,
    showName: showName,
    slotAround: slotAround,
    handPlaced: handPlaced,
    addedAtEnd: addedAtEnd,
    removeAiring: removeAiring,
    escapeAction: escapeAction,
    length: length,
    dayClock: dayClock,
};
