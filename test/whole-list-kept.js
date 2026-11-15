/*
 * The whole-list tools on a Time Slots channel with hand edits kept in the list
 * (DarkManX16, Nov 15, 2026): a tool that only takes rows out - Remove shows,
 * Remove duplicates, Remove Flex, Remove specials, Clear the list - asks
 * nothing and rebuilds nothing. The rows it removes go; every kept row that
 * stays airs exactly when it did, its mark on it. Remove shows takes the
 * removed show's own kept rows with it. Only the tools that reorder everything
 * (Sort, Shuffle and the rest) still ask first.
 *
 * keptRows.removeRows is the rule; the page's wrapper (web/directives/
 * channel-config.js `wholeListTool`) is lifted from the source and run with the
 * real tools and stand-ins, as test/kept-editor.js does.
 */
const fs = require('fs');
const path = require('path');
const { MIN, Suite } = require('./support');
const keptRows = require('../src/kept-rows');
const getShowData = require('../web/services/get-show-data')();
const commonProgramTools = require('../web/services/common-program-tools')(getShowData);

const START = new Date('2026-11-20T06:00:00').getTime();
const NOW = new Date('2026-11-15T05:00:00').getTime();

function episode(show, n, extra) {
    return Object.assign({ type: 'episode', showTitle: show, title: `${show} ${n}`, season: 1, episode: n,
        duration: 22 * MIN, serverKey: 'srv', key: `/e/${show}/${n}`, slotPosition: 'next|' }, extra || {});
}
const flex = (d) => ({ duration: d, isOffline: true });
const swapMark = (show) => ({ edits: [ { id: 'e' + show, kind: 'swap', was: show + ' 9', show: 'tv.' + show, made: '2026-11-09T11:00:00.000Z' } ] });
const shiftedMark = () => ({ edits: [ { id: 'e2', kind: 'shifted', made: '2026-11-09T11:00:00.000Z' } ] });

/*
 * Half hours from 6:00am: Hannah Montana, Suite Life, Hannah Montana, Wizards, ...
 * with 8:00 of Flex after each. The 7:00am Hannah Montana airing is swapped for
 * a Lizzie McGuire special (kept, season 0), Wizards at 7:30 was shifted (kept in
 * time), a Hannah Montana airing at 9:00 is a swap of Hannah's (kept, the
 * removed show's own), and a removal left kept Flex at 10:00.
 */
function lineup() {
    const order = [ 'Hannah Montana', 'Suite Life', 'Hannah Montana', 'Wizards', 'Suite Life', 'Wizards',
        'Hannah Montana', 'Suite Life', 'Hannah Montana', 'Wizards', 'Suite Life', 'Wizards' ];
    const count = {};
    const programs = [];
    order.forEach( (show, k) => {
        count[show] = (count[show] || 0) + 1;
        let p = episode(show, count[show]);
        if (k === 2) {
            p = episode('Lizzie McGuire', 0, { season: 0, title: 'Lizzie Special', slotPosition: undefined, kept: swapMark('Hannah Montana') });
            delete p.slotPosition;
        } else if (k === 3) {
            p.kept = shiftedMark();
        } else if (k === 6) {
            p = episode('Hannah Montana', 40, { kept: swapMark('Hannah Montana') });
            delete p.slotPosition;
        }
        if (k === 8) {
            const gap = flex(22 * MIN);
            gap.kept = { edits: [ { id: 'eR', kind: 'remove', was: 'Hannah Montana 5', show: 'tv.Hannah Montana', made: '2026-11-09T11:00:00.000Z' } ] };
            programs.push(gap, flex(8 * MIN));
            return;
        }
        programs.push(p, flex(8 * MIN));
    } );
    // A season-0 episode no one kept, and a duplicate of Suite Life 1 no one kept.
    programs.push(episode('Suite Life', 0, { season: 0, title: 'Suite Life Special' }), flex(8 * MIN));
    programs.push(episode('Suite Life', 1), flex(8 * MIN));
    return { programs, startTime: START };
}
function startsOf(l) {
    let t = l.startTime;
    return l.programs.map( (p) => { const s = t; t += p.duration; return s; } );
}
// Every kept row, as [ start, the object ].
function keptAt(l) {
    const s = startsOf(l);
    return l.programs.map( (p, i) => [ s[i], p ] ).filter( ([ , p ]) => keptRows.isKept(p) );
}
const sameKept = (a, b) => (a.length === b.length) && a.every( ([ t, p ], i) => (b[i][0] === t) && (b[i][1] === p) );

// A `const NAME = {...};`, `let name = (...) => {...};` or `scope.name = (...) => {...};` from channel-config.js.
function lift(src, head) {
    const at = src.indexOf(head);
    if (at === -1) {
        throw new Error(`channel-config.js no longer declares ${head}`);
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

// The channel page's tools on a stand-in page: the real removeShows, removeDuplicates,
// removeOffline, wipeSpecials, wipeSchedule and sortShows, wrapped as the page wraps them.
function page({ timeSlots }) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'directives', 'channel-config.js'), 'utf8');
    const l = lineup();
    const scope = {
        hasTimeSlots: () => timeSlots,
        channel: { programs: l.programs.slice(), startTime: new Date(l.startTime) },
        undoPrompt: null,
        lastChange: '',
    };
    const env = {
        keptRows: keptRows,
        commonProgramTools: commonProgramTools,
        getShowData: getShowData,
        updateChannelDuration: () => {},
        $timeout: () => {},
        lineupMs: () => ({ programs: scope.channel.programs, startTime: new Date(scope.channel.startTime).getTime() }),
    };
    const tools = [ 'removeShows', 'removeDuplicates', 'removeOffline', 'wipeSpecials', 'wipeSchedule', 'sortShows' ];
    // eslint-disable-next-line no-new-func
    const make = new Function('scope', ...Object.keys(env), `
        ${ tools.map( (name) => `scope.${name} = ${lift(src, `scope.${name} = `)};` ).join('\n') }
        const REBUILDS = ${lift(src, 'const REBUILDS = ')};
        const REMOVES = ${lift(src, 'const REMOVES = ')};
        let rebuilding = false;
        let wholeListTool = ${lift(src, 'let wholeListTool = ')};
        Object.keys(REBUILDS).forEach( (name) => {
            if (typeof(scope[name]) === 'function') {
                scope[name] = wholeListTool(name, scope[name]);
            }
        } );
    `);
    make(scope, ...Object.values(env));
    return { scope, before: l, lineup: () => env.lineupMs() };
}

module.exports = async function () {
    const suite = new Suite('whole-list-kept');

    suite.log('-- keptRows.removeRows: the rows taken out go, every kept row stays at its time --');
    {
        const l = lineup();
        const isHannah = (p) => getShowData(p).hasShow && (getShowData(p).showId === 'tv.Hannah Montana');
        const got = keptRows.removeRows({ lineup: l, stays: (p) => ! isHannah(p) });
        const after = { programs: got.programs, startTime: l.startTime };
        suite.check('no Hannah Montana airing is left', ! got.programs.some(isHannah));
        const wanted = keptAt(l).filter( ([ , p ]) => ! isHannah(p) );
        suite.check('every other kept row is the same object, with its mark, at the same start',
            sameKept(keptAt(after), wanted), JSON.stringify(keptAt(after).map( ([ t, p ]) => [ new Date(t).toLocaleTimeString(), p.title || 'Flex' ] )));
        const s = startsOf(after);
        const firstKept = got.programs.findIndex( (p) => keptRows.isKept(p) );
        suite.check('the time taken out before a kept row is Flex right in front of it, one break, not kept',
            got.programs[firstKept - 1].isOffline && ! got.programs[firstKept - 1].kept && ! got.programs[firstKept - 2].isOffline
                && (s[firstKept] === START + 60 * MIN),
            JSON.stringify(got.programs.slice(0, firstKept + 1).map( (p) => p.isOffline ? p.duration / MIN : p.title )));
        suite.check('the lineup given is left as it was', l.programs.length === lineup().programs.length && l.programs.some(isHannah));
        const none = { programs: lineup().programs.map( (p) => { const c = Object.assign({}, p); delete c.kept; return c; } ), startTime: START };
        const plain = keptRows.removeRows({ lineup: none, stays: (p) => ! isHannah(p) });
        suite.check('with no kept rows it is exactly the filter: every row after a removed one moves up',
            JSON.stringify(plain.programs) === JSON.stringify(none.programs.filter( (p) => ! isHannah(p) )));
    }

    suite.log('-- the page: tools that only take rows out ask nothing and keep what is kept --');
    {
        const { scope, before, lineup: now } = page({ timeSlots: true });
        scope.removeShows([ 'tv.Hannah Montana' ]);
        const hannah = (p) => ! p.isOffline && (p.showTitle === 'Hannah Montana');
        suite.check('Remove shows asks nothing', scope.undoPrompt === null, JSON.stringify(scope.undoPrompt && scope.undoPrompt.text));
        suite.check('...Hannah Montana is gone, its own kept swap with it', ! scope.channel.programs.some(hannah));
        suite.check('...every other kept row stays, mark and all, at exactly its time - the special in Hannah’s airing too',
            sameKept(keptAt(now()), keptAt(before).filter( ([ , p ]) => ! hannah(p) )), String(keptAt(now()).length));
    }
    for (const [ name, args, gone ] of [
        [ 'removeDuplicates', [], (p) => (p.title === 'Suite Life 1') ],
        [ 'removeOffline', [], (p) => p.isOffline && ! p.kept ],
        [ 'wipeSpecials', [], (p) => (p.season === 0) && ! p.kept ],
    ]) {
        const { scope, before, lineup: now } = page({ timeSlots: true });
        scope[name](...args);
        suite.check(`${name} asks nothing`, scope.undoPrompt === null, JSON.stringify(scope.undoPrompt && scope.undoPrompt.text));
        suite.check(`...every kept row stays, mark and all, at exactly its time`, sameKept(keptAt(now()), keptAt(before)),
            JSON.stringify(keptAt(now()).map( ([ t, p ]) => [ new Date(t).toLocaleTimeString(), p.title || 'Flex' ] )));
        if (name === 'removeDuplicates') {
            suite.check('...the later Suite Life 1, no one’s edit, is gone', scope.channel.programs.filter(gone).length === 1);
        } else if (name === 'removeOffline') {
            const held = scope.channel.programs.filter(gone).length;
            const kept = keptAt(before).length;
            suite.check('...only the Flex that holds a kept row at its time is left', held <= kept, `${held} plain Flex, ${kept} kept rows`);
        } else {
            suite.check('...the Suite Life special no one kept is gone, the kept Lizzie special stays',
                ! scope.channel.programs.some(gone) && scope.channel.programs.some( (p) => p.title === 'Lizzie Special' ));
        }
    }
    {
        const { scope } = page({ timeSlots: true });
        scope.wipeSchedule();
        suite.check('Clear the list asks nothing and leaves nothing', (scope.undoPrompt === null) && (scope.channel.programs.length === 0));
    }
    {
        const { scope, before } = page({ timeSlots: true });
        scope.sortShows();
        const asked = scope.undoPrompt;
        suite.check('Sort, which reorders everything, still asks first, in one sentence', (asked !== null) && /rebuilds the whole list/.test(asked.text),
            JSON.stringify(asked && asked.text));
        suite.check('...and changes nothing until it is answered', scope.channel.programs.every( (p, i) => p === before.programs[i] ));
    }
    {
        const { scope } = page({ timeSlots: false });
        scope.removeShows([ 'tv.Hannah Montana' ]);
        suite.check('on a channel without Time Slots, Remove shows filters the list as it always did',
            (scope.undoPrompt === null) && JSON.stringify(scope.channel.programs) === JSON.stringify(lineup().programs.filter( (p) => p.isOffline || (p.showTitle !== 'Hannah Montana') )));
    }

    return suite;
};
