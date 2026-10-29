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
 * a drag or a run-late moved. Put back undoes one edit, on the list as it is
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
const pins = require('./pins');
const SLACK = require('./constants').SLACK;
const showDataOf = require('../web/services/get-show-data')();

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
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
const title = (p) => p.isOffline ? 'Flex' : p.title;
const an = (word) => (/^[aeiou]/.test(word) ? 'an ' : 'a ') + word;
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${ (n === 1) ? '' : 's' }`;

function editsOf(program) {
    return ( program && program.kept && Array.isArray(program.kept.edits) ) ? program.kept.edits : [];
}

// The row's kind: its latest edit that keeps the item, else 'shifted'; null
// for a row nothing keeps.
function keptKind(program) {
    let edits = editsOf(program);
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
 * The item for the airing at `index`, in place. The Flex after it takes the
 * difference; when the item is longer than the row and its Flex, `choice`
 * says what gives: 'late', the rows after run late until a break absorbs it;
 * 'take', it takes the rows it runs into. Without one, it answers with the
 * choices.
 */
function swap({ lineup, index, item, choice, now }) {
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
    if (! earlier) {
        swapped.kept.edits.push({ id: id, kind: 'swap', was: pins.label(row.program), show: showOf(row.program), room: room, made: iso(now) });
    }
    let text = `${title(item)} replaces ${title(row.program)} at ${clockAm(row.start)}.`;
    let head = programs.slice(0, row.index).concat([ swapped ]);
    if (overrun <= 0) {
        let rest = (room - item.duration > 0) ? [ flex(room - item.duration) ] : [];
        return { programs: head.concat(rest, programs.slice(row.last + 1)), text: text, edit: id };
    }
    if (choice === 'late') {
        let late = runLate({ programs, rows, k: k + 1, late: overrun, id, now });
        if (late === null) {
            return { refused: `${title(item)} is too long to catch up before the list ends.` };
        }
        return { programs: head.concat(late.entries), text: `${text} ${sayLate(overrun, late)}`, edit: id };
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
    return {
        programs: head.concat(rest, programs.slice(taken[taken.length - 1].last + 1)),
        text: `${text.slice(0, -1)} and takes ${names}.`,
        edit: id,
        taken: taken.map( (q) => q.program ),
    };
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

// "Remove this airing only": kept Flex of the airing's length; every row where it was.
function removeOnly({ lineup, index, now }) {
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
    gap.kept = { edits: [ { id: id, kind: 'remove', was: pins.label(row.program), show: showOf(row.program), made: iso(now) } ] };
    let programs = lineup.programs.slice();
    programs[index] = gap;
    return { programs: programs, text: `Leaves ${pins.length(row.program.duration)} of Flex at ${clockAm(row.start)} in place of ${title(row.program)}.`, edit: id };
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
 * Put back on the row at `index`: undoes its latest edit that keeps it as it
 * is, on the list as it is now; every other edit stays as it is.
 */
function putBack({ lineup, index, now }) {
    let program = lineup.programs[index];
    let edits = editsOf(program);
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
    return { refused: `Put back for a ${edit.kind} isn't built yet.` };
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

module.exports = {
    keptKind: keptKind,
    keepsItem: keepsItem,
    rowsOf: rowsOf,
    firstOpen: firstOpen,
    applyFirstOpen: applyFirstOpen,
    swap: swap,
    insertAfter: insertAfter,
    removeOnly: removeOnly,
    move: move,
    putBack: putBack,
    clockAm: clockAm,
};
