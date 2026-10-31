/*
 * Special days: a stretch of time on given dates with its own Time Slots, in
 * place of the regular schedule for those hours, and optionally a block for
 * the whole stretch. Saved on the Time Slots schedule:
 *
 *   schedule.specialDays = [{
 *     id, name,
 *     from: { date: 'YYYY-MM-DD', time },   // a local date, and ms after its midnight
 *     to:   { date: 'YYYY-MM-DD', time },
 *     blockId,                              // or null
 *     positions: 'advance' | 'apart',
 *     layout: 'back' | 'times',
 *     slots: [ { showId, order, seasons, at, start, item } ],
 *   }]
 *
 * A Set times ('times') row has `at`, ms after from.date's local midnight, so
 * a row after midnight is past a day's worth. A Back to back ('back') row has
 * no time: each starts at the next :00 or :30 after the one before ends.
 *
 * Pure, tested in Node, bundled into the editor as src/kept-rows.js is. The
 * generator, slotProgress.slotAt, resolveContext and the editor all ask this,
 * so they can't disagree. See NOTES.md, Known issues, "Special days".
 */

const SLACK = require('./constants').SLACK;

const MINUTE = 60 * 1000;
const HALF_HOUR = 30 * MINUTE;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const EPOCH_WEEK_DAY0 = 4; // a weekly slot's day 0 is a Thursday

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/*
 * A local date and ms after its midnight, as an instant: the clock time on
 * that date, at that date's own offset. `gap` when the clock never shows that
 * time that night (the spring-forward hour); on the fall-back night the first
 * occurrence.
 */
function localInstant(date, ms) {
    let m = (typeof(date) === 'string') ? DATE.exec(date) : null;
    if ( (m === null) || (typeof(ms) !== 'number') || ! Number.isFinite(ms) || (ms < 0) ) {
        return null;
    }
    let y = Number(m[1]);
    let mo = Number(m[2]) - 1;
    let d = Number(m[3]);
    let midnight = new Date(y, mo, d);
    if ( (midnight.getFullYear() !== y) || (midnight.getMonth() !== mo) || (midnight.getDate() !== d) ) {
        return null;
    }
    let days = Math.floor(ms / DAY);
    let rest = ms - days * DAY;
    let h = Math.floor(rest / HOUR);
    let min = Math.floor( (rest % HOUR) / MINUTE );
    let sec = Math.floor( (rest % MINUTE) / 1000 );
    let milli = rest % 1000;
    let t = new Date(y, mo, d + days, h, min, sec, milli);
    return { at: t.getTime(), gap: (t.getHours() !== h) || (t.getMinutes() !== min) };
}

function wellFormed(day) {
    return (day !== null) && (typeof(day) === 'object') && (typeof(day.id) === 'string')
        && (typeof(day.from) === 'object') && (day.from !== null)
        && (typeof(day.to) === 'object') && (day.to !== null)
        && (localInstant(day.from.date, day.from.time) !== null)
        && (localInstant(day.to.date, day.to.time) !== null);
}

/* A day's start and end as instants, or null for one that isn't well formed. */
function windowOf(day) {
    if (! wellFormed(day)) {
        return null;
    }
    return { from: localInstant(day.from.date, day.from.time).at, to: localInstant(day.to.date, day.to.time).at };
}

function daysOf(schedule) {
    return ( (schedule != null) && Array.isArray(schedule.specialDays) ) ? schedule.specialDays : [];
}

/* A day that can be laid out: well formed, ending after it starts, at most a week. */
function usable(day) {
    let w = windowOf(day);
    return (w !== null) && (w.to > w.from) && (w.to - w.from <= WEEK + HOUR);
}

/*
 * The special day covering an instant, or null. The first declared wins when
 * two overlap, as with blocks; the editor doesn't let them.
 */
function dayAt(schedule, instant) {
    let days = daysOf(schedule);
    for (let i = 0; i < days.length; i++) {
        if (! usable(days[i])) {
            continue;
        }
        let w = windowOf(days[i]);
        if ( (w.from <= instant) && (instant < w.to) ) {
            return days[i];
        }
    }
    return null;
}

function aired(day, now) {
    let w = windowOf(day);
    return (w !== null) && (w.to <= now);
}

/* The usable days that haven't ended by `now`, in the order they start. */
function ahead(schedule, now) {
    return daysOf(schedule)
        .filter( (day) => usable(day) && ! aired(day, now) )
        .sort( (a, b) => windowOf(a).from - windowOf(b).from );
}

/*
 * A Set times day's rows with their instants, in time order: [{ row, at, gap }].
 * Rows without a time are left out (problems() names them).
 */
function rowTimes(day) {
    if (! wellFormed(day) || ! Array.isArray(day.slots) ) {
        return [];
    }
    let out = [];
    day.slots.forEach( (row) => {
        if ( (row == null) || (typeof(row.at) !== 'number') ) {
            return;
        }
        let x = localInstant(day.from.date, row.at);
        if (x !== null) {
            out.push({ row: row, at: x.at, gap: x.gap });
        }
    } );
    return out.sort( (a, b) => a.at - b.at );
}

/*
 * The first local :00 or :30 at or after t, in real time; a moment up to
 * SLACK past one counts as on it. Across a clock change the next one in real
 * time: 1:47am CDT on the fall-back night goes to 1:00am CST.
 */
function nextHalfHour(t) {
    let offset = (new Date(t)).getTimezoneOffset() * MINUTE;
    let local = t - offset;
    let into = ( (local % HALF_HOUR) + HALF_HOUR ) % HALF_HOUR;
    if (into <= SLACK) {
        return t;
    }
    return t + (HALF_HOUR - into);
}

/* The tag a Keep-apart day puts on its positions' keys and its airings' labels. */
function tag(dayId) {
    return '@' + dayId;
}

function taggedKey(key, dayId) {
    let parts = JSON.parse(key);
    return JSON.stringify( parts.concat( [ tag(dayId) ] ) );
}

function taggedLabel(text, dayId) {
    return text + '|' + tag(dayId);
}

/* The day a tagged key or label belongs to, or null. */
function tagOf(text) {
    if (typeof(text) !== 'string') {
        return null;
    }
    let last = null;
    if (text.charAt(0) === '[') {
        try {
            let parts = JSON.parse(text);
            last = Array.isArray(parts) ? parts[parts.length - 1] : null;
        } catch (e) {
            return null;
        }
    } else {
        let parts = text.split('|');
        last = parts[parts.length - 1];
    }
    return ( (typeof(last) === 'string') && (last.charAt(0) === '@') && (last.length > 1) ) ? last.slice(1) : null;
}

function clock(t) {
    let d = new Date(t);
    return clockOf(d.getHours(), d.getMinutes());
}

/* A clock time as entered: ms after a midnight, a day's worth or more past it. */
function clockOfMs(ms) {
    let rest = ( (ms % DAY) + DAY ) % DAY;
    return clockOf(Math.floor(rest / HOUR), Math.floor( (rest % HOUR) / MINUTE ));
}

function clockOf(h, m) {
    return `${ (h % 12 === 0) ? 12 : h % 12 }:${String(m).padStart(2, '0')}${ (h < 12) ? 'am' : 'pm' }`;
}

/*
 * What stops a day being laid out, each in a few words, keyed by the field it
 * belongs to: [{ dayId, field, text }]. `blocks` is the channel's blocks.
 */
function problems(schedule, blocks) {
    let out = [];
    let days = daysOf(schedule);
    let say = (day, field, text) => out.push({ dayId: (day && day.id) || null, field: field, text: text });
    let windows = days.map( (day) => (usable(day) ? windowOf(day) : null) );
    days.forEach( (day, i) => {
        if (! wellFormed(day)) {
            say(day, 'when', 'Needs a start and an end.');
            return;
        }
        let w = windowOf(day);
        if (w.to <= w.from) {
            say(day, 'when', 'Ends before it starts.');
            return;
        }
        if (! usable(day)) {
            say(day, 'when', 'Longer than a week.');
            return;
        }
        for (let j = 0; j < i; j++) {
            let o = windows[j];
            if ( (o !== null) && (o.from < w.to) && (w.from < o.to) ) {
                say(day, 'when', `Overlaps ${days[j].name || 'another special day'}.`);
            }
        }
        if ( (day.blockId != null) && ! (Array.isArray(blocks) && blocks.some( (b) => (b != null) && (b.id === day.blockId) )) ) {
            say(day, 'block', 'Its block is gone.');
        }
        let rows = Array.isArray(day.slots) ? day.slots : [];
        if (rows.length === 0) {
            say(day, 'rows', 'Has no rows.');
            return;
        }
        if (rows.some( (row) => (row != null) && (typeof(row.item) === 'object') && ( (row.item === null) || (typeof(row.item.program) !== 'object') || (row.item.program === null) ) )) {
            say(day, 'rows', 'A row has no item picked.');
        }
        if (day.layout !== 'times') {
            return;
        }
        if (rows.some( (row) => (row == null) || (typeof(row.at) !== 'number') )) {
            say(day, 'rows', 'A row has no time.');
        }
        let timed = rowTimes(day);
        if ( (timed.length > 0) && (timed[0].at !== w.from) ) {
            say(day, 'rows', `The first row must be at ${clock(w.from)}.`);
        }
        timed.forEach( (x, k) => {
            if (x.gap) {
                say(day, 'rows', `${clockOfMs(x.row.at)} doesn't happen that night.`);
            } else if ( (x.at < w.from) || (x.at >= w.to) ) {
                say(day, 'rows', `A row at ${clock(x.at)} is outside the day.`);
            }
            if ( (k > 0) && (timed[k - 1].at === x.at) ) {
                say(day, 'rows', `Two rows at ${clock(x.at)}.`);
            }
        } );
    } );
    return out;
}

/*
 * A block's slots, once, in the order they air through the calendar week
 * (Sunday first; for Toonami Mon, Tue, Wed, Fri), each as a row: its show,
 * order and seasons, and `length`, the slot's own length, for fillTimes. A
 * Repeat becomes a Rerun of its show - a special day doesn't offer Repeat -
 * and Flex and redirect slots are left out.
 */
function fillFromBlock({ block, schedule }) {
    if ( (block == null) || ! Array.isArray(block.airings) || (schedule == null) || ! Array.isArray(schedule.slots) ) {
        return [];
    }
    let period = (typeof(schedule.period) === 'number') ? schedule.period : DAY;
    let slots = schedule.slots.filter( (s) => (s != null) && (typeof(s.time) === 'number') ).slice().sort( (a, b) => a.time - b.time );
    let lengthOf = (k) => ( (k === slots.length - 1) ? slots[0].time + period : slots[k + 1].time ) - slots[k].time;
    let found = [];
    slots.forEach( (slot, k) => {
        if ( (typeof(slot.showId) !== 'string') || (slot.showId === 'flex.') || slot.showId.startsWith('redirect.') ) {
            return;
        }
        let ms = slot.time % DAY;
        let days = (period === WEEK) ? [ (Math.floor(slot.time / DAY) + EPOCH_WEEK_DAY0) % 7 ] : [ 0, 1, 2, 3, 4, 5, 6 ];
        let best = null;
        block.airings.forEach( (a) => {
            if ( (a == null) || ! Array.isArray(a.days) || (typeof(a.start) !== 'number') || (typeof(a.end) !== 'number') ) {
                return;
            }
            days.forEach( (cd) => {
                let crosses = (a.end <= a.start);
                let starts = null;
                if (a.days.indexOf(cd) !== -1 && (ms >= a.start) && (crosses || (ms < a.end))) {
                    starts = cd;
                } else if (crosses && (a.days.indexOf( (cd + 6) % 7 ) !== -1) && (ms < a.end)) {
                    starts = (cd + 6) % 7;
                }
                if (starts !== null) {
                    let into = (starts === cd) ? ms - a.start : ms + DAY - a.start;
                    let sortKey = (period === WEEK) ? starts * DAY + a.start + into : a.start + into;
                    if ( (best === null) || (sortKey < best) ) {
                        best = sortKey;
                    }
                }
            } );
        } );
        if (best !== null) {
            let row = { showId: slot.showId, order: (slot.order === 'repeat') ? 'rerun' : (slot.order || 'next'), length: lengthOf(k) };
            if ( (typeof(slot.seasons) === 'object') && (slot.seasons !== null) ) {
                row.seasons = JSON.parse(JSON.stringify(slot.seasons));
            } else if ( (schedule.showConstraints != null) && (typeof(schedule.showConstraints[slot.showId]) === 'object') ) {
                row.seasons = JSON.parse(JSON.stringify(schedule.showConstraints[slot.showId]));
            }
            found.push({ row: row, sortKey: best });
        }
    } );
    return found.sort( (a, b) => a.sortKey - b.sortKey ).map( (x) => x.row );
}

/*
 * Set times: the rows repeated at their own lengths from the day's start to
 * its end, each given `at`. Rows without a length take half an hour.
 */
function fillTimes(day, rows) {
    let w = windowOf(day);
    if ( (w === null) || ! Array.isArray(rows) || (rows.length === 0) ) {
        return [];
    }
    let out = [];
    let at = day.from.time;
    let span = w.to - w.from;
    for (let k = 0; at - day.from.time < span; k++) {
        let row = rows[k % rows.length];
        let copy = JSON.parse(JSON.stringify(row));
        delete copy.length;
        copy.at = at;
        out.push(copy);
        at += (typeof(row.length) === 'number') && (row.length > 0) ? row.length : HALF_HOUR;
    }
    return out;
}

/*
 * For slotProgress.slotAt: wraps a regular finder so a moment inside a
 * special day answers with that day's row - a Set times row, marked
 * `special` with the day's id - or, inside a Back to back day, whose rows'
 * times only the lineup knows, `{ special, row: null }`. The answers are built
 * once, so the same moment always gets the same object.
 */
function wrapFinder(schedule, regular) {
    let days = daysOf(schedule).filter(usable);
    if (days.length === 0) {
        return regular;
    }
    let laid = days.map( (day) => {
        let w = windowOf(day);
        if (day.layout === 'times') {
            let timed = rowTimes(day).filter( (x) => ! x.gap && (x.at >= w.from) && (x.at < w.to) );
            return { day: day, w: w, timed: timed.map( (x) => ({ at: x.at, slot: Object.assign( {}, x.row, { special: day.id } ) }) ) };
        }
        return { day: day, w: w, back: { special: day.id, row: null } };
    } );
    return (instant) => {
        for (let i = 0; i < laid.length; i++) {
            let x = laid[i];
            if ( (x.w.from <= instant) && (instant < x.w.to) ) {
                if (x.back) {
                    return x.back;
                }
                let found = null;
                for (let k = 0; k < x.timed.length; k++) {
                    if (x.timed[k].at <= instant) {
                        found = x.timed[k].slot;
                    }
                }
                return found;
            }
        }
        return regular(instant);
    };
}

module.exports = {
    localInstant: localInstant,
    windowOf: windowOf,
    dayAt: dayAt,
    ahead: ahead,
    aired: aired,
    usable: usable,
    rowTimes: rowTimes,
    nextHalfHour: nextHalfHour,
    tag: tag,
    taggedKey: taggedKey,
    taggedLabel: taggedLabel,
    tagOf: tagOf,
    problems: problems,
    fillFromBlock: fillFromBlock,
    fillTimes: fillTimes,
    wrapFinder: wrapFinder,
};
