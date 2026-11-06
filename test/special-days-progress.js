/*
 * Special days and stored progress: a Keep-apart day's own positions, read from
 * its own airings and never as a regular position's place; a row's start, kept
 * until the day begins (Keep apart: the place; Advance: a jump on the day); a
 * re-make during a day carrying on with the day; a picked item once per day;
 * rows on the quarter hour. Create Lineup's path driven directly - the planner
 * reading places from the lineup on air, the program on air carried, the real
 * generator with the clock frozen. See NOTES.md, Known issues, "Special days".
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const timeSlotsService = require('../src/services/time-slots-service');
const slotProgress = require('../src/slot-progress');
const pinTools = require('../src/pins');
const episodeStart = require('../src/episode-start');
const getShowData = require('../web/services/get-show-data')();

const SEC = 1000;
const NOW = new Date('2026-10-08T12:00:00').getTime();            // Thu Oct 8, 2026 noon
const fri = (h, m, s) => new Date(2026, 9, 9, h, m || 0, s || 0).getTime();
const sat = (h, m, s) => new Date(2026, 9, 10, h, m || 0, s || 0).getTime();
const FRI6 = fri(6);
const SAT6 = sat(6);

function episode(show, season, n, duration) {
    return {
        type: 'episode', showTitle: show, title: `${show} S${season}E${n}`,
        season, episode: n, duration: duration || 22 * MIN, serverKey: 'srv', key: `/e/${show}/${season}/${n}`,
    };
}
function seasons(show, count, duration) {
    const out = [];
    for (let e = 1; e <= count; e++) {
        out.push(episode(show, 1, e, duration));
    }
    return out;
}
const movie = (title, duration) => ({ type: 'movie', title, duration, serverKey: 'srv', key: '/m/' + title });
const SHORT = movie('The Short One', 47 * MIN);
const LONG = movie('The Long One', 95 * MIN);

// Half-hour slots all day, A B C D round the clock.
function daily() {
    let slots = [];
    for (let k = 0; k < 48; k++) {
        slots.push({ time: k * 30 * MIN, showId: 'tv.' + 'ABCD'[k % 4], order: 'next' });
    }
    return { period: DAY, lateness: 24 * HOUR, maxDays: 10, flexPreference: 'distribute', pad: 5 * MIN, slots };
}
// X is on no regular slot; its later episodes come first in the pool, so the
// founder rule alone would start it at S1E31.
// Z, 7-minute shorts on no slot, fills long breaks.
function pool() {
    return seasons('A', 80).concat(seasons('B', 80), seasons('C', 80), seasons('D', 80),
        seasons('X', 60).slice(30), seasons('X', 60).slice(0, 30), seasons('Z', 40, 7 * MIN));
}
function day(extra) {
    return Object.assign({
        id: 'sd_t', name: 'Marathon', from: { date: '2026-10-09', time: 6 * HOUR }, to: { date: '2026-10-10', time: 6 * HOUR },
        blockId: null, positions: 'apart', layout: 'back', slots: [ { showId: 'tv.A', order: 'next' } ],
    }, extra || {});
}
const startOf = (show, n) => ({ key: `srv|/e/${show}/1/${n}`, order: 1000000 + n });

// Create Lineup as the editor runs it, from the lineup `prev` was (or none).
async function make(prev, schedule, now, holidayItems) {
    const sched = JSON.parse(JSON.stringify(schedule));
    let carry;
    if (prev !== null) {
        const start = Date.parse(prev.startTime);
        const c = pinTools.carryAt({ programs: prev.programs, startTime: start, now, schedule: prev.schedule });
        carry = (c === null) ? undefined : c;
        sched.progress = slotProgress.planProgress({ programs: prev.programs, startTime: start, now,
            placesFrom: carry ? Math.max(now, carry.start + carry.program.duration) : undefined,
            openedSchedule: prev.schedule, schedule: sched, pool: pool(), getShowData });
    }
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(now); else super(...a); }
        static now() { return now; }
    }
    global.Date = FrozenDate;
    try {
        const res = await timeSlotsService(pool(), JSON.parse(JSON.stringify(sched)), undefined, undefined, carry ? JSON.parse(JSON.stringify(carry)) : undefined,
            undefined, holidayItems ? JSON.parse(JSON.stringify(holidayItems)) : undefined);
        return { programs: res.programs, startTime: res.startTime, schedule: sched };
    } finally {
        global.Date = RealDate;
    }
}
function withStarts(res) {
    let t = Date.parse(res.startTime);
    return res.programs.map( (p) => { const a = { start: t, program: p }; t += p.duration; return a; } );
}
const shows = (res) => withStarts(res).filter( (a) => ! a.program.isOffline );
const inside = (res, from, to) => shows(res).filter( (a) => (a.start >= from) && (a.start < to) );
const titles = (list) => list.map( (a) => a.program.title );
const sameDay = (x, y, from) => JSON.stringify(inside(x, from, SAT6).map( (a) => [ a.start, a.program.title ] ))
    === JSON.stringify(inside(y, from, SAT6).map( (a) => [ a.start, a.program.title ] ));
const clock = (t) => new Date(t).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

module.exports = async function () {
    const suite = new Suite('special-days-progress');
    const sched = (d) => Object.assign(daily(), { specialDays: [ d ] });

    suite.log('-- labels --');
    {
        const parsed = slotProgress.parseLabel('next||@sd_t');
        const round = slotProgress.parseLabel('shuffle|2|3|@sd_t');
        suite.check('a Keep-apart label reads with its day; untagged labels read as before',
            parsed.mode === 'next' && parsed.tag === 'sd_t' && round.round === 3 && JSON.stringify(round.excluded) === '[2]' && round.tag === 'sd_t'
                && JSON.stringify(slotProgress.parseLabel('next|')) === '{"mode":"next","excluded":[],"round":null}'
                && slotProgress.parseLabel('next|x') === null, JSON.stringify(parsed));
        const tagged = Object.assign(episode('A', 1, 1), { slotPosition: 'next||@sd_t' });
        const plain = Object.assign(episode('A', 1, 9), { slotPosition: 'next|' });
        const places = slotProgress.readPlaces({ programs: [ tagged, plain, { isOffline: true, duration: DAY - 44 * MIN } ], startTime: NOW, now: NOW, schedule: daily(), getShowData });
        suite.check('...a tagged airing is its day\'s place, never the regular position\'s',
            places.get('["tv.A","next",[]]').program.title === 'A S1E9' && places.get('["tv.A","next",[],"@sd_t"]').program.title === 'A S1E1',
            JSON.stringify([ ...places.keys() ]));
    }

    suite.log('-- Keep apart --');
    const first = await make(null, sched(day()), NOW);
    {
        const d = inside(first, FRI6, SAT6);
        suite.check('Keep apart, no start: the day plays A from its range\'s first episode', d[0].program.title === 'A S1E1', titles(d.slice(0, 2)).join(', '));
        const again = await make(first, sched(day()), NOW + HOUR);
        suite.check('...and a Create Lineup an hour later gives the same day', sameDay(first, again, FRI6), '');
        const started = await make(first, sched(day({ slots: [ { showId: 'tv.A', order: 'next', start: startOf('A', 20) } ] })), NOW + HOUR);
        suite.check('Keep apart, before the day: the row\'s start is the place, even with the day already in the lineup',
            inside(started, FRI6, SAT6)[0].program.title === 'A S1E20', titles(inside(started, FRI6, SAT6).slice(0, 2)).join(', '));
        const twice = await make(started, sched(day({ slots: [ { showId: 'tv.A', order: 'next', start: startOf('A', 20) } ] })), NOW + 2 * HOUR);
        suite.check('...and still is the next time', sameDay(started, twice, FRI6), '');
        const regularBefore = shows(first).find( (a) => (a.start >= SAT6) && (a.program.showTitle === 'A') ).program.title;
        const regularAfter = shows(twice).find( (a) => (a.start >= SAT6) && (a.program.showTitle === 'A') ).program.title;
        suite.check('...and the regular A is the same either way', regularBefore === regularAfter, `${regularBefore} / ${regularAfter}`);
        const mid = fri(15, 10);
        const during = await make(twice, sched(day({ slots: [ { showId: 'tv.A', order: 'next', start: startOf('A', 20) } ] })), mid);
        suite.check('Keep apart, during the day (the program on air carried): the rest of the day is unchanged',
            sameDay(twice, during, fri(15, 30)), `${clock(mid)}: ${titles(inside(during, fri(15), fri(16, 30))).join(', ')}`);
        const gap = fri(15, 25);
        const inGap = await make(twice, sched(day({ slots: [ { showId: 'tv.A', order: 'next', start: startOf('A', 20) } ] })), gap);
        suite.check('...and in the Flex between rows, with nothing carried, the day carries on with the next row',
            sameDay(twice, inGap, fri(15, 30)), `${titles(inside(inGap, fri(15, 30), fri(16, 30))).join(', ')}`);
        const after = await make(during, sched(day({ slots: [ { showId: 'tv.A', order: 'next', start: startOf('A', 20) } ] })), sat(12));
        const tagged = Object.keys(after.schedule.progress.positions).filter( (k) => /@sd_t/.test(k) );
        suite.check('...and once the day has ended, its records go', tagged.length === 0, JSON.stringify(tagged));
    }

    suite.log('-- Advance --');
    {
        const adv = (rows) => sched(day({ positions: 'advance', slots: rows }));
        const plain = await make(first, adv([ { showId: 'tv.A', order: 'next' } ]), NOW + HOUR);
        const lastBefore = shows(plain).filter( (a) => (a.program.showTitle === 'A') && (a.start < FRI6) ).pop().program.episode;
        suite.check('Advance: A continues its regular position', inside(plain, FRI6, SAT6)[0].program.episode === lastBefore + 1, '');
        const jump = await make(first, adv([ { showId: 'tv.A', order: 'next', start: startOf('A', 1) } ]), NOW + HOUR);
        const d = inside(jump, FRI6, SAT6);
        const afterA = shows(jump).find( (a) => (a.start >= SAT6) && (a.program.showTitle === 'A') ).program.title;
        suite.check('Advance, a start: A jumps to S1E1 on the day, and after the day carries on from where the day left it',
            d[0].program.title === 'A S1E1' && afterA === `A S1E${d.length + 1}`, `${titles(d.slice(0, 2)).join(', ')} ... after: ${afterA}`);
        const before = shows(jump).filter( (a) => (a.program.showTitle === 'A') && (a.start < FRI6) ).pop().program.episode;
        suite.check('...and A before the day is untouched by the jump', before === lastBefore, `${before} vs ${lastBefore}`);
        const mid = await make(jump, adv([ { showId: 'tv.A', order: 'next', start: startOf('A', 1) } ]), fri(15, 10));
        suite.check('...a Create Lineup during the day doesn\'t jump again: the rest of the day is unchanged',
            sameDay(jump, mid, fri(15, 30)), titles(inside(mid, fri(15, 30), fri(16, 30))).join(', '));
        const x = await make(first, adv([ { showId: 'tv.X', order: 'next' } ]), NOW + HOUR);
        suite.check('Advance, a show on no regular slot: its range\'s first episode, not wherever it first sits in the pool',
            inside(x, FRI6, SAT6)[0].program.title === 'X S1E1', titles(inside(x, FRI6, SAT6).slice(0, 2)).join(', '));
    }

    suite.log('-- a picked item once a day --');
    {
        const d1 = day({ positions: 'advance', slots: [ { showId: 'movie.', item: { program: SHORT } }, { showId: 'tv.X', order: 'next' } ] });
        const res = await make(first, sched(d1), NOW + HOUR);
        const d = inside(res, FRI6, SAT6);
        suite.check('This item airs once a day though the list starts again; the show row fills the rest',
            d.filter( (a) => a.program.title === 'The Short One' ).length === 1 && d[0].program.title === 'The Short One'
                && d.slice(1).every( (a) => a.program.showTitle === 'X' ) && d.length === 47, `${d.length} airings, first ${d[0].program.title}`);
        const mid = await make(res, sched(d1), fri(15, 25));
        suite.check('...and a Create Lineup during the day doesn\'t air it again', sameDay(res, mid, fri(15, 30))
            && inside(mid, fri(15, 30), SAT6).every( (a) => a.program.title !== 'The Short One' ), '');
        const onlyItems = day({ positions: 'advance', slots: [ { showId: 'movie.', item: { program: SHORT } }, { showId: 'movie.', item: { program: LONG } } ] });
        const items = await make(first, sched(onlyItems), NOW + HOUR);
        const di = inside(items, FRI6, SAT6);
        suite.check('...a day of only picked items airs each once, then Flex to its end',
            titles(di).join(', ') === 'The Short One, The Long One' && shows(items).find( (a) => a.start >= fri(9) ).start >= SAT6, titles(di).join(', '));
    }

    suite.log('-- Fill long breaks with, during the day --');
    {
        // 47:00 at 6:00 leaves 13:00 on air: Z S1E1 fills it. 95:00 at 7:00 ends 8:35:
        // Z S1E2-4 fill the 25:00 before 9:00. Step 7, Nov 5: a Create Lineup at 7:30,
        // the long movie on air, replayed the fill from Z S1E1 at 8:35 - the fill's own
        // position (tagged "fill:" + the day) was dropped as a day's that had ended.
        const fd = day({ positions: 'advance', fillBreaksWith: 'tv.Z',
            slots: [ { showId: 'movie.', item: { program: SHORT } }, { showId: 'movie.', item: { program: LONG } }, { showId: 'tv.X', order: 'next' } ] });
        const laid = await make(first, sched(fd), NOW + HOUR);
        const zs = (res, from) => inside(res, from, SAT6).filter( (a) => a.program.showTitle === 'Z' ).map( (a) => `${clock(a.start)} ${a.program.title}` );
        suite.check('the day\'s fill, as laid: Z S1E1 after the 6:00 movie, Z S1E2-4 after the 7:00 one',
            zs(laid, FRI6).join(', ') === 'Fri 6:50 AM Z S1E1, Fri 8:35 AM Z S1E2, Fri 8:42 AM Z S1E3, Fri 8:49 AM Z S1E4', zs(laid, FRI6).join(', '));
        const during = await make(laid, sched(fd), fri(7, 30));
        suite.check('...a Create Lineup at 7:30 carries the fill on: Z S1E2 at 8:35, not Z S1E1 again',
            sameDay(laid, during, fri(8)), zs(during, fri(8)).join(', '));
        const after = await make(during, sched(fd), sat(12));
        const tagged = Object.keys(after.schedule.progress.positions).filter( (k) => /@fill:sd_t/.test(k) );
        suite.check('...and once the day has ended, the fill\'s record goes too', tagged.length === 0, JSON.stringify(tagged));
    }

    suite.log('-- holiday rows, during the day --');
    {
        // Fri 6:00-12:00, one A row on 4 set-aside episodes: the first four airings are
        // them, the rest A's regular ones. A Create Lineup at any moment carries on exactly.
        const xmas = (n) => Object.assign( episode('A', 0, n), { title: `A Christmas ${n}`, key: `/e/A/xmas/${n}` } );
        const items = { sd_t: { 'tv.A': [ xmas(1), xmas(2), xmas(3), xmas(4) ] } };
        const hd = day({ positions: 'advance', holiday: 'Christmas', to: { date: '2026-10-09', time: 12 * HOUR },
            slots: [ { showId: 'tv.A', order: 'next', holidayOnly: true } ] });
        const laid = await make(first, sched(hd), NOW, items);
        const titlesFrom = (res, from) => titles(inside(res, from, fri(12)));
        suite.check('the day as laid: four set-aside episodes, then A\'s regular ones',
            titles(inside(laid, FRI6, fri(8))).join(', ') === 'A Christmas 1, A Christmas 2, A Christmas 3, A Christmas 4'
                && inside(laid, fri(8), fri(12)).every( (a) => /^A S1E/.test(a.program.title) ), titles(inside(laid, FRI6, fri(9))).join(', '));
        const during = await make(laid, sched(hd), fri(7, 10), items);
        suite.check('...a Create Lineup in the middle of the set-aside episodes carries on: the rest of the day is unchanged',
            sameDay(laid, during, fri(7, 30)), `${titlesFrom(during, fri(7, 30)).slice(0, 4).join(', ')}`);
        const late = await make(laid, sched(hd), fri(9, 10), items);
        suite.check('...and after they have all aired, none comes round again: the rest of the day is unchanged',
            sameDay(laid, late, fri(9, 30)), `${titlesFrom(late, fri(9, 30)).slice(0, 3).join(', ')}`);
        const inGap = await make(laid, sched(hd), fri(7, 25), items);
        suite.check('...and in the Flex between two rows, with nothing carried',
            sameDay(laid, inGap, fri(7, 30)), titlesFrom(inGap, fri(7, 30)).slice(0, 3).join(', '));
        const hs = day({ positions: 'advance', holiday: 'Christmas', to: { date: '2026-10-09', time: 12 * HOUR },
            slots: [ { showId: 'tv.A', order: 'shuffle', holidayOnly: true } ] });
        const shuffled = await make(first, sched(hs), NOW, items);
        const shuffledDuring = await make(shuffled, sched(hs), fri(7, 10), items);
        const shuffledLate = await make(shuffled, sched(hs), fri(9, 10), items);
        suite.check('a shuffled holiday row carries on the same way: the same order, none twice, mid-day and after',
            sameDay(shuffled, shuffledDuring, fri(7, 30)) && sameDay(shuffled, shuffledLate, fri(9, 30))
                && titles(inside(shuffled, FRI6, fri(8))).sort().join(',') === 'A Christmas 1,A Christmas 2,A Christmas 3,A Christmas 4',
            titles(inside(shuffled, FRI6, fri(9))).join(', ') + ' | ' + titles(inside(shuffledDuring, fri(7, 30), fri(9))).join(', '));
        const ended = await make(late, sched(hd), sat(12), items);
        const tagged = Object.keys(ended.schedule.progress.positions).filter( (k) => /@holiday:sd_t/.test(k) );
        suite.check('...and once the day has ended, the holiday position\'s record goes too', tagged.length === 0, JSON.stringify(tagged));
    }

    suite.log('-- the quarter hour --');
    {
        const rows = [ { showId: 'movie.', item: { program: SHORT } }, { showId: 'movie.', item: { program: LONG } }, { showId: 'tv.X', order: 'next' } ];
        const half = await make(first, sched(day({ positions: 'advance', slots: rows })), NOW + HOUR);
        const quarter = await make(first, sched(day({ positions: 'advance', slots: rows, rounding: 'quarter' })), NOW + HOUR);
        const h = inside(half, FRI6, SAT6);
        const q = inside(quarter, FRI6, SAT6);
        suite.check('on the half hour: 47:00 at 6:00, next at 7:00; 95:00 to 8:35, next at 9:00',
            h[1].start === fri(7) && h[2].start === fri(9), h.slice(0, 3).map( (a) => clock(a.start) ).join(', '));
        suite.check('on the quarter hour: 47:00 at 6:00, next at 7:00; 95:00 to 8:35, next at 8:45; X then every half hour from 8:45',
            q[1].start === fri(7) && q[2].start === fri(8, 45) && q[3].start === fri(9, 15), q.slice(0, 4).map( (a) => clock(a.start) ).join(', '));
    }

    suite.log('-- Next, for a regular row --');
    {
        const s = sched(day({ positions: 'advance' }));
        const at = episodeStart.firstAiring({ slots: s.slots.filter( (x) => x.time === 6 * HOUR ), schedule: s, now: fri(3) });
        suite.check('a regular row\'s next airing skips the slot the day replaces: the 6:00am slot airs next Saturday',
            at.at === sat(6), clock(at.at));
        // Review, Nov 6: it stepped one slot at a time, so a long day over a dense schedule ran
        // out of its 400 steps inside the day. 288 slots a day (every 5 minutes), a 2-day day.
        const dense = Object.assign( daily(), { slots: Array.from( { length: 288 }, (_, k) => ({ time: k * 5 * MIN, showId: 'tv.A', order: 'next' }) ) } );
        const longDay = Object.assign( {}, dense, { specialDays: [ day({ positions: 'advance', to: { date: '2026-10-11', time: 6 * HOUR } }) ] } );
        const denseAt = episodeStart.firstAiring({ slots: dense.slots, schedule: longDay, now: fri(7) });
        suite.check('...over a dense schedule and a 2-day day, the next airing is the first slot after the day, not a moment inside it',
            denseAt.at === new Date(2026, 9, 11, 6).getTime(), clock(denseAt.at));
    }
    return suite;
};
