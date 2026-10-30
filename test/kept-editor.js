/*
 * The channel page's part of hand edits kept in the list (web/directives/
 * channel-config.js; src/kept-rows.js): pieces of it lifted from the source and
 * run with stand-ins, since the page itself needs a browser. See NOTES.md,
 * Known issues, "What you see is what airs: hand edits kept in the list".
 */
const fs = require('fs');
const path = require('path');
const { Suite } = require('./support');

// A `let name = (...) => { ... };` (or `scope.name = ...`) from channel-config.js, by brace-matching.
function liftArrow(src, name, owner = 'let ') {
    const head = `${owner}${name} = `;
    const at = src.indexOf(head);
    if (at === -1) {
        throw new Error(`channel-config.js no longer declares ${name}`);
    }
    let i = src.indexOf('{', at);
    for (let depth = 0; i < src.length; i++) {
        if (src[i] === '{') {
            depth++;
        } else if ( (src[i] === '}') && (--depth === 0) ) {
            break;
        }
    }
    return src.slice(at + head.length, i + 1);
}

// The library's Done (`scope.importPrograms`) on a stand-in page: what it leaves in the
// list, and whether it went to the kept insert at the scroll position.
function libraryAdd(src, { timeSlots, insertPoint, programs, selected }) {
    const scope = { hasTimeSlots: () => timeSlots, channel: { programs: programs.slice() }, currentStartIndex: 2,
        $apply: (f) => f() };
    const calls = [];
    let scrolled = false;
    const page = {
        document: { getElementById: () => ({ scrollTo: () => {} }) },
        insertFromLibrary: (items) => calls.push(items.length),
        scrollToLast: () => { scrolled = true; },
        updateChannelDuration: () => {},
        setTimeout: (f) => f(),
    };
    // eslint-disable-next-line no-new-func
    const importPrograms = new Function('scope', ...Object.keys(page), `return ${liftArrow(src, 'importPrograms', 'scope.')};`)(
        scope, ...Object.values(page));
    importPrograms(selected.slice(), insertPoint);
    return { programs: scope.channel.programs, keptInserts: calls, said: scope.lastChange || '', scrolled };
}

module.exports = async function () {
    const suite = new Suite('kept-editor');
    const src = fs.readFileSync(path.join(__dirname, '../web/directives/channel-config.js'), 'utf8');

    suite.log('-- the first open is read once --');
    {
        // Every Swap, drag, Delete and Create Lineup asks first whether the first open is
        // still to answer: a list that never needed it is read once, not on every edit
        // (240 ms on channel 1's 40,000 entries).
        let reads = 0;
        let state = { firstOpenAnswered: false };
        const scope = { hasTimeSlots: () => true, channel: { scheduleBackup: {} } };
        const keptRows = { firstOpen: () => { reads++; return { needed: false, lines: [] }; } };
        // eslint-disable-next-line no-new-func
        const found = new Function('scope', 'keptRows', 'lineupMs', 'getShowData', 'state',
            `let firstOpenAnswered = false; const f = ${liftArrow(src, 'firstOpenFound').replace(/firstOpenAnswered/g, 'state.firstOpenAnswered')}; return f;`)(
            scope, keptRows, () => ({ programs: [], startTime: 0 }), () => ({}), state);
        const first = found();
        found();
        found();
        suite.check('a list with nothing to answer is read for the first open once, however many edits follow',
            (first === null) && (reads === 1), `${reads} reads`);
    }

    suite.log('-- the library adds to the channel; only "insert here" places in the lineup --');
    {
        // Ron, Oct 30: 57 House of Mouse episodes added "at the end of list" on channel 3
        // went in as kept inserts after the first row in view. On a Time Slots channel the
        // library's add joins the channel for Time Slots and Create Lineup, as it always
        // did: nothing in the lineup moves or is kept.
        const lineup = [
            { title: 'Kim Possible', duration: 1320000, slotPosition: 'p1' },
            { isOffline: true, duration: 480000 },
            { title: 'Recess', duration: 1320000, slotPosition: 'p2' },
            { isOffline: true, duration: 480000 },
            { isOffline: true, duration: 86400000 * 3 },
        ];
        const houseOfMouse = [1, 2, 3].map( (n) => ({ title: `House of Mouse ${n}`, duration: 1320000, commercials: [] }) );
        const sameRows = (got) => lineup.every( (p, i) => got.programs[i] === p );
        const added = (got) => got.programs.slice(lineup.length);

        let end = libraryAdd(src, { timeSlots: true, insertPoint: 'end', programs: lineup, selected: houseOfMouse });
        suite.check('Time Slots, "at the end of list": the episodes join the channel after the lineup, in order',
            (end.programs.length === lineup.length + 3) && added(end).every( (p, i) => p.title === houseOfMouse[i].title ),
            end.programs.map( (p) => p.title || 'Flex' ).join(', '));
        suite.check('Time Slots, "at the end of list": every row of the lineup stays where it was, untouched', sameRows(end));
        suite.check('Time Slots, "at the end of list": nothing is kept and nothing goes in as an insert',
            (end.keptInserts.length === 0) && end.programs.every( (p) => typeof(p.kept) === 'undefined' ), `${end.keptInserts.length} kept inserts`);

        let start = libraryAdd(src, { timeSlots: true, insertPoint: 'start', programs: lineup, selected: houseOfMouse });
        suite.check('Time Slots, "at the beginning": the lineup doesn\'t move either; the episodes join after it',
            sameRows(start) && (added(start).length === 3) && (start.keptInserts.length === 0),
            start.programs.map( (p) => p.title || 'Flex' ).join(', '));

        let here = libraryAdd(src, { timeSlots: true, insertPoint: 'current', programs: lineup, selected: houseOfMouse });
        suite.check('Time Slots, insert here at the scroll position: the one choice that puts them in the lineup, kept',
            (here.keptInserts.length === 1) && (here.keptInserts[0] === 3), `${here.keptInserts.length} kept inserts`);

        // The library's Cancel hands over an empty selection and no choice.
        let cancel = libraryAdd(src, { timeSlots: true, insertPoint: undefined, programs: lineup, selected: [] });
        suite.check('Time Slots, the library\'s Cancel: nothing added, nothing said, the list stays where it was scrolled',
            sameRows(cancel) && (cancel.programs.length === lineup.length) && (cancel.said === '') && !cancel.scrolled && (cancel.keptInserts.length === 0),
            `said "${cancel.said}", scrolled ${cancel.scrolled}`);

        let plain = libraryAdd(src, { timeSlots: false, insertPoint: 'start', programs: lineup, selected: houseOfMouse });
        suite.check('a channel without Time Slots: "at the beginning" puts them first, as always',
            (plain.programs[0].title === 'House of Mouse 1') && (plain.programs.length === lineup.length + 3) && (plain.keptInserts.length === 0));
    }
    return suite;
};
