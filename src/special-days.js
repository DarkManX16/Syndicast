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
 *     rounding: 'half' | 'quarter',        // Back to back: where rows start; 'half' when absent
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
const fileKey = require('./shuffle-rounds').fileKey;

const MINUTE = 60 * 1000;
const HALF_HOUR = 30 * MINUTE;
const QUARTER_HOUR = 15 * MINUTE;
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
 * A Back to back row that runs until a time (NOTES.md, "Event tools"): the
 * instant of its `until` - ms after from.date's midnight, as a Set times row's
 * `at` - or null for a row without one, a This item row, or a Set times day,
 * whose rows already run to the next row's time.
 */
function isItemRow(row) {
    return (row != null) && (typeof(row.item) === 'object') && (row.item !== null);
}
function untilAt(day, row) {
    if ( (day == null) || (day.layout === 'times') || (row == null) || (typeof(row.until) !== 'number') || isItemRow(row)
         || (row.showId === 'flex.') ) {
        return null;
    }
    let x = localInstant(day.from && day.from.date, row.until);
    let w = windowOf(day);
    if ( (x === null) || (w === null) ) {
        return null;
    }
    // Left outside the day by a change to the day's times (review, Nov 8): at or
    // before its start it is no until at all, a go like any row; after its end it
    // runs to the end. Neither stops the day.
    if (x.at <= w.from) {
        return null;
    }
    return Math.min(x.at, w.to);
}

/*
 * The Until dropdown's choices: each of the day's own marks (half hours, or
 * quarter hours) after its start, up to and including its end, as
 * [{ id, description }] - `id` the ms after from.date's midnight that `until`
 * stores, `description` the clock time, with the weekday on a day longer than
 * a day. A time the clock skips that night is left out.
 */
const WEEKDAYS = [ 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat' ];
function untilOptions(day, current) {
    let w = (day != null) ? windowOf(day) : null;
    if ( (w === null) || (w.to <= w.from) ) {
        return [];
    }
    let step = stepOf(day);
    let multi = (w.to - w.from) > DAY;
    let out = [];
    for (let off = Math.floor(day.from.time / step) * step + step; ; off += step) {
        let x = localInstant(day.from.date, off);
        if ( (x === null) || (x.at > w.to) ) {
            break;
        }
        if (x.gap || (x.at <= w.from)) {
            continue;
        }
        out.push({ id: off, description: (multi ? WEEKDAYS[new Date(x.at).getDay()] + ' ' : '') + clock(x.at) });
    }
    // A row's own until that is not one of the marks (the day's times or rounding
    // changed since) still shows as itself, in its place, rather than blank.
    if ( (typeof(current) === 'number') && ! out.some( (o) => o.id === current ) ) {
        let x = localInstant(day.from.date, current);
        if (x !== null) {
            out.push({ id: current, description: (multi ? WEEKDAYS[new Date(x.at).getDay()] + ' ' : '') + clock(x.at) });
            out.sort( (a, b) => a.id - b.id );
        }
    }
    return out;
}

/*
 * Copy to another date (NOTES.md, "Event tools"): a copy of `day` starting on
 * `date` (YYYY-MM-DD) at the same clock time, ending as many calendar days
 * later as the original, with id `id` and everything else as it was - name,
 * block, settings, rows. A row's `at` and `until` are counted from the day's
 * own first date, so they move with it. An Advance day's episode starts are
 * left behind: each was a jump on the old date, and copied it would air the
 * same episodes again. A Keep-apart day's starts are its own places, so they
 * stay. Null when `date` is not a date.
 */
function calendarDay(text) {
    let m = (typeof(text) === 'string') ? DATE.exec(text) : null;
    if (m === null) {
        return null;
    }
    let u = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    let back = new Date(u);
    if ( (back.getUTCFullYear() !== Number(m[1])) || (back.getUTCMonth() !== Number(m[2]) - 1) || (back.getUTCDate() !== Number(m[3])) ) {
        return null;
    }
    return u / DAY;
}
function dateOfCalendarDay(n) {
    return new Date(n * DAY).toISOString().slice(0, 10);
}
function copyTo(day, date, id) {
    let target = calendarDay(date);
    let from = calendarDay(day && day.from && day.from.date);
    let to = calendarDay(day && day.to && day.to.date);
    if ( (target === null) || (from === null) || (to === null) ) {
        return null;
    }
    let copy = JSON.parse(JSON.stringify(day));
    copy.id = id;
    copy.from.date = dateOfCalendarDay(target);
    copy.to.date = dateOfCalendarDay(target + (to - from));
    if (copy.positions !== 'apart') {
        (copy.slots || []).forEach( (row) => {
            if (row != null) {
                delete row.start;
            }
        } );
    }
    return copy;
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
 * The first local mark - a :00 or :30, or with `step` a quarter hour - at or
 * after t, in real time; a moment up to SLACK past one counts as on it. Across a
 * clock change the next one in real time: 1:47am CDT on the fall-back night goes
 * to 1:00am CST.
 */
function nextMark(t, step) {
    let offset = (new Date(t)).getTimezoneOffset() * MINUTE;
    let local = t - offset;
    let into = ( (local % step) + step ) % step;
    if (into <= SLACK) {
        return t;
    }
    return t + (step - into);
}

function nextHalfHour(t) {
    return nextMark(t, HALF_HOUR);
}

/* Where a Back to back day's rows start: the next half hour, or quarter hour. */
function stepOf(day) {
    return ( (day != null) && (day.rounding === 'quarter') ) ? QUARTER_HOUR : HALF_HOUR;
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

/*
 * The day a tag belongs to. A day's Keep-apart rows are tagged with its id; its
 * "Fill long breaks with" position and its holiday rows' positions are tagged
 * "fill:" and "holiday:" before it, so each stays its own and none is a regular one's.
 */
function dayOfTag(tagText) {
    return tagText.replace(/^(fill|holiday):/, '');
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
        if ( (typeof(day.rounding) !== 'undefined') && (day.rounding !== 'half') && (day.rounding !== 'quarter') ) {
            say(day, 'rounding', 'Rows start on the half hour or the quarter hour.');
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
 * its end, each given `at`. Rows without a length take half an hour. A picked
 * item is in the first round only: it airs once a day.
 */
function fillTimes(day, rows) {
    let w = windowOf(day);
    if ( (w === null) || ! Array.isArray(rows) || (rows.length === 0) ) {
        return [];
    }
    let out = [];
    let at = day.from.time;
    let span = w.to - w.from;
    let shows = rows.filter( (r) => (typeof(r.item) !== 'object') || (r.item === null) );
    for (let k = 0; at - day.from.time < span; k++) {
        if ( (k >= rows.length) && (shows.length === 0) ) {
            break;
        }
        let row = (k < rows.length) ? rows[k] : shows[ (k - rows.length) % shows.length ];
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

/*
 * "Preview this day" (NOTES.md, "Special days"): the day's own timetable,
 * read from a generated lineup - programs/startTime, exactly as Create
 * Lineup would save them - rather than worked out separately, so it can
 * never disagree with what airs. One row per airing of the day (its start
 * and pins.label - a show or custom show's episode, or a movie), where Back
 * to back's rows start again from the top, the rows of the day's last,
 * unfinished lap that never got a turn, and the one line when the last item
 * ran past the day's own end. No Flex, no break steps - just the timetable.
 */
// "Lizzie McGuire, 28 episodes (S1E1–S2E6)": an until row's run as one line.
function runTitle(run, pins) {
    let code = (p) => `S${p.season}E${p.episode}`;
    let numbered = run.every( (p) => Number.isInteger(p.season) && Number.isInteger(p.episode) );
    // A range only when the run airs in episode order; a Shuffle's first and last aren't one.
    let inOrder = numbered && run.every( (p, i) => (i === 0) || (p.season > run[i - 1].season)
        || ( (p.season === run[i - 1].season) && (p.episode > run[i - 1].episode) ) );
    let what = ! numbered ? `${run.length} airings`
        : inOrder ? `${run.length} episodes (${code(run[0])}–${code(run[run.length - 1])})` : `${run.length} episodes`;
    return `${pins.showName(run[0])}, ${what}`;
}

function timetable({ programs, startTime, day, schedule }) {
    // Required here, not at the top: pins.js reaches back to this module
    // through slot-progress.js, and a top-level require would hand pins.js
    // (and everything loaded while this module is still mid-load) an
    // incomplete, partly-undefined copy of these exports.
    const pins = require('./pins');
    let w = windowOf(day);
    if (w === null) {
        return { rows: [], restarts: [], never: [], overrun: null };
    }
    let t = startTime;
    let rows = [];
    let overrunEnd = null;
    let dayRows = Array.isArray(day.slots) ? day.slots.filter( (r) => (r !== null) && (typeof(r) === 'object') ) : [];
    for (let i = 0; (i < programs.length) && (t < w.to + DAY); i++) {
        let p = programs[i];
        let start = t;
        let end = start + p.duration;
        t = end;
        if (end <= w.from) {
            continue;
        }
        if (start >= w.to) {
            break;
        }
        if (! p.isOffline && (p.specialDay === day.id)) {
            // A row running until a time is one line for its run (Event tools). Its
            // specialRow counts the day's rows as the generator does, nulls left out;
            // a long break's fill inside the run stays inside its line.
            let row = (typeof(p.specialRow) === 'number') ? dayRows[p.specialRow] : null;
            let u = untilAt(day, row);
            let last = (rows.length > 0) ? rows[rows.length - 1] : null;
            let open = (last !== null) && (last.run !== undefined);
            if ( open && (p.specialRow === 'fill') && (start < last.runUntil) ) {
                continue;
            }
            if ( (u !== null) && (start < u) && open && (last.specialRow === p.specialRow) ) {
                last.run.push(p);
            } else {
                rows.push({ at: start, title: pins.label(p), specialRow: p.specialRow, run: ( (u !== null) && (start < u) ) ? [ p ] : undefined, runUntil: u });
            }
            if (end > w.to) {
                overrunEnd = end;
            }
        }
    }
    let restarts = [];
    for (let i = 1; i < rows.length; i++) {
        if ( (typeof(rows[i].specialRow) === 'number') && (typeof(rows[i - 1].specialRow) === 'number') && (rows[i].specialRow < rows[i - 1].specialRow) ) {
            restarts.push(rows[i].at);
        }
    }
    let n = Array.isArray(day.slots) ? day.slots.length : 0;
    let lastRow = -1;
    for (let i = rows.length - 1; (i >= 0) && (lastRow === -1); i--) {
        if (typeof(rows[i].specialRow) === 'number') {
            lastRow = rows[i].specialRow;
        }
    }
    let never = [];
    for (let i = lastRow + 1; i < n; i++) {
        let row = day.slots[i];
        let picked = (row != null) && (typeof(row.item) === 'object') && (row.item !== null) && (typeof(row.item.program) === 'object') && (row.item.program !== null);
        if (picked) {
            never.push(pins.label(row.item.program));
        } else if ( (row != null) && (typeof(row.showId) === 'string') ) {
            never.push(row.showId.replace(/^(tv|custom)\./, ''));
        }
    }
    let overrun = (overrunEnd === null) ? null : { overMs: overrunEnd - w.to, backOnTimeAt: nextMark(overrunEnd, stepOf(day)) };
    return {
        rows: rows.map( (r) => ({ at: r.at, title: ( (r.run !== undefined) && (r.run.length > 1) ) ? runTitle(r.run, pins) : r.title }) ),
        restarts: restarts,
        never: never,
        overrun: overrun,
    };
}

/*
 * Holidays (step 8; NOTES.md, "Special days"). A day names one - `day.holiday` -
 * and a row marked `holidayOnly` plays its show's episodes set aside for it
 * (the channel's catalog state: neverAir entries with reason 'holiday'), each
 * once, then the show's regular next episode. A name is a holiday of the
 * catalog's list, or a group of them.
 */
const HOLIDAY_GROUPS = { 'Christmas season': [ 'Christmas', 'Hanukkah', 'Kwanzaa' ] };

// A holiday row has no "rerun" of its set-aside episodes: it shuffles them.
function holidayOrder(order) {
    return (order === 'rerun') ? 'shuffle' : order;
}

function holidayNames(holiday) {
    if ( (typeof(holiday) !== 'string') || (holiday === '') ) {
        return [];
    }
    return Object.prototype.hasOwnProperty.call(HOLIDAY_GROUPS, holiday) ? HOLIDAY_GROUPS[holiday].slice() : [ holiday ];
}

/*
 * The programs of `items` (a show's whole catalog) set aside for `holiday`, each
 * once, in the catalog's order. `state` is the catalog state { neverAir }.
 */
function holidayCandidates({ state, items, holiday }) {
    let names = holidayNames(holiday);
    let aside = ( (state != null) && (typeof(state.neverAir) === 'object') && (state.neverAir !== null) ) ? state.neverAir : {};
    if ( (names.length === 0) || ! Array.isArray(items) ) {
        return [];
    }
    let seen = new Set();
    return items.filter( (p) => {
        let key = fileKey(p);
        let entry = Object.prototype.hasOwnProperty.call(aside, key) ? aside[key] : null;
        if ( (entry === null) || (entry.reason !== 'holiday') || (names.indexOf(entry.holiday) === -1) || seen.has(key) ) {
            return false;
        }
        seen.add(key);
        return true;
    } );
}

/*
 * What the generator is given: { dayId: { showId: [program, ...] } } - for each
 * day that names a holiday, the candidates of each show a holiday row names,
 * read from `catalogs` ({ showId: { items } | { error } }). Days, shows or
 * holidays with none are left out.
 */
function holidayItems({ schedule, state, catalogs }) {
    let out = {};
    daysOf(schedule).forEach( (day) => {
        if ( (day == null) || (typeof(day.id) !== 'string') || (holidayNames(day.holiday).length === 0) || ! Array.isArray(day.slots) ) {
            return;
        }
        day.slots.forEach( (row) => {
            if ( (row == null) || (row.holidayOnly !== true) || (typeof(row.showId) !== 'string') || ((typeof(row.item) === 'object') && (row.item !== null)) ) {
                return;
            }
            let catalog = (catalogs || {})[row.showId];
            if ( (catalog == null) || ! Array.isArray(catalog.items) || (out[day.id] && out[day.id][row.showId]) ) {
                return;
            }
            let found = holidayCandidates({ state, items: catalog.items, holiday: day.holiday });
            if (found.length > 0) {
                out[day.id] = out[day.id] || {};
                out[day.id][row.showId] = found;
            }
        } );
    } );
    return out;
}

/*
 * The Schedule tab's chips for a day's band, [from, to): each airing ({ at,
 * duration, label }) that overlaps it, clipped to it - one that began before
 * the band (the movie still on at midnight) included.
 */
function spansIn(airings, from, to) {
    return airings
        .filter( (a) => (a.at < to) && (a.at + a.duration > from) )
        .map( (a) => ({ label: a.label, from: Math.max(a.at, from), to: Math.min(a.at + a.duration, to) }) );
}

module.exports = {
    localInstant: localInstant,
    windowOf: windowOf,
    dayAt: dayAt,
    ahead: ahead,
    aired: aired,
    untilAt: untilAt,
    daysOf: daysOf,
    untilOptions: untilOptions,
    copyTo: copyTo,
    usable: usable,
    rowTimes: rowTimes,
    nextHalfHour: nextHalfHour,
    nextMark: nextMark,
    stepOf: stepOf,
    tag: tag,
    taggedKey: taggedKey,
    taggedLabel: taggedLabel,
    tagOf: tagOf,
    dayOfTag: dayOfTag,
    holidayNames: holidayNames,
    holidayOrder: holidayOrder,
    holidayCandidates: holidayCandidates,
    holidayItems: holidayItems,
    HOLIDAY_GROUPS: HOLIDAY_GROUPS,
    problems: problems,
    fillFromBlock: fillFromBlock,
    fillTimes: fillTimes,
    wrapFinder: wrapFinder,
    timetable: timetable,
    spansIn: spansIn,
};
