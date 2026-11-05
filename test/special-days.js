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
    return suite;
};
