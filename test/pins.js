/*
 * src/pins.js: swaps and inserts pinned to their date and time, and what the
 * editor says about them. See NOTES.md, Known issues, "Swaps, inserts and
 * Flex that keeps time".
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const pins = require('../src/pins');
const getShowData = require('../web/services/get-show-data')();
const commonProgramTools = require('../web/services/common-program-tools')(getShowData);

const THU = new Date('2026-10-08T00:00:00').getTime();
const NOW = Date.parse('2026-10-11T08:00:00.000Z');

function episode(show, season, n, extra) {
    return Object.assign({
        type: 'episode', showTitle: show, title: `${show} S${season}E${n}`,
        season, episode: n, duration: 22 * MIN, serverKey: 'srv', key: `/e/${show}/${season}/${n}`,
    }, extra || {});
}

module.exports = async function () {
    const suite = new Suite('pins');

    suite.log('-- the mark --');
    {
        const from = episode('Hey Arnold!', 3, 23, { title: 'Best Man / Cool Party', slotPosition: 'next|', shuffleOrder: 4,
            start: new Date(THU), stop: new Date(THU), $index: 9 });
        const special = episode('Hey Arnold!', 0, 7, { title: "Arnold's Christmas", slotPosition: 'shuffle||2', shuffleOrder: 3 });
        const at = THU + 19.5 * HOUR;
        const p = pins.makePin({ program: special, at, kind: 'swap', then: 'take', was: pins.label(from), slotShow: 'tv.Hey Arnold!', now: NOW });
        suite.check('makePin strips labels and numbers and records the pin',
            p !== special && typeof p.slotPosition === 'undefined' && typeof p.shuffleOrder === 'undefined'
                && JSON.stringify(p.pin) === JSON.stringify({ at, kind: 'swap', then: 'take', was: 'Hey Arnold! S03E23 Best Man / Cool Party',
                    slotShow: 'tv.Hey Arnold!', made: '2026-10-11T08:00:00.000Z' })
                && typeof special.pin === 'undefined',
            JSON.stringify(p.pin));
        const insert = pins.makePin({ program: special, at, kind: 'insert', then: 'late', slotShow: 'tv.Rugrats', now: NOW });
        suite.check('...and leaves out what it replaced for an insert', ! ('was' in insert.pin));

        const r = pins.removalPin({ airing: from, at, slotShow: 'tv.Hey Arnold!', now: NOW });
        suite.check('removalPin is Flex of the airing\'s length, kind remove',
            r.isOffline === true && r.duration === 22 * MIN && r.pin.kind === 'remove' && r.pin.then === 'take'
                && r.pin.was === 'Hey Arnold! S03E23 Best Man / Cool Party' && r.pin.at === at && Object.keys(r).length === 3,
            JSON.stringify(r));

        suite.check('label names an episode, a custom-show item and a movie',
            pins.label(from) === 'Hey Arnold! S03E23 Best Man / Cool Party'
                && pins.label({ type: 'movie', title: 'The Night Before Christmas (1933)', customShowId: 'x', customShowName: 'Silly Symphonies', customOrder: 11 })
                    === 'Silly Symphonies #12 The Night Before Christmas (1933)'
                && pins.label({ type: 'movie', title: 'The Iron Giant' }) === 'The Iron Giant',
            pins.label(from));
    }

    suite.log('-- pins still to air --');
    {
        const mark = (title, at, then) => episode('X', 0, 1, { title, duration: 30 * MIN, pin: { at, kind: 'swap', then: then || 'take' } });
        const flex = (d) => ({ isOffline: true, duration: d });
        const later = mark('Later', NOW + 2 * DAY, 'late');
        const soon = mark('Soon', NOW + HOUR);
        const aired = mark('Aired', NOW - HOUR);
        const onAir = mark('On air', NOW - 10 * MIN);
        const programs = [flex(HOUR), later, flex(HOUR), aired, episode('A', 1, 1), soon, onAir, flex(DAY)];
        const ahead = pins.pinsAhead({ programs, startTime: NOW - 3 * DAY, now: NOW });
        suite.check('pinsAhead reads pins that end after now, in time order',
            ahead.map((x) => x.program.title).join() === 'On air,Soon,Later' && ahead[2].then === 'late' && ahead[1].at === NOW + HOUR
                && ahead[0].program === onAir,
            ahead.map((x) => x.program.title).join());
        suite.check('...and not one that has aired', ! ahead.some((x) => x.program.title === 'Aired'));
    }

    suite.log('-- the pool --');
    {
        const rotation = episode('Kim Possible', 2, 15, { title: 'A Very Possible Christmas' });
        const pinned = Object.assign({}, rotation, { pin: { at: NOW, kind: 'swap', then: 'take' } });
        const pool = commonProgramTools.slotPool([pinned, { isOffline: true, duration: MIN }, rotation, episode('Kim Possible', 2, 16)]);
        suite.check('slotPool leaves pinned airings out',
            pool.length === 2 && pool[0] === rotation && ! pool.some((p) => p.pin),
            pool.map((p) => p.title + (p.pin ? ' [pin]' : '')).join(', '));
    }

    return suite;
};
