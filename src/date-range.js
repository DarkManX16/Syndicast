/*
 * A date range on a transition step or a Mix entry (NOTES.md, "Event tools"):
 * `dates: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }`, local calendar dates,
 * both ends included. Unset and null are off - every date - as a step's days
 * and times are. It is judged by the date a break *starts* on, the same way a
 * step's weekday is: a break starting 11:50pm on Nov 26 is a Nov 26 break.
 *
 * Pure, and bundled into the editor (src/transitions-editor.js) as well as
 * read by playback, so the two can never disagree.
 */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Whether `text` is a real calendar date written YYYY-MM-DD.
function isDate(text) {
    if (typeof(text) !== 'string') {
        return false;
    }
    const m = DATE.exec(text);
    if (m === null) {
        return false;
    }
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const probe = new Date(y, mo - 1, d);
    return (probe.getFullYear() === y) && (probe.getMonth() === mo - 1) && (probe.getDate() === d);
}

/*
 * Why `owner.dates` cannot be honoured, or null when it is unset, null or
 * well-formed. A range ending before it starts would play on no date at all,
 * so it is a problem, never read as "every date".
 */
function datesProblem(owner) {
    const r = owner.dates;
    if ( (typeof(r) === 'undefined') || (r === null) ) {
        return null;
    }
    if ( (typeof(r) !== 'object') || Array.isArray(r) ) {
        return 'dates must be an object with a from and a to date';
    }
    if (! isDate(r.from) || ! isDate(r.to)) {
        return 'dates.from and dates.to must both be dates written YYYY-MM-DD';
    }
    if (r.to < r.from) {
        return 'dates end before they start, so it plays on no date at all';
    }
    return null;
}

// The local calendar date of `instant`, written YYYY-MM-DD.
function localDate(instant) {
    const d = new Date(instant);
    const two = (n) => ( (n < 10) ? '0' : '' ) + n;
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

// Whether `instant`'s local date is inside `dates` (already known to be
// well-formed - datesProblem rejects anything else before this is asked).
function inDates(dates, instant) {
    const day = localDate(instant);
    return (day >= dates.from) && (day <= dates.to);
}

// Whether `dates` have all gone by at `now`: its last date is before today.
// No dates (or malformed ones) never pass.
function passed(dates, now) {
    if ( (dates == null) || (datesProblem({ dates: dates }) !== null) ) {
        return false;
    }
    return localDate(now) > dates.to;
}

module.exports = {
    isDate: isDate,
    datesProblem: datesProblem,
    localDate: localDate,
    inDates: inDates,
    passed: passed,
};
