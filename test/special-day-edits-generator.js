/*
 * Edits inside a special day (NOTES.md, "Event tools", feature 4), in the Time
 * Slots generator: a day's row carries `changes`, each to one airing of that row
 * - its nth item in the day - and the generator lays the day with them: a swap
 * airs the item in place of the row's nth (the row's show doesn't move on, so its
 * next airing gets the episode the swap pushed out), an insert after airs right
 * after it, an insert before airs right before it, in the break in front. A
 * re-make during the day lays the same day. Rows without changes lay exactly as
 * before (test/special-days-generator.js).
 *
 * The real time-slots-service with the clock frozen, as the other generator tests.
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const timeSlotsService = require('../src/services/time-slots-service');
const slotProgress = require('../src/slot-progress');
const pinTools = require('../src/pins');
const getShowData = require('../web/services/get-show-data')();

const NOW = new Date('2026-10-08T12:00:00').getTime();            // Thu Oct 8, 2026 noon
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
const HALF = movie('Half Hour Special', 30 * MIN);
const SHORT = movie('The Short One', 47 * MIN);
const SAME = episode('K', 1, 1, 22 * MIN);

function daily() {
    let slots = [];
    for (let k = 0; k < 48; k++) {
        slots.push({ time: k * 30 * MIN, showId: 'tv.' + 'ABCD'[k % 4], order: 'next' });
    }
    return { period: DAY, lateness: 24 * HOUR, maxDays: 10, flexPreference: 'distribute', pad: 5 * MIN, slots };
}
const pool = () => seasons('A', 80).concat(seasons('B', 80), seasons('C', 80), seasons('D', 80), seasons('X', 60), seasons('Y', 40, 11 * MIN));
function day(extra) {
    return Object.assign({
        id: 'sd_t', name: 'Marathon', from: { date: '2026-10-09', time: 6 * HOUR }, to: { date: '2026-10-10', time: 6 * HOUR },
        blockId: null, positions: 'apart', layout: 'back', slots: [ { showId: 'tv.X', order: 'next' } ],
    }, extra || {});
}
const change = (n, kind, program, id) => ({ id: id || `ch${n}${kind}`, n, kind, item: { program } });
const sched = (d) => Object.assign(daily(), { specialDays: [ d ] });

// Create Lineup as the editor runs it, from the lineup `prev` was (or none).
async function make(prev, schedule, now) {
    const s = JSON.parse(JSON.stringify(schedule));
    let carry;
    if (prev !== null) {
        const start = Date.parse(prev.startTime);
        const c = pinTools.carryAt({ programs: prev.programs, startTime: start, now, schedule: prev.schedule });
        carry = (c === null) ? undefined : c;
        s.progress = slotProgress.planProgress({ programs: prev.programs, startTime: start, now,
            placesFrom: carry ? Math.max(now, carry.start + carry.program.duration) : undefined,
            openedSchedule: prev.schedule, schedule: s, pool: pool(), getShowData });
    }
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(now); else super(...a); }
        static now() { return now; }
    }
    global.Date = FrozenDate;
    try {
        const res = await timeSlotsService(pool(), JSON.parse(JSON.stringify(s)), undefined, undefined, carry ? JSON.parse(JSON.stringify(carry)) : undefined);
        return { programs: res.programs, startTime: res.startTime, schedule: s };
    } finally {
        global.Date = RealDate;
    }
}
function withStarts(res) {
    let t = Date.parse(res.startTime);
    return res.programs.map( (p) => { const a = { start: t, program: p }; t += p.duration; return a; } );
}
const shows = (res) => withStarts(res).filter( (a) => ! a.program.isOffline );
const inside = (res) => shows(res).filter( (a) => (a.start >= FRI6) && (a.start < SAT6) );
const clock = (t) => new Date(t).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });
const lines = (list) => list.map( (a) => `${clock(a.start)} ${a.program.title}` );
const flexBefore = (res, at) => {
    const all = withStarts(res);
    const i = all.findIndex( (a) => a.start === at && ! a.program.isOffline );
    return ( (i > 0) && all[i - 1].program.isOffline ) ? all[i - 1].program.duration : 0;
};

module.exports = async function () {
    const suite = new Suite('special-day-edits-generator');
    const plain = await make(null, sched(day()), NOW);
    const p = inside(plain);

    suite.log('-- a swap --');
    {
        const res = await make(null, sched(day({ slots: [ { showId: 'tv.X', order: 'next', changes: [ change(3, 'swap', SAME) ] } ] })), NOW);
        const d = inside(res);
        suite.check('a same-length swap of the row’s 3rd airing: it airs in its place, nothing else moves',
            d[2].program.title === 'K S1E1' && d[2].start === p[2].start && d.every( (a, i) => a.start === p[i].start ), lines(d.slice(1, 4)).join(' / '));
        suite.check('...and the row’s show doesn’t move on: the episode swapped out airs next',
            d[1].program.title === 'X S1E2' && d[3].program.title === 'X S1E3' && d[4].program.title === 'X S1E4', lines(d.slice(3, 5)).join(' / '));
        suite.check('...the swapped item carries the day, its row and its change', d[2].program.specialDay === 'sd_t' && d[2].program.specialRow === 0
            && d[2].program.specialChange === 'ch3swap' && ! d[2].program.slotPosition, JSON.stringify([ d[2].program.specialChange, d[2].program.slotPosition ]));
    }
    {
        const res = await make(null, sched(day({ slots: [ { showId: 'tv.X', order: 'next', changes: [ change(3, 'swap', SHORT) ] } ] })), NOW);
        const d = inside(res);
        suite.check('a longer swap (47 min at 7:00): the rows after it start at the next half hour after it, 8:00',
            d[2].program.title === 'The Short One' && d[2].start === fri(7) && d[3].start === fri(8) && d[3].program.title === 'X S1E3',
            lines(d.slice(2, 4)).join(' / '));
    }

    suite.log('-- inserts --');
    {
        const res = await make(null, sched(day({ slots: [ { showId: 'tv.X', order: 'next', changes: [ change(2, 'after', CLIP) ] } ] })), NOW);
        const d = inside(res);
        suite.check('insert after the 2nd airing: the clip airs right after it, and the next airing keeps its time',
            d[1].program.title === 'X S1E2' && d[2].program.title === 'Promo Clip' && d[2].start === d[1].start + 22 * MIN
                && d[3].start === fri(7) && d[3].program.title === 'X S1E3', lines(d.slice(1, 4)).join(' / '));
        suite.check('...the clip carries the day, its row and the change, and counts as no airing of the row',
            d[2].program.specialDay === 'sd_t' && d[2].program.specialRow === 0 && d[2].program.specialInsert === 'ch2after'
                && d.filter( (a) => a.program.showTitle === 'X' ).length === p.length, '');
    }
    {
        const res = await make(null, sched(day({ slots: [ { showId: 'tv.X', order: 'next', changes: [ change(2, 'after', HALF) ] } ] })), NOW);
        const d = inside(res);
        suite.check('a 30-minute insert after 6:30’s airing: it ends 7:22, so the rows after start at 7:30',
            d[2].program.title === 'Half Hour Special' && d[2].start === fri(6, 52) && d[3].start === fri(7, 30), lines(d.slice(1, 4)).join(' / '));
    }
    {
        const res = await make(null, sched(day({ slots: [ { showId: 'tv.X', order: 'next', changes: [ change(3, 'before', CLIP) ] } ] })), NOW);
        const d = inside(res);
        suite.check('insert before the 3rd airing: the clip ends right as it starts, in the break in front; nothing moves',
            d[2].program.title === 'Promo Clip' && d[2].start === fri(6, 55) && d[3].start === fri(7) && d[3].program.title === 'X S1E3'
                && flexBefore(res, fri(6, 55)) === 3 * MIN, lines(d.slice(1, 4)).join(' / ') + ` / Flex before ${flexBefore(res, fri(6, 55)) / MIN}`);
    }

    suite.log('-- a Set times day --');
    {
        const timed = (changes) => day({ layout: 'times', slots: [ { showId: 'tv.Y', order: 'next', at: 6 * HOUR, changes },
            { showId: 'tv.X', order: 'next', at: 8 * HOUR } ] });
        const base = inside(await make(null, sched(timed(undefined)), NOW));
        const res = inside(await make(null, sched(timed([ change(2, 'swap', episode('K', 1, 2, 11 * MIN)) ])), NOW));
        suite.check('Set times: a same-length swap of the row’s 2nd airing airs in its place; every start as before',
            res[1].program.title === 'K S1E2' && res[2].program.title === 'Y S1E2' && res.every( (a, i) => a.start === base[i].start ),
            lines(res.slice(0, 3)).join(' / '));
    }

    suite.log('-- a re-make during the day --');
    {
        const d1 = day({ slots: [ { showId: 'tv.X', order: 'next', changes: [ change(5, 'swap', SAME), change(6, 'after', CLIP) ] } ] });
        const laid = await make(null, sched(d1), NOW);
        for (const [ label, at ] of [ [ '7:10am (the 3rd airing on air)', fri(7, 10) ], [ '8:05am (the swap on air)', fri(8, 5) ],
            [ '8:40am (the airing with an insert after it on air)', fri(8, 40) ], [ '8:54am (the insert on air)', fri(8, 54) ] ]) {
            const again = await make(laid, sched(d1), at);
            // From where the re-made lineup begins: the program on air.
            const from = Math.max(at - 30 * MIN, inside(again)[0].start);
            const same = JSON.stringify(lines(inside(laid).filter( (a) => a.start >= from )))
                === JSON.stringify(lines(inside(again).filter( (a) => a.start >= from )));
            suite.check(`a Create Lineup at ${label} lays the rest of the day as it was`, same,
                lines(inside(again).filter( (a) => (a.start >= fri(8)) && (a.start < fri(9, 30)) )).join(' / '));
        }
    }

    {
        const d2 = day({ slots: [ { showId: 'tv.X', order: 'next', changes: [ change(3, 'before', CLIP) ] } ] });
        const laid = await make(null, sched(d2), NOW);
        const again = await make(laid, sched(d2), fri(6, 57));
        suite.check('a Create Lineup with an insert before on air (6:57am) doesn’t lay it twice',
            inside(again).filter( (a) => a.program.title === 'Promo Clip' ).length === 1
                && JSON.stringify(lines(inside(laid).filter( (a) => a.start >= fri(6, 55) ))) === JSON.stringify(lines(inside(again).filter( (a) => a.start >= fri(6, 55) ))),
            lines(inside(again).filter( (a) => (a.start >= fri(6, 30)) && (a.start < fri(7, 30)) )).join(' / '));
    }

    suite.log('-- rows without changes --');
    {
        const empty = await make(null, sched(day({ slots: [ { showId: 'tv.X', order: 'next', changes: [] } ] })), NOW);
        suite.check('an empty changes list lays exactly as no changes', JSON.stringify(empty.programs) === JSON.stringify(plain.programs), '');
    }
    return suite;
};
