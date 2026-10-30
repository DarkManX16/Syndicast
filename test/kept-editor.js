/*
 * The channel page's part of hand edits kept in the list (web/directives/
 * channel-config.js; src/kept-rows.js): pieces of it lifted from the source and
 * run with stand-ins, since the page itself needs a browser. See NOTES.md,
 * Known issues, "What you see is what airs: hand edits kept in the list".
 */
const fs = require('fs');
const path = require('path');
const { Suite } = require('./support');

// A `let name = (...) => { ... };` from channel-config.js, by brace-matching.
function liftArrow(src, name) {
    const at = src.indexOf(`let ${name} = `);
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
    return src.slice(at + `let ${name} = `.length, i + 1);
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
    return suite;
};
