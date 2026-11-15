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
async function make(schedule, poolOf) {
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
        static now() { return NOW; }
    }
    global.Date = FrozenDate;
    try {
        const res = await timeSlotsService( (poolOf || pool)(), JSON.parse(JSON.stringify(schedule)));
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

    const undoSaid = {
        'a same-length swap': 'X S1E3 is back at 7:00am, and the airings after it go back an episode. Nothing else in the day moves.',
        'a longer swap': 'X S1E3 is back at 7:00am, and the airings after it go back an episode. The rows after it start 30 minutes earlier; X airs one more episode.',
        'an insert after': 'Promo Clip comes out after X S1E2 at 6:30am. Nothing else in the day moves.',
        'an insert before': 'Promo Clip comes out before X S1E3 at 7:00am. Nothing else in the day moves.',
    };
    suite.log('-- the day laid again, spliced in (Keep apart) --');
    for (const [ label, change, expect ] of [
        [ 'a same-length swap', { n: 3, kind: 'swap', item: { program: SAME } }, 'K S1E1 replaces X S1E3 at 7:00am; it airs at 7:30am instead. Nothing else in the day moves.' ],
        [ 'a longer swap', { n: 3, kind: 'swap', item: { program: SHORT } }, 'The Short One replaces X S1E3 at 7:00am; it airs at 8:00am instead. The rows after it start 30 minutes later; X airs one fewer episode.' ],
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
        const back = dayEdits.describe({ before: spliced, after: L, day: s1.specialDays[0], change: Object.assign({ id: 'ch1' }, change), undo: true });
        suite.check(`...and its Put back says "${undoSaid[label]}"`, back === undoSaid[label], back);
    }

    suite.log('-- refusals and the day\u2019s end (review, Nov 8) --');
    {
        const thirdAt = indexAt(L, fri(7));
        suite.check('Insert before an airing whose break in front is shorter than the item is refused, in today\u2019s words',
            dayEdits.beforeFits({ lineup: L, index: thirdAt, item: movie('Long Promo', 30 * MIN) }) === 'Long Promo is longer than the 8:00 break before X S1E3.'
                && dayEdits.beforeFits({ lineup: L, index: thirdAt, item: CLIP }) === null,
            String(dayEdits.beforeFits({ lineup: L, index: thirdAt, item: movie('Long Promo', 30 * MIN) })));
        suite.check('an edit inside a day that has begun is refused, in one line; before it begins, none',
            dayEdits.whyNot({ day: s0.specialDays[0], now: fri(6, 1) }) === 'Marathon is on the air: edits inside it are made before it begins.'
                && dayEdits.whyNot({ day: s0.specialDays[0], now: fri(5, 59) }) === null);
        const lastAt = shows(L).filter( (a) => (a.start >= FRI6) && (a.start < fri(12)) ).length;
        const s1 = dayEdits.withChange(s0, 'sd_t', 0, { n: lastAt, kind: 'after', item: { program: SHORT } }, 'chE');
        const R = await make(s1);
        const got = dayEdits.splice({ lineup: L, relaid: R, day: s1.specialDays[0] });
        const said = dayEdits.describe({ before: L, after: { programs: got.programs, startTime: L.startTime }, day: s1.specialDays[0], change: { id: 'chE', n: lastAt, kind: 'after' } });
        suite.check('an insert after the day\u2019s last airing that runs past its end says so',
            /runs 39:00 past the end of the day/.test(said), said);
    }

    suite.log('-- Delete inside a day: never air, the day laid again without it --');
    {
        const without = (title) => () => pool().filter( (p) => p.title !== title );
        const R = await make(s0, without('X S1E3'));
        const got = dayEdits.splice({ lineup: L, relaid: R, day: s0.specialDays[0] });
        const spliced = { programs: got.programs, startTime: L.startTime };
        suite.check('Keep apart: the list with the day laid again without X S1E3 is what Create Lineup makes',
            sig(spliced, L.startTime, L.startTime + 3 * DAY) === sig(R, L.startTime, L.startTime + 3 * DAY), '');
        const said = dayEdits.leftOutSentence({ before: L, after: spliced, day: s0.specialDays[0], at: fri(7), title: 'X S1E3' });
        suite.check('...and says "X S1E3 is left out; X S1E4 airs at 7:00am instead. Nothing else in the day moves."',
            said === 'X S1E3 is left out; X S1E4 airs at 7:00am instead. Nothing else in the day moves.', said);

        const adv = sched(day({ positions: 'advance', slots: [ { showId: 'tv.A', order: 'next' } ] }));
        const LA = await make(adv);
        const third = shows(LA).find( (a) => a.start === fri(7) ).program.title;
        const RA = await make(adv, without(third));
        const gotA = dayEdits.splice({ lineup: LA, relaid: RA, day: adv.specialDays[0] });
        const deleted = shows(LA).find( (a) => a.start === fri(7) ).program;
        const moved = dayEdits.alongAfter({ lineup: LA, spliced: gotA, relaid: RA, now: NOW, schedule: adv, catalog: without(third)(), leftOut: [ deleted ] });
        suite.check(`Advance: deleting ${third} at 7:00am, A\u2019s later airings after the day move up one, as Create Lineup makes them`,
            sig({ programs: moved.programs, startTime: LA.startTime }, SAT6 - 18 * HOUR, SAT6 + DAY) === sig(RA, SAT6 - 18 * HOUR, SAT6 + DAY)
                && /later episodes move up one/.test(moved.text), moved.text);
    }

    suite.log('-- a Keep apart day touches only itself --');
    {
        const s1 = dayEdits.withChange(s0, 'sd_t', 0, { n: 3, kind: 'swap', item: { program: SAME } }, 'ch1');
        const R = await make(s1);
        const got = dayEdits.splice({ lineup: L, relaid: R, day: s1.specialDays[0] });
        const moved = dayEdits.alongAfter({ lineup: L, spliced: got, relaid: R, now: NOW, schedule: s1, catalog: pool() });
        suite.check('a swap on a Keep apart day moves nothing after it and says nothing of an episode the day no longer airs',
            moved.text === '' && moved.programs === got.programs, moved.text);
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
        suite.check('...and no airing outside the day carries the day\u2019s marks (review, Nov 8)',
            withStarts(out).every( (a) => ( (a.start >= FRI6) && (a.start < fri(12)) ) || a.program.isOffline
                || ( (typeof(a.program.specialDay) === 'undefined') && (typeof(a.program.specialRow) === 'undefined') ) ),
            JSON.stringify(withStarts(out).filter( (a) => (a.start >= fri(12)) && a.program.specialDay ).slice(0, 1).map( (a) => [ a.program.title, a.program.specialDay ] )));
        suite.check('...and says where the episode pushed out lands', /A S1E\d+ airs Fri Oct 9, 12:00pm/.test(moved.text || ''), moved.text);
        const putBack = dayEdits.withoutChange(s1, 'ch1');
        const RB = await make(putBack);
        const got2 = dayEdits.splice({ lineup: out, relaid: RB, day: putBack.specialDays[0] });
        const back = dayEdits.alongAfter({ lineup: out, spliced: got2, relaid: RB, now: NOW, schedule: putBack, catalog: pool() });
        suite.check('...Put back gives the list back exactly as it was', sig({ programs: back.programs, startTime: LA.startTime }, LA.startTime, LA.startTime + 3 * DAY)
            === sig(LA, LA.startTime, LA.startTime + 3 * DAY), '');
    }

    suite.log('-- Swap changes only the airing clicked (DarkManX16, Nov 15) --');
    {
        // A shuffled run until 10:00am, then A: X's episodes in a shuffle's order.
        const sS = sched(day({ slots: [ { showId: 'tv.X', order: 'shuffle', until: 10 * HOUR }, { showId: 'tv.A', order: 'next' } ] }));
        const dayS = sS.specialDays[0];
        const LS = await make(sS);
        const inDay = (l) => shows(l).filter( (a) => (a.start >= FRI6) && (a.start < fri(12)) ).map( (a) => [ a.start, a.program.title ] );
        const was = inDay(LS);
        const titleAt = (l, t) => shows(l).find( (a) => a.start === t ).program.title;
        const but = (list, swaps) => JSON.stringify(list.map( ([ t, title ]) => [ t, (t in swaps) ? swaps[t] : title ] ));
        // The editor's whole path: the change on the row, the day laid again, the list and its sentence.
        const edit = async (lineup, schedule, index, item, id) => {
            const got = dayEdits.swapIn({ lineup, index, item, schedule, id, tradeId: id + 't' });
            const R = await make(got.schedule);
            const done = dayEdits.applyRelaid({ lineup, relaid: R, day: got.schedule.specialDays[0], change: got.change, trade: got.trade,
                now: NOW, schedule: got.schedule, catalog: pool() });
            return Object.assign({ R, list: { programs: done.programs, startTime: lineup.startTime } }, got, { text: done.text });
        };

        const x7 = titleAt(LS, fri(7));
        const one = await edit(LS, sS, indexAt(LS, fri(7)), SAME, 'chS');
        suite.check('a swap of the 7:00am airing, in a Shuffle run: the change is in place, and no trade', one.change.inPlace === true && one.trade === null,
            JSON.stringify(one.change) + ' ' + JSON.stringify(one.trade));
        suite.check('...in the list, only 7:00am changes: every other airing of the day is the same episode at the same time',
            but(inDay(one.list), {}) === but(was, { [fri(7)]: 'K S1E1' }), JSON.stringify(inDay(one.list).slice(0, 4)));
        suite.check('...outside the day nothing changes, and the list is what Create Lineup makes',
            sig(one.list, LS.startTime, LS.startTime + 3 * DAY) === sig(one.R, LS.startTime, LS.startTime + 3 * DAY), '');
        suite.check(`...and it says "K S1E1 replaces ${x7} at 7:00am. Nothing else in the day moves."`,
            one.text === `K S1E1 replaces ${x7} at 7:00am. Nothing else in the day moves.`, one.text);

        // The episode swapped in already airs later in the day: the two trade places.
        const x9 = titleAt(LS, fri(9));
        const later = shows(LS).find( (a) => a.start === fri(9) ).program;
        const two = await edit(LS, sS, indexAt(LS, fri(7)), later, 'chT');
        suite.check(`swapping ${x9} (9:00am) into 7:00am: a second change gives 9:00am the episode swapped out`,
            (two.trade !== null) && (two.trade.with === 'chT') && (two.trade.n === dayEdits.locate({ lineup: LS, index: indexAt(LS, fri(9)), schedule: sS }).n),
            JSON.stringify(two.trade && { n: two.trade.n, with: two.trade.with, title: two.trade.item.program.title }));
        suite.check('...in the list the two trade places; every other airing of the day stays',
            but(inDay(two.list), {}) === but(was, { [fri(7)]: x9, [fri(9)]: x7 }), JSON.stringify(inDay(two.list).slice(0, 7)));
        suite.check('...and the list is what Create Lineup makes', sig(two.list, LS.startTime, LS.startTime + 3 * DAY) === sig(two.R, LS.startTime, LS.startTime + 3 * DAY), '');
        suite.check(`...and it says "${x9} and ${x7} trade places: ${x9} at 7:00am, ${x7} at 9:00am. Nothing else in the day moves."`,
            two.text === `${x9} and ${x7} trade places: ${x9} at 7:00am, ${x7} at 9:00am. Nothing else in the day moves.`, two.text);

        // Put back, from either of the two: both come off, and the day is as it was.
        for (const id of [ 'chT', 'chTt' ]) {
            const off = dayEdits.withoutChange(two.schedule, id);
            const RB = await make(off);
            const found = dayEdits.findChange(two.schedule, id);
            const back = dayEdits.applyRelaid({ lineup: two.list, relaid: RB, day: off.specialDays[0], change: found.change, trade: found.trade,
                undo: true, now: NOW, schedule: off, catalog: pool() });
            suite.check(`Put back of ${ (id === 'chT') ? 'the swap' : 'the airing it traded with' } takes both off the row, and the day is as it was`,
                (typeof(off.specialDays[0].slots[0].changes) === 'undefined') && (but(inDay({ programs: back.programs, startTime: LS.startTime }), {}) === but(was, {})),
                JSON.stringify(off.specialDays[0].slots[0].changes));
            suite.check(`...and says "${x7} is back at 7:00am and ${x9} at 9:00am. Nothing else in the day moves."`,
                back.text === `${x7} is back at 7:00am and ${x9} at 9:00am. Nothing else in the day moves.`, back.text);
        }
        {
            const off = dayEdits.withoutChange(one.schedule, 'chS');
            const found = dayEdits.findChange(one.schedule, 'chS');
            const back = dayEdits.applyRelaid({ lineup: one.list, relaid: await make(off), day: off.specialDays[0], change: found.change, trade: found.trade,
                undo: true, now: NOW, schedule: off, catalog: pool() });
            suite.check(`Put back of a swap in place says "${x7} is back at 7:00am. Nothing else in the day moves."`,
                back.text === `${x7} is back at 7:00am. Nothing else in the day moves.`, back.text);
        }

        // A swap on an airing an older swap holds keeps that swap's way: the airings after it stay too.
        const old = dayEdits.withChange(sS, 'sd_t', 0, { n: 2, kind: 'swap', item: { program: SAME } }, 'chOld');
        const LO = await make(old);
        const wasO = inDay(LO);
        const three = await edit(LO, old, indexAt(LO, fri(6, 30)), episode('K', 1, 2), 'chN');
        suite.check('swapping an airing an older swap holds (one that moved nothing on): it stays that kind of change',
            (three.change.inPlace === undefined) && (three.schedule.specialDays[0].slots[0].changes.length === 1), JSON.stringify(three.change));
        suite.check('...and only that airing changes', but(inDay(three.list), {}) === but(wasO, { [fri(6, 30)]: 'K S1E2' }), JSON.stringify(inDay(three.list).slice(0, 4)));
        const undone = dayEdits.withoutChange(three.schedule, 'chN');
        suite.check('...and its Put back gives back the swap it took the place of', JSON.stringify(undone) === JSON.stringify(old),
            JSON.stringify(undone.specialDays[0].slots[0].changes));
        const backO = dayEdits.applyRelaid({ lineup: three.list, relaid: await make(undone), day: undone.specialDays[0], change: three.change, trade: null,
            undo: true, now: NOW, schedule: undone, catalog: pool() });
        suite.check('...the day as it was, saying "K S1E1 is back at 6:30am. Nothing else in the day moves."',
            (but(inDay({ programs: backO.programs, startTime: LO.startTime }), {}) === but(wasO, {})) && (backO.text === 'K S1E1 is back at 6:30am. Nothing else in the day moves.'),
            backO.text);

        // An Advance day: nothing after the day moves either.
        const adv = sched(day({ positions: 'advance', slots: [ { showId: 'tv.A', order: 'next' } ] }));
        const LA = await make(adv);
        const four = await edit(LA, adv, indexAt(LA, fri(7)), SAME, 'chV');
        suite.check('on an Advance day a swap changes that airing only, before, in and after the day, as Create Lineup makes it',
            (sig(four.list, LA.startTime, LA.startTime + 3 * DAY) === sig(four.R, LA.startTime, LA.startTime + 3 * DAY))
                && (but(shows(four.list).map( (a) => [ a.start, a.program.title ] ), {}) === but(shows(LA).map( (a) => [ a.start, a.program.title ] ), { [fri(7)]: 'K S1E1' })),
            four.text);
    }
    return suite;
};
