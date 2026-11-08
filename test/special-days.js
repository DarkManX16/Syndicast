/*
 * src/special-days.js: a date's own Time Slots - the window, which day covers
 * a moment, the back to back rounding, what stops a day, Fill from a block,
 * the Keep-apart tag - and slotProgress.slotAt inside a day. In the machine's
 * zone (America/Chicago), as every slot test is. See NOTES.md, Known issues,
 * "Special days".
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const sd = require('../src/special-days');
const slotProgress = require('../src/slot-progress');

const SEC = 1000;
const WEEK = 7 * DAY;
const local = (y, mo, d, h, m, s) => new Date(y, mo - 1, d, h || 0, m || 0, s || 0).getTime();
const iso = (t) => new Date(t).toISOString();

// A weekly slot's time: day 0 is a Thursday; calendar days count from Sunday.
const slotTime = (calendarDay, h, m) => ( (calendarDay + 3) % 7 ) * DAY + h * HOUR + (m || 0) * MIN;

const TOONAMI = [
    [ 1, [ 'tv.Ronin Warriors', 'tv.Sailor Moon', 'tv.Dragon Ball', 'tv.Dragon Ball Z' ] ],
    [ 2, [ 'custom.voltron', 'tv.The Transformers', 'tv.The Big O', 'custom.gundam' ] ],
    [ 3, [ 'custom.gi-joe', 'tv.Transformers: Robots In Disguise', 'tv.Batman Beyond', 'tv.He-Man and the Masters of the Universe (2002)' ] ],
    [ 5, [ 'tv.X-Men: Evolution', 'tv.Justice League', 'tv.Superman: The Animated Series', 'custom.batman' ] ],
];

// Channel 1's week, cut down: Toonami's 16, a show either side of each afternoon,
// the Midnight Run, and Flex overnight Thursday.
function channel() {
    let slots = [];
    TOONAMI.forEach( ([ day, shows ]) => {
        slots.push({ time: slotTime(day, 14, 30), showId: 'tv.Jackie Chan Adventures', order: 'next' });
        shows.forEach( (show, k) => slots.push({ time: slotTime(day, 15, 30 * k), showId: show, order: 'next' }) );
        slots.push({ time: slotTime(day, 17), showId: 'tv.I Am Weasel', order: 'next' });
    } );
    slots.push({ time: slotTime(6, 1), showId: 'tv.Dragon Ball Z', order: 'next' });
    slots.push({ time: slotTime(6, 1, 30), showId: 'custom.gundam', order: 'repeat', repeatOf: slotTime(2, 16, 30) });
    slots.push({ time: slotTime(6, 2), showId: 'tv.Sailor Moon', order: 'shuffle', seasons: { excludeSeasons: [ 2 ] } });
    slots.push({ time: slotTime(6, 3), showId: 'tv.Toonheads', order: 'next' });
    slots.push({ time: slotTime(4, 0), showId: 'flex.', order: 'next' });
    return {
        blocks: [
            { id: 'bl_toonami', name: 'Toonami', airings: [ { days: [ 1, 2, 3, 5 ], start: 15 * HOUR, end: 17 * HOUR } ] },
            { id: 'bl_midnight', name: 'Toonami Midnight Run', airings: [ { days: [ 6 ], start: 1 * HOUR, end: 3 * HOUR } ] },
            { id: 'bl_late', name: 'Late', airings: [ { days: [ 5 ], start: 23 * HOUR + 30 * MIN, end: 2 * HOUR + 30 * MIN } ] },
        ],
        schedule: { period: WEEK, lateness: DAY, pad: 5 * MIN, maxDays: 365, slots: slots },
    };
}

function newYears(extra) {
    return Object.assign({
        id: 'sd_ny', name: "New Year's Toonami Marathon",
        from: { date: '2027-01-01', time: 6 * HOUR }, to: { date: '2027-01-02', time: 6 * HOUR },
        blockId: 'bl_toonami', positions: 'advance', layout: 'back',
        slots: [ { showId: 'tv.Ronin Warriors', order: 'next' } ],
    }, extra || {});
}

const texts = (schedule, blocks) => sd.problems(schedule, blocks).map( (p) => p.text );

module.exports = async () => {
    const suite = new Suite('special-days');
    const ch = channel();

    // The window
    let w = sd.windowOf(newYears());
    suite.check("New Year's window: Fri Jan 1, 2027 12:00Z to Sat Jan 2 12:00Z",
        iso(w.from) === '2027-01-01T12:00:00.000Z' && iso(w.to) === '2027-01-02T12:00:00.000Z', `${iso(w.from)} ${iso(w.to)}`);
    suite.check('a day without a proper start or end has no window',
        sd.windowOf(newYears({ from: { date: '2027-02-31', time: 0 } })) === null
            && sd.windowOf(newYears({ to: { date: 'Jan 2', time: 0 } })) === null
            && sd.windowOf(newYears({ from: { date: '2027-01-01' } })) === null, '');

    // dayAt
    let sch = Object.assign( {}, ch.schedule, { specialDays: [ newYears() ] } );
    suite.check("dayAt: the window's first ms is the day's, its end is not",
        (sd.dayAt(sch, w.from) || {}).id === 'sd_ny' && sd.dayAt(sch, w.to) === null && sd.dayAt(sch, w.from - 1) === null
            && (sd.dayAt(sch, w.to - 1) || {}).id === 'sd_ny', '');
    suite.check('an aired day still answers by instant, and is aired',
        (sd.dayAt(sch, w.from + HOUR) || {}).id === 'sd_ny' && sd.aired(newYears(), w.to) && ! sd.aired(newYears(), w.to - 1), '');
    let pair = Object.assign( {}, ch.schedule, { specialDays: [
        newYears(), newYears({ id: 'sd_eve', name: 'Late show', from: { date: '2027-01-01', time: 20 * HOUR }, to: { date: '2027-01-02', time: 8 * HOUR } }) ] } );
    suite.check('two days overlapping: a problem, and dayAt takes the first declared',
        texts(pair, ch.blocks).indexOf("Overlaps New Year's Toonami Marathon.") !== -1
            && sd.dayAt(pair, local(2027, 1, 2, 7)).id === 'sd_eve' && sd.dayAt(pair, local(2027, 1, 1, 21)).id === 'sd_ny',
        JSON.stringify(texts(pair, ch.blocks)));
    suite.check('ahead: only days not yet ended, in the order they start',
        JSON.stringify(sd.ahead(pair, w.from).map( (d) => d.id )) === '["sd_ny","sd_eve"]'
            && JSON.stringify(sd.ahead(pair, w.to).map( (d) => d.id )) === '["sd_eve"]'
            && sd.ahead(pair, local(2027, 1, 2, 8)).length === 0, '');

    // nextHalfHour
    let t7 = local(2027, 1, 1, 7);
    suite.check('nextHalfHour: 6:47:00 goes to 7:00:00, 8:35:00 to 9:00:00',
        sd.nextHalfHour(local(2027, 1, 1, 6, 47)) === t7 && sd.nextHalfHour(local(2027, 1, 1, 8, 35)) === local(2027, 1, 1, 9), '');
    suite.check('...7:00:05 counts as on the hour; 7:00:10.5 goes to 7:30:00; 7:00:00 stays',
        sd.nextHalfHour(t7 + 5 * SEC) === t7 + 5 * SEC && sd.nextHalfHour(t7 + 10.5 * SEC) === local(2027, 1, 1, 7, 30)
            && sd.nextHalfHour(t7) === t7, '');
    suite.check('...on Nov 7, 2027, 1:47am CDT goes to 1:00am CST (07:00Z), the next :00 in real time',
        iso(sd.nextHalfHour(Date.parse('2027-11-07T06:47:00Z'))) === '2027-11-07T07:00:00.000Z', '');
    suite.check('...on Mar 14, 2027, 1:47am CST goes to 3:00am CDT (08:00Z)',
        iso(sd.nextHalfHour(Date.parse('2027-03-14T07:47:00Z'))) === '2027-03-14T08:00:00.000Z', '');

    // rowTimes and the clock changes
    let spring = { id: 'sd_spring', name: 'Spring', layout: 'times', from: { date: '2027-03-13', time: 22 * HOUR }, to: { date: '2027-03-14', time: 6 * HOUR },
        slots: [ { showId: 'tv.A', at: 22 * HOUR }, { showId: 'tv.B', at: DAY + 2 * HOUR + 30 * MIN } ] };
    suite.check("rowTimes: a row at 2:30am on Mar 14, 2027 is a problem: \"2:30am doesn't happen that night.\"",
        texts({ specialDays: [ spring ] }, []).indexOf("2:30am doesn't happen that night.") !== -1, JSON.stringify(texts({ specialDays: [ spring ] }, [])));
    let fall = { id: 'sd_fall', name: 'Fall', layout: 'times', from: { date: '2027-11-06', time: 22 * HOUR }, to: { date: '2027-11-07', time: 6 * HOUR },
        slots: [ { showId: 'tv.A', at: 22 * HOUR }, { showId: 'tv.B', at: DAY + HOUR + 30 * MIN } ] };
    let fallTimes = sd.rowTimes(fall);
    suite.check('...on Nov 7, 2027 a row at 1:30am is its first occurrence, 1:30am CDT (06:30Z)',
        iso(fallTimes[1].at) === '2027-11-07T06:30:00.000Z' && ! fallTimes[1].gap && texts({ specialDays: [ fall ] }, []).length === 0,
        iso(fallTimes[1].at));
    suite.check('...and a row past midnight belongs to the next date: Sat Jan 2 1:00am',
        sd.rowTimes(newYears({ layout: 'times', slots: [ { showId: 'tv.A', at: 6 * HOUR }, { showId: 'tv.B', at: DAY + HOUR } ] }))[1].at === local(2027, 1, 2, 1), '');

    // problems
    const one = (day) => texts({ specialDays: [ day ] }, ch.blocks);
    suite.check('problems: a well-made day has none', one(newYears()).length === 0, JSON.stringify(one(newYears())));
    suite.check('problems: no proper start or end', JSON.stringify(one(newYears({ to: null }))) === '["Needs a start and an end."]', '');
    suite.check('problems: ends before it starts', JSON.stringify(one(newYears({ to: { date: '2027-01-01', time: 5 * HOUR } }))) === '["Ends before it starts."]', '');
    suite.check('problems: longer than a week', JSON.stringify(one(newYears({ to: { date: '2027-01-09', time: 7 * HOUR } }))) === '["Longer than a week."]', '');
    suite.check('problems: its block is gone', JSON.stringify(one(newYears({ blockId: 'bl_gone' }))) === '["Its block is gone."]', '');
    suite.check('problems: no rows', JSON.stringify(one(newYears({ slots: [] }))) === '["Has no rows."]', '');
    suite.check('problems: a This item row with nothing picked',
        JSON.stringify(one(newYears({ slots: [ { showId: 'custom.movies', item: null } ] }))) === '["A row has no item picked."]', '');
    let timesDay = (rows) => newYears({ layout: 'times', slots: rows });
    suite.check('problems: Set times, the first row must be at the start',
        JSON.stringify(one(timesDay([ { showId: 'tv.A', at: 6 * HOUR + 30 * MIN } ]))) === '["The first row must be at 6:00am."]', '');
    suite.check('problems: Set times, two rows at one time',
        JSON.stringify(one(timesDay([ { showId: 'tv.A', at: 6 * HOUR }, { showId: 'tv.B', at: 7 * HOUR }, { showId: 'tv.C', at: 7 * HOUR } ]))) === '["Two rows at 7:00am."]', '');
    suite.check('problems: Set times, a row outside the day',
        JSON.stringify(one(timesDay([ { showId: 'tv.A', at: 6 * HOUR }, { showId: 'tv.B', at: DAY + 7 * HOUR } ]))) === '["A row at 7:00am is outside the day."]', '');
    suite.check('problems: Set times, a row with no time',
        JSON.stringify(one(timesDay([ { showId: 'tv.A', at: 6 * HOUR }, { showId: 'tv.B' } ]))) === '["A row has no time."]', '');
    suite.check('problems: Back to back rows need no time', one(newYears({ slots: [ { showId: 'tv.A' }, { showId: 'tv.B' } ] })).length === 0, '');
    {
        const backDay = (until, extra) => Object.assign(newYears({ blockId: null, layout: 'back', slots: [ { showId: 'tv.X', order: 'next', until: until } ] }), extra || {});
        const w = sd.windowOf(backDay(0));
        const offset = (t) => t - (w.from - backDay(0).from.time);   // ms after from.date's midnight
        suite.check('problems: an until inside the day is fine', texts({ specialDays: [ backDay(offset(w.from) + 14 * HOUR) ] }).length === 0,
            texts({ specialDays: [ backDay(offset(w.from) + 14 * HOUR) ] }).join(' / '));
        suite.check('problems: an until at or before the day starts is named, at its row',
            texts({ specialDays: [ backDay(offset(w.from)) ] }).join() === 'A row runs until a time outside the day.'
                && sd.problems({ specialDays: [ backDay(offset(w.from)) ] })[0].field === 'rows');
        suite.check('problems: an until after the day ends is named', texts({ specialDays: [ backDay(offset(w.to) + 30 * MIN) ] }).join() === 'A row runs until a time outside the day.');
        suite.check('problems: an until right at the end of the day is fine', texts({ specialDays: [ backDay(offset(w.to)) ] }).length === 0);
        suite.check('problems: a Set times day ignores until', texts({ specialDays: [ backDay(offset(w.to) + HOUR, { layout: 'times',
            slots: [ { showId: 'tv.X', order: 'next', at: newYears().from.time, until: 99 * HOUR } ] }) ] }).length === 0);
        suite.check('untilAt: the instant of a Back to back row until, null without one or on a Set times day',
            sd.untilAt(backDay(offset(w.from) + HOUR), backDay(offset(w.from) + HOUR).slots[0]) === w.from + HOUR
                && sd.untilAt(backDay(0), { showId: 'tv.X' }) === null
                && sd.untilAt(Object.assign(backDay(0), { layout: 'times' }), { showId: 'tv.X', until: HOUR }) === null
                && sd.untilAt(backDay(0), { showId: 'movie.', item: { program: {} }, until: HOUR }) === null);
    }
    suite.check('problems: each names its field', JSON.stringify(sd.problems({ specialDays: [ newYears({ blockId: 'bl_gone', slots: [] }) ] }, ch.blocks)
        .map( (p) => [ p.dayId, p.field ] )) === '[["sd_ny","block"],["sd_ny","rows"]]', '');

    // fillFromBlock
    let rows = sd.fillFromBlock({ block: ch.blocks[0], schedule: ch.schedule });
    let expected = [].concat.apply([], TOONAMI.map( (x) => x[1] ));
    suite.check("fillFromBlock: Toonami's 16 rows, Mon, Tue, Wed, Fri, in time order",
        JSON.stringify(rows.map( (r) => r.showId )) === JSON.stringify(expected), rows.map( (r) => r.showId ).join(', '));
    suite.check('...each Play Next, half an hour long, and nothing else carried over',
        rows.every( (r) => (r.order === 'next') && (r.length === 30 * MIN) && (Object.keys(r).sort().join() === 'length,order,showId') ), JSON.stringify(rows[0]));
    let midnight = sd.fillFromBlock({ block: ch.blocks[1], schedule: ch.schedule });
    suite.check('...the Midnight Run: a Repeat becomes a Rerun of its show, seasons are copied',
        JSON.stringify(midnight.map( (r) => [ r.showId, r.order ] )) === '[["tv.Dragon Ball Z","next"],["custom.gundam","rerun"],["tv.Sailor Moon","shuffle"]]'
            && JSON.stringify(midnight[2].seasons) === '{"excludeSeasons":[2]}' && (midnight[2].length === HOUR), JSON.stringify(midnight));
    let late = sd.fillFromBlock({ block: ch.blocks[2], schedule: Object.assign( {}, ch.schedule, { slots: ch.schedule.slots.concat( [
        { time: slotTime(5, 23, 30), showId: 'tv.Late A', order: 'next' }, { time: slotTime(6, 0), showId: 'tv.Late B', order: 'next' } ] ) } ) });
    suite.check('...an airing across midnight: Friday 11:30pm first, then Saturday\'s rows until 2:30am, Flex left out',
        JSON.stringify(late.map( (r) => r.showId )) === '["tv.Late A","tv.Late B","tv.Dragon Ball Z","custom.gundam","tv.Sailor Moon"]'
            && JSON.stringify(late[4].seasons) === '{"excludeSeasons":[2]}' && late[4].order === 'shuffle', JSON.stringify(late.map( (r) => r.showId )));
    let filled = sd.fillTimes(newYears({ layout: 'times' }), rows);
    suite.check('fillTimes: 16 half-hour rows fill 6:00am to 6:00am three times over - 48 rows, the last at 5:30am',
        (filled.length === 48) && (filled[0].at === 6 * HOUR) && (filled[47].at === DAY + 5 * HOUR + 30 * MIN)
            && (filled[16].showId === 'tv.Ronin Warriors') && filled.every( (r) => typeof(r.length) === 'undefined' )
            && one(newYears({ layout: 'times', slots: filled })).length === 0, `${filled.length}`);
    const film = { showId: 'movie.', item: { program: { type: 'movie', title: 'Film', duration: 90 * MIN, key: '/m/f', serverKey: 'srv' } }, length: 2 * HOUR };
    let withFilm = sd.fillTimes(newYears({ layout: 'times' }), [ film ].concat(rows));
    suite.check('fillTimes: a picked item is in the first round only - it airs once a day',
        withFilm.filter( (r) => r.item ).length === 1 && withFilm[1].at === 8 * HOUR && withFilm[withFilm.length - 1].showId !== 'movie.', `${withFilm.length} rows`);

    // Where Back to back rows start
    suite.check('the quarter hour: 12:35am goes to 12:45am, 12:30am stays; the half hour takes 12:35am to 1:00am',
        sd.nextMark(local(2027, 1, 2, 0, 35), 15 * MIN) === local(2027, 1, 2, 0, 45) && sd.nextMark(local(2027, 1, 2, 0, 30), 15 * MIN) === local(2027, 1, 2, 0, 30)
            && sd.nextMark(local(2027, 1, 2, 0, 35), sd.stepOf(newYears())) === local(2027, 1, 2, 1), '');
    suite.check('...a day says which: half by default, quarter when chosen, anything else a problem',
        sd.stepOf(newYears()) === 30 * MIN && sd.stepOf(newYears({ rounding: 'quarter' })) === 15 * MIN
            && JSON.stringify(one(newYears({ rounding: 'tenth' }))) === '["Rows start on the half hour or the quarter hour."]', '');

    // The tag
    let key = slotProgress.positionKey('tv.X-Men: Evolution', 'next', undefined);
    suite.check('the Keep-apart tag: on a key and a label, and read back from either',
        sd.taggedKey(key, 'sd_ny') === '["tv.X-Men: Evolution","next",[],"@sd_ny"]'
            && sd.taggedLabel('next|', 'sd_ny') === 'next||@sd_ny' && sd.taggedLabel('shuffle|2|3', 'sd_ny') === 'shuffle|2|3|@sd_ny'
            && sd.tagOf('next||@sd_ny') === 'sd_ny' && sd.tagOf(sd.taggedKey(key, 'sd_ny')) === 'sd_ny', '');
    suite.check('...and nothing untagged reads as tagged', sd.tagOf('next|') === null && sd.tagOf(key) === null
        && sd.tagOf('repeat') === null && sd.tagOf(undefined) === null && sd.tagOf('[broken') === null, '');

    // slotAt
    let timed = newYears({ layout: 'times', slots: [ { showId: 'tv.A', at: 6 * HOUR }, { showId: 'tv.X-Men: Evolution', at: 15 * HOUR } ] });
    let withTimed = Object.assign( {}, ch.schedule, { specialDays: [ timed ] } );
    let at310 = slotProgress.slotAt(withTimed, local(2027, 1, 1, 15, 10));
    suite.check('slotAt: Jan 1 3:10pm in a Set times day is its row, marked with the day',
        at310.showId === 'tv.X-Men: Evolution' && at310.special === 'sd_ny' && at310.at === 15 * HOUR, JSON.stringify(at310));
    let finder = slotProgress.slotFinder(withTimed);
    suite.check('...the same object every time', finder(local(2027, 1, 1, 15, 10)) === finder(local(2027, 1, 1, 23)), '');
    let back = slotProgress.slotAt(Object.assign( {}, ch.schedule, { specialDays: [ newYears() ] } ), local(2027, 1, 1, 15, 10));
    suite.check('...in a Back to back day: the day, and no row (only the lineup knows its rows\' times)',
        back.special === 'sd_ny' && back.row === null, JSON.stringify(back));
    let plain = slotProgress.slotFinder(ch.schedule);
    let wrapped = slotProgress.slotFinder(withTimed);
    let same = true;
    for (let t = local(2026, 12, 27); t < local(2027, 1, 10); t += 7 * MIN) {
        let inside = (t >= w.from) && (t < w.to);
        if (! inside && (wrapped(t) !== plain(t)) ) {
            same = false;
        }
    }
    suite.check('...outside the day, the regular slot - the very same one - every 7 minutes for two weeks', same, '');
    let empty = Object.assign( {}, ch.schedule, { specialDays: [] } );
    let fri310 = ch.schedule.slots.find( (s) => s.time === slotTime(5, 15) );
    suite.check('...and a schedule with no special days, or an empty list, answers exactly as before',
        (plain(local(2027, 1, 1, 15, 10)) === fri310) && (slotProgress.slotAt(empty, local(2027, 1, 1, 15, 10)) === fri310), '');
    suite.check('...a day that can\'t be laid out answers as if it weren\'t there',
        slotProgress.slotAt(Object.assign( {}, ch.schedule, { specialDays: [ newYears({ to: { date: '2027-01-01', time: 0 } }) ] } ), local(2027, 1, 1, 15, 10))
            === slotProgress.slotAt(ch.schedule, local(2027, 1, 1, 15, 10)), '');

    // The save-time warning
    const ChannelDB = require('../src/dao/channel-db');
    const db = new ChannelDB('unused');
    const warnings = (scheduleBackup) => {
        const lines = [];
        const real = console.error;
        console.error = (...args) => lines.push(args.join(' '));
        try {
            db.validateChannelJson(1, { number: 1, blocks: ch.blocks, scheduleBackup: scheduleBackup });
        } finally {
            console.error = real;
        }
        return lines.filter( (l) => /special ?day/i.test(l) );
    };
    let bad = Object.assign( {}, ch.schedule, { specialDays: [ newYears({ blockId: 'bl_gone' }) ] } );
    let saved = JSON.stringify(bad);
    let said = warnings(bad);
    suite.check('saving: a problem is warned about by the day\'s name, and nothing is rewritten',
        (said.length === 1) && said[0] === 'Channel 1: special day "New Year\'s Toonami Marathon": Its block is gone.' && JSON.stringify(bad) === saved,
        JSON.stringify(said));
    suite.check('saving: a good day, no days, or no schedule says nothing',
        warnings(sch).length === 0 && warnings(ch.schedule).length === 0 && warnings(undefined).length === 0, '');
    suite.check('saving: specialDays that isn\'t a list is warned about once',
        JSON.stringify(warnings(Object.assign( {}, ch.schedule, { specialDays: 'x' } ))) === '["Channel 1: scheduleBackup.specialDays was saved as string rather than an array. It will be ignored."]', '');

    // A block that exists only for a special day (Ron, Nov 5): its own bumpers, no
    // weekly airings of its own - not a mistake to warn about.
    const blocksAirless = (airings) => ch.blocks.concat([ { id: 'bl_fullcycle', name: 'Toonami: Full Cycle', airings: airings } ]);
    const airingsWarnings = (blocks, scheduleBackup) => {
        const lines = [];
        const real = console.error;
        console.error = (...args) => lines.push(args.join(' '));
        try {
            db.validateChannelJson(1, { number: 1, blocks: blocks, scheduleBackup: scheduleBackup });
        } finally {
            console.error = real;
        }
        return lines.filter( (l) => /no airings|never airs/i.test(l) );
    };
    suite.check('saving: a block with no airings is warned about, on its own',
        JSON.stringify(airingsWarnings(blocksAirless([]), sch)) === '["Channel 1: block 3 (\\"Toonami: Full Cycle\\") has no airings, so it never airs."]',
        JSON.stringify(airingsWarnings(blocksAirless([]), sch)));
    suite.check('saving: ...but not when a special day names it as its own block',
        airingsWarnings(blocksAirless([]), Object.assign( {}, sch, { specialDays: [ newYears({ blockId: 'bl_fullcycle' }) ] } )).length === 0,
        JSON.stringify(airingsWarnings(blocksAirless([]), Object.assign( {}, sch, { specialDays: [ newYears({ blockId: 'bl_fullcycle' }) ] } ))));
    suite.check('saving: ...and a block another special day names, with its own airings, is unaffected',
        airingsWarnings(blocksAirless([ { days: [ 0 ], start: 0, end: HOUR } ]), Object.assign( {}, sch, { specialDays: [ newYears({ blockId: 'bl_fullcycle' }) ] } )).length === 0,
        '');

    // timetable (step 6, "Preview this day"): read from a generated lineup, so
    // it can never disagree with what Create Lineup saves - never worked out
    // separately. A - B - A again (Back to back's rows starting over), the
    // second A running past the day's own 7:15 end, B's second turn in that
    // final lap never came.
    suite.log('timetable');
    {
        const episode = (show, n, title, duration, specialRow) => ({
            type: 'episode', showTitle: show, title: title, season: 1, episode: n, duration: duration,
            specialDay: 'sd_tt', specialRow: specialRow,
        });
        const ttDay = Object.assign({}, newYears({
            id: 'sd_tt', from: { date: '2027-01-01', time: 6 * HOUR }, to: { date: '2027-01-01', time: 7 * HOUR + 15 * MIN },
            slots: [ { showId: 'tv.A', order: 'next' }, { showId: 'tv.B', order: 'next' } ],
        }));
        const programs = [
            { title: 'Before', duration: 5 * MIN, isOffline: false },
            episode('A', 1, 'A1', 20 * MIN, 0),
            { duration: 10 * MIN, isOffline: true },
            episode('B', 1, 'B1', 20 * MIN, 1),
            { duration: 10 * MIN, isOffline: true },
            episode('A', 2, 'A2', 20 * MIN, 0),
            { title: 'After', duration: 20 * MIN, isOffline: false },
        ];
        const startTime = local(2027, 1, 1, 5, 55);
        const tt = sd.timetable({ programs, startTime, day: ttDay, schedule: {} });
        suite.check('one row per airing of the day, in order, Flex and what is before the window left out',
            JSON.stringify(tt.rows.map( (r) => r.title )) === '["A S01E01 A1","B S01E01 B1","A S01E02 A2"]', JSON.stringify(tt.rows));
        suite.check('...each at its real start',
            (tt.rows[0].at === local(2027, 1, 1, 6, 0)) && (tt.rows[1].at === local(2027, 1, 1, 6, 30)) && (tt.rows[2].at === local(2027, 1, 1, 7, 0)), JSON.stringify(tt.rows.map( (r) => iso(r.at) )));
        suite.check('a thin rule where the rows start again: A\'s second airing, the list back at the top',
            JSON.stringify(tt.restarts) === JSON.stringify([ local(2027, 1, 1, 7, 0) ]), JSON.stringify(tt.restarts));
        suite.check('B\'s row in that last, unfinished lap never got a turn',
            JSON.stringify(tt.never) === '["B"]', JSON.stringify(tt.never));
        suite.check('the last item ran 5:00 past the day\'s own end; back on time at the next half hour',
            tt.overrun && (tt.overrun.overMs === 5 * MIN) && (tt.overrun.backOnTimeAt === local(2027, 1, 1, 7, 30)),
            JSON.stringify(tt.overrun));
    }
    {
        // No overrun, no restart, nothing left out: a day that ends exactly on
        // time after one clean lap says so by saying nothing extra.
        const episode = (show, n, title, duration, specialRow) => ({
            type: 'episode', showTitle: show, title: title, season: 1, episode: n, duration: duration,
            specialDay: 'sd_tt', specialRow: specialRow,
        });
        const ttDay = Object.assign({}, newYears({
            id: 'sd_tt', from: { date: '2027-01-01', time: 6 * HOUR }, to: { date: '2027-01-01', time: 6 * HOUR + 40 * MIN },
            slots: [ { showId: 'tv.A', order: 'next' }, { showId: 'tv.B', order: 'next' } ],
        }));
        const programs = [
            episode('A', 1, 'A1', 20 * MIN, 0),
            episode('B', 1, 'B1', 20 * MIN, 1),
        ];
        const tt = sd.timetable({ programs, startTime: local(2027, 1, 1, 6, 0), day: ttDay, schedule: {} });
        suite.check('a day that ends exactly on time: no restart, nothing left out, no overrun line',
            (tt.restarts.length === 0) && (tt.never.length === 0) && (tt.overrun === null), JSON.stringify(tt));
    }
    {
        // Event tools: a row that runs until a time is one line for its run, not one
        // per episode; past its until time, the list started again, a go is its own line.
        const episode = (show, season, n, duration, specialRow) => ({
            type: 'episode', showTitle: show, title: `${show} ${season}x${n}`, season: season, episode: n, duration: duration,
            specialDay: 'sd_tt', specialRow: specialRow,
        });
        const movieItem = { type: 'movie', title: 'The Movie', duration: 30 * MIN, specialDay: 'sd_tt', specialRow: 1 };
        const ttDay = Object.assign({}, newYears({
            id: 'sd_tt', from: { date: '2027-01-01', time: 6 * HOUR }, to: { date: '2027-01-01', time: 9 * HOUR },
            slots: [ { showId: 'tv.L', order: 'next', until: 7 * HOUR + 30 * MIN }, { showId: 'movie.', item: { program: movieItem } } ],
        }));
        const flex8 = { duration: 8 * MIN, isOffline: true };
        const programs = [
            episode('L', 1, 1, 22 * MIN, 0), flex8, episode('L', 1, 2, 22 * MIN, 0), flex8, episode('L', 2, 1, 22 * MIN, 0), flex8,
            movieItem,
            episode('L', 2, 2, 22 * MIN, 0), flex8, episode('L', 2, 3, 22 * MIN, 0), flex8,
        ];
        const tt = sd.timetable({ programs, startTime: local(2027, 1, 1, 6, 0), day: ttDay, schedule: {} });
        suite.check('an until row\u2019s run is one line: show, how many episodes, first and last',
            JSON.stringify(tt.rows.map( (r) => r.title )) === '["L, 3 episodes (S1E1–S2E1)","The Movie","L S02E02 L 2x2","L S02E03 L 2x3"]',
            JSON.stringify(tt.rows.map( (r) => r.title )));
        suite.check('...at the run\u2019s start', tt.rows[0].at === local(2027, 1, 1, 6, 0) && tt.rows[1].at === local(2027, 1, 1, 7, 30), '');
        suite.check('...and the list starting again is still a thin rule', JSON.stringify(tt.restarts) === JSON.stringify([ local(2027, 1, 1, 8, 0) ]),
            JSON.stringify(tt.restarts));
    }
    {
        // The Until dropdown: the day's own marks after its start, to its end.
        const half = sd.untilOptions(newYears({ from: { date: '2027-01-01', time: 6 * HOUR }, to: { date: '2027-01-02', time: 6 * HOUR } }));
        suite.check('untilOptions: every half hour after the start up to the end, 48 of them, labelled by the clock',
            half.length === 48 && half[0].id === 6 * HOUR + 30 * MIN && half[0].description === '6:30am'
                && half[27].id === 20 * HOUR && half[27].description === '8:00pm'
                && half[47].id === 30 * HOUR && half[47].description === '6:00am',
            JSON.stringify(half.slice(0, 2)) + ' ... ' + JSON.stringify(half.slice(-1)));
        const quarter = sd.untilOptions(newYears({ rounding: 'quarter', from: { date: '2027-01-01', time: 18 * HOUR }, to: { date: '2027-01-01', time: 20 * HOUR } }));
        suite.check('untilOptions: a quarter-hour day offers quarter hours',
            quarter.map( (o) => o.description ).join(',') === '6:15pm,6:30pm,6:45pm,7:00pm,7:15pm,7:30pm,7:45pm,8:00pm', quarter.map( (o) => o.description ).join(','));
        const long = sd.untilOptions(newYears({ from: { date: '2027-01-01', time: 22 * HOUR }, to: { date: '2027-01-03', time: 2 * HOUR } }));
        suite.check('untilOptions: a day longer than a day names the weekday',
            long[0].description === 'Fri 10:30pm' && long[long.length - 1].description === 'Sun 2:00am', `${long[0].description} ... ${long[long.length - 1].description}`);
        suite.check('untilOptions: a day without a proper window offers nothing', sd.untilOptions({}).length === 0);
    }
    suite.check('timetable on a day with no proper window answers empty, not throws',
        JSON.stringify(sd.timetable({ programs: [], startTime: 0, day: {}, schedule: {} })) === '{"rows":[],"restarts":[],"never":[],"overrun":null}', '');

    suite.log('spansIn (the Schedule tab\'s chips for a day\'s band)');
    {
        // Review, Nov 5: a column kept only airings starting inside it, so Batman: Mask
        // of the Phantasm (11:30pm Fri to 12:46am Sat) drew nothing in Saturday's column.
        const airings = [
            { at: local(2027, 1, 1, 22, 0), duration: 61 * MIN, label: 'Tree of Might' },
            { at: local(2027, 1, 1, 23, 30), duration: 76 * MIN + 28 * SEC, label: 'Mask of the Phantasm' },
            { at: local(2027, 1, 2, 1, 0), duration: 59 * MIN, label: "World's Strongest" },
        ];
        const sat = sd.spansIn(airings, local(2027, 1, 2, 0, 0), local(2027, 1, 2, 6, 0));
        suite.check('an airing that crosses midnight shows in the next day\'s band from midnight to its end',
            (sat.length === 2) && (sat[0].label === 'Mask of the Phantasm') && (sat[0].from === local(2027, 1, 2, 0, 0))
                && (sat[0].to === local(2027, 1, 2, 0, 46, 28)) && (sat[1].label === "World's Strongest"),
            JSON.stringify(sat.map( (s) => [ s.label, iso(s.from), iso(s.to) ] )));
        const fri = sd.spansIn(airings, local(2027, 1, 1, 6, 0), local(2027, 1, 2, 0, 0));
        suite.check('...and in its own day\'s band up to midnight; nothing outside the band',
            (fri.length === 2) && (fri[1].label === 'Mask of the Phantasm') && (fri[1].to === local(2027, 1, 2, 0, 0)), JSON.stringify(fri.map( (s) => s.label )));
    }

    suite.log('holiday rows (step 8)');
    {
        const ep = (show, season, n, key) => ({ type: 'episode', showTitle: show, title: `${show} ${season}.${n}`, season, episode: n,
            duration: 22 * MIN, serverKey: 'srv', key: key || `/e/${show}/${season}/${n}` });
        const aside = (program, holiday, reason) => ({ showId: 'tv.' + program.showTitle, season: program.season, episode: program.episode,
            title: program.title, reason: reason || 'holiday', holiday });
        const xmas1 = ep('Hey Arnold!', 0, 1, '/x/1');
        const xmas2 = ep('Hey Arnold!', 0, 2, '/x/2');
        const hanuk = ep('Hey Arnold!', 0, 3, '/x/3');
        const scary = ep('Hey Arnold!', 0, 4, '/x/4');
        const never = ep('Hey Arnold!', 0, 5, '/x/5');
        const regular = ep('Hey Arnold!', 1, 1);
        const items = [ xmas2, regular, xmas1, hanuk, scary, never ];
        const state = { shows: {}, neverAir: {
            'srv|/x/1': aside(xmas1, 'Christmas'), 'srv|/x/2': aside(xmas2, 'Christmas'), 'srv|/x/3': aside(hanuk, 'Hanukkah'),
            'srv|/x/4': aside(scary, 'Halloween'), 'srv|/x/5': aside(never, undefined, 'never') } };
        const keys = (list) => list.map( (p) => p.key );

        suite.check('a holiday day names its holidays: one, or the Christmas season\'s three',
            JSON.stringify(sd.holidayNames('Halloween')) === '["Halloween"]'
                && JSON.stringify(sd.holidayNames('Christmas season')) === '["Christmas","Hanukkah","Kwanzaa"]'
                && sd.holidayNames(null).length === 0 && sd.holidayNames('').length === 0,
            JSON.stringify(sd.holidayNames('Christmas season')));
        suite.check('candidates are exactly the episodes set aside as that holiday - not the rest of the show, not other holidays, not never-air',
            JSON.stringify(keys(sd.holidayCandidates({ state, items, holiday: 'Christmas' }))) === '["/x/2","/x/1"]',
            JSON.stringify(keys(sd.holidayCandidates({ state, items, holiday: 'Christmas' }))));
        suite.check('...the Christmas season adds Hanukkah\'s; a holiday with none set aside has none',
            JSON.stringify(keys(sd.holidayCandidates({ state, items, holiday: 'Christmas season' }))) === '["/x/2","/x/1","/x/3"]'
                && sd.holidayCandidates({ state, items, holiday: 'Easter' }).length === 0 && sd.holidayCandidates({ state, items, holiday: null }).length === 0, '');
        suite.check('...and an episode the catalog lists twice is one candidate',
            sd.holidayCandidates({ state, items: items.concat([ xmas1 ]), holiday: 'Christmas' }).length === 2, '');

        const day = { id: 'sd_x', name: 'Eve', from: { date: '2026-12-24', time: 0 }, to: { date: '2026-12-25', time: 0 }, blockId: null,
            positions: 'advance', layout: 'back', holiday: 'Christmas',
            slots: [ { showId: 'tv.Hey Arnold!', order: 'next', holidayOnly: true }, { showId: 'tv.Rugrats', order: 'next' },
                { showId: 'tv.Hey Arnold!', order: 'shuffle', holidayOnly: true }, { showId: 'tv.Hey Arnold!', order: 'next', holidayOnly: false } ] };
        const got = sd.holidayItems({ schedule: { specialDays: [ day ] }, state, catalogs: { 'tv.Hey Arnold!': { items }, 'tv.Rugrats': { items: [ ep('Rugrats', 1, 1) ] } } });
        suite.check('what the generator is given: per day, per show of a holiday row, its candidates once - rows that are not holiday rows add nothing',
            JSON.stringify(Object.keys(got)) === '["sd_x"]' && JSON.stringify(Object.keys(got.sd_x)) === '["tv.Hey Arnold!"]'
                && JSON.stringify(keys(got.sd_x['tv.Hey Arnold!'])) === '["/x/2","/x/1"]', JSON.stringify(got).slice(0, 200));
        suite.check('...a day with no holiday, or a show not read, gives nothing',
            JSON.stringify(sd.holidayItems({ schedule: { specialDays: [ Object.assign( {}, day, { holiday: null } ) ] }, state, catalogs: { 'tv.Hey Arnold!': { items } } })) === '{}'
                && JSON.stringify(sd.holidayItems({ schedule: { specialDays: [ day ] }, state, catalogs: { 'tv.Hey Arnold!': { error: 'down' } } })) === '{}', '');
        suite.check('the tag on a holiday row\'s position names its day, as the fill\'s and a Keep-apart row\'s do',
            sd.dayOfTag('sd_x') === 'sd_x' && sd.dayOfTag('fill:sd_x') === 'sd_x' && sd.dayOfTag('holiday:sd_x') === 'sd_x', '');
    }
    return suite;
};
