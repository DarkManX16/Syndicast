/*
 * Edits inside a special day, the editor's side (NOTES.md, "Event tools",
 * feature 4). A Swap or Insert on an airing inside a day is saved on the day's
 * row it touched, as a change to that row's nth airing in the day (the
 * generator lays it: src/services/time-slots-service.js). The day is then laid
 * again by the generator Create Lineup runs, and only the day is spliced into
 * the list - nothing outside it is rebuilt; on an Advance day the show's later
 * episodes move along (keptRows.moveAlong). Pure: the editor hands in the
 * lineup and the re-laid one.
 */
const specialDays = require('./special-days');
const keptRows = require('./kept-rows');
const pins = require('./pins');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const startsOf = ({ programs, startTime }) => {
    let out = new Array(programs.length);
    let t = startTime;
    for (let i = 0; i < programs.length; i++) {
        out[i] = t;
        t += programs[i].duration;
    }
    return out;
};
// A day's rows as the generator counts them: specialRow indexes these.
const rowsOf = (day) => (Array.isArray(day.slots) ? day.slots : []).filter( (r) => (r !== null) && (typeof(r) === 'object') );
const title = (p) => String(p.title).trim();
const showOf = (p) => p.showTitle || p.customShowName || title(p);
const isDays = (p, dayId) => (p != null) && ! p.isOffline && (p.specialDay === dayId);
const ownAiring = (p, dayId, k) => isDays(p, dayId) && (p.specialRow === k) && (typeof(p.specialInsert) === 'undefined');

/*
 * The day and row a list entry belongs to, and which of the row's airings it is:
 * { day, row, n, start } - or { day, row, insert } for an edit's insert - or
 * null for anything a day's row didn't lay (outside every day, its fill, a
 * kept row sitting inside it).
 */
function locate({ lineup, index, schedule }) {
    let p = lineup.programs[index];
    if ( (p == null) || p.isOffline || (typeof(p.specialDay) !== 'string') || (typeof(p.specialRow) !== 'number') ) {
        return null;
    }
    let day = specialDays.daysOf(schedule).find( (d) => d.id === p.specialDay );
    if (typeof(day) === 'undefined') {
        return null;
    }
    let start = startsOf(lineup)[index];
    if (typeof(p.specialInsert) === 'string') {
        return { day: day, row: p.specialRow, insert: p.specialInsert, start: start };
    }
    if (Number.isInteger(p.specialN)) {
        return { day: day, row: p.specialRow, n: p.specialN, start: start };
    }
    let n = 0;
    for (let i = 0; i <= index; i++) {
        if (ownAiring(lineup.programs[i], day.id, p.specialRow)) {
            n++;
        }
    }
    return { day: day, row: p.specialRow, n: n, start: start };
}

/*
 * Why an edit inside `day` can't be made now, or null. Edits inside a day are
 * made before it begins (review, Nov 8): once it has, a lineup made during it no
 * longer holds its first airings, so the list can't say which airing is which.
 */
function whyNot({ day, now }) {
    let w = specialDays.windowOf(day);
    return ( (w !== null) && (w.from <= now) ) ? `${day.name} is on the air: edits inside it are made before it begins.` : null;
}

// Insert before: refused when the item is longer than the break in front, in today's words.
function beforeFits({ lineup, index, item }) {
    let room = keptRows.breakBefore({ lineup: lineup, index: index });
    if (item.duration > room) {
        return `${title(item)} is longer than the ${pins.length(room)} break before ${title(lineup.programs[index])}.`;
    }
    return null;
}

// The schedule, copied, with `change` ({ n, kind, item: { program } }) on the
// day's row `row`, as `id`; a change of the same kind to the same airing goes.
function withChange(schedule, dayId, row, change, id) {
    let copy = JSON.parse(JSON.stringify(schedule));
    let day = specialDays.daysOf(copy).find( (d) => d.id === dayId );
    let r = rowsOf(day)[row];
    r.changes = (Array.isArray(r.changes) ? r.changes : []).filter( (c) => ! ( (c.n === change.n) && (c.kind === change.kind) ) )
        .concat([ Object.assign({ id: id }, JSON.parse(JSON.stringify(change))) ]);
    return copy;
}
// The schedule, copied, without change `id`; a row left with none loses the key.
function withoutChange(schedule, id) {
    let copy = JSON.parse(JSON.stringify(schedule));
    specialDays.daysOf(copy).forEach( (day) => rowsOf(day).forEach( (r) => {
        if (Array.isArray(r.changes)) {
            r.changes = r.changes.filter( (c) => c.id !== id );
            if (r.changes.length === 0) {
                delete r.changes;
            }
        }
    } ) );
    return copy;
}
// The change `id` on the schedule, with its day and row, or null.
function findChange(schedule, id) {
    let found = null;
    specialDays.daysOf(schedule).forEach( (day) => rowsOf(day).forEach( (r, k) => {
        (r.changes || []).forEach( (c) => {
            if (c.id === id) {
                found = { day: day, row: k, change: c };
            }
        } );
    } ) );
    return found;
}

/*
 * The re-laid day spliced into the list. It runs from the end of the last
 * regular program before the day to the first program after it that starts at
 * the same instant in both lists: everything before and after is the list's
 * own entries, untouched. { programs, from, to, oldTo } - the new list, where
 * the day's entries now run [from, to), and where they ran to in the old one -
 * or { refused } when the two can't be lined up.
 */
function splice({ lineup, relaid, day }) {
    let L = lineup.programs;
    let R = relaid.programs;
    let LS = startsOf(lineup);
    let RS = startsOf(relaid);
    let firstOf = (list) => list.findIndex( (p) => isDays(p, day.id) );
    let lastOf = (list) => { for (let i = list.length - 1; i >= 0; i--) { if (isDays(list[i], day.id)) { return i; } } return -1; };
    let fL = firstOf(L);
    let fR = firstOf(R);
    if ( (fL === -1) || (fR === -1) ) {
        return { refused: `${day.name} isn't in the list yet: run Create Lineup first.` };
    }
    // The start: just after the last regular program before the day, in both.
    let iL1 = fL;
    while ( (iL1 > 0) && L[iL1 - 1].isOffline ) {
        iL1--;
    }
    let c1 = LS[iL1];
    let iR1 = RS.findIndex( (t, j) => (t === c1) && ( (j === 0) || ! R[j - 1].isOffline || (j === fR) ) );
    if ( (iR1 === -1) || (iR1 > fR) ) {
        return { refused: `${day.name} can't be laid again here: run Create Lineup first.` };
    }
    // The end: the first program after both days' last airing starting at one instant in both.
    let lL = lastOf(L);
    let lR = lastOf(R);
    let after = Math.max(LS[lL] + L[lL].duration, RS[lR] + R[lR].duration);
    let rStarts = new Map();
    R.forEach( (p, j) => {
        if ( (j > lR) && ! p.isOffline && (RS[j] >= after) ) {
            rStarts.set(RS[j], j);
        }
    } );
    let iL2 = -1;
    let iR2 = -1;
    for (let i = lL + 1; i < L.length; i++) {
        if ( ! L[i].isOffline && (LS[i] >= after) && rStarts.has(LS[i]) ) {
            iL2 = i;
            iR2 = rStarts.get(LS[i]);
            break;
        }
        if (LS[i] > after + 3 * DAY) {
            break;
        }
    }
    if (iL2 === -1) {
        return { refused: `${day.name} can't be laid again here: run Create Lineup first.` };
    }
    let mid = R.slice(iR1, iR2);
    return {
        programs: L.slice(0, iL1).concat(mid, L.slice(iL2)),
        from: iL1,
        to: iL1 + mid.length,
        oldTo: iL2,
    };
}

/*
 * On an Advance day, the episodes of each show the day aired differently now:
 * one it no longer airs goes to the show's next airing after the day and each
 * later one moves along; one it now airs that was a later airing's comes back
 * from it (keptRows.moveAlong). { programs, text }: text the "; X airs ..."
 * the sentence ends with, '' when nothing moved.
 */
function alongAfter({ lineup, spliced, relaid, now, schedule, catalog, id }) {
    if (spliced.refused) {
        return { programs: lineup.programs, text: '' };
    }
    let fileKey = (p) => `${p.serverKey}|${p.key}`;
    // A Keep-apart day's positions are its own (tagged): it touches only itself.
    let regular = (p) => { let key = keptRows.positionOf(p); return (key !== null) && (JSON.parse(key).length < 4); };
    let before = lineup.programs.slice(spliced.from, spliced.oldTo).filter(regular);
    let now_ = spliced.programs.slice(spliced.from, spliced.to).filter(regular);
    let had = new Set(now_.map(fileKey));
    let has = new Set(before.map(fileKey));
    // An episode moved past the day airs in a regular slot: none of the day's marks (review, Nov 8).
    let plain = (p) => {
        let c = Object.assign({}, p);
        [ 'specialDay', 'specialRow', 'specialChange', 'specialInsert', 'specialN' ].forEach( (k) => delete c[k] );
        return c;
    };
    let pushed = before.filter( (p) => ! had.has(fileKey(p)) ).map(plain);
    let taken = now_.filter( (p) => ! has.has(fileKey(p)) );
    if ( (pushed.length === 0) && (taken.length === 0) ) {
        return { programs: spliced.programs, text: '' };
    }
    let pulled = new Map();
    taken.forEach( (p) => { let key = keptRows.positionOf(p); pulled.set(key, (pulled.get(key) || 0) + 1); } );
    let moved = keptRows.moveAlong({
        lineup: { programs: spliced.programs, startTime: lineup.startTime },
        after: spliced.to - 1, pushed: pushed, pulled: [ ...pulled ].map( ([ key, count ]) => ({ key, count }) ),
        catalog: catalog, now: now, schedule: schedule, id: id || 'day-edit',
    });
    return { programs: moved.programs, text: moved.text };
}

// "30 minutes", "1 minute", or minutes and seconds.
function minutes(ms) {
    let m = Math.round(Math.abs(ms) / MINUTE);
    if (Math.abs(Math.abs(ms) - m * MINUTE) < 1000) {
        return `${m} minute${ (m === 1) ? '' : 's' }`;
    }
    return pins.length(Math.abs(ms));
}
const NUMBERS = [ 'no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten' ];
const count = (n) => (n < NUMBERS.length) ? NUMBERS[n] : String(n);

/*
 * What the change does, in one sentence after the one naming it: the day's
 * airings after the one changed, before and after, their starts and how many
 * of each show. "The Short One replaces X S1E3 at 7:00am. The rows after it
 * start 30 minutes later; X airs one fewer episode."
 */
function describe({ before, after, day, change, undo }) {
    let bS = startsOf(before);
    let aS = startsOf(after);
    // The list holding the change, and the one without it: Put back (undo) goes the other way.
    let withIt = undo ? before : after;
    let wS = undo ? bS : aS;
    let without = undo ? after : before;
    let oS = undo ? aS : bS;
    let marked = (p) => (p.specialChange === change.id) || (p.specialInsert === change.id);
    let at = withIt.programs.findIndex( (p) => isDays(p, day.id) && marked(p) );
    if (at === -1) {
        return '';
    }
    let item = withIt.programs[at];
    let k = item.specialRow;
    // The row's nth airing in the list without the change.
    let nth = -1;
    let seen = 0;
    for (let i = 0; i < without.programs.length; i++) {
        if (ownAiring(without.programs[i], day.id, k) && (++seen === change.n)) {
            nth = i;
            break;
        }
    }
    let lead;
    let pivot;
    if (change.kind === 'swap') {
        let old = (nth !== -1) ? title(without.programs[nth]) : 'its airing';
        lead = undo ? `${old} is back at ${keptRows.clockAm( (nth !== -1) ? oS[nth] : wS[at] )}`
            : `${title(item)} replaces ${old} at ${keptRows.clockAm(wS[at])}`;
        pivot = (nth !== -1) ? oS[nth] : wS[at];
        // The episodes too: the one swapped out airs at the row's next airing, and Put back
        // takes each later airing back an episode.
        let fileKey = (p) => `${p.serverKey}|${p.key}`;
        if ( (nth !== -1) && ! undo ) {
            let oldKey = fileKey(without.programs[nth]);
            let later = withIt.programs.findIndex( (p, i) => (i > at) && ownAiring(p, day.id, k) && (fileKey(p) === oldKey) );
            if (later !== -1) {
                lead += `; it airs at ${keptRows.clockAm(wS[later])} instead`;
            }
        } else if (undo) {
            let rowAfter = (list, starts) => list.programs.map( (p, i) => ({ p, t: starts[i] }) )
                .filter( (x) => ownAiring(x.p, day.id, k) && (x.t > pivot) && ! marked(x.p) ).map( (x) => fileKey(x.p) );
            let was = rowAfter(withIt, wS);
            let now = rowAfter(without, oS);
            if (was.some( (key, i) => (i < now.length) && (now[i] !== key) )) {
                lead += ', and the airings after it go back an episode';
            }
        }
    } else {
        let target = withIt.programs.findIndex( (p, i) => ownAiring(p, day.id, k)
            && ( (change.kind === 'after') ? (i === at - 1) : (i === at + 1) ) );
        let targetTitle = (target !== -1) ? title(withIt.programs[target]) : 'its airing';
        let targetAt = (target !== -1) ? wS[target] : wS[at];
        if (undo) {
            lead = `${title(item)} comes out ${change.kind} ${targetTitle} at ${keptRows.clockAm(targetAt)}`;
        } else {
            lead = (change.kind === 'after')
                ? `${title(item)} goes in right after ${targetTitle} at ${keptRows.clockAm(wS[at])}`
                : `${title(item)} goes in right before ${targetTitle} at ${keptRows.clockAm(targetAt)}`;
        }
        pivot = targetAt;
    }
    let rest = (programs, starts) => programs.map( (p, i) => ({ p, start: starts[i] }) )
        .filter( (x) => isDays(x.p, day.id) && (x.start > pivot) && ! marked(x.p) && (typeof(x.p.specialInsert) === 'undefined') );
    let was = rest(before.programs, bS);
    let now = rest(after.programs, aS);
    let deltas = [];
    for (let i = 0; i < Math.min(was.length, now.length); i++) {
        if (now[i].start !== was[i].start) {
            deltas.push(now[i].start - was[i].start);
        }
    }
    let parts = [];
    if (deltas.length > 0) {
        let later = deltas.every( (d) => d > 0 );
        let earlier = deltas.every( (d) => d < 0 );
        let biggest = deltas.reduce( (m, d) => (Math.abs(d) > Math.abs(m)) ? d : m, 0 );
        let same = deltas.every( (d) => d === deltas[0] );
        parts.push(`The rows after it start ${same ? '' : 'up to '}${minutes(biggest)} ${ later ? 'later' : (earlier ? 'earlier' : 'later or earlier') }`);
    }
    let tally = (list) => list.reduce( (m, x) => m.set(showOf(x.p), (m.get(showOf(x.p)) || 0) + 1), new Map() );
    let tb = tally(was);
    let ta = tally(now);
    new Set([ ...tb.keys(), ...ta.keys() ]).forEach( (show) => {
        let d = (ta.get(show) || 0) - (tb.get(show) || 0);
        if (d !== 0) {
            parts.push(`${show} airs ${count(Math.abs(d))} ${ (d < 0) ? 'fewer' : 'more' } episode${ (Math.abs(d) === 1) ? '' : 's' }`);
        }
    } );
    let w = specialDays.windowOf(day);
    // Every airing of the day, the change's own included: it can run past the end itself.
    let all = (programs, starts) => programs.map( (p, i) => ({ p, start: starts[i] }) ).filter( (x) => isDays(x.p, day.id) );
    let endOf = (list) => list.reduce( (m, x) => Math.max(m, x.start + x.p.duration), 0 );
    let nowAll = all(after.programs, aS);
    let wasAll = all(before.programs, bS);
    let over = (w !== null) ? endOf(nowAll) - w.to : 0;
    if ( (w !== null) && (over > 1000) && (endOf(wasAll) <= w.to + 1000) ) {
        parts.push(`it runs ${pins.length(over)} past the end of the day`);
    }
    if (parts.length === 0) {
        return `${lead}. Nothing else in the day moves.`;
    }
    let tail = parts.join('; ');
    return `${lead}. ${tail.charAt(0).toUpperCase()}${tail.slice(1)}.`;
}

module.exports = {
    locate: locate,
    whyNot: whyNot,
    beforeFits: beforeFits,
    withChange: withChange,
    withoutChange: withoutChange,
    findChange: findChange,
    splice: splice,
    alongAfter: alongAfter,
    describe: describe,
};
