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

/*
 * What a re-lay did, from the lineup before it to the one after, from
 * `from` to `to`: positions whose episode now airs at a later slot (the
 * first of each), programs that run late the same evening, when the schedule
 * is back on time, and airings that belonged to no slot - placed by hand -
 * that the re-lay drops.
 */
function relayEffects({ before, after, from, to, schedule, getShowData }) {
    // Not past two weeks before either lineup comes round its loop: a
    // lineup's last days sit off the slots and end in Flex, so they'd read
    // as hand-placed, and they're a year out, beyond what a re-lay keeps.
    // A lineup's real end is where its loop comes round - and, since the
    // editor rotates a lineup's start to now, that is found as its longest
    // Flex (a day or more: generators end a lineup in days of it), not from
    // its start.
    let loopEnd = (lineup) => {
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
    };
    to = Math.min(to, loopEnd(before) - 14 * DAY, loopEnd(after) - 14 * DAY);
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
    return effects;
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

function sayDropped(dropped) {
    if (dropped.length === 0) {
        return '';
    }
    return 'This also drops what was placed in the list by hand: '
        + dropped.map( (d) => `${dayClock(d.start)} ${d.program.title} (${length(d.program.duration)})` ).join('; ') + '.';
}

function sayFirstSwap({ dropped }) {
    return 'Swapping re-makes the lineup from your Time Slots schedule, as Create Lineup does, so anything placed in the list by hand'
        + ' - bumpers, promos, episodes inserted from the library - is dropped. '
        + ( (dropped.length > 0) ? sayDropped(dropped) : 'Nothing placed by hand from now on would be lost.' );
}

// The undo prompt, from the re-lay without the pin, worked out before asking.
function sayUndo({ label, at, effects, anyway, dropped }) {
    let changed = (effects.movedAlong.length + effects.late.length + (effects.early || []).length) > 0;
    return `Undo ${label}, pinned to ${dayClock(at)}? The slot's own programming comes back`
        + (changed ? ': ' + sayEffects(effects) : '.')
        + (anyway ? ' ' + anyway : '')
        + ( (dropped.length > 0) ? ' ' + sayDropped(dropped) : '' );
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
    label: label,
    makePin: makePin,
    removalPin: removalPin,
    pinsAhead: pinsAhead,
    walk: walk,
    airingAt: airingAt,
    localInstant: localInstant,
    showName: showName,
    slotAround: slotAround,
    fitAt: fitAt,
    relayEffects: relayEffects,
    sayFit: sayFit,
    sayEffects: sayEffects,
    sayDropped: sayDropped,
    sayFirstSwap: sayFirstSwap,
    sayKept: sayKept,
    sayUndo: sayUndo,
    length: length,
    clock: clock,
    dayClock: dayClock,
};
