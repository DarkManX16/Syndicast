/*
 * Dragging the very last row of the list to an earlier place (NOTES.md, Resolved,
 * "Dragging the last row of the list threw"). The editor rotates its list to start
 * at the program on air, so the last row of the array is usually something aired
 * today rotated round, or an item added at the end from the library. Nothing
 * follows it, so there is no row to say "back on time at"; the drag gives the list
 * back with one plain sentence, and Put back undoes it exactly.
 */
const { MIN, Suite } = require('./support');
const kept = require('../src/kept-rows');

const START = new Date('2026-10-29T00:00:00').getTime();
const NOW = new Date('2026-10-29T00:05:00').getTime();
const HALF = 30 * MIN;

const episode = (n, extra) => Object.assign({
    type: 'episode', showTitle: 'Show', title: `Show ${n}`, season: 1, episode: n,
    duration: 22 * MIN + 30000, serverKey: 'srv', key: `/e/${n}`, slotPosition: 'next|',
}, extra || {});
const flex = (d) => ({ duration: d, isOffline: true });
const tail = (p) => HALF - p.duration;

// Four half hours, each an episode and its Flex.
function plain() {
    let programs = [];
    for (let n = 1; n <= 4; n++) {
        let e = episode(n);
        programs.push(e, flex(tail(e)));
    }
    return { programs, startTime: START };
}
const indexOfTitle = (l, title) => l.programs.findIndex( (p) => p.title === title );
const titles = (l) => l.programs.filter( (p) => ! p.isOffline ).map( (p) => p.title );
const strip = (programs) => JSON.parse(JSON.stringify(programs, (k, v) => (k === 'addedAt') ? undefined : v));

module.exports = async function () {
    const suite = new Suite('move-last-row');

    suite.log('-- the last row, with its Flex --');
    {
        const base = plain();
        const from = indexOfTitle(base, 'Show 4');
        const to = indexOfTitle(base, 'Show 2');
        let m;
        let threw = null;
        try {
            m = kept.move({ lineup: base, from, to, now: NOW });
        } catch (e) {
            threw = e;
        }
        suite.check('drags without throwing', threw === null, threw ? threw.message : '');
        if (threw === null) {
            const l = { programs: m.programs, startTime: START };
            suite.check('the row lands where it was dropped, the rows between shifted later',
                JSON.stringify(titles(l)) === JSON.stringify([ 'Show 1', 'Show 4', 'Show 2', 'Show 3' ]), JSON.stringify(titles(l)));
            suite.check('...and says so in one plain sentence, with nothing "back on time"',
                m.text === 'Show 4 moves to Thu Oct 29, 12:30am; 2 airings shift 30 minutes later.', m.text);
            suite.check('...the dragged row kept', kept.keptKind(m.programs.find( (p) => p.title === 'Show 4' )) === 'moved', '');
            const back = kept.putBack({ lineup: l, index: indexOfTitle(l, 'Show 4'), now: NOW });
            suite.check('Put back: the list exactly as before',
                JSON.stringify(back.programs) === JSON.stringify(base.programs), JSON.stringify(titles({ programs: back.programs || [] })));
        }
    }

    suite.log('-- the last row, with no Flex after it (added at the end) --');
    {
        const base = plain();
        base.programs.pop();
        base.programs[base.programs.length - 1] = Object.assign({}, base.programs[base.programs.length - 1], { addedAt: NOW - MIN });
        const from = indexOfTitle(base, 'Show 4');
        const to = indexOfTitle(base, 'Show 3');
        let m;
        let threw = null;
        try {
            m = kept.move({ lineup: base, from, to, now: NOW });
        } catch (e) {
            threw = e;
        }
        suite.check('drags without throwing', threw === null, threw ? threw.message : '');
        if (threw === null) {
            const l = { programs: m.programs, startTime: START };
            suite.check('...to the place dropped, saying one airing shifts',
                JSON.stringify(titles(l)) === JSON.stringify([ 'Show 1', 'Show 2', 'Show 4', 'Show 3' ])
                    && m.text === 'Show 4 moves to Thu Oct 29, 1:00am; 1 airing shift 22:30 later.', m.text);
            suite.check('...and it is in the lineup now: no add mark', ! ('addedAt' in m.programs.find( (p) => p.title === 'Show 4' )), '');
            const back = kept.putBack({ lineup: l, index: indexOfTitle(l, 'Show 4'), now: NOW });
            suite.check('Put back: the list as before (the add mark, once dropped, is not restored)',
                JSON.stringify(strip(back.programs)) === JSON.stringify(strip(base.programs)), '');
        }
    }

    return suite;
};
