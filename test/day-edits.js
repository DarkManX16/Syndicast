/*
 * src/day-edits.js: the editor's side of edits inside a special day (NOTES.md,
 * "Event tools", feature 4). Which row and which of its airings a list row is;
 * a change added to or taken off a day's row; the day laid again (by the real
 * generator here, as the Time Slots dialog lays it) spliced into the list with
 * nothing outside the day rebuilt; on an Advance day the show's later episodes
 * moved along; and one sentence on what the change does to the rest of the day.
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const timeSlotsService = require('../src/services/time-slots-service');
const dayEdits = require('../src/day-edits');

const NOW = new Date('2026-10-08T12:00:00').getTime();
const fri = (h, m) => new Date(2026, 9, 9, h, m || 0).getTime();
const FRI6 = fri(6);
const SAT6 = new Date(2026, 9, 10, 6).getTime();

function episode(show, season, n, duration) {
    return { type: 'episode', showTitle: show, title: `${show} S${season}E${n}`, season, episode: n,
        duration: duration || 22 * MIN, serverKey: 'srv', key: `/e/${show}/${season}/${n}` };
}
const seasons = (show, count, duration) => Array.from({ length: count }, (x, i) => episode(show, 1, i + 1, duration));
const movie = (title, duration) => ({ type: 'movie', title, duration, serverKey: 'srv', key: '/m/' + title });
const CLIP = movie('Promo Clip', 5 * MIN);
const SHORT = movie('The Short One', 47 * MIN);
const SAME = episode('K', 1, 1, 22 * MIN);

function daily() {
    let slots = [];
    for (let k = 0; k < 48; k++) {
        slots.push({ time: k * 30 * MIN, showId: 'tv.' + 'ABCD'[k % 4], order: 'next' });
    }
    return { period: DAY, lateness: 24 * HOUR, maxDays: 10, flexPreference: 'distribute', pad: 5 * MIN, slots };
}
const pool = () => seasons('A', 120).concat(seasons('B', 80), seasons('C', 80), seasons('D', 80), seasons('X', 60));
function day(extra) {
    return Object.assign({
        id: 'sd_t', name: 'Marathon', from: { date: '2026-10-09', time: 6 * HOUR }, to: { date: '2026-10-09', time: 12 * HOUR },
        blockId: null, positions: 'apart', layout: 'back', slots: [ { showId: 'tv.X', order: 'next' } ],
    }, extra || {});
}
const sched = (d) => Object.assign(daily(), { specialDays: [ d ] });
async function make(schedule) {
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
        static now() { return NOW; }
    }
    global.Date = FrozenDate;
    try {
        const res = await timeSlotsService(pool(), JSON.parse(JSON.stringify(schedule)));
        return { programs: res.programs, startTime: Date.parse(res.startTime) };
    } finally {
        global.Date = RealDate;
    }
}
function withStarts(l) {
    let t = l.startTime;
    return l.programs.map( (p, i) => { const a = { i, start: t, program: p }; t += p.duration; return a; } );
}
const shows = (l) => withStarts(l).filter( (a) => ! a.program.isOffline );
const indexAt = (l, at) => withStarts(l).find( (a) => (a.start === at) && ! a.program.isOffline ).i;
const sig = (l, from, to) => JSON.stringify(shows(l).filter( (a) => (a.start >= from) && (a.start < to) ).map( (a) => [ a.start, a.program.title ] ));

module.exports = async function () {
    const suite = new Suite('day-edits');
    const s0 = sched(day());
    const L = await make(s0);

    suite.log('-- which row, which airing --');
    {
        const third = dayEdits.locate({ lineup: L, index: indexAt(L, fri(7)), schedule: s0 });
        suite.check('the 7:00am airing is the day’s row 0, its 3rd airing', third && third.day.id === 'sd_t' && third.row === 0 && third.n === 3, JSON.stringify(third && { row: third.row, n: third.n }));
        const outside = dayEdits.locate({ lineup: L, index: indexAt(L, fri(13)), schedule: s0 });
        suite.check('an airing outside every special day is none of a day’s', outside === null);
    }

    suite.log('-- a change on the schedule --');
    {
        const s1 = dayEdits.withChange(s0, 'sd_t', 0, { n: 3, kind: 'swap', item: { program: SAME } }, 'chA');
        suite.check('withChange adds it to the row, with its id, and leaves the schedule it was given alone',
            s1.specialDays[0].slots[0].changes.length === 1 && s1.specialDays[0].slots[0].changes[0].id === 'chA'
                && typeof(s0.specialDays[0].slots[0].changes) === 'undefined', JSON.stringify(s1.specialDays[0].slots[0].changes));
        const s2 = dayEdits.withChange(s1, 'sd_t', 0, { n: 3, kind: 'swap', item: { program: SHORT } }, 'chB');
        suite.check('a second swap of the same airing replaces the first', s2.specialDays[0].slots[0].changes.length === 1
            && s2.specialDays[0].slots[0].changes[0].item.program.title === 'The Short One');
        const back = dayEdits.withoutChange(s2, 'chB');
        suite.check('withoutChange takes it off, and the row has no changes key left', typeof(back.specialDays[0].slots[0].changes) === 'undefined');
    }

    suite.log('-- the day laid again, spliced in (Keep apart) --');
    for (const [ label, change, expect ] of [
        [ 'a same-length swap', { n: 3, kind: 'swap', item: { program: SAME } }, 'K S1E1 replaces X S1E3 at 7:00am. Nothing else in the day moves.' ],
        [ 'a longer swap', { n: 3, kind: 'swap', item: { program: SHORT } }, 'The Short One replaces X S1E3 at 7:00am. The rows after it start 30 minutes later; X airs one fewer episode.' ],
        [ 'an insert after', { n: 2, kind: 'after', item: { program: CLIP } }, 'Promo Clip goes in right after X S1E2 at 6:52am. Nothing else in the day moves.' ],
        [ 'an insert before', { n: 3, kind: 'before', item: { program: CLIP } }, 'Promo Clip goes in right before X S1E3 at 7:00am. Nothing else in the day moves.' ],
    ]) {
        const s1 = dayEdits.withChange(s0, 'sd_t', 0, change, 'ch1');
        const R = await make(s1);
        const got = dayEdits.splice({ lineup: L, relaid: R, day: s1.specialDays[0] });
        const spliced = { programs: got.programs, startTime: L.startTime };
        suite.check(`${label}: the list with the day spliced in is what Create Lineup makes`,
            sig(spliced, L.startTime, L.startTime + 3 * DAY) === sig(R, L.startTime, L.startTime + 3 * DAY), '');
        suite.check(`...outside the day every entry is the old list’s own object`,
            got.programs.slice(0, got.from).every( (p, i) => p === L.programs[i] ) && got.programs.slice(got.to).every( (p, i) => p === L.programs[got.oldTo + i] ), '');
        const said = dayEdits.describe({ before: L, after: spliced, day: s1.specialDays[0], change: Object.assign({ id: 'ch1' }, change) });
        suite.check(`...and it says "${expect}"`, said === expect, said);
    }

    suite.log('-- an Advance day: the show’s later episodes move along --');
    {
        const adv = sched(day({ positions: 'advance', slots: [ { showId: 'tv.A', order: 'next' } ] }));
        const LA = await make(adv);
        const s1 = dayEdits.withChange(adv, 'sd_t', 0, { n: 3, kind: 'swap', item: { program: SAME } }, 'ch1');
        const RA = await make(s1);
        const got = dayEdits.splice({ lineup: LA, relaid: RA, day: s1.specialDays[0] });
        const moved = dayEdits.alongAfter({ lineup: LA, spliced: got, relaid: RA, now: NOW, schedule: s1, catalog: pool() });
        const out = { programs: moved.programs, startTime: LA.startTime };
        suite.check('a swap on an Advance day: after the day, A’s airings each carry the episode before them, as Create Lineup makes them',
            sig(out, SAT6 - 18 * HOUR, SAT6 + DAY) === sig(RA, SAT6 - 18 * HOUR, SAT6 + DAY),
            shows(out).filter( (a) => (a.start >= fri(12)) && (a.program.showTitle === 'A') ).slice(0, 2).map( (a) => a.program.title ).join(', ')
                + ' vs ' + shows(RA).filter( (a) => (a.start >= fri(12)) && (a.program.showTitle === 'A') ).slice(0, 2).map( (a) => a.program.title ).join(', '));
        suite.check('...and says where the episode pushed out lands', /A S1E\d+ airs Fri Oct 9, 12:00pm/.test(moved.text || ''), moved.text);
        const putBack = dayEdits.withoutChange(s1, 'ch1');
        const RB = await make(putBack);
        const got2 = dayEdits.splice({ lineup: out, relaid: RB, day: putBack.specialDays[0] });
        const back = dayEdits.alongAfter({ lineup: out, spliced: got2, relaid: RB, now: NOW, schedule: putBack, catalog: pool() });
        suite.check('...Put back gives the list back exactly as it was', sig({ programs: back.programs, startTime: LA.startTime }, LA.startTime, LA.startTime + 3 * DAY)
            === sig(LA, LA.startTime, LA.startTime + 3 * DAY), '');
    }
    return suite;
};
