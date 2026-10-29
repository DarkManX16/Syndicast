/*
 * Hand edits kept where they sit in the list. On a Time Slots channel the
 * programming list is the lineup: an edit changes the list, and a mark on
 * each row it touches, `program.kept`, keeps it there through Create Lineup.
 * A kept row has no clock time of its own - its time is where it sits - so
 * nothing can disagree with the list.
 *
 *   program.kept = { edits: [ { id, kind, made, ... } ] }
 *
 * A row's edits, oldest first. 'swap', 'insert', 'remove' and 'moved' keep the
 * row as it is (its time and its item); 'shifted' keeps only its time - a row
 * a drag or a run-late moved. 'late' keeps nothing: a row an episode moving
 * along ran late, recorded only so Put back can restore it - Create Lineup
 * lays that night out again. Put back undoes one edit, on the list as it is
 * now, and a row whose last edit goes is ordinary again.
 *
 * Every edit takes a lineup ({ programs, startTime }) and returns a new
 * `programs` array and one sentence saying what it does, or `refused` (why
 * not), `choices` (an item too long for its row) or `ask` (a drag that
 * shifts more than a day). Rows it doesn't name are the same objects.
 * Pure, tested in Node, bundled into the editor as src/pins.js is. See
 * NOTES.md, Known issues, "What you see is what airs: hand edits kept in the
 * list".
 */

const slotProgress = require('./slot-progress');
const rounds = require('./shuffle-rounds');
const pins = require('./pins');
const SLACK = require('./constants').SLACK;
const showDataOf = require('../web/services/get-show-data')();

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Two starts this close are the same airing: saved lineups start a fraction
// of a second off the minute.
const SAME = 2 * SECOND;
// Kinds that keep the row's item as well as its time.
const ITEM = [ 'swap', 'insert', 'remove', 'moved' ];

const pad2 = (n) => String(n).padStart(2, '0');
const iso = (t) => new Date(t).toISOString();

// 12:44:09am, 1:30am
function clockAm(t) {
    let d = new Date(t);
    let h = d.getHours() % 12 || 12;
    let s = d.getSeconds();
    return `${h}:${pad2(d.getMinutes())}` + ( (s > 0) ? `:${pad2(s)}` : '' ) + ( (d.getHours() < 12) ? 'am' : 'pm' );
}
// Sat Oct 31, 10:22:30am
function dayClockAm(t) {
    return pins.dayClock(t).replace(/, .*$/, ', ') + clockAm(t);
}
// 30 minutes, 1 minute, 14:09
function amount(ms) {
    if ( (ms % MINUTE) === 0 ) {
        let m = ms / MINUTE;
        return `${m} minute${ (m === 1) ? '' : 's' }`;
    }
    return pins.length(ms);
}
const possessive = (name) => /s$/.test(name) ? name + "'" : name + "'s";
const title = (p) => p.isOffline ? 'Flex' : String(p.title).trim();
const an = (word) => (/^[aeiou]/.test(word) ? 'an ' : 'a ') + word;
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${ (n === 1) ? '' : 's' }`;

function editsOf(program) {
    return ( program && program.kept && Array.isArray(program.kept.edits) ) ? program.kept.edits : [];
}

// The row's kind: its latest edit that keeps the item, else 'shifted'; null
// for a row nothing keeps.
function keptKind(program) {
    let edits = editsOf(program).filter( (e) => e.kind !== 'late' );
    if (edits.length === 0) {
        return null;
    }
    for (let k = edits.length - 1; k >= 0; k--) {
        if (ITEM.indexOf(edits[k].kind) !== -1) {
            return edits[k].kind;
        }
    }
    return 'shifted';
}
const keepsItem = (program) => ITEM.indexOf(keptKind(program)) !== -1;

// Flex that belongs to the row before it: not a redirect, not kept Flex (a
// removal), not a pin.
const isBreak = (p) => p.isOffline && (p.type !== 'redirect') && ! p.kept && ! p.pin;
// As the generator writes a break.
const flex = (d) => ({ duration: d, isOffline: true });

function withEdit(program, edit) {
    let copy = Object.assign({}, program);
    copy.kept = { edits: editsOf(program).map( (e) => Object.assign({}, e) ).concat([ edit ]) };
    return copy;
}
function withoutEdit(program, id) {
    let left = editsOf(program).filter( (e) => e.id !== id );
    if (left.length === editsOf(program).length) {
        return program;
    }
    let copy = Object.assign({}, program);
    if (left.length === 0) {
        delete copy.kept;
    } else {
        copy.kept = { edits: left.map( (e) => Object.assign({}, e) ) };
    }
    return copy;
}

// A copy of a picked item carrying nothing of where it came from.
function stripped(item) {
    let copy = JSON.parse(JSON.stringify(item));
    [ 'slotPosition', 'shuffleOrder', 'start', 'stop', '$index', 'pin', 'kept' ].forEach( (k) => delete copy[k] );
    return copy;
}

function newId(programs, now) {
    let taken = new Set();
    programs.forEach( (p) => editsOf(p).forEach( (e) => taken.add(e.id) ) );
    let id = 'e' + now;
    for (let n = 1; taken.has(id); n++) {
        id = `e${now}.${n}`;
    }
    return id;
}

function showOf(program) {
    let d = showDataOf(program);
    return d.hasShow ? d.showId : null;
}

/*
 * The list's rows in order: each program or kept Flex with its start and
 * the break after it - `flex` its length, `last` the index of its last
 * entry. A row's block is its entries from `index` to `last`.
 */
function rowsOf({ programs, startTime }) {
    let out = [];
    let t = startTime;
    for (let i = 0; i < programs.length; i++) {
        let p = programs[i];
        if (isBreak(p)) {
            if (out.length > 0) {
                out[out.length - 1].flex += p.duration;
                out[out.length - 1].last = i;
            }
        } else {
            out.push({ index: i, start: t, program: p, flex: 0, last: i });
        }
        t += p.duration;
    }
    return out;
}
const blockOf = (row) => row.program.duration + row.flex;

function whyNot({ row, now, what }) {
    return pins.whyNot({ airing: Object.assign({}, row.program, { start: row.start }), now: now, what: what });
}

/*
 * Rows from rows[k] on run `late` later: each starts that much later, and its
 * break is cut by as much as it has, until one starts on time. Each row it
 * moves is kept in time by edit `id`, recording the cut, for Put back. The
 * entries from rows[k].index to the end, new, with the first late row and
 * the row back on time.
 */
function runLate({ programs, rows, k, late, id, now }) {
    let out = [];
    let first = null;
    for (let j = k; j < rows.length; j++) {
        let q = rows[j];
        if (late <= 0) {
            return { entries: out.concat(programs.slice(q.index)), first: first, onTime: q };
        }
        let cut = Math.min(q.flex, late);
        let shifted = withEdit(q.program, { id: id, kind: 'shifted', cut: cut, made: iso(now) });
        out.push(shifted);
        if (q.flex - cut > 0) {
            out.push(flex(q.flex - cut));
        }
        if ( (first === null) && ! q.program.isOffline ) {
            first = { program: q.program, start: q.start + late };
        }
        late -= cut;
    }
    return null;
}

// "Runs 14:09 long: Family Guy starts 12:44:09am, back on time at 1:30am."
function sayLate(overrun, late) {
    if (late.first === null) {
        return `Runs ${pins.length(overrun)} long, back on time at ${clockAm(late.onTime.start)}.`;
    }
    return `Runs ${pins.length(overrun)} long: ${pins.showName(late.first.program)} starts ${clockAm(late.first.start)}, back on time at ${clockAm(late.onTime.start)}.`;
}

/*
 * Episodes move along (Ron's rule 5). An episode an edit pushes out airs at
 * its position's next airing, and each later airing of the position takes the
 * episode of the one before, to the end of the lineup the generator made;
 * Put back runs it the other way. That end is pins.loopEnd: after its days of
 * Flex, Create Lineup's carry has rotated what aired since the lineup was
 * made, which stored progress reads as aired, so nothing past it changes.
 *
 * A position is a show, a mode and a range, read from the airing's label
 * (src/slot-progress.js), so an episode and its label move together - a
 * Shuffle's rounds with them. A row kept as it is isn't the position's; a row
 * kept in time is. Each row keeps its start and the break after it takes the
 * difference; an episode longer than its row's room runs late until a break
 * absorbs it, marked 'late' - nothing keeps that night. A Repeat of an airing
 * that changes follows it.
 */

// The position an episode counts for, or null: Flex, a Repeat, an airing no slot made.
function positionOf(content) {
    if (content.isOffline) {
        return null;
    }
    let parsed = slotProgress.parseLabel(content.slotPosition);
    let show = showDataOf(content);
    if ( (parsed === null) || (parsed.mode === 'repeat') || ! show.hasShow ) {
        return null;
    }
    return slotProgress.positionKey(show.showId, parsed.mode, { excludeSeasons: parsed.excluded });
}

// What a row airs, without the marks that belong to the row.
function contentOf(program) {
    let c = Object.assign({}, program);
    delete c.kept;
    return c;
}
// `content` in the row `row`, which keeps its own marks.
function filled(row, content) {
    let c = contentOf(content);
    if (editsOf(row).length > 0) {
        c.kept = { edits: editsOf(row).map( (e) => Object.assign({}, e) ) };
    }
    return c;
}

// The first entry at or after the end of the lineup the generator made.
function endOf(lineup, starts, now) {
    let horizon = pins.loopEnd(lineup, now);
    let i = starts.findIndex( (t) => t >= horizon );
    return (i === -1) ? lineup.programs.length : i;
}

const startsOf = ({ programs, startTime }) => {
    let out = new Array(programs.length);
    let t = startTime;
    for (let i = 0; i < programs.length; i++) {
        out[i] = t;
        t += programs[i].duration;
    }
    return out;
};

// Marked by edit `id` - 'shifted', kept in time, or 'late', only run late -
// `cut` shorter than its row was: one mark per edit and kind.
function markShifted(program, id, cut, now, kind) {
    let edits = editsOf(program);
    let mine = edits.find( (e) => (e.id === id) && (e.kind === kind) );
    if (! mine) {
        return withEdit(program, { id: id, kind: kind, cut: cut, made: iso(now) });
    }
    let copy = Object.assign({}, program);
    copy.kept = { edits: edits.map( (e) => Object.assign({}, e, (e === mine) ? { cut: (e.cut || 0) + cut } : {}) ) };
    return copy;
}

// The rows after `after` and before `end` that air position `key`: none kept as it is.
function chainOf(programs, after, key, end) {
    let out = [];
    for (let i = after + 1; i < end; i++) {
        let p = programs[i];
        if ( ! p.isOffline && ! p.pin && ! keepsItem(p) && (positionOf(p) === key) ) {
            out.push(i);
        }
    }
    return out;
}

// `contents`: what each row will air, by index, where it changes.
const airingAt = (programs, contents, i) => contents.has(i) ? contents.get(i) : contentOf(programs[i]);

// Forward: `pushed` at its position's next airing after row `after`, each later
// one's episode at the next, before `end`. What falls off the end.
function pushAlong(programs, contents, after, pushed, end) {
    let carry = pushed;
    chainOf(programs, after, positionOf(pushed), end).forEach( (i) => {
        let here = airingAt(programs, contents, i);
        contents.set(i, carry);
        carry = here;
    } );
    return carry;
}

// Back: row `head` takes the next airing's episode, each later one the next
// one's, the last `entering(its own)`. False when nothing can fill `head`.
function pullBack(programs, contents, head, key, entering, end) {
    let seq = [ head ].concat(chainOf(programs, head, key, end));
    let last = airingAt(programs, contents, seq[seq.length - 1]);
    for (let j = 0; j < seq.length - 1; j++) {
        contents.set(seq[j], airingAt(programs, contents, seq[j + 1]));
    }
    let next = entering( (seq.length > 1) ? last : null );
    if (next) {
        contents.set(seq[seq.length - 1], next);
    } else if (seq.length === 1) {
        return false;
    }
    return true;
}

/*
 * A Repeat follows its source: an airing labelled 'repeat', in a Repeat slot,
 * holding what an airing of the slot it repeats held before a change, a period
 * or less earlier, airs what that airing airs now - a copy, as the generator
 * makes one. `changes`: [{ index, start, was, now }].
 */
function followRepeats({ programs, starts, contents, changes, schedule, end }) {
    let sources = changes.filter( (c) => c.was && ! c.now.isOffline );
    if ( (sources.length === 0) || ! schedule || ! Array.isArray(schedule.slots) ) {
        return;
    }
    let findSlot = slotProgress.slotFinder(schedule);
    let period = (typeof(schedule.period) === 'number') ? schedule.period : DAY;
    let first = sources.reduce( (a, c) => Math.min(a, c.index), Infinity );
    for (let i = first + 1; i < end; i++) {
        let p = programs[i];
        if ( (p.slotPosition !== 'repeat') || p.isOffline || keepsItem(p) ) {
            continue;
        }
        let slot = findSlot(starts[i]);
        if ( (slot === null) || (slot.order !== 'repeat') ) {
            continue;
        }
        let file = rounds.fileKey(p);
        let source = null;
        sources.forEach( (c) => {
            if ( (c.start < starts[i]) && (c.start >= starts[i] - period - HOUR) && (rounds.fileKey(c.was) === file)
                 && ( (source === null) || (c.start > source.start) ) ) {
                let s = findSlot(c.start);
                if ( (s !== null) && (s.time === slot.repeatOf) ) {
                    source = c;
                }
            }
        } );
        if (source !== null) {
            let copy = contentOf(source.now);
            delete copy.shuffleOrder;
            copy.slotPosition = slotProgress.label('repeat');
            contents.set(i, copy);
        }
    }
}

/*
 * The list laid out again from its first changed row: each row keeps its
 * start and airs `contents` where given; its block - the program and the
 * break after it - is `targets` long where given, else as long as it is plus
 * what edit `undo` cut from it (its marks come off). A program longer than
 * its block runs late, and the rows after shorten their breaks until it is
 * absorbed, marked `kind` by edit `id` with what each was cut, for Put back.
 * Rows that don't change keep their entries. `watch`: rows whose new start is
 * wanted; `late`: each run late, where it starts and when it's back on time.
 */
function layout({ lineup, contents, targets, undo, id, kind, now, watch }) {
    let programs = lineup.programs;
    let rows = rowsOf(lineup);
    let touched = new Set( [ ...contents.keys(), ...targets.keys() ] );
    if (undo) {
        rows.forEach( (r) => {
            if (editsOf(r.program).some( (e) => e.id === undo )) {
                touched.add(r.index);
            }
        } );
    }
    let startOf = new Map();
    let late = [];
    if (touched.size === 0) {
        return { programs, startOf, late };
    }
    let first = Infinity;
    let lastTouched = -1;
    touched.forEach( (i) => { first = Math.min(first, i); lastTouched = Math.max(lastTouched, i); } );
    let k0 = rows.findIndex( (r) => r.index >= first );
    let out = programs.slice(0, rows[k0].index);
    let t = rows[k0].start;
    let behind = 0;
    let open = null;
    for (let k = k0; k < rows.length; k++) {
        let row = rows[k];
        if ( (behind === 0) && (row.index > lastTouched) ) {
            out = out.concat(programs.slice(row.index));
            break;
        }
        let p = row.program;
        let room = blockOf(row);
        let mine = undo ? editsOf(p).filter( (e) => e.id === undo ) : [];
        if (mine.length > 0) {
            mine.forEach( (e) => { room += e.cut || 0; } );
            p = withoutEdit(p, undo);
        }
        if (targets.has(row.index)) {
            room = targets.get(row.index);
        }
        if (contents.has(row.index)) {
            p = filled(p, contents.get(row.index));
        }
        if (watch && watch.has(row.index)) {
            startOf.set(row.index, t);
        }
        let d = p.duration;
        let block = (behind + d <= room) ? room - behind : d;
        if ( (behind > 0) || (d > room) ) {
            p = markShifted(p, id, room - block, now, kind);
        }
        if ( (behind === 0) && (d > room) ) {
            open = { program: p, start: t, over: d - room };
        }
        let gap = block - d;
        if (gap === row.flex) {
            out = out.concat([ p ], programs.slice(row.index + 1, row.last + 1));
        } else {
            out.push(p);
            if (gap > 0) {
                out.push(flex(gap));
            }
        }
        t += block;
        behind += block - room;
        if ( (open !== null) && (behind === 0) ) {
            open.onTime = t;
            late.push(open);
            open = null;
        }
    }
    if (open !== null) {
        late.push(open);
    }
    return { programs: out, startOf, late };
}

/*
 * After an edit at row `at` replaced `was` with `into` and pushed out `pushed`
 * (the episodes of `was` and of any rows it took): each at its position's
 * next airing. Returns the list, where each landed (`start` null when the
 * list has no later airing of its position), what ran late, and what fell off
 * the list's end, in the order it fell, for Put back.
 */
function rippleOut({ lineup, at, was, into, pushed, id, now, schedule }) {
    let programs = lineup.programs;
    let contents = new Map();
    let out = pushed.map(contentOf).filter( (c) => positionOf(c) !== null );
    let off = [];
    let starts = startsOf(lineup);
    let end = endOf(lineup, starts, now);
    out.slice().reverse().forEach( (c) => off.push(pushAlong(programs, contents, at, c, end)) );
    let changes = [ { index: at, start: starts[at], was: contentOf(was), now: into } ];
    contents.forEach( (c, i) => changes.push({ index: i, start: starts[i], was: contentOf(programs[i]), now: c }) );
    let landedAt = new Map();
    contents.forEach( (c, i) => { if (out.indexOf(c) !== -1) { landedAt.set(c, i); } } );
    followRepeats({ programs, starts, contents, changes, schedule, end });
    let laid = layout({ lineup, contents, targets: new Map(), id, kind: 'late', now, watch: new Set(landedAt.values()) });
    return {
        programs: laid.programs,
        landed: out.map( (c) => ({ content: c, start: landedAt.has(c) ? laid.startOf.get(landedAt.get(c)) : null }) ),
        late: laid.late,
        off: off,
    };
}

// What an edit records of the airing it pushes out, for Put back: its label
// when it moves along (it comes back from its next airing), else itself.
function recordOut(edit, program) {
    if (positionOf(contentOf(program)) !== null) {
        edit.pos = program.slotPosition;
    } else {
        edit.item = contentOf(program);
    }
    return edit;
}

// "; There's Something About Paulie airs Sun Nov 1, 11:00pm"
function sayLanded(landed) {
    if (landed.length === 0) {
        return '';
    }
    return '; ' + landed.map( (x) => (x.start === null)
        ? `${title(x.content)} waits for ${possessive(pins.showName(x.content))} next airing after the list ends`
        : `${title(x.content)} airs ${pins.dayClock(x.start)}` ).join(' and ');
}
// " He's Too Sexy for His Fat runs 4:00 long at Tue Nov 3, 12:30am, back on time at 1:00am."
// Only in the coming week: a night further off is laid out again by Create
// Lineup before it airs (Ron, Oct 29).
const SAID_AHEAD = 7 * DAY;
function sayRunsLong(found, now) {
    let late = found.filter( (x) => x.start < now + SAID_AHEAD );
    if (late.length === 0) {
        return '';
    }
    let x = late[0];
    let text = ` ${title(x.program)} runs ${pins.length(x.over)} long at ${pins.dayClock(x.start)}`;
    if (typeof(x.onTime) === 'number') {
        let sameDay = (new Date(x.onTime)).toDateString() === (new Date(x.start)).toDateString();
        text += `, back on time at ${sameDay ? clockAm(x.onTime) : dayClockAm(x.onTime)}`;
    }
    if (late.length > 1) {
        text += `; ${late.length - 1} more after it run long`;
    }
    return text + '.';
}

/*
 * The item for the airing at `index`, in place. The Flex after it takes the
 * difference; when the item is longer than the row and its Flex, `choice`
 * says what gives: 'late', the rows after run late until a break absorbs it;
 * 'take', it takes the rows it runs into. Without one, it answers with the
 * choices. The episode it replaces, and each it takes, airs at its
 * position's next airing (rippleOut); `schedule` lets Repeats follow.
 */
function swap({ lineup, index, item, choice, now, schedule }) {
    let rows = rowsOf(lineup);
    let k = rows.findIndex( (r) => r.index === index );
    let row = rows[k];
    if ( (typeof(row) === 'undefined') || row.program.isOffline ) {
        return { refused: 'Pick a program to swap.' };
    }
    let why = whyNot({ row, now, what: 'swap' });
    if (why !== null) {
        return { refused: why };
    }
    let room = blockOf(row);
    let overrun = item.duration - room;
    if ( (overrun > 0) && (choice !== 'late') && (choice !== 'take') ) {
        return { choices: [ 'late', 'take' ], overrun: overrun, room: room };
    }
    let programs = lineup.programs;
    // Swapping a swap again keeps the first swap's record of what it replaced.
    let earlier = editsOf(row.program).find( (e) => e.kind === 'swap' );
    let id = earlier ? earlier.id : newId(programs, now);
    let swapped = stripped(item);
    swapped.kept = { edits: editsOf(row.program).map( (e) => Object.assign({}, e) ) };
    let edit = swapped.kept.edits.find( (e) => e.id === id );
    // A swap swapped again pushes nothing out: what it replaces was placed by hand.
    let pushed = [];
    if (! earlier) {
        edit = recordOut({ id: id, kind: 'swap', was: pins.label(row.program), show: showOf(row.program), room: room, made: iso(now) }, row.program);
        swapped.kept.edits.push(edit);
        pushed.push(row.program);
    }
    let text = `${title(item)} replaces ${title(row.program)} at ${clockAm(row.start)}`;
    let head = programs.slice(0, row.index).concat([ swapped ]);
    let moveAlong = (list, said, taken) => {
        let r = rippleOut({ lineup: { programs: list, startTime: lineup.startTime }, at: row.index, was: row.program, into: swapped, pushed, id, now, schedule });
        if (r.off.length > 0) {
            edit.off = (edit.off || []).concat(r.off);
        }
        let out = { programs: r.programs, text: text + sayLanded(r.landed) + '.' + said + sayRunsLong(r.late, now), edit: id };
        if (taken) {
            out.taken = taken;
        }
        return out;
    };
    if (overrun <= 0) {
        let rest = (room - item.duration > 0) ? [ flex(room - item.duration) ] : [];
        return moveAlong(head.concat(rest, programs.slice(row.last + 1)), '');
    }
    if (choice === 'late') {
        let late = runLate({ programs, rows, k: k + 1, late: overrun, id, now });
        if (late === null) {
            return { refused: `${title(item)} is too long to catch up before the list ends.` };
        }
        return moveAlong(head.concat(late.entries), ' ' + sayLate(overrun, late));
    }
    let taken = [];
    let j = k + 1;
    for (; room < item.duration; j++) {
        let q = rows[j];
        if (typeof(q) === 'undefined') {
            return { refused: `${title(item)} is too long for what is left of the list.` };
        }
        if (keepsItem(q.program)) {
            return { refused: `${title(item)} would run into ${title(q.program)} at ${clockAm(q.start)}, which you placed there. Choose Run late instead.` };
        }
        taken.push(q);
        room += blockOf(q);
    }
    let rest = (room - item.duration > 0) ? [ flex(room - item.duration) ] : [];
    let names = taken.map( (q) => `${possessive(pins.showName(q.program))} ${clockAm(q.start)}` ).join(' and ');
    text += ` and takes ${names}`;
    // Each row taken comes back with Put back: its room, and its episode as the swap's.
    edit.took = (edit.took || []).concat(taken.map( (q) => {
        let t = recordOut({ room: blockOf(q) }, q.program);
        if (typeof(t.pos) === 'string') {
            t.show = showOf(q.program);
        }
        if (editsOf(q.program).length > 0) {
            t.kept = JSON.parse(JSON.stringify(q.program.kept));
        }
        return t;
    } ));
    pushed = pushed.concat(taken.map( (q) => q.program ));
    return moveAlong(head.concat(rest, programs.slice(taken[taken.length - 1].last + 1)), '', taken.map( (q) => q.program ));
}

/*
 * The item in the break after the airing at `index`: the rest of the break
 * after it, or, when it is longer than the break, the rows after run late
 * until a break absorbs it.
 */
function insertAfter({ lineup, index, item, now }) {
    let rows = rowsOf(lineup);
    let k = rows.findIndex( (r) => r.index === index );
    let row = rows[k];
    if ( (typeof(row) === 'undefined') || row.program.isOffline ) {
        return { refused: 'Pick a program to insert after.' };
    }
    let why = whyNot({ row, now, what: 'insert' });
    if (why !== null) {
        return { refused: why };
    }
    let programs = lineup.programs;
    let id = newId(programs, now);
    let inserted = stripped(item);
    inserted.kept = { edits: [ { id: id, kind: 'insert', brk: row.flex, made: iso(now) } ] };
    let at = row.start + row.program.duration;
    let text = `${title(item)} goes in after ${title(row.program)} at ${clockAm(at)}`;
    let head = programs.slice(0, row.index + 1).concat([ inserted ]);
    let overrun = item.duration - row.flex;
    if (overrun <= 0) {
        let rest = (row.flex - item.duration > 0) ? [ flex(row.flex - item.duration) ] : [];
        let next = rows[k + 1];
        return {
            programs: head.concat(rest, programs.slice(row.last + 1)),
            text: text + ( next ? `; ${pins.showName(next.program)} stays at ${clockAm(next.start)}.` : '.' ),
            edit: id,
        };
    }
    let late = runLate({ programs, rows, k: k + 1, late: overrun, id, now });
    if (late === null) {
        return { refused: `${title(item)} is too long to catch up before the list ends.` };
    }
    return { programs: head.concat(late.entries), text: `${text}. ${sayLate(overrun, late)}`, edit: id };
}

// "Remove this airing only": kept Flex of the airing's length; every row where
// it was, and its episode at its position's next airing.
function removeOnly({ lineup, index, now, schedule }) {
    let rows = rowsOf(lineup);
    let row = rows.find( (r) => r.index === index );
    if ( (typeof(row) === 'undefined') || row.program.isOffline ) {
        return { refused: 'Pick a program to remove.' };
    }
    let why = whyNot({ row, now, what: 'remove' });
    if (why !== null) {
        return { refused: why };
    }
    let id = newId(lineup.programs, now);
    let gap = flex(row.program.duration);
    let edit = recordOut({ id: id, kind: 'remove', was: pins.label(row.program), show: showOf(row.program), made: iso(now) }, row.program);
    gap.kept = { edits: editsOf(row.program).map( (e) => Object.assign({}, e) ).concat([ edit ]) };
    let programs = lineup.programs.slice();
    programs[index] = gap;
    let r = rippleOut({ lineup: { programs, startTime: lineup.startTime }, at: index, was: row.program, into: gap, pushed: [ row.program ], id, now, schedule });
    if (r.off.length > 0) {
        edit.off = r.off;
    }
    return {
        programs: r.programs,
        text: `Leaves ${pins.length(row.program.duration)} of Flex at ${clockAm(row.start)} in place of ${title(row.program)}${sayLanded(r.landed)}.${sayRunsLong(r.late, now)}`,
        edit: id,
    };
}

/*
 * A drag: the row at `from`, with its break, put in front of the row at
 * `to`. The rows between shift like a playlist - later when it moves
 * earlier, earlier when it moves later - and are back on time where it came
 * from. A drag across more than a day asks first, unless `sure`.
 */
function move({ lineup, from, to, now, sure }) {
    let rows = rowsOf(lineup);
    let kf = rows.findIndex( (r) => r.index === from );
    let rf = rows[kf];
    if ( (typeof(rf) === 'undefined') || rf.program.isOffline ) {
        return { refused: 'Only a program can be dragged here.' };
    }
    // Dropped on a break: in front of the row after it.
    let kt = rows.findIndex( (r) => r.index >= to );
    if ( (kt === kf) || (kt === kf + 1) ) {
        return {};
    }
    let rt = rows[kt];
    if (typeof(rt) === 'undefined') {
        return { refused: 'Drop it in front of an airing.' };
    }
    let why = whyNot({ row: rf, now, what: 'move' });
    if (why !== null) {
        return { refused: why };
    }
    if (rt.start <= now) {
        return { refused: `You can't drop it there: ${title(rt.program)} is on air now, or has aired.` };
    }
    let earlier = kt < kf;
    let between = earlier ? rows.slice(kt, kf) : rows.slice(kf + 1, kt);
    let span = Math.abs(rt.start - rf.start);
    if ( (span > DAY) && (sure !== true) ) {
        return { ask: `This shifts ${plural(between.length, 'airing')} over ${Math.round(span / DAY)} days. Move it?` };
    }
    let programs = lineup.programs;
    let id = newId(programs, now);
    let length = blockOf(rf);
    let block = [ withEdit(rf.program, { id: id, kind: 'moved', from: rf.start, made: iso(now) }) ].concat(programs.slice(rf.index + 1, rf.last + 1));
    let mark = (r) => [ withEdit(r.program, { id: id, kind: 'shifted', made: iso(now) }) ].concat(programs.slice(r.index + 1, r.last + 1));
    let middle = [].concat(...between.map(mark));
    let out = earlier
        ? programs.slice(0, rt.index).concat(block, middle, programs.slice(rf.last + 1))
        : programs.slice(0, rf.index).concat(middle, block, programs.slice(rt.index));
    let lands = earlier ? rt.start : rt.start - length;
    let onTime = earlier ? rows[kf + 1] : rt;
    return {
        programs: out,
        text: `${title(rf.program)} moves to ${pins.dayClock(lands)}; ${plural(between.length, 'airing')} shift ${amount(length)} ${earlier ? 'later' : 'earlier'}, back on time at ${clockAm(onTime.start)}.`,
        edit: id,
    };
}

// Undoes an insert: the item out, the break before it as it was, and the rows
// it ran late back on time.
function undoInsert(lineup, index, edit) {
    let programs = lineup.programs;
    let out = programs.slice(0, index);
    let j = index + 1;
    while ( (j < programs.length) && isBreak(programs[j]) ) {
        j++;
    }
    if (edit.brk > 0) {
        out.push(flex(edit.brk));
    }
    for (; j < programs.length; j++) {
        let p = programs[j];
        let mine = editsOf(p).find( (e) => e.id === edit.id );
        if (! mine) {
            out.push(p);
            continue;
        }
        out.push(withoutEdit(p, edit.id));
        let n = j + 1;
        let had = 0;
        while ( (n < programs.length) && isBreak(programs[n]) ) {
            had += programs[n].duration;
            n++;
        }
        if (had + mine.cut > 0) {
            out.push(flex(had + mine.cut));
        }
        j = n - 1;
    }
    return out;
}

// Undoes a drag: the row and its break taken out and put back in front of the
// first row at or after where it was.
function undoMove(lineup, index, edit) {
    let rows = rowsOf(lineup);
    let k = rows.findIndex( (r) => r.index === index );
    let row = rows[k];
    let programs = lineup.programs;
    let block = programs.slice(row.index, row.last + 1);
    let rest = programs.slice(0, row.index).concat(programs.slice(row.last + 1));
    let target = rowsOf({ programs: rest, startTime: lineup.startTime }).find( (r) => r.start >= edit.from - SAME );
    if (typeof(target) === 'undefined') {
        return null;
    }
    let out = rest.slice(0, target.index).concat(block, rest.slice(target.index));
    return out.map( (p) => withoutEdit(p, edit.id) );
}

/*
 * Undoes a swap or a removal: the row, and any it took, back at their rooms
 * with their episodes - each from its position's next airing, the later
 * airings moving back one - and the rows it ran late back on time.
 *
 * What comes back in at the list's end is the last episode that fell off it
 * for that position, whichever edit pushed it, so two swaps of a show undone
 * in either order leave its episodes in order; the episodes still past the end
 * pass to the edits still made. A swap the first open made from a pin records
 * no label and nothing that fell off: its position is the show's next airing's,
 * and the episode past the end the next in `catalog` (or the list), for Play
 * Next. Null when an episode can't be found.
 */
function undoReplace({ lineup, row, edit, now, schedule, catalog }) {
    let programs = lineup.programs;
    let rest = withoutEdit(row.program, edit.id);
    let holes = [ { room: (typeof(edit.room) === 'number') ? edit.room : blockOf(row), kept: rest.kept, pos: edit.pos, show: edit.show, item: edit.item } ]
        .concat( (Array.isArray(edit.took) ? edit.took : []).map( (t) => Object.assign({}, t, t.kept ? { kept: JSON.parse(JSON.stringify(t.kept)) } : {}) ) );
    // Each hole a row of its room until it is filled.
    let p0 = programs.slice(0, row.index)
        .concat(holes.map( (h) => Object.assign({ duration: h.room, isOffline: false }, h.kept ? { kept: h.kept } : {}) ), programs.slice(row.last + 1));

    let keyOf = (h, at) => {
        if (h.item) {
            return null;
        }
        let parsed = slotProgress.parseLabel(h.pos);
        if ( (parsed !== null) && (parsed.mode !== 'repeat') && (typeof(h.show) === 'string') ) {
            return slotProgress.positionKey(h.show, parsed.mode, { excludeSeasons: parsed.excluded });
        }
        for (let i = at + 1; i < end; i++) {
            let p = p0[i];
            if ( ! p.isOffline && ! p.pin && ! keepsItem(p) && (showOf(p) === h.show) && (positionOf(p) !== null) ) {
                return positionOf(p);
            }
        }
        return null;
    };

    // What fell off the end, by position, in the order it fell.
    let owners = [];
    programs.forEach( (p) => editsOf(p).forEach( (e) => {
        if (Array.isArray(e.off) && (e.off.length > 0)) {
            owners.push(e);
        }
    } ) );
    owners.sort( (a, b) => (a.made !== b.made) ? ( (a.made < b.made) ? -1 : 1 ) : ( (a.id < b.id) ? -1 : (a.id > b.id) ? 1 : 0 ) );
    let fell = new Map();
    owners.forEach( (e) => e.off.forEach( (c, k) => {
        let key = positionOf(c);
        if (key !== null) {
            if (! fell.has(key)) {
                fell.set(key, { slots: [], values: [] });
            }
            fell.get(key).slots.push({ owner: e, k: k });
            fell.get(key).values.push(c);
        }
    } ) );
    let popped = new Set();
    let successor = (key, last) => {
        let [ showId, mode, excluded ] = JSON.parse(key);
        if ( (mode !== 'next') || (last === null) ) {
            return null;
        }
        let seen = new Set();
        let candidates = slotProgress.candidatesFor(Array.isArray(catalog) ? catalog : programs, showId, { excludeSeasons: excluded }, showDataOf)
            .filter( (p) => ! seen.has(rounds.fileKey(p)) && seen.add(rounds.fileKey(p)) );
        let i = candidates.findIndex( (p) => rounds.fileKey(p) === rounds.fileKey(last) );
        if (i === -1) {
            return null;
        }
        let c = stripped(candidates[ (i + 1) % candidates.length ]);
        c.slotPosition = last.slotPosition;
        return c;
    };
    let entering = (key) => (last) => {
        let f = fell.get(key);
        if (f && (f.values.length > 0)) {
            popped.add(key);
            return f.values.pop();
        }
        return successor(key, last);
    };

    let starts = startsOf({ programs: p0, startTime: lineup.startTime });
    let end = endOf({ programs: p0, startTime: lineup.startTime }, starts, now);
    let contents = new Map();
    let shows = [];
    for (let j = 0; j < holes.length; j++) {
        let h = holes[j];
        let at = row.index + j;
        let key = keyOf(h, at);
        if (key !== null) {
            if (! pullBack(p0, contents, at, key, entering(key), end)) {
                return null;
            }
            shows.push(pins.showName(contents.get(at)));
        } else if (h.item) {
            contents.set(at, contentOf(h.item));
        } else {
            return null;
        }
    }
    let changes = [];
    contents.forEach( (c, i) => changes.push({ index: i, start: starts[i], was: (i === row.index) ? contentOf(row.program) : (i > row.index + holes.length - 1) ? contentOf(p0[i]) : null, now: c }) );
    followRepeats({ programs: p0, starts, contents, changes, schedule, end });
    let targets = new Map(holes.map( (h, j) => [ row.index + j, h.room ] ));
    let laid = layout({ lineup: { programs: p0, startTime: lineup.startTime }, contents, targets, undo: edit.id, id: newId(programs, now), kind: 'late', now }).programs;

    // The episodes still past the end pass to the edits still made, in order.
    let offs = new Map();
    popped.forEach( (key) => {
        let f = fell.get(key);
        let left = f.values.slice();
        f.slots.filter( (s) => s.owner !== edit ).forEach( (s) => {
            if (! offs.has(s.owner.id)) {
                offs.set(s.owner.id, s.owner.off.slice());
            }
            offs.get(s.owner.id)[s.k] = (left.length > 0) ? left.shift() : undefined;
        } );
    } );
    if (offs.size > 0) {
        laid = laid.map( (p) => {
            if (! editsOf(p).some( (e) => offs.has(e.id) )) {
                return p;
            }
            let copy = Object.assign({}, p);
            copy.kept = { edits: editsOf(p).map( (e) => offs.has(e.id)
                ? Object.assign({}, e, { off: offs.get(e.id).filter( (c) => typeof(c) !== 'undefined' ) })
                : Object.assign({}, e) ) };
            return copy;
        } );
    }
    let t = row.start;
    let back = holes.map( (h, j) => {
        let said = `${title(contents.get(row.index + j))} is back at ${clockAm(t)}`;
        t += h.room;
        return said;
    } ).join(', and ');
    let unique = shows.filter( (s, i) => shows.indexOf(s) === i );
    let along = (unique.length === 0) ? '.' : (unique.length === 1) ? `; ${possessive(unique[0])} later episodes move back one.` : '; their later episodes move back one.';
    return { programs: laid, text: back + along };
}

/*
 * Put back on the row at `index`: undoes its latest edit that keeps it as it
 * is, on the list as it is now; every other edit stays as it is. `schedule`
 * lets Repeats follow; `catalog`, the show's episodes, finds the one past the
 * list's end when nothing recorded it.
 */
function putBack({ lineup, index, now, schedule, catalog }) {
    let program = lineup.programs[index];
    let edits = editsOf(program).filter( (e) => e.kind !== 'late' );
    let edit = edits.slice().reverse().find( (e) => ITEM.indexOf(e.kind) !== -1 );
    if (edits.length === 0) {
        return { refused: `Nothing to put back: ${title(program)} is as Create Lineup made it.` };
    }
    if (! edit) {
        // Kept in time only: name the row whose edit moved it, when it is still in the list.
        let ids = new Set(edits.map( (e) => e.id ));
        let by = lineup.programs.find( (p) => editsOf(p).some( (e) => ids.has(e.id) && (ITEM.indexOf(e.kind) !== -1) ) );
        return { refused: `${title(program)} only moved with the rows around it.` + (by ? ` Put back ${title(by)} to move it back.` : '') };
    }
    let row = rowsOf(lineup).find( (r) => r.index === index );
    let why = whyNot({ row, now, what: 'undo' });
    if (why !== null) {
        return { refused: why };
    }
    if (edit.kind === 'insert') {
        return { programs: undoInsert(lineup, index, edit), text: `Takes out ${title(program)}; the rows after it are back where they were.` };
    }
    if (edit.kind === 'moved') {
        let out = undoMove(lineup, index, edit);
        if (out === null) {
            return { refused: `${title(program)} can't go back to ${pins.dayClock(edit.from)}: the list no longer reaches it.` };
        }
        return { programs: out, text: `${title(program)} goes back to ${pins.dayClock(edit.from)}.` };
    }
    let out = undoReplace({ lineup, row, edit, now, schedule, catalog });
    if (out === null) {
        return { refused: `${title(program)} can't be put back: the episode it replaced isn't in the list any more.` };
    }
    return out;
}

/*
 * The first open of a channel (Ron, Oct 29): what this list holds that was
 * edited by hand, before pins become kept rows. Read over one loop of the
 * list from `now`, each entry at its next airing:
 *
 *   keep  - every pin still to air, where it sits ('pin', `pinnedAt` when that
 *           isn't where it sits); the airings a drag moved ('shifted'): one
 *           between a pin and its pinned time (`by` that pin), or a labelled
 *           airing in another show's slot;
 *   letGo - pins that have aired and come round again as the list loops
 *           ('aired'); airings no slot made and no pin ('placed') - old
 *           bumpers and promos, which Create Lineup replaces.
 */
function firstOpen({ programs, startTime, now, schedule, getShowData }) {
    let lineup = { programs, startTime };
    let total = programs.reduce( (a, p) => a + p.duration, 0 );
    let keep = [];
    let letGo = [];
    if (! (total > 0) ) {
        return { keep, letGo, needed: false, lines: [] };
    }
    let next = [];
    let comesRound = [];
    programs.reduce( (t, p) => {
        let k = Math.max(0, Math.ceil( (now - (t + p.duration) + 1) / total ));
        next.push(t + k * total);
        // Its airing this time round the list has ended: what is ahead is the loop.
        comesRound.push(k > 0);
        return t + p.duration;
    }, startTime );
    let rows = rowsOf(lineup);
    let blockAt = new Map(rows.map( (r) => [ r.index, blockOf(r) ] ));

    programs.forEach( (p, i) => {
        if ( ! p.pin || (typeof(p.pin.at) !== 'number') ) {
            return;
        }
        // Aired: its airing in the list has ended, whatever its pinned time; or its
        // pinned time has passed and the list only has it again most of a loop later.
        let aired = comesRound[i] || ( (p.pin.at + p.duration <= now) && (next[i] - p.pin.at > total / 2) );
        if (aired) {
            letGo.push({ index: i, start: next[i], program: p, why: 'aired' });
        } else {
            let x = { index: i, start: next[i], program: p, why: 'pin' };
            if (Math.abs(next[i] - p.pin.at) > SLACK) {
                x.pinnedAt = p.pin.at;
                // Moved earlier, the night is back on time where its pinned row ended.
                x.until = p.pin.at + (blockAt.get(i) || p.duration);
            }
            keep.push(x);
        }
    } );

    // What a drag moved, up to where the generator's own last days begin.
    let horizon = pins.loopEnd(lineup, now) - 14 * DAY;
    let spans = keep.filter( (x) => typeof(x.pinnedAt) === 'number' ).map( (x) => (x.start < x.pinnedAt)
        ? { by: x.program, from: x.start + SAME, to: x.pinnedAt + (blockAt.get(x.index) || x.program.duration) - SAME }
        : { by: x.program, from: x.pinnedAt - SAME, to: x.start - SAME } );
    programs.forEach( (p, i) => {
        let t = next[i];
        if ( p.isOffline || p.pin || (typeof(p.slotPosition) !== 'string') || (t >= horizon) ) {
            return;
        }
        let span = spans.find( (s) => (t > s.from) && (t < s.to) );
        if (typeof(span) !== 'undefined') {
            keep.push({ index: i, start: t, program: p, why: 'shifted', by: span.by });
            return;
        }
        let show = getShowData(p);
        let slot = slotProgress.slotAt(schedule, t);
        if ( (p.slotPosition !== 'repeat') && show.hasShow && (slot !== null) && (slot.showId !== show.showId) ) {
            keep.push({ index: i, start: t, program: p, why: 'shifted', by: null });
        }
    } );

    let byHand = pins.handPlaced({ programs, startTime, from: now, to: now + total, schedule, getShowData })
        .concat(pins.addedAtEnd({ programs, startTime, from: now, schedule, getShowData }));
    let seen = new Set();
    byHand.forEach( (x) => {
        let i = programs.indexOf(x.program);
        if ( (i !== -1) && ! seen.has(i) ) {
            seen.add(i);
            letGo.push({ index: i, start: x.start, program: x.program, why: 'placed' });
        }
    } );

    keep.sort( (a, b) => a.start - b.start );
    letGo.sort( (a, b) => a.start - b.start );
    let needed = (keep.length > 0) || (letGo.length > 0);
    return { keep, letGo, needed, lines: needed ? sayFirstOpen({ keep, letGo }) : [] };
}

const KIND_WORD = { swap: 'swap', insert: 'insert', remove: 'removal' };

function sayFirstOpen({ keep, letGo }) {
    let lines = [];
    let pinsKept = keep.filter( (x) => x.why === 'pin' );
    let shifted = keep.filter( (x) => x.why === 'shifted' );
    lines.push( (keep.length > 0) ? 'Keeping, as they sit in your list:' : 'Keeping nothing: no edit by hand is still to air.' );
    Object.keys(KIND_WORD).forEach( (kind) => {
        let still = pinsKept.filter( (x) => (x.program.pin.kind === kind) && (typeof(x.pinnedAt) !== 'number') );
        if (still.length === 1) {
            lines.push(`${pins.label(still[0].program)}, ${an(KIND_WORD[kind])} at ${pins.dayClock(still[0].start)}.`);
        } else if (still.length > 1) {
            lines.push(`${plural(still.length, KIND_WORD[kind])}, ${pins.dayClock(still[0].start)} to ${pins.dayClock(still[still.length - 1].start)}.`);
        }
    } );
    pinsKept.filter( (x) => typeof(x.pinnedAt) === 'number' ).forEach( (x) => {
        let moved = shifted.filter( (s) => s.by === x.program );
        let when = ( (new Date(x.pinnedAt)).toDateString() === (new Date(x.start)).toDateString() ) ? clockAm(x.pinnedAt) : pins.dayClock(x.pinnedAt);
        let line = `${pins.label(x.program)} at ${pins.dayClock(x.start)}, where you moved it (it was pinned to ${when})`;
        if (moved.length > 0) {
            line += (x.start < x.pinnedAt)
                ? `, and the ${plural(moved.length, 'airing')} it moved, until ${clockAm(x.until)}`
                : `, and the ${plural(moved.length, 'airing')} it moved, from ${clockAm(moved[0].start)}`;
        }
        lines.push(line + '.');
    } );
    let loose = shifted.filter( (s) => s.by === null );
    if (loose.length > 0) {
        lines.push(`${plural(loose.length, 'airing')} you moved by hand, ${pins.dayClock(loose[0].start)} to ${pins.dayClock(loose[loose.length - 1].start)}.`);
    }
    if (letGo.length === 0) {
        return lines;
    }
    lines.push('Letting go - Create Lineup replaces these:');
    let aired = letGo.filter( (x) => x.why === 'aired' );
    if (aired.length > 0 && aired.length <= 3) {
        aired.forEach( (x) => lines.push(`${pins.label(x.program)}, ${an(KIND_WORD[x.program.pin.kind] || 'swap')} that aired ${pins.dayClock(x.program.pin.at)} and only comes round again as the list loops.`) );
    } else if (aired.length > 3) {
        let ats = aired.map( (x) => x.program.pin.at ).sort( (a, b) => a - b );
        lines.push(`${plural(aired.length, 'pin')} that aired from ${pins.dayClock(ats[0])} to ${pins.dayClock(ats[ats.length - 1])} and only come round again as the list loops.`);
    }
    let placed = letGo.filter( (x) => x.why === 'placed' );
    if (placed.length > 0) {
        let named = placed.slice(0, 3).map( (x) => `${title(x.program)}, ${dayClockAm(x.start)}` ).join('; ');
        let more = (placed.length > 3) ? ` and ${placed.length - 3} more` : '';
        lines.push(`${plural(placed.length, 'airing')} no slot made: ${named}${more}.`);
    }
    return lines;
}

/*
 * The first open's answer: each pin it keeps becomes a kept row - its own
 * kind, and a kept move from its pinned time when it sits elsewhere - and the
 * airings that move shifted are kept in time by it; a pin it lets go loses its
 * pin. Nothing moves.
 */
function applyFirstOpen({ programs, startTime, now, schedule, getShowData }) {
    let found = firstOpen({ programs, startTime, now, schedule, getShowData });
    let out = programs.slice();
    let count = 0;
    let id = () => `e${now}.${++count}`;
    let moveOf = new Map();
    let loose = null;
    found.keep.filter( (x) => x.why === 'pin' ).forEach( (x) => {
        let pin = x.program.pin;
        let copy = Object.assign({}, x.program);
        delete copy.pin;
        let edit = { id: id(), kind: (ITEM.indexOf(pin.kind) !== -1) ? pin.kind : 'swap', made: pin.made || iso(now) };
        if (typeof(pin.was) === 'string') {
            edit.was = pin.was;
        }
        if (typeof(pin.slotShow) === 'string') {
            edit.show = pin.slotShow;
        }
        copy.kept = { edits: [ edit ] };
        if (typeof(x.pinnedAt) === 'number') {
            let move = { id: id(), kind: 'moved', from: x.pinnedAt, made: iso(now) };
            copy.kept.edits.push(move);
            moveOf.set(x.program, move.id);
        }
        out[x.index] = copy;
    } );
    found.keep.filter( (x) => x.why === 'shifted' ).forEach( (x) => {
        let by = (x.by !== null) ? moveOf.get(x.by) : (loose = loose || id());
        out[x.index] = withEdit(x.program, { id: by, kind: 'shifted', made: iso(now) });
    } );
    found.letGo.filter( (x) => x.why === 'aired' ).forEach( (x) => {
        let copy = Object.assign({}, x.program);
        delete copy.pin;
        out[x.index] = copy;
    } );
    return out;
}

/*
 * What Create Lineup keeps (src/services/time-slots-service.js): every kept
 * row still to air in the lineup the generator made, at its instant in the
 * list - read again each time, so it is always where the list has it. Rows
 * kept as they are, and pins the first open hasn't answered for yet, air as
 * they are; a row kept in time is its position's (`key`) one-off slot. A row
 * that has aired is let go, and so is anything rotated past the lineup's end
 * (pins.loopEnd), where the loop brings what aired round again.
 *
 *   [ { at, program, kept: true, key? } ]
 */
function keptAhead({ programs, startTime, now }) {
    let lineup = { programs, startTime };
    let end = pins.loopEnd(lineup, now);
    return rowsOf(lineup)
        .filter( (r) => (r.start + r.program.duration > now) && (r.start < end) && ( (keptKind(r.program) !== null) || r.program.pin ) )
        .map( (r) => {
            let x = { at: r.start, program: r.program, kept: true };
            let key = (keptKind(r.program) === 'shifted') ? positionOf(r.program) : null;
            if (key !== null) {
                x.key = key;
            }
            return x;
        } );
}

/*
 * One sentence for each kept swap or removal still to air whose slot
 * `schedule` now gives to another show (Ron, Oct 29: it stays where it is).
 * `rows`, keptAhead's answer, when the caller has it - the Time Slots dialog
 * asks on every redraw. `nameOf(showId)` names a show; without it, its id
 * less the prefix.
 */
function scheduleNotes({ programs, startTime, now, rows, schedule, nameOf }) {
    let name = (id) => ( (typeof(nameOf) === 'function') && nameOf(id) ) || String(id).replace(/^(tv|custom|movie)\./, '');
    let notes = [];
    (Array.isArray(rows) ? rows : keptAhead({ programs, startTime, now })).forEach( (x) => {
        let edit = editsOf(x.program).slice().reverse().find( (e) => (e.kind === 'swap') || (e.kind === 'remove') );
        let made = edit ? edit.show : (x.program.pin ? x.program.pin.slotShow : undefined);
        let slot = slotProgress.slotAt(schedule, x.at);
        if ( (typeof(made) !== 'string') || (slot === null) || (slot.showId === made) ) {
            return;
        }
        let what = x.program.isOffline ? `The Flex in place of ${edit ? edit.was : 'an airing'}` : title(x.program);
        let now = (slot.showId === 'flex.') ? 'Flex' : `${possessive(name(slot.showId))} slot`;
        notes.push(`${what} at ${pins.dayClock(x.at)} is now in ${now}; it stays.`);
    } );
    return notes;
}

// "Create Lineup keeps 15 swaps, 1 insert and 12 rows kept in time where they sit in your list."
const KEPT_WORDS = { swap: 'swap', insert: 'insert', remove: 'removal', moved: 'row you moved', shifted: 'row kept in time' };
function sayKeptAhead(rows) {
    if (rows.length === 0) {
        return '';
    }
    let count = {};
    rows.forEach( (x) => {
        let kind = keptKind(x.program) || (x.program.pin && x.program.pin.kind) || 'swap';
        count[kind] = (count[kind] || 0) + 1;
    } );
    let parts = Object.keys(KEPT_WORDS).filter( (k) => count[k] ).map( (k) => (count[k] === 1)
        ? `1 ${KEPT_WORDS[k]}` : `${count[k]} ${KEPT_WORDS[k].replace(/^(\w+)/, '$1s')}` );
    let list = (parts.length === 1) ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
    return `Create Lineup keeps ${list} where they sit in your list.`;
}

module.exports = {
    keptKind: keptKind,
    keepsItem: keepsItem,
    positionOf: positionOf,
    rowsOf: rowsOf,
    firstOpen: firstOpen,
    applyFirstOpen: applyFirstOpen,
    swap: swap,
    insertAfter: insertAfter,
    removeOnly: removeOnly,
    move: move,
    putBack: putBack,
    keptAhead: keptAhead,
    scheduleNotes: scheduleNotes,
    sayKeptAhead: sayKeptAhead,
    clockAm: clockAm,
};
