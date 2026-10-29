/*
 * Swaps and inserts: an airing fixed to its date and time by a mark,
 * `program.pin`, on the airing itself in channel.programs - so there is no
 * separate list to keep in step with the lineup. The Time Slots generator
 * places pins (src/services/time-slots-service.js); this module is what the
 * editor needs around them. Pure, tested in Node, and bundled into the editor
 * as src/episode-start.js is. See NOTES.md, Known issues, "Swaps, inserts and
 * Flex that keeps time".
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
// 8:00, 7:44:09 - a time on the evening the dialog is about
function clock(t) {
    let d = new Date(t);
    let h = d.getHours() % 12 || 12;
    let s = d.getSeconds();
    return `${h}:${pad2(d.getMinutes())}` + ( (s > 0) ? `:${pad2(s)}` : '' );
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
const possessive = (name) => /s$/.test(name) ? name + "'" : name + "'s";

const fileOf = (p) => (p.serverKey || '') + '|' + (p.key || '') + '|' + p.title;

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

// "7:30-8:00pm", "11:40am-12:10pm": a time range to the minute, saying am or
// pm once when both ends agree.
function range(from, to) {
    let at = (t) => {
        let d = new Date(Math.round(t / MINUTE) * MINUTE);
        let h = d.getHours() % 12 || 12;
        return { text: `${h}:${pad2(d.getMinutes())}`, half: (d.getHours() < 12) ? 'am' : 'pm' };
    };
    let a = at(from), b = at(to);
    return (a.half === b.half) ? `${a.text}-${b.text}${b.half}` : `${a.text}${a.half}-${b.text}${b.half}`;
}

/*
 * What deleting the airing at `index` of `programs` (which starts at
 * `startTime`) leaves: the Flex from where it began to where the next program
 * does - its own length and the break after it. `offerSwap` when that is
 * longer than about two minutes: the prompt then offers Swap instead.
 */
function sayRemoval({ programs, startTime, index, schedule }) {
    let from = startTime;
    for (let i = 0; i < index; i++) {
        from += programs[i].duration;
    }
    let flexMs = programs[index].duration;
    for (let j = index + 1; (j < programs.length) && programs[j].isOffline && (programs[j].type !== 'redirect'); j++) {
        flexMs += programs[j].duration;
    }
    // The airing's slot stays Flex to its end - what follows in the slot is not refilled,
    // so a half of a two-halves slot leaves the whole slot (the generator's remove rule).
    if ( (typeof(schedule) === 'object') && (schedule !== null) ) {
        let slot = slotAround({ schedule: schedule, at: from });
        if ( (slot !== null) && (slot.end > from + flexMs) ) {
            flexMs = slot.end - from;
        }
    }
    return {
        flexMs: flexMs, from: from, to: from + flexMs, offerSwap: flexMs > 2 * MINUTE,
        text: `Leaves ${length(flexMs)} of Flex, ${range(from, from + flexMs)}.`,
    };
}

/*
 * Pins whose slot has changed since they were made: a pin records the show
 * of the slot it sits in (`pin.slotShow`), and when the schedule now puts
 * another show there - or Flex - the Time Slots dialog says so. A pin made
 * before slots were recorded has none and gets no note. `nameOf` turns a
 * show id into a name; the default drops the "tv." / "custom." prefix.
 */
function pinNotes({ pins, schedule, nameOf }) {
    let name = (id) => (typeof(nameOf) === 'function' && nameOf(id)) || ( (id === 'flex.') ? 'Flex' : String(id).replace(/^(tv|custom|movie)\./, '') );
    let notes = [];
    pins.forEach( (x) => {
        let made = x.program && x.program.pin && x.program.pin.slotShow;
        if (typeof(made) !== 'string') {
            return;
        }
        let slot = slotProgress.slotAt(schedule, x.at);
        let now = (slot === null) ? null : slot.showId;
        if ( (now !== null) && (now !== made) ) {
            let what = x.program.isOffline ? 'Flex' : x.program.title;
            notes.push({ pin: x, text: `${what}, ${dayClock(x.at)}: that slot is ${(now === 'flex.') ? 'Flex' : possessive(name(now))} now, not ${possessive(name(made))}.` });
        }
    } );
    return notes;
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

// A prompt that is still working out `program`'s re-lay and has not been
// cancelled or replaced: only then may its result be applied.
function stillWanted(prompt, program) {
    return (typeof(prompt) === 'object') && (prompt !== null) && (prompt.program === program) && (prompt.working === true);
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

// Where an item of `duration` put at `at` fits: to the end of its slot.
function fitAt({ programs, startTime, schedule, at, duration }) {
    let around = slotAround({ schedule, at });
    let slotEnd = (around !== null) ? around.end : at + duration;
    let next = walk(programs, startTime, slotEnd - SAME, slotEnd + SAME)
        .find( (x) => ! x.program.isOffline && (Math.abs(x.start - slotEnd) <= SAME) );
    return {
        slotEnd: slotEnd,
        space: slotEnd - at,
        overrun: Math.max(0, at + duration - slotEnd),
        runsInto: (typeof(next) === 'undefined') ? null : { start: next.start, program: next.program },
    };
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
 * What a re-lay did, from the lineup before it to the one after, from
 * `from` to `to`: positions whose episode now airs at a later slot (the
 * first of each), programs that run late the same evening, when the schedule
 * is back on time, and airings that belonged to no slot - placed by hand -
 * that the re-lay drops.
 */
function relayEffects({ before, after, from, to, schedule, getShowData }) {
    // Not past two weeks before either lineup comes round its loop (see loopEnd).
    to = Math.min(to, loopEnd(before, from) - 14 * DAY, loopEnd(after, from) - 14 * DAY);
    let starts = new Map();
    let anyStart = new Set();
    walk(after.programs, after.startTime, from - 3 * HOUR, to + 3 * HOUR).forEach( (x) => {
        if (x.program.isOffline) {
            return;
        }
        anyStart.add(Math.round(x.start / SECOND));
        let k = fileOf(x.program);
        if (! starts.has(k)) {
            starts.set(k, []);
        }
        starts.get(k).push(x.start);
    } );
    let has = (x) => (starts.get(fileOf(x.program)) || []).some( (s) => Math.abs(s - x.start) <= SAME );
    // Whether some program starts in `after` at an instant: a show that only
    // shifted - ran late, or came back on time - leaves its old time to the
    // program before it, still on; one that moved along leaves it to another.
    let startsNear = (t) => {
        let s = Math.round(t / SECOND);
        for (let d = -2; d <= 2; d++) {
            if (anyStart.has(s + d)) {
                return true;
            }
        }
        return false;
    };
    let effects = { movedAlong: [], late: [], early: [], backOnTime: null, dropped: [] };
    let seen = new Set();
    let lastLate = null;
    let found = slotProgress.airings({ programs: before.programs, startTime: before.startTime, from, to, schedule, getShowData });
    for (let x of found) {
        if ( (x.start < from - SAME) || x.program.pin ) {
            continue;
        }
        if (has(x)) {
            if ( (lastLate !== null) && (effects.backOnTime === null) && (x.start > lastLate) ) {
                effects.backOnTime = x.start;
            }
            continue;
        }
        if (x.key === null) {
            if (x.program.slotPosition !== 'repeat') {
                effects.dropped.push({ start: x.start, program: x.program });
            }
            continue;
        }
        let elsewhere = (starts.get(fileOf(x.program)) || []).filter( (s) => Math.abs(s - x.start) > SLACK );
        let nearest = elsewhere.slice().sort( (a, b) => Math.abs(a - x.start) - Math.abs(b - x.start) )[0];
        if ( (typeof(nearest) !== 'undefined') && (Math.abs(nearest - x.start) <= 3 * HOUR) && ! startsNear(x.start) ) {
            if (nearest > x.start) {
                effects.late.push({ program: x.program, wasAt: x.start, nowAt: nearest });
                lastLate = x.start;
            } else {
                effects.early.push({ program: x.program, wasAt: x.start, nowAt: nearest });
            }
        } else if (! seen.has(x.key)) {
            seen.add(x.key);
            // The episode's nearest airing now: later when a swap pushed it out,
            // earlier when undoing one brought it back.
            effects.movedAlong.push({ name: showName(x.program), program: x.program, wasAt: x.start,
                nowAt: (typeof(nearest) === 'undefined') ? null : nearest,
                back: (typeof(nearest) !== 'undefined') && (nearest < x.start) });
        }
    }
    // What was added after the lineup's end Flex is past the clip above, and a
    // re-lay drops it all the same.
    let named = new Set(effects.dropped.map( (d) => d.program ));
    addedAtEnd({ programs: before.programs, startTime: before.startTime, from, schedule, getShowData })
        .forEach( (d) => { if (! named.has(d.program)) { effects.dropped.push(d); } } );
    return effects;
}

/*
 * What was put at the end of the list - the library's "Insert at the end of
 * list" - which relayEffects and handPlaced never reach: it sits after the
 * lineup's end Flex, where they stop (two weeks before the loop's end), yet a
 * re-lay drops it. Read from the list alone: the run of airings at its very
 * end that no slot made, each at its next airing from `from`.
 *
 * The editor rotates the list to start at now, so the end Flex is not at the
 * end of the array: after it come the loop's seam (the generator leaves an
 * airing or two off the slots there) and the lineup's first days, and what was
 * added follows those. So it is the run that ends the list, after the last
 * airing a slot made. And the generator makes a lineup a whole number of the
 * schedule's periods long, so only one that is not whole has had anything
 * added; a lineup with no labels reads every airing as no slot's, which says
 * nothing here (relayEffects' own window reports that).
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
 * programs, or a show added from the library. Read as relayEffects reads what
 * a re-lay would drop, from `from` to `to` (clipped before the loop comes
 * round), but from the lineup alone: no re-lay is needed to know it.
 */
function handPlaced({ programs, startTime, from, to, schedule, getShowData }) {
    let lineup = { programs, startTime };
    to = Math.min(to, loopEnd(lineup, from) - 14 * DAY);
    return slotProgress.airings({ programs, startTime, from, to, schedule, getShowData })
        .filter( (x) => (x.start >= from - SAME) && ! x.program.pin && (x.key === null) && (x.program.slotPosition !== 'repeat') )
        .map( (x) => ({ start: x.start, program: x.program }) );
}

/*
 * What deleting an airing does on a Time Slots channel: 'relay' re-makes the
 * lineup from the schedule, which drops anything in the list that no slot
 * made, so unless the list is the generator's own it is 'splice' - the airing
 * comes out of the list and nothing else changes.
 *
 * It is not the generator's own when something in it is placed by hand
 * (handPlaced), or when it is not a whole number of the schedule's periods
 * long: the generator makes it so, and whatever was added after its end Flex
 * - the library's "Insert at the end of list" - or taken out of it by hand
 * is past where handPlaced reaches (a lineup's last two weeks are the
 * generator's own, off the slots), and a re-lay would drop it unseen.
 */
function deleteMode({ programs, startTime, from, to, schedule, getShowData }) {
    if (handPlaced({ programs, startTime, from, to, schedule, getShowData }).length > 0) {
        return 'splice';
    }
    let period = (schedule && schedule.period);
    if (Number.isFinite(period) && (period > 0)) {
        let left = mod(programs.reduce( (a, p) => a + p.duration, 0 ), period);
        if ( (left > 1) && (period - left > 1) ) {
            return 'splice';
        }
    }
    return 'relay';
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

// Which prompt Escape closes: the undo/confirm prompt sits on top of the delete prompt.
function escapeAction({ key, deletePrompt, undoPrompt }) {
    if ( (key !== 'Escape') && (key !== 'Esc') ) {
        return null;
    }
    return undoPrompt ? 'undo' : (deletePrompt ? 'delete' : null);
}

/*
 * The dialog's sentences. sayFit works out the Flex left from the lineup as
 * it is, unless `after` - the re-laid lineup - is given, which says it
 * exactly (a slot's own show may air after the item).
 */
function sayFit({ programs, startTime, schedule, at, item, kind, after }) {
    let fit = fitAt({ programs, startTime, schedule, at, duration: item.duration });
    let here = walk(programs, startTime, at - SAME, fit.slotEnd - SAME);
    let space;
    if (kind === 'insert') {
        let before = walk(programs, startTime, at - SAME - 1, at - SAME).filter( (x) => ! x.program.isOffline ).pop();
        space = `the break after ${before ? before.program.title : 'the program before it'}`;
    } else {
        let shows = here.filter( (x) => ! x.program.isOffline && (x.start >= at - SAME) );
        let last = shows[shows.length - 1];
        let flex = last ? fit.slotEnd - (last.start + last.program.duration) : fit.space;
        space = shows.map( (x) => x.program.title ).join(' and ')
            + ( (flex > SAME) ? ` and the ${length(flex)} of Flex after ${ (shows.length > 1) ? 'them' : 'it' }` : '' );
    }
    let text = `${item.title} runs ${length(item.duration)}. The space is ${length(fit.space)} - ${space}.`;
    if (fit.overrun > SLACK) {
        return text + ` It runs ${length(fit.overrun)} past ${clock(fit.slotEnd)}`
            + (fit.runsInto ? `, into ${possessive(showName(fit.runsInto.program))} slot.` : '.');
    }
    let left = fit.space - item.duration;
    let next = fit.runsInto;
    if (after) {
        let placed = walk(after.programs, after.startTime, at - SAME, fit.slotEnd + 3 * HOUR)
            .find( (x) => x.program.pin && (Math.abs(x.program.pin.at - at) <= SAME) );
        if (placed && (placed.start > at + SLACK)) {
            // Held back by a program still on at its time: what it fits is from there.
            let behind = walk(after.programs, after.startTime, placed.start - DAY, placed.start)
                .filter( (x) => ! x.program.isOffline && (x.start < placed.start) ).pop();
            let held = `can't start until ${clock(placed.start)}` + (behind ? `: ${showName(behind.program)} is still on until then` : '');
            let over = placed.start + item.duration - fit.slotEnd;
            if (over > SLACK) {
                return text + ` It fits the space, but ${held}, so it runs ${length(over)} past ${clock(fit.slotEnd)}`
                    + (fit.runsInto ? `, into ${possessive(showName(fit.runsInto.program))} slot.` : '.');
            }
            let following = walk(after.programs, after.startTime, placed.start + placed.program.duration, fit.slotEnd + 3 * HOUR)
                .find( (x) => ! x.program.isOffline );
            return text + ` It fits, but ${held}: ${length(placed.flex)} of Flex after it`
                + (following ? `, and ${showName(following.program)} starts at ${clock(following.start)}.` : '.');
        }
        if (placed) {
            left = placed.flex;
            let following = walk(after.programs, after.startTime, placed.start + placed.program.duration, fit.slotEnd + 3 * HOUR)
                .find( (x) => ! x.program.isOffline );
            next = following ? { start: following.start, program: following.program } : null;
        }
    }
    return text + ` It fits: ${length(left)} of Flex after it`
        + (next ? `, and ${showName(next.program)} starts at ${clock(next.start)}.` : '.');
}

function sayEffects(effects) {
    let parts = effects.movedAlong.map( (m) => (m.nowAt === null)
        ? `${m.program.title} waits for ${possessive(m.name)} next airing.`
        : (m.back
            ? `${m.program.title} airs ${dayClock(m.nowAt)} instead, and ${possessive(m.name)} later airings move back one.`
            : `${m.program.title} airs ${dayClock(m.nowAt)}, and ${possessive(m.name)} later airings move one along.`) );
    if (effects.late.length > 0) {
        let names = effects.late.map( (l, i) => (i === 0)
            ? `${showName(l.program)} starts at ${clock(l.nowAt)}`
            : `${showName(l.program)} at ${clock(l.nowAt)}` );
        let joined = (names.length === 1) ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
        parts.push(joined + ( (effects.backOnTime !== null) ? `; back on time at ${clock(effects.backOnTime)}.` : '.' ));
    }
    let early = effects.early || [];
    if (early.length > 0) {
        let and = (list) => (list.length === 1) ? list[0] : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
        parts.push(`${and(early.map( (e) => showName(e.program) ))} ${ (early.length === 1) ? 'is' : 'are' } back on time, at `
            + `${and(early.map( (e) => clock(e.nowAt) ))}.`);
    }
    return (parts.length > 0) ? parts.join(' ') : 'Nothing else changes.';
}

/*
 * What a re-lay does that is said first, before any choice: pins in `after`
 * that would start later than their time - a program still on then - and slot
 * occurrences from `from` to `to` whose own show aired in `before` but has no
 * airing starting in them in `after`. The slot `own` - the new pin's instant -
 * is in is left out: the pin is there in its place.
 *
 * And `moved`: pins still to air in `before` that `after` doesn't air where
 * `before` has them - one moved by hand in the list, which a re-lay puts back
 * at its pinned time (Ron, Oct 29: the Venture Bros. special dragged from
 * 3:30am to 12:00am), or one `after` doesn't hold at all (`nowAt` null). A pin
 * `after` pushes late is `pushed`'s. `replacing`, the instant a swap is made
 * at, leaves out the pinned airing there: the swap replaces it; `moving`, the
 * pinned time of a pin dragged elsewhere, leaves that one out: it is re-pinned.
 */
function slotWarnings({ before, after, from, to, schedule, getShowData, own, replacing, moving }) {
    let pushed = [];
    let behind = null;
    walk(after.programs, after.startTime, from - DAY, loopEnd(after, from)).forEach( (x) => {
        let pin = x.program.pin;
        if ( pin && (typeof(pin.at) === 'number') && (x.start + x.program.duration > from) && (x.start > pin.at + SLACK) ) {
            pushed.push({ program: x.program, at: pin.at, start: x.start, behind: behind });
        }
        if (! x.program.isOffline) {
            behind = { start: x.start, program: x.program };
        }
    } );
    let moved = pinsMoved({ before, after, from, replacing, moving });
    let airings = (lineup) => walk(lineup.programs, lineup.startTime, from - 3 * HOUR, to + 3 * HOUR).filter( (x) => ! x.program.isOffline );
    let was = airings(before);
    let now = airings(after);
    let ownSlot = (typeof(own) === 'number') ? slotAround({ schedule, at: own }) : null;
    let lost = [];
    for (let t = from; t < to; ) {
        let occ = slotAround({ schedule, at: t });
        if ( (occ === null) || (occ.end <= t) ) {
            break;
        }
        let id = occ.showId;
        if ( (occ.start >= from - SAME) && ! ( (ownSlot !== null) && (ownSlot.start === occ.start) )
            && (typeof(id) === 'string') && ! /^(flex|redirect)\./.test(id) ) {
            let airs = (list) => list.find( (x) => (x.start >= occ.start - SAME) && (x.start < occ.end - SAME) && (getShowData(x.program).showId === id) );
            let had = airs(was);
            if (had && ! airs(now)) {
                lost.push({ name: showName(had.program), start: occ.start, program: had.program });
            }
        }
        t = occ.end;
    }
    return { pushed, lost, moved };
}

// slotWarnings' `moved`, for the prompts that re-lay without its other warnings (undo, delete).
function pinsMoved({ before, after, from, replacing, moving }) {
    let pinKey = (pin) => `${pin.at}|${pin.made}|${pin.kind}`;
    let placed = new Map();
    walk(after.programs, after.startTime, from - DAY, loopEnd(after, from)).forEach( (x) => {
        let pin = x.program.pin;
        if ( pin && (typeof(pin.at) === 'number') && (x.start + x.program.duration > from) && ! placed.has(pinKey(pin)) ) {
            placed.set(pinKey(pin), x.start);
        }
    } );
    let moved = [];
    let seen = new Set();
    walk(before.programs, before.startTime, from - DAY, loopEnd(before, from)).forEach( (x) => {
        let pin = x.program.pin;
        if ( ! pin || (typeof(pin.at) !== 'number') || (x.start + x.program.duration <= from) || seen.has(pinKey(pin))
            || ( (typeof(moving) === 'number') && (pin.at === moving) ) ) {
            return;
        }
        seen.add(pinKey(pin));
        let nowAt = placed.has(pinKey(pin)) ? placed.get(pinKey(pin)) : null;
        if (nowAt === null) {
            if ( ! ( (typeof(replacing) === 'number') && (Math.abs(x.start - replacing) <= SLACK) ) ) {
                moved.push({ program: x.program, at: pin.at, wasAt: x.start, nowAt: null, passed: pin.at + x.program.duration <= from });
            }
        } else if ( (Math.abs(nowAt - x.start) > SLACK) && (nowAt <= pin.at + SLACK) ) {
            moved.push({ program: x.program, at: pin.at, wasAt: x.start, nowAt: nowAt });
        }
    } );
    return moved;
}

function sayMoved(moved) {
    let named = (p) => p.isOffline ? `The Flex in place of ${p.pin.was}` : p.title;
    return (moved || []).map( (x) => (x.nowAt !== null)
        ? `${named(x.program)} is at ${dayClock(x.wasAt)} in the list, but it is pinned to ${dayClock(x.at)}: re-making puts it back at its pinned time.`
        : (x.passed
            ? `${named(x.program)} is at ${dayClock(x.wasAt)} in the list, but it is pinned to ${dayClock(x.at)}, which has passed: re-making drops it.`
            : `${named(x.program)}, pinned to ${dayClock(x.at)}, would be dropped.`) );
}

/*
 * slotWarnings' `moved` read from one lineup, with no re-lay to compare: for
 * the Time Slots dialog, whose Create Lineup applies at once. A pin still to
 * air whose row starts before its time - the generator never airs one early -
 * or after it with Flex before it (a program still on pushes a pin to the
 * moment it ends, Flex never does), or whose time has passed while its row is
 * still ahead.
 */
function outOfPlace({ programs, startTime, now }) {
    let lineup = { programs, startTime };
    let out = [];
    let seen = new Set();
    let before = null;
    walk(programs, startTime, now - DAY, loopEnd(lineup, now)).forEach( (x) => {
        let pin = x.program.pin;
        if ( pin && (typeof(pin.at) === 'number') && (x.start + x.program.duration > now) && ! seen.has(pin) ) {
            seen.add(pin);
            if (pin.at + x.program.duration <= now) {
                out.push({ program: x.program, at: pin.at, wasAt: x.start, nowAt: null, passed: true });
            } else if ( (x.start < pin.at - SLACK) || ( (x.start > pin.at + SLACK) && (before !== null) && before.isOffline ) ) {
                out.push({ program: x.program, at: pin.at, wasAt: x.start, nowAt: pin.at });
            }
        }
        before = x.program;
    } );
    return out;
}

function sayWarnings({ pushed, lost, moved }) {
    let named = (p) => p.isOffline ? `The Flex in place of ${p.pin.was}` : p.title;
    return sayMoved(moved).concat(pushed.map( (x) => `${named(x.program)}, pinned to ${dayClock(x.at)}, would start late, at ${clock(x.start)}`
        + (x.behind ? `: ${showName(x.behind.program)} is still on until then.` : '.') ))
        .concat(lost.map( (x) => `${x.name} loses its ${dayClock(x.start)} slot.` ));
}

// A few are named in the sentence; hundreds (a show added from the library) are
// counted, and droppedLines has the list for the dialog to hold behind "show them".
const NAMED = 3;
function sayDropped(dropped) {
    if (dropped.length === 0) {
        return '';
    }
    if (dropped.length > NAMED) {
        return `This also drops ${dropped.length} airings placed in the list by hand.`;
    }
    return 'This also drops what was placed in the list by hand: '
        + droppedLines(dropped).join('; ') + '.';
}

// What a prompt holds behind "show them": the list, when the sentence only counts it.
function droppedBehind(dropped) {
    return (dropped.length > NAMED) ? droppedLines(dropped) : [];
}

function droppedLines(dropped) {
    return dropped.map( (d) => `${dayClock(d.start)} ${d.program.title} (${length(d.program.duration)})` );
}

function sayFirstSwap({ dropped }) {
    return 'A swap or an insert re-makes the lineup from your Time Slots schedule, as Create Lineup does, so anything placed in the list by hand'
        + ' - bumpers, promos, episodes inserted from the library - is dropped. '
        + ( (dropped.length > 0) ? sayDropped(dropped) : 'Nothing placed by hand from now on would be lost.' );
}

// The undo prompt, from the re-lay without the pin, worked out before asking;
// `moved`, slotWarnings' other pins a re-lay moves or drops.
function sayUndo({ label, at, effects, anyway, dropped, moved }) {
    let changed = (effects.movedAlong.length + effects.late.length + (effects.early || []).length) > 0;
    return `Undo ${label}, pinned to ${dayClock(at)}? The slot's own programming comes back`
        + (changed ? ': ' + sayEffects(effects) : '.')
        + (anyway ? ' ' + anyway : '')
        + ( (dropped.length > 0) ? ' ' + sayDropped(dropped) : '' )
        + sayMoved(moved).map( (s) => ' ' + s ).join('');
}

function sayKept(ahead) {
    if (ahead.length === 0) {
        return '';
    }
    return 'Keeping your swaps and inserts: ' + ahead.map( (x) => x.program.isOffline
        ? `${dayClock(x.at)} Flex in place of ${x.program.pin.was}`
        : `${dayClock(x.at)} ${x.program.title} (${showName(x.program)})` ).join(', ') + '.';
}

// "Hey Arnold! S03E23 Best Man / Cool Party"; a custom-show item by its place
// in the show; a movie or anything else by its title.
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

// "Remove this airing only": Flex the airing's length, kept by Create Lineup.
function removalPin({ airing, at, slotShow, now }) {
    return {
        isOffline: true,
        duration: airing.duration,
        pin: { at: at, kind: 'remove', then: 'take', was: label(airing), slotShow: slotShow, made: new Date(now).toISOString() },
    };
}

// The pins in a lineup still to air, as the generator takes them. Each airing
// is in the lineup once a cycle and its pin names its instant, so no walk is
// needed: `startTime` is accepted for symmetry with the other readers.
/*
 * Where a pinned row dragged in the list lands, to be re-pinned there (Ron,
 * Oct 29): `from` is its row, `before` the row it is dropped in front of, as
 * the list shows them. Before an airing, a swap of that airing - at its slot's
 * start when it starts there, as the swap dialog pins one; before a Flex, an
 * insert in the break after the airing before it. Null when it would land
 * where it is, or nowhere a swap or insert can go.
 */
function dropSpot({ programs, startTime, schedule, from, before }) {
    if ( (before === from) || (before === from + 1) || (before < 0) || (before >= programs.length) ) {
        return null;
    }
    let starts = [];
    programs.reduce( (t, p) => { starts.push(t); return t + p.duration; }, startTime );
    let row = programs[before];
    if ( ! row.isOffline ) {
        let around = slotAround({ schedule, at: starts[before] });
        let at = ( (around !== null) && (Math.abs(starts[before] - around.start) <= SLACK) ) ? around.start : starts[before];
        return { mode: 'swap', index: before, at: at };
    }
    let after = before - 1;
    if ( (after < 0) || (after === from) || programs[after].isOffline ) {
        return null;
    }
    return { mode: 'insert', index: after, at: starts[after] + programs[after].duration };
}

function pinsAhead({ programs, startTime, now }) {
    void startTime;
    return programs
        .filter( (p) => (typeof(p.pin) === 'object') && (p.pin !== null) && (typeof(p.pin.at) === 'number') && (p.pin.at + p.duration > now) )
        .map( (p) => ({ at: p.pin.at, then: (p.pin.then === 'late') ? 'late' : 'take', program: p }) )
        .sort( (a, b) => a.at - b.at );
}

// The pins to keep (pinsAhead's shape) with one more, a pinned program from
// makePin or removalPin, in the shape the generator takes.
function withPin(ahead, program) {
    return ahead.concat([ { at: program.pin.at, then: (program.pin.then === 'late') ? 'late' : 'take', program: program } ])
        .sort( (a, b) => a.at - b.at );
}

// Whether a re-laid lineup holds a pin made for `at` - the generator leaves
// out one it can't place (past its horizon, or with no length).
function placedIn(lineup, at) {
    return lineup.programs.some( (p) => p.pin && (typeof(p.pin.at) === 'number') && (Math.abs(p.pin.at - at) <= SAME) );
}

// Re-lays share the Time Slots editor's state, so they run one at a time:
// a second asked for while one is under way is refused, never interleaved.
function oneAtATime() {
    let running = false;
    return {
        busy: () => running,
        run: async (fn) => {
            if (running) {
                throw new Error('busy');
            }
            running = true;
            try {
                return await fn();
            } finally {
                running = false;
            }
        },
    };
}

module.exports = {
    oneAtATime: oneAtATime,
    placedIn: placedIn,
    withPin: withPin,
    slotWarnings: slotWarnings,
    sayWarnings: sayWarnings,
    sayMoved: sayMoved,
    outOfPlace: outOfPlace,
    pinsMoved: pinsMoved,
    dropSpot: dropSpot,
    label: label,
    makePin: makePin,
    removalPin: removalPin,
    pinsAhead: pinsAhead,
    walk: walk,
    airingAt: airingAt,
    carryAt: carryAt,
    whyNot: whyNot,
    stillWanted: stillWanted,
    pinNotes: pinNotes,
    sayRemoval: sayRemoval,
    breaksThatFit: breaksThatFit,
    localInstant: localInstant,
    showName: showName,
    slotAround: slotAround,
    fitAt: fitAt,
    relayEffects: relayEffects,
    sayFit: sayFit,
    sayEffects: sayEffects,
    sayDropped: sayDropped,
    droppedLines: droppedLines,
    droppedBehind: droppedBehind,
    handPlaced: handPlaced,
    addedAtEnd: addedAtEnd,
    deleteMode: deleteMode,
    removeAiring: removeAiring,
    escapeAction: escapeAction,
    sayFirstSwap: sayFirstSwap,
    sayKept: sayKept,
    sayUndo: sayUndo,
    length: length,
    clock: clock,
    dayClock: dayClock,
};
