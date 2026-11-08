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

async function generate(programs, schedule, now, pins, fillerPools, holidayItems) {
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(now); else super(...a); }
        static now() { return now; }
    }
    global.Date = FrozenDate;
    try {
        const args = [ JSON.parse(JSON.stringify(programs)), JSON.parse(JSON.stringify(schedule)), undefined ];
        if ( (typeof pins !== 'undefined') || (typeof fillerPools !== 'undefined') || (typeof holidayItems !== 'undefined') ) {
            args.push(typeof pins !== 'undefined' ? JSON.parse(JSON.stringify(pins)) : undefined);
        }
        if ( (typeof fillerPools !== 'undefined') || (typeof holidayItems !== 'undefined') ) {
            args.push(undefined);   // carry
            args.push(typeof fillerPools !== 'undefined' ? JSON.parse(JSON.stringify(fillerPools)) : undefined);
        }
        if (typeof holidayItems !== 'undefined') {
            args.push(JSON.parse(JSON.stringify(holidayItems)));
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

    suite.log('-- a row that runs until a time (row.until, Event tools) --');
    {
        // Ron's Marathon and a Movie: Lizzie (X) until 8:00pm, then the movie.
        const rows = [ { showId: 'tv.X', order: 'next', until: 20 * HOUR }, item(LONG_MOVIE) ];
        const res = await generate(pool(), withDays(daily(), [ day({ slots: rows }) ]), NOW);
        const d = inside(res, FRI6, SAT6);
        const before8 = d.filter( (a) => a.start < fri(20) );
        suite.check('until 8:00pm: the show airs on every half hour from 6:00am to 7:30pm, 28 goes',
            before8.length === 28 && before8.every( (a, k) => (a.program.showTitle === 'X') && (a.start === fri(6) + k * 30 * MIN) ),
            before8.slice(0, 3).map(line).join(' / ') + ' ... ' + before8.slice(-2).map(line).join(' / '));
        suite.check('...each go its own episode, in order', before8.every( (a, k) => a.program.title === `X S1E${k + 1}` ), '');
        const movieAt = d.find( (a) => a.program.title === 'The Long One' );
        suite.check('...the next row, the movie, starts at 8:00pm', (movieAt !== undefined) && (movieAt.start === fri(20)),
            movieAt ? line(movieAt) : 'no movie');
        const after = d.filter( (a) => a.start > fri(20) );
        suite.check('...after the movie (ends 9:35) the list starts again: past 8:00pm, the row plays a go at a time to the day\'s end',
            (after[0].start === fri(22)) && after.every( (a) => a.program.showTitle === 'X' ) && (after.length === 16)
                && (after[after.length - 1].start === sat(5, 30)) && (after[0].program.title === 'X S1E29'),
            after.slice(0, 2).map(line).join(' / ') + ` ... ${after.length} goes`);
        suite.check('...no Flex inside the day is 30 minutes or longer', longestFlex(res, FRI6, SAT6) < 30 * MIN,
            `${longestFlex(res, FRI6, SAT6) / MIN} min`);
        suite.check('...and outside the day every airing keeps its slot and its show', slotsOutside(res) === slotsOutside(plain), '');
        suite.check('...it is the same day as 28 rows of the show written out, then the movie',
            JSON.stringify(d.map(line)) === JSON.stringify(inside(await generate(pool(), withDays(daily(), [ day({ slots:
                Array.from({ length: 28 }, () => ({ showId: 'tv.X', order: 'next' })).concat([ item(LONG_MOVIE) ]) }) ]), NOW), FRI6, SAT6).map(line)), '');
    }
    {
        // A go that would not finish by the until time doesn't start: the time left is Flex.
        const rows = [ { showId: 'tv.X', order: 'next', until: 20 * HOUR + 15 * MIN }, item(LONG_MOVIE) ];
        const res = await generate(pool(), withDays(daily(), [ day({ slots: rows, rounding: 'quarter' }) ]), NOW);
        const d = inside(res, FRI6, SAT6);
        const lastX = d.filter( (a) => (a.program.showTitle === 'X') && (a.start < fri(20, 15)) ).pop();
        const movieAt = d.find( (a) => a.program.title === 'The Long One' );
        suite.check('until 8:15pm on a quarter-hour day: the last go is the one at 7:30pm (8:00 would end 8:22), the movie at 8:15pm',
            (lastX.start === fri(19, 30)) && (movieAt.start === fri(20, 15)), `${line(lastX)} / ${line(movieAt)}`);
        const flexBefore = withStarts(res).find( (a) => a.program.isOffline && (a.start >= fri(19, 52)) && (a.start < fri(20, 15)) );
        suite.check('...Flex from the last go\'s end to 8:15pm', (flexBefore !== undefined) && (flexBefore.start + flexBefore.program.duration === fri(20, 15)),
            flexBefore ? `${clock(flexBefore.start)} ${flexBefore.program.duration / MIN} min` : 'none');
    }
    {
        // An until between the day's marks (kept from a quarter-hour day): the run ends
        // at it, and the next row starts right there.
        const rows = [ { showId: 'tv.Y', order: 'next', until: 20 * HOUR + 15 * MIN }, item(LONG_MOVIE) ];
        const res = await generate(pool(), withDays(daily(), [ day({ slots: rows }) ]), NOW);
        const movieAt = inside(res, FRI6, SAT6).find( (a) => a.program.title === 'The Long One' );
        suite.check('an until of 8:15pm on a half-hour day: the next row starts at 8:15pm, not 8:30pm',
            movieAt.start === fri(20, 15), line(movieAt));
    }
    {
        // Until a time the rows before it have already passed: one go, like any row.
        const rows = [ item(LONG_MOVIE), { showId: 'tv.X', order: 'next', until: 7 * HOUR }, item(SHORT_MOVIE) ];
        const res = await generate(pool(), withDays(daily(), [ day({ slots: rows }) ]), NOW);
        const d = inside(res, FRI6, SAT6);
        suite.check('a row whose until time has passed when it comes up plays one go, and the next row follows',
            d[0].program.title === 'The Long One' && d[1].start === fri(8) && d[1].program.showTitle === 'X'
                && d[2].start === fri(8, 30) && d[2].program.title === 'The Short One', d.slice(0, 3).map(line).join(' / '));
    }
    {
        // Set times rows run to the next row's time already; an until there changes nothing.
        const set = (until) => day({ layout: 'times', slots: [ Object.assign({ showId: 'tv.X', order: 'next', at: 6 * HOUR }, until),
            { showId: 'tv.A', order: 'next', at: 12 * HOUR } ] });
        const without = await generate(pool(), withDays(daily(), [ set({}) ]), NOW);
        const withUntil = await generate(pool(), withDays(daily(), [ set({ until: 9 * HOUR }) ]), NOW);
        suite.check('on a Set times day an until changes nothing', JSON.stringify(without) === JSON.stringify(withUntil), '');
    }

    suite.log('-- Fill long breaks with (day.fillBreaksWith) --');
    {
        // The Back to back fixture above, unchanged: LONG_MOVIE (95:00) from 7:00 ends
        // 8:35, 25:00 short of X's own 9:00 row - over the 10-minute threshold, so Z's
        // shorts (7:00 each) fill it first: 3 fit (21:00), a 4:00 break closes the rest.
        const rows = [ item(SHORT_MOVIE), item(LONG_MOVIE), { showId: 'tv.X', order: 'next' } ];
        const res = await generate(pool(), withDays(daily(), [ day({ slots: rows, fillBreaksWith: 'tv.Z' }) ]), NOW);
        const d = withStarts(res).filter( (a) => (a.start >= fri(7)) && (a.start <= fri(9)) );
        const zs = d.filter( (a) => a.program.showTitle === 'Z' );
        const x = d.find( (a) => a.program.title === 'X S1E1' );
        const brk = x ? d[d.indexOf(x) - 1] : undefined;
        suite.check('a long break after the movie fills with Z\'s shorts first',
            (zs.length === 3) && (zs[0].start === fri(8, 35)) && zs.every( (a) => a.program.duration === 7 * MIN )
                && zs.every( (a) => a.program.specialDay === 'sd_test' ),
            d.slice(0, 4).map(line).join(' / '));
        suite.check('...then a break of what is left, not the whole 25 minutes',
            brk && brk.program.isOffline && (brk.program.duration === 4 * MIN), brk ? `${brk.program.duration / MIN} min` : 'none');
        suite.check('...and X\'s own row still starts right on its 9:00 mark',
            x && (x.start === fri(9)), x ? clock(x.start) : 'not found');
    }
    {
        // Off by default: the same fixture with no fillBreaksWith is the existing Back
        // to back proof above - one plain 25:00 Flex, nothing of Z's in it.
        const rows = [ item(SHORT_MOVIE), item(LONG_MOVIE), { showId: 'tv.X', order: 'next' } ];
        const res = await generate(pool(), withDays(daily(), [ day({ slots: rows }) ]), NOW);
        const d = withStarts(res).filter( (a) => (a.start >= fri(7)) && (a.start <= fri(9)) );
        suite.check('off by default: nothing fills the break',
            ! d.some( (a) => a.program.showTitle === 'Z' ) && (longestFlex(res, fri(7), fri(9)) === 25 * MIN), d.map(line).join(' / '));
    }
    {
        // The break as it airs, not as the pad rounds it (step 7, Nov 5): 76:28 from 7:00
        // (Batman: Mask of the Phantasm's length) ends 8:16:28 and pads to 8:20 - exactly
        // 10:00 left after the pad, but 13:32 of break on air before X's 8:30 row. Over
        // 10 minutes as it airs, so a Z short (7:00) fills it: the movie's own 3:32 pad,
        // Z from 8:20, a 3:00 break, X right on 8:30.
        const PHANTASM = movie('Seventy Six Twenty Eight', 76 * MIN + 28 * SEC, 5);
        const rows = [ item(PHANTASM), { showId: 'tv.X', order: 'next' } ];
        const res = await generate(pool(), withDays(daily(), [ day({ from: { date: '2026-10-09', time: 7 * HOUR }, slots: rows, fillBreaksWith: 'tv.Z' }) ]), NOW);
        const d = withStarts(res).filter( (a) => (a.start >= fri(7)) && (a.start <= fri(8, 30)) );
        const zs = d.filter( (a) => a.program.showTitle === 'Z' );
        const x = d.find( (a) => a.program.title === 'X S1E1' );
        suite.check('a break of 13:32 on air is long, though the movie\'s pad leaves exactly 10:00: a Z short fills it',
            (zs.length === 1) && (zs[0].start === fri(8, 20)), d.map( (a) => a.program.isOffline ? `${clock(a.start)} Flex ${a.program.duration / SEC}s` : line(a) ).join(' / '));
        suite.check('...and X\'s row still starts right on 8:30', x && (x.start === fri(8, 30)), x ? clock(x.start) : 'not found');
    }
    {
        // Under the threshold: 22:00 from 6:00 ends 6:22, 8:00 short of 6:30 - a long
        // break's source is never used on a break this short.
        const SHORT_GAP = movie('Just Under Ten', 22 * MIN, 7);
        const res = await generate(pool(), withDays(daily(), [ day({ slots: [ item(SHORT_GAP), { showId: 'tv.X', order: 'next' } ], fillBreaksWith: 'tv.Z' }) ]), NOW);
        const d = inside(res, FRI6, fri(6, 30));
        suite.check('a break of 10 minutes or less is not "long": the fill source is left alone',
            ! d.some( (a) => a.program.showTitle === 'Z' ), d.map(line).join(' / '));
    }
    {
        // A filler list: fillerPools passed in, as the server reads its own filler
        // store (src/api.js) or progress-check.js reads <data>/filler. The 47:00 movie
        // at 6:00 leaves 13:00 on air before 7:00 (10:00 after its pad): Bumper One
        // fills it. Then two 10:00 clips fit the 25:00 gap after the 95:00 one, the
        // round robin carrying on - Bumper Two, Bumper One - a 5:00 break closing out the rest.
        const clip = (title, duration) => ({ title, duration, isOffline: false, type: 'movie', key: '/c/' + title, serverKey: 'srv' });
        const pools = { fc_test: [ clip('Bumper One', 10 * MIN), clip('Bumper Two', 10 * MIN) ] };
        const rows = [ item(SHORT_MOVIE), item(LONG_MOVIE), { showId: 'tv.X', order: 'next' } ];
        const res = await generate(pool(), withDays(daily(), [ day({ slots: rows, fillBreaksWith: 'filler:fc_test' }) ]), NOW, undefined, pools);
        const first = withStarts(res).filter( (a) => (a.start >= fri(6)) && (a.start < fri(7)) && /^Bumper/.test(a.program.title) );
        const d = withStarts(res).filter( (a) => (a.start >= fri(7)) && (a.start <= fri(9)) );
        const bumpers = d.filter( (a) => /^Bumper/.test(a.program.title) );
        const x = d.find( (a) => a.program.title === 'X S1E1' );
        const brk = x ? d[d.indexOf(x) - 1] : undefined;
        suite.check('a filler list\'s own clips fill a long break the same way, round robin across the day\'s breaks',
            (first.length === 1) && (first[0].program.title === 'Bumper One') && (first[0].start === fri(6, 50))
                && (bumpers.length === 2) && (bumpers[0].program.title === 'Bumper Two') && (bumpers[1].program.title === 'Bumper One')
                && bumpers.every( (a) => a.program.specialDay === 'sd_test' ),
            first.concat(bumpers).map( (a) => `${clock(a.start)} ${a.program.title}` ).join(','));
        suite.check('...then a break of what is left, and the next row still right on its mark',
            brk && brk.program.isOffline && (brk.program.duration === 5 * MIN) && x && (x.start === fri(9)),
            `${brk ? brk.program.duration / MIN : '?'} min, X at ${x ? clock(x.start) : '?'}`);
    }
    {
        // Ron, Nov 5: filling a break must never move the regular channel's own
        // position for that show. A is one of daily()'s own regular slots, never
        // named by the day's rows, so the day itself already displaces A's 12
        // regular occurrences for its 24 hours either way (NOTES.md, "the shows
        // it displaces carry on") - comparing against a day with no fill at all
        // (same displacement) isolates just the fill, not the day's own effect.
        const rows = [ item(SHORT_MOVIE), item(LONG_MOVIE), { showId: 'tv.X', order: 'next' } ];
        const filled = await generate(pool(), withDays(daily(), [ day({ slots: rows, fillBreaksWith: 'tv.A' }) ]), NOW);
        const unfilled = await generate(pool(), withDays(daily(), [ day({ slots: rows }) ]), NOW);
        const d = withStarts(filled).filter( (a) => (a.start >= fri(7)) && (a.start <= fri(9)) );
        const as = d.filter( (a) => a.program.showTitle === 'A' );
        const filledA = titlesOf(filled, 'A', SAT6);
        const unfilledA = titlesOf(unfilled, 'A', SAT6);
        suite.check('filling a break with A does use A\'s shorts',
            as.length > 0, as.map( (a) => a.program.title ).join(','));
        suite.check('...but A\'s own regular rotation after the day is exactly as it would be with no fill at all',
            JSON.stringify(filledA) === JSON.stringify(unfilledA), `${filledA.slice(0, 3)} vs ${unfilledA.slice(0, 3)}`);
    }

    suite.log('-- Create Lineup again, from a lineup that already holds the day --');
    {
        // Step 7, Nov 5: the dialog's pool is the channel's own programs, first copy of
        // each episode kept - and once a day is laid, the first copy of an episode the
        // day aired first is the day's own, carrying specialDay/specialRow. A second run
        // made that copy the episode every regular slot played: on the real copy, 25
        // regular airings from March to May 2027 marked as rows of the New Year's day.
        const rows = [ { showId: 'tv.A', order: 'next' }, { showId: 'tv.B', order: 'next' } ];
        const sched = withDays(daily(), [ day({ slots: rows }) ]);
        const first = await generate(pool(), sched, NOW);
        const again = await generate(first.programs.concat(pool()), sched, NOW);
        const leaked = (res) => withStarts(res).filter( (a) => (typeof(a.program.specialDay) !== 'undefined')
            && ( (a.start < FRI6) || (a.start >= SAT6 + HOUR) ) );
        const insideAgain = inside(again, FRI6, SAT6);
        suite.check('a second run from the first one\'s lineup marks no airing outside the day as the day\'s',
            leaked(first).length === 0 && leaked(again).length === 0,
            leaked(again).slice(0, 3).map( (a) => `${clock(a.start)} ${a.program.title} row ${a.program.specialRow}` ).join(' / '));
        suite.check('...and inside the day every airing still carries the day and its row',
            insideAgain.length > 0 && insideAgain.every( (a) => (a.program.specialDay === 'sd_test') && (typeof(a.program.specialRow) === 'number') ), '');
        suite.check('...the same day, airing for airing, as the first run laid it',
            JSON.stringify(inside(first, FRI6, SAT6).map(line)) === JSON.stringify(insideAgain.map(line)), '');
    }

    suite.log('-- holiday rows --');
    {
        // Fri 6:00-9:00, A's half-hour slots displaced: six 22:00 rows of A, the first
        // three its set-aside Christmas episodes (in no pool), then A's regular ones.
        const xmas = (n) => Object.assign( episode('A', 0, n), { title: `A Christmas ${n}`, key: `/e/A/xmas/${n}` } );
        const aside = [ xmas(2), xmas(1), xmas(3) ];
        const hday = (extra) => day(Object.assign({ holiday: 'Christmas', to: { date: '2026-10-09', time: 9 * HOUR },
            slots: [ { showId: 'tv.A', order: 'next', holidayOnly: true } ] }, extra || {}));
        const items = { sd_test: { 'tv.A': aside } };
        const res = await generate(pool(), withDays(daily(), [ hday() ]), NOW, undefined, undefined, items);
        const d = inside(res, FRI6, fri(9));
        const firstRegular = inside(plain, FRI6, SAT6).find( (a) => a.program.showTitle === 'A' ).program.episode;
        suite.check('a holiday row plays its show\'s set-aside episodes first, in order, then its regular episodes',
            d.length === 6 && d.slice(0, 3).map( (a) => a.program.title ).join(', ') === 'A Christmas 1, A Christmas 2, A Christmas 3'
                && d.slice(3).every( (a, k) => a.program.title === `A S1E${firstRegular + k}` ), d.map(line).join(' / '));
        suite.check('...every airing carries the day, and the holiday ones their own position, not the regular one\'s',
            d.every( (a) => a.program.specialDay === 'sd_test' ) && d.slice(0, 3).every( (a) => /\|@holiday:sd_test$/.test(a.program.slotPosition) )
                && d.slice(3).every( (a) => a.program.slotPosition === 'next|' ), d.map( (a) => a.program.slotPosition ).join(' / '));
        const firstAfter = (r) => shows(r).find( (a) => (a.start >= fri(9)) && (a.program.showTitle === 'A') ).program.title;
        const after = firstAfter(res);
        const control = await generate(pool(), withDays(daily(), [ day({ to: { date: '2026-10-09', time: 9 * HOUR }, slots: [ { showId: 'tv.A', order: 'next' } ] }) ]), NOW);
        const controlAfter = firstAfter(control);
        suite.check('...and the regular A moves only by what it really aired: 3 regular episodes, where the plain row (6) moves it 6',
            after === `A S1E${firstRegular + 3}` && controlAfter === `A S1E${firstRegular + 6}`, `${after} / ${controlAfter}`);
        suite.check('...a holidayOnly row of a day with no holiday, or with nothing set aside, plays regular',
            inside(await generate(pool(), withDays(daily(), [ hday({ holiday: null }) ]), NOW, undefined, undefined, items), FRI6, fri(9)).every( (a) => /^A S1E/.test(a.program.title) )
                && inside(await generate(pool(), withDays(daily(), [ hday() ]), NOW, undefined, undefined, {}), FRI6, fri(9)).every( (a) => /^A S1E/.test(a.program.title) ), '');

        // Shuffled: each set-aside episode once, in some order, then regular.
        const shuf = await generate(pool(), withDays(daily(), [ hday({ slots: [ { showId: 'tv.A', order: 'shuffle', holidayOnly: true } ] }) ]), NOW, undefined, undefined, items);
        const ds = inside(shuf, FRI6, fri(9));
        suite.check('a shuffled holiday row plays each set-aside episode once, then regular ones',
            ds.slice(0, 3).map( (a) => a.program.title ).sort().join(', ') === 'A Christmas 1, A Christmas 2, A Christmas 3'
                && ds.slice(3).every( (a) => /^A S1E/.test(a.program.title) ), ds.map( (a) => a.program.title ).join(' / '));

        // Keep apart: the regular rows stay on the day's own position, the holiday's on its own.
        const apart = await generate(pool(), withDays(daily(), [ hday({ positions: 'apart', slots: [ { showId: 'tv.A', order: 'next', holidayOnly: true } ] }) ]), NOW, undefined, undefined, items);
        const da = inside(apart, FRI6, fri(9));
        suite.check('on a Keep-apart day too: the holiday episodes, then the day\'s own A from its first episode',
            da.slice(0, 3).every( (a) => /^A Christmas/.test(a.program.title) ) && da[3].program.title === 'A S1E1' && da[4].program.title === 'A S1E2', da.map( (a) => a.program.title ).join(' / '));

        // Two rows of the same show share the holiday episodes.
        const two = await generate(pool(), withDays(daily(), [ hday({ slots: [ { showId: 'tv.A', order: 'next', holidayOnly: true }, { showId: 'tv.B', order: 'next' }, { showId: 'tv.A', order: 'next', holidayOnly: true } ] }) ]), NOW, undefined, undefined, items);
        const dt = inside(two, FRI6, fri(9)).map( (a) => a.program.title );
        suite.check('rows of one show share its set-aside episodes, each aired once in the day',
            dt.filter( (t) => /^A Christmas/.test(t) ).sort().join(',') === 'A Christmas 1,A Christmas 2,A Christmas 3', dt.join(' / '));
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
        const after = withStarts(res).filter( (a) => a.start >= SAT6 - MIN );
        const brk = after.find( (a) => a.program.isOffline );
        const programs = after.filter( (a) => ! a.program.isOffline );
        suite.check('the last row runs 14:09 past the end: a break holds it to the next half hour (the day\'s own mark) - 6:14:09 to 6:30 - which lands exactly on B\'s slot, so A\'s 6:00 slot is skipped rather than run late',
            brk && (brk.start === sat(6, 14, 9)) && (brk.program.duration === 15 * MIN + 51 * SEC)
                && (programs[0].start === sat(6, 30)) && (programs[0].program.showTitle === 'B'),
            after.slice(0, 2).map( (a) => a.program.isOffline ? `${clock(a.start)} Flex ${a.program.duration / 1000}s` : line(a) ).join(' / '));
    }
    {
        // Same overrun, the day set to the quarter hour: 6:15 isn't on the half-hour
        // slot grid, so the break is short (just long enough for a sign-off and a
        // sign-on) and the slot it lands in - A, from 6:00 - runs late and catches
        // up, exactly as after a swap set to run late.
        const OVER = movie('Runs Over', 44 * MIN + 9 * SEC, 6);
        const rows = [];
        for (let k = 0; k < 47; k++) {
            rows.push({ showId: 'tv.X', order: 'next', at: 6 * HOUR + k * 30 * MIN });
        }
        rows.push(Object.assign(item(OVER), { at: DAY + 5 * HOUR + 30 * MIN }));
        const res = await generate(pool(), withDays(daily(), [ day({ layout: 'times', slots: rows, rounding: 'quarter' }) ]), NOW);
        const after = withStarts(res).filter( (a) => a.start >= SAT6 - MIN );
        const brk = after.find( (a) => a.program.isOffline );
        const programs = after.filter( (a) => ! a.program.isOffline );
        suite.check('...on the quarter hour: the break is only to 6:15 (51s); A then runs 15:00 late, back on time by 7:00',
            brk && (brk.start === sat(6, 14, 9)) && (brk.program.duration === 51 * SEC)
                && (programs[0].start === sat(6, 15)) && (programs[0].program.showTitle === 'A')
                && (programs[1].start === sat(6, 37)) && (programs[1].program.showTitle === 'B')
                && (programs[2].start === sat(7)) && (programs[2].program.showTitle === 'C'),
            after.slice(0, 5).map( (a) => a.program.isOffline ? `${clock(a.start)} Flex ${a.program.duration / 1000}s` : line(a) ).join(' / '));
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
