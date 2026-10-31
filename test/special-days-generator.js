/*
 * Special days in the Time Slots generator: a date's own rows in place of the
 * regular slots for its hours - at set times, or back to back on the next :00
 * or :30 - Advance or Keep apart, a picked item, the end running late and
 * catching up as after a swap, and nothing changing outside the day except the
 * shows it displaces moving along. See NOTES.md, Known issues, "Special days".
 *
 * The real time-slots-service with the clock frozen, on fixtures in the
 * machine's own zone, as test/pins-generator.js does.
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const timeSlotsService = require('../src/services/time-slots-service');
const slotProgress = require('../src/slot-progress');

const SEC = 1000;
const WEEK = 7 * DAY;
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
function movie(title, duration, order) {
    return { type: 'movie', title, duration, serverKey: 'srv', key: '/m/' + title,
        customShowId: 'movies', customShowName: 'Movies', customOrder: order };
}
const MOVIES = [ movie('Movie One', 81 * MIN, 0), movie('Movie Two', 77 * MIN, 1), movie('Movie Three', 84 * MIN, 2) ];
const SHORT_MOVIE = movie('The Short One', 47 * MIN, 9);      // picked from the library: in no pool
const LONG_MOVIE = movie('The Long One', 95 * MIN, 8);

// Half-hour slots all day, A B C D round the clock, and the movies at 9pm for an hour.
function daily() {
    let slots = [];
    const order = [ 'A', 'B', 'C', 'D' ];
    for (let k = 0; k < 48; k++) {
        const time = k * 30 * MIN;
        if (time === 21 * HOUR + 30 * MIN) {
            continue;
        }
        slots.push({ time, showId: (time === 21 * HOUR) ? 'custom.movies' : 'tv.' + order[k % 4], order: 'next' });
    }
    return { period: DAY, lateness: 24 * HOUR, maxDays: 30, flexPreference: 'distribute', pad: 5 * MIN, slots };
}
function pool() {
    return seasons('A', 60).concat(seasons('B', 60), seasons('C', 60), seasons('D', 60),
        seasons('X', 40), seasons('Y', 40, 11 * MIN), seasons('Z', 40, 7 * MIN), seasons('L', 20, 44 * MIN), MOVIES);
}
function withDays(schedule, days) {
    return Object.assign( {}, schedule, { specialDays: days } );
}
function day(extra) {
    return Object.assign({
        id: 'sd_test', name: 'Marathon', from: { date: '2026-10-09', time: 6 * HOUR }, to: { date: '2026-10-10', time: 6 * HOUR },
        blockId: null, positions: 'advance', layout: 'back', slots: [ { showId: 'tv.X', order: 'next' } ],
    }, extra || {});
}
const item = (program) => ({ showId: program.customShowId ? 'custom.' + program.customShowId : 'tv.' + program.showTitle, item: { program } });

async function generate(programs, schedule, now, pins) {
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(now); else super(...a); }
        static now() { return now; }
    }
    global.Date = FrozenDate;
    try {
        const args = [ JSON.parse(JSON.stringify(programs)), JSON.parse(JSON.stringify(schedule)), undefined ];
        if (typeof pins !== 'undefined') {
            args.push(JSON.parse(JSON.stringify(pins)));
        }
        return await timeSlotsService(...args);
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
const outside = (res, from, to) => shows(res).filter( (a) => (a.start < from) || (a.start >= to) );
const titlesOf = (res, show, from) => shows(res).filter( (a) => (a.program.showTitle === show) && (a.start >= from) ).map( (a) => a.program.title );
const clock = (t) => new Date(t).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const line = (a) => `${clock(a.start)} ${a.program.title}`;
const longestFlex = (res, from, to) => withStarts(res).filter( (a) => a.program.isOffline && (a.start >= from) && (a.start < to) )
    .reduce( (m, a) => Math.max(m, a.program.duration), 0 );
// Outside the window, which slot each airing is in and its show, episodes aside: a
// displaced show's next episode may be another length, so a start within a slot can
// move (a movie sliding past its hour), but never the slot or the show.
const slotsOutside = (res) => JSON.stringify(outside(res, FRI6, SAT6).map( (a) => {
    const slot = slotProgress.slotAt(daily(), a.start);
    const d = new Date(a.start);
    return [ d.toDateString(), slot.time, a.program.showTitle || a.program.customShowName ];
} ));
let plainLineup = null;
// ...and the starts that move: only in the catch-up after the 9pm movie, which slides
// past its hour by the length of whichever movie is next once one is displaced.
const movedOutside = (res) => {
    const before = outside(plainLineup, FRI6, SAT6);
    return outside(res, FRI6, SAT6).filter( (a, k) => (before[k] !== undefined) && (before[k].start !== a.start) );
};
const movedOnlyAfterTheMovie = (res) => movedOutside(res).every( (a) => [ 22, 23, 0 ].indexOf(new Date(a.start).getHours()) !== -1 );

module.exports = async function () {
    const suite = new Suite('special-days-generator');
    const plain = await generate(pool(), daily(), NOW);
    plainLineup = plain;

    suite.log('-- no special days --');
    {
        const empty = await generate(pool(), withDays(daily(), []), NOW);
        const aired = await generate(pool(), withDays(daily(), [ day({ from: { date: '2026-10-01', time: 6 * HOUR }, to: { date: '2026-10-02', time: 6 * HOUR } }) ]), NOW);
        suite.check('no special days: absent, [] and only an aired day give the same lineup',
            JSON.stringify(empty) === JSON.stringify(plain) && JSON.stringify(aired) === JSON.stringify(plain), '');
    }

    suite.log('-- Set times --');
    {
        const rows = [];
        for (let k = 0; k < 48; k++) {
            rows.push({ showId: 'tv.X', order: 'next', at: 6 * HOUR + k * 30 * MIN });
        }
        const res = await generate(pool(), withDays(daily(), [ day({ layout: 'times', slots: rows }) ]), NOW);
        const day1 = inside(res, FRI6, SAT6);
        suite.check('Set times: the day\'s rows replace the regular slots for its hours - 48 X episodes on the half hours',
            day1.length === 48 && day1.every( (a, k) => (a.program.showTitle === 'X') && (a.start === FRI6 + k * 30 * MIN) )
                && day1[0].program.title === 'X S1E1', day1.slice(0, 2).map(line).join(' / '));
        suite.check('...and outside the day every airing keeps its slot and its show', slotsOutside(res) === slotsOutside(plain), '');
        suite.check('...a start moves only in the catch-up after the 9pm movie, whose rotation the day moved along',
            movedOnlyAfterTheMovie(res), `${movedOutside(res).length} moved`);
        const firstA = inside(plain, FRI6, SAT6).find( (a) => a.program.showTitle === 'A' ).program.title;
        suite.check('...the shows it displaces carry on: A\'s first airing after the day is the one the day displaced',
            titlesOf(res, 'A', SAT6)[0] === firstA, `${titlesOf(res, 'A', SAT6)[0]} vs ${firstA}`);
    }

    suite.log('-- Back to back --');
    let backRes;
    {
        const rows = [ item(SHORT_MOVIE), item(LONG_MOVIE), { showId: 'tv.X', order: 'next' } ];
        backRes = await generate(pool(), withDays(daily(), [ day({ slots: rows }) ]), NOW);
        const d = inside(backRes, FRI6, SAT6);
        suite.check('Back to back: 47:00 at 6:00, the next row at 7:00; 95:00 at 7:00, the next row at 9:00',
            d[0].start === fri(6) && d[0].program.title === 'The Short One' && d[1].start === fri(7) && d[1].program.title === 'The Long One'
                && d[2].start === fri(9) && d[2].program.title === 'X S1E1', d.slice(0, 3).map(line).join(' / '));
        suite.check('...no Flex inside the day is 30 minutes or longer', longestFlex(backRes, FRI6, SAT6) < 30 * MIN,
            `${longestFlex(backRes, FRI6, SAT6) / MIN} min`);
        suite.check('...every row starts on a :00 or :30', d.every( (a) => (new Date(a.start).getMinutes() % 30 === 0) && (new Date(a.start).getSeconds() === 0) ), '');
        suite.check('...the rows run out and start again, the picked movies once a day: X\'s next episode at 9:30, then on',
            d[3].start === fri(9, 30) && d[3].program.title === 'X S1E2' && d[4].program.title === 'X S1E3'
                && d.filter( (a) => a.program.type === 'movie' ).length === 2, d.slice(3, 6).map(line).join(' / '));
        suite.check('...every airing inside the day carries the day; none outside does',
            d.every( (a) => a.program.specialDay === 'sd_test' ) && outside(backRes, FRI6, SAT6).every( (a) => typeof(a.program.specialDay) === 'undefined' ), '');
        suite.check('...a picked item carries no label and no mark of a hand edit',
            d.filter( (a) => a.program.type === 'movie' ).every( (a) => ! a.program.slotPosition && ! a.program.kept && ! a.program.pin ), '');
        suite.check('...and outside the day every airing keeps its slot and its show', slotsOutside(backRes) === slotsOutside(plain), '');
        suite.check('...a start moves only in the catch-up after the 9pm movie, whose rotation the day moved along',
            movedOnlyAfterTheMovie(backRes), `${movedOutside(backRes).length} moved`);
        const regularMovieInDay = inside(plain, FRI6, SAT6).find( (a) => a.program.customShowName === 'Movies' ).program.title;
        const firstMovieAfter = shows(backRes).find( (a) => (a.start >= SAT6) && (a.program.customShowName === 'Movies') ).program.title;
        suite.check('...a picked movie leaves its custom show\'s rotation where it was: the movie the day displaced airs next',
            firstMovieAfter === regularMovieInDay, `${firstMovieAfter} vs ${regularMovieInDay}`);
    }
    {
        const res = await generate(pool(), withDays(daily(), [ day({ slots: [ { showId: 'tv.Y', order: 'next' }, { showId: 'tv.Z', order: 'next' } ] }) ]), NOW);
        const d = inside(res, FRI6, sat(0));
        suite.check('Back to back: two 11:00 halves share a half hour',
            d[0].start === fri(6) && d[1].program.title === 'Y S1E2' && d[1].start < fri(6, 30) && d[2].program.showTitle === 'Z' && d[2].start === fri(6, 30),
            d.slice(0, 3).map(line).join(' / '));
        suite.check('...and 7:00 shorts three to a half hour, padded as a regular slot pads them',
            d.slice(2, 5).every( (a) => a.program.showTitle === 'Z' ) && d[5].program.showTitle === 'Y' && d[5].start === fri(7), d.slice(2, 6).map(line).join(' / '));
    }
    {
        const ODD = movie('Thirty And Five', 30 * MIN + 5 * SEC, 7);
        const res = await generate(pool(), withDays(daily(), [ day({ slots: [ item(ODD), { showId: 'tv.X', order: 'next' } ] }) ]), NOW);
        const d = inside(res, FRI6, sat(0));
        suite.check('Back to back: an item ending 5 s past the half hour - the next row starts at once',
            d[1].start === fri(6, 30, 5) && d[1].program.showTitle === 'X', d.slice(0, 2).map(line).join(' / '));
    }

    suite.log('-- the edges --');
    {
        const OVER = movie('Runs Over', 44 * MIN + 9 * SEC, 6);
        const rows = [];
        for (let k = 0; k < 47; k++) {
            rows.push({ showId: 'tv.X', order: 'next', at: 6 * HOUR + k * 30 * MIN });
        }
        rows.push(Object.assign(item(OVER), { at: DAY + 5 * HOUR + 30 * MIN }));
        const res = await generate(pool(), withDays(daily(), [ day({ layout: 'times', slots: rows }) ]), NOW);
        const after = shows(res).filter( (a) => a.start >= SAT6 );
        suite.check('the last row runs 14:09 past the end: the 6:00 show starts 6:14:09, the next right after it, 7:00 on time',
            after[0].start === sat(6, 14, 9) && after[1].start === sat(6, 36, 9) && after[2].start === sat(7), after.slice(0, 3).map(line).join(' / '));
        suite.check('...nothing turns to Flex: the 6:00 and 6:30 shows both air', after[0].program.showTitle === 'A' && after[1].program.showTitle === 'B', '');
    }
    {
        // L, 44:00, in the 5:30 slot: still on at 6:00.
        const sched = daily();
        sched.slots.find( (s) => s.time === 5 * HOUR + 30 * MIN ).showId = 'tv.L';
        const back = await generate(pool(), withDays(sched, [ day() ]), NOW);
        const db = inside(back, FRI6, SAT6);
        const lOn = shows(back).find( (a) => (a.program.showTitle === 'L') && (a.start === fri(5, 30)) );
        suite.check('a program still on at the start finishes; Back to back\'s first row at the next half hour',
            Boolean(lOn) && db[0].start === fri(6, 30) && db[0].program.title === 'X S1E1', db.slice(0, 1).map(line).join(''));
        const rows = [ { showId: 'tv.X', order: 'next', at: 6 * HOUR }, { showId: 'tv.X', order: 'next', at: 7 * HOUR } ];
        const times = await generate(pool(), withDays(sched, [ day({ layout: 'times', slots: rows, to: { date: '2026-10-09', time: 8 * HOUR } }) ]), NOW);
        const dt = inside(times, FRI6, fri(8));
        suite.check('...Set times\' first row when it ends, on the 5-minute pad as any slot', dt[0].start === fri(6, 15) && dt[0].program.title === 'X S1E1', dt.slice(0, 1).map(line).join(''));
    }

    suite.log('-- Advance and Keep apart --');
    {
        const rows = [ { showId: 'tv.A', order: 'next' } ];
        const adv = await generate(pool(), withDays(daily(), [ day({ slots: rows }) ]), NOW);
        const apart = await generate(pool(), withDays(daily(), [ day({ slots: rows, positions: 'apart' }) ]), NOW);
        const lastBefore = shows(plain).filter( (a) => (a.program.showTitle === 'A') && (a.start < FRI6) ).pop().program.episode;
        const dayA = inside(adv, FRI6, SAT6);
        const afterAdv = titlesOf(adv, 'A', SAT6)[0];
        suite.check('Advance: the day continues A\'s regular position, and A after the day picks up where the day left it',
            dayA[0].program.episode === lastBefore + 1 && afterAdv === `A S1E${dayA[dayA.length - 1].program.episode + 1}`,
            `before E${lastBefore}; day E${dayA[0].program.episode}-E${dayA[dayA.length - 1].program.episode}; after ${afterAdv}`);
        const dayB = inside(apart, FRI6, SAT6);
        const firstAInPlain = inside(plain, FRI6, SAT6).find( (a) => a.program.showTitle === 'A' ).program.title;
        suite.check('Keep apart: the day plays A from its range\'s first episode, labelled with the day',
            dayB[0].program.title === 'A S1E1' && dayB.every( (a) => /\|@sd_test$/.test(a.program.slotPosition) ), dayB[0].program.slotPosition);
        suite.check('...and the regular A is untouched: after the day it airs the episode the day displaced',
            titlesOf(apart, 'A', SAT6)[0] === firstAInPlain, `${titlesOf(apart, 'A', SAT6)[0]} vs ${firstAInPlain}`);
        suite.check('...and every airing outside the day is the same as Advance\'s but for A',
            JSON.stringify(outside(apart, FRI6, SAT6).filter( (a) => a.program.showTitle !== 'A' ).map( (a) => [ a.start, a.program.title ] ))
                === JSON.stringify(outside(adv, FRI6, SAT6).filter( (a) => a.program.showTitle !== 'A' ).map( (a) => [ a.start, a.program.title ] )), '');
    }

    suite.log('-- kept rows and Repeat --');
    {
        const KEPT = Object.assign(episode('K', 1, 1, 22 * MIN), { kept: { edits: [ { id: 'e1', kind: 'swap', made: '2026-10-08T12:00:00.000Z' } ] } });
        const rows = [ item(SHORT_MOVIE), item(LONG_MOVIE), { showId: 'tv.X', order: 'next' } ];
        const res = await generate(pool(), withDays(daily(), [ day({ slots: rows }) ]), NOW, [ { at: fri(9), kept: true, program: KEPT } ]);
        const d = inside(res, FRI6, sat(0));
        const k = d.findIndex( (a) => a.program.title === 'K S1E1' );
        suite.check('a kept swap inside a Back to back day stays where it sits; the next row at the next half hour after it',
            k !== -1 && d[k].start === fri(9) && d[k + 1].start === fri(9, 30) && d[k + 1].program.title === 'X S1E1', d.slice(k, k + 2).map(line).join(' / '));
        suite.check('...the day\'s own airings carry no kept mark', d.filter( (a) => a.program.specialDay ).every( (a) => ! a.program.kept ), '');
    }
    {
        // Weekly: B at Thu 7pm, a Repeat of it Sat 7pm. The day covers Thu Oct 15 with B's rows.
        const sched = { period: WEEK, lateness: DAY, maxDays: 21, flexPreference: 'distribute', pad: 5 * MIN, slots: [
            { time: 19 * HOUR, showId: 'tv.B', order: 'next' },
            { time: 19 * HOUR + 30 * MIN, showId: 'flex.', order: 'next' },
            { time: 2 * DAY + 19 * HOUR, showId: 'tv.B', order: 'repeat', repeatOf: 19 * HOUR },
            { time: 2 * DAY + 19 * HOUR + 30 * MIN, showId: 'flex.', order: 'next' },
        ] };
        const sd = day({ from: { date: '2026-10-15', time: 6 * HOUR }, to: { date: '2026-10-16', time: 6 * HOUR }, slots: [ { showId: 'tv.B', order: 'next' } ] });
        const plainW = await generate(pool(), sched, NOW);
        const res = await generate(pool(), withDays(sched, [ sd ]), NOW);
        const satRepeat = (r) => shows(r).find( (a) => a.start === new Date(2026, 9, 17, 19).getTime() );
        suite.check('a Repeat whose source falls inside the day airs a Rerun of its show, not the day\'s airing',
            /^repeat/.test(satRepeat(plainW).program.slotPosition) && /^rerun/.test(satRepeat(res).program.slotPosition),
            `${satRepeat(plainW).program.slotPosition} -> ${satRepeat(res).program.slotPosition}`);
    }

    suite.log('-- the clocks --');
    {
        // Sat Oct 31, 2026 10pm to Sun Nov 1 6am: the clocks fall back at 2:00am CDT.
        const sd = day({ layout: 'times', from: { date: '2026-10-31', time: 22 * HOUR }, to: { date: '2026-11-01', time: 6 * HOUR }, slots: [
            { showId: 'tv.X', order: 'next', at: 22 * HOUR }, { showId: 'tv.Y', order: 'next', at: DAY + HOUR },
            { showId: 'tv.Z', order: 'next', at: DAY + HOUR + 30 * MIN }, { showId: 'tv.L', order: 'next', at: DAY + 2 * HOUR } ] });
        const res = await generate(pool(), withDays(daily(), [ sd ]), NOW);
        const from = Date.parse('2026-11-01T03:00:00Z');
        const to = Date.parse('2026-11-01T12:00:00Z');
        const d = inside(res, from, to);
        const firstOf = (show) => d.find( (a) => a.program.showTitle === show );
        const within = (show, a, b) => d.filter( (x) => x.program.showTitle === show ).every( (x) => (x.start >= Date.parse(a)) && (x.start < Date.parse(b)) );
        suite.check('the fall-back night inside a Set times day: each row once, at its first occurrence - 1:00am CDT, 1:30am CDT, 2:00am CST',
            firstOf('Y').start === Date.parse('2026-11-01T06:00:00Z') && firstOf('Z').start === Date.parse('2026-11-01T06:30:00Z')
                && firstOf('L').start === Date.parse('2026-11-01T08:00:00Z'),
            [ 'Y', 'Z', 'L' ].map( (s) => new Date(firstOf(s).start).toISOString() ).join(' '));
        suite.check('...no row airs again in the repeated hour: the 1:30 row runs on through it to 2:00am CST',
            within('Y', '2026-11-01T06:00:00Z', '2026-11-01T06:30:00Z') && within('Z', '2026-11-01T06:30:00Z', '2026-11-01T08:00:00Z')
                && within('L', '2026-11-01T08:00:00Z', '2026-11-01T12:00:00Z'), '');
    }
    return suite;
};
