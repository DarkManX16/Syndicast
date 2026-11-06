/*
 * Split episodes: a half-hour episode kept as two (or three) files, one per
 * story - The Weekenders' "S03E11a - Clown" and "S03E11b - Testing Dixon".
 * A slot that starts an "a" half plays the rest of that episode in the same
 * slot, and a slot never starts with a "b" half. See NOTES.md, Known issues,
 * "Split episodes stay together".
 *
 * Ron's case, Sat Nov 7, 2026 on channel 3 (the Nov 2 lineup): the 2:30
 * Weekenders slot started 5 minutes late behind a 22:35 House of Mouse, so it
 * had 25 minutes; 11a counted as its padded 15:00, 11b's 10:49 "didn't fit",
 * and 11a aired alone - though both end by 2:57:22. Sunday then started with
 * 11b, and every pair after it was out of step.
 *
 * The real time-slots-service with the clock frozen, and the real planner, on
 * fixtures in the machine's own zone.
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const timeSlotsService = require('../src/services/time-slots-service');
const slotProgress = require('../src/slot-progress');
const multiPart = require('../src/multi-part');
const getShowData = require('../web/services/get-show-data')();

const SEC = 1000;
const THU = new Date('2026-10-08T00:00:00').getTime();
const day = (n, hour, minute, second) => THU + n * DAY + hour * HOUR + (minute || 0) * MIN + (second || 0) * SEC;
const NOON = day(0, 12);
const ms = (m, s) => m * MIN + s * SEC;

// The Weekenders, as Ron's custom show holds it: one item per file, in list order.
const WK_ITEMS = [
    [ 'S03E10 - Celebrity', ms(22, 18) ],
    [ 'S03E11a - Clown', ms(11, 33) ],
    [ 'S03E11b - Testing Dixon', ms(10, 49) ],
    [ 'S03E12a - Croquembouche', ms(11, 33) ],
    [ 'S03E12b - Imperfection', ms(10, 48) ],
    [ 'S04E02a - Brain Dead', ms(11, 33) ],
    [ 'S04E02b - Lor\'s Will', ms(10, 47) ],
    [ 'S04E05 - Tino\'s Dad', ms(22, 19) ],
];
function wk() {
    return WK_ITEMS.map( ([ title, duration ], i) => ({
        title, duration, type: 'movie', serverKey: 'srv', key: '/wk/' + i, showTitle: title,
        file: 'E:\\The Weekenders\\' + title + '.m4v',
        customShowId: 'wk', customShowName: 'The Weekenders', customOrder: i,
    }) );
}
const WK = 'custom.wk';
const short = (title) => title.replace(/ - .*/, '');

function episode(show, n, duration) {
    return {
        type: 'episode', showTitle: show, title: `${show} S1E${n}`,
        season: 1, episode: n, duration: duration || 22 * MIN, serverKey: 'srv', key: `/e/${show}/1/${n}`,
    };
}
const seasonOf = (show, count, duration) => Array.from({ length: count }, (x, i) => episode(show, i + 1, duration));

// 2:00 House of Mouse, 2:30 The Weekenders, 3:00 Recess; Flex the rest of the day.
function daily(o) {
    o = o || {};
    const wkEnd = o.wkEnd || 15 * HOUR;
    return {
        period: DAY, lateness: 24 * HOUR, maxDays: 7, flexPreference: 'distribute', pad: 5 * MIN,
        slots: [
            { time: 0, showId: 'flex.', order: 'next' },
            { time: 14 * HOUR, showId: 'tv.House of Mouse', order: 'next' },
            { time: 14 * HOUR + 30 * MIN, showId: WK, order: o.order || 'next' },
            { time: wkEnd, showId: 'tv.Recess', order: 'next' },
            { time: wkEnd + 30 * MIN, showId: 'flex.', order: 'next' },
        ],
    };
}
// House of Mouse runs 22:35 (Ron's 1355s) and ends 2:22:35, or 32 minutes to run the slot late.
const pool = (mouse) => seasonOf('House of Mouse', 20, mouse || ms(22, 35)).concat(seasonOf('Recess', 20), wk());
const atWk = (key) => ({ [slotProgress.positionKey(WK, 'next', undefined)]: { next: slotProgress.ref(wk().find( (p) => p.key === key ), getShowData), wrapped: false } });

async function generate(programs, schedule, now, o) {
    o = o || {};
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(now); else super(...a); }
        static now() { return now; }
    }
    global.Date = FrozenDate;
    try {
        const copy = (x) => (typeof(x) === 'undefined') ? undefined : JSON.parse(JSON.stringify(x));
        return await timeSlotsService(copy(programs), copy(schedule), undefined, copy(o.pins), copy(o.carry), copy(o.fillerPools));
    } finally {
        global.Date = RealDate;
    }
}
function withStarts(res) {
    let t = Date.parse(res.startTime);
    return res.programs.map( (p) => { const a = { start: t, program: p }; t += p.duration; return a; } );
}
const shows = (res) => withStarts(res).filter( (a) => ! a.program.isOffline );
const clock = (t) => new Date(t).toLocaleTimeString('en-US');
// The Weekenders' airings on day n, as "2:35:00 PM S03E11a".
const wkOn = (res, n) => shows(res).filter( (a) => (a.program.customShowId === 'wk') && (a.start >= day(n, 0)) && (a.start < day(n + 1, 0)) )
    .map( (a) => `${clock(a.start)} ${short(a.program.title)}` );
const startOf = (res, show, n) => {
    const a = shows(res).find( (x) => (x.program.showTitle === show) && (x.start >= day(n, 0)) && (x.start < day(n + 1, 0)) );
    return (typeof(a) === 'undefined') ? null : clock(a.start);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (list) => JSON.stringify(list);

module.exports = async function () {
    const suite = new Suite('split-episodes');

    suite.log('-- which files are halves (multi-part.js halfOf) --');
    {
        const half = (title, file) => multiPart.halfOf({ title, file });
        const said = (h) => (h === null) ? 'none' : `S${h.season}E${h.episode}${h.letter}`;
        suite.check('"S03E11a - Clown" is the a half of S3E11', said(half('S03E11a - Clown')) === 'S3E11a', said(half('S03E11a - Clown')));
        suite.check('"S03E11b - Testing Dixon" is its b half', said(half('S03E11b - Testing Dixon')) === 'S3E11b');
        suite.check('Ren & Stimpy\'s "...Show.S03.E01b" is a b half', said(half('The.Ren.And.Stimpy.Show.S03.E01b')) === 'S3E1b');
        suite.check('Invader Zim\'s capital "S01E08A" is an a half', said(half('Invader Zim S01E08A Invasion of the Idiot Dog Brain  [1080p x265 q22 Joy]')) === 'S1E8a');
        suite.check('a title without one reads the file\'s name (Teamo Supremo)',
            said(half('Electronica\'s Game / The Angler\'s Angle', 'D:\\Shows\\Teamo Supremo\\Season 2\\Teamo Supremo S02E05a Getaway Car-Go!.mp4')) === 'S2E5a');
        suite.check('a whole episode is not a half', half('S03E10 - Celebrity') === null);
        suite.check('a file holding both, "a-b", "a+b" or ".E01a.E01b", is not a half',
            half('S01E06a-b - Get That Bigfoot Outa My Face!; Tree to Get Ready') === null
            && half('Hair Ball', 'E:\\Jungle Cubs\\Jungle Cubs S02E06a+b Hair Ball + A Tale of Two Tails.mp4') === null
            && half('Stimpy\'s Big Day / The Big Shot', 'F:\\Ren\\The.Ren.And.Stimpy.Show.S01.E01a.E01b.mp4') === null);
        suite.check('a release hash in brackets is not a half (Cowboy Bebop "[E548716B]")',
            half('Waltz for Venus', 'G:\\Cowboy.Bebop.S01E04.1080p-Hi10p.BluRay.FLAC5.1.x264.[E548716B].mkv') === null);
        suite.check('a show\'s own title is not a half ("A Sappy Ending")', half('A Sappy Ending', 'G:\\Pokemon S03E03 A Sappy Ending.mp4') === null);
    }

    suite.log('-- halves are one story (multi-part.js stories) --');
    {
        const titles = (programs) => multiPart.stories(programs).map( (s) => s.map( (p) => short(p.title) ) );
        suite.check('11a and 11b are one story; Celebrity and Tino\'s Dad stand alone', same(titles(wk()),
            [ [ 'S03E10' ], [ 'S03E11a', 'S03E11b' ], [ 'S03E12a', 'S03E12b' ], [ 'S04E02a', 'S04E02b' ], [ 'S04E05' ] ]), show(titles(wk())));
        const abc = [ 'S01E01a - One', 'S01E01b - Two', 'S01E01c - Three', 'S01E02a - Four' ].map( (title, i) => ({ title, customShowId: 'x', customOrder: i, key: '/x/' + i }) );
        suite.check('a, b and c are one story of three', same(titles(abc), [ [ 'S01E01a', 'S01E01b', 'S01E01c' ], [ 'S01E02a' ] ]), show(titles(abc)));
        const stray = [ 'S01E01a - One', 'S01E02b - Two', 'S01E03b - Three' ].map( (title, i) => ({ title, customShowId: 'x', customOrder: i, key: '/x/' + i }) );
        suite.check('a b half after another episode\'s a stays single', same(titles(stray), [ [ 'S01E01a' ], [ 'S01E02b' ], [ 'S01E03b' ] ]), show(titles(stray)));
    }

    suite.log('-- Time Slots: a slot that starts an a half plays the rest --');
    {
        // Ron's Saturday: the slot starts at 2:35 with 25 minutes; 11a and 11b end 2:57:22.
        const late = await generate(pool(32 * MIN), Object.assign(daily(), { progress: { positions: atWk('/wk/1') } }), NOON);
        suite.check('a slot running 5 minutes late airs 11a and 11b, both before 3:00',
            same(wkOn(late, 0), [ '2:35:00 PM S03E11a', '2:46:33 PM S03E11b' ]), show(wkOn(late, 0)));
        suite.check('...and Recess is on time at 3:00', startOf(late, 'Recess', 0) === '3:00:00 PM', startOf(late, 'Recess', 0));
        suite.check('...and the next day starts on an a half, 12a with 12b',
            same(wkOn(late, 1), [ '2:35:00 PM S03E12a', '2:46:33 PM S03E12b' ]), show(wkOn(late, 1)));

        const onTime = await generate(pool(), Object.assign(daily(), { progress: { positions: atWk('/wk/1') } }), NOON);
        suite.check('on time, the halves air at 2:30 and 2:45, as they always have',
            same(wkOn(onTime, 0), [ '2:30:00 PM S03E11a', '2:45:00 PM S03E11b' ]), show(wkOn(onTime, 0)));

        // A 45-minute slot from Celebrity: 25:00 padded and 11a's 11:33 fit, 11b's 10:49 doesn't.
        const long = daily({ wkEnd: 15 * HOUR + 15 * MIN });
        const celebrity = await generate(pool(), Object.assign(long, { progress: { positions: atWk('/wk/0') } }), NOON);
        suite.check('a slot with room for 11a but not 11b leaves the whole episode for the next',
            same(wkOn(celebrity, 0), [ '2:30:00 PM S03E10' ]), show(wkOn(celebrity, 0)));
        suite.check('...which starts with 11a', short(wkOn(celebrity, 1)[0] || '').endsWith('S03E11a'), show(wkOn(celebrity, 1)));

        // A 15-minute slot: the episode is longer than the slot, so it slides, whole.
        const tiny = await generate(pool(), Object.assign(daily({ wkEnd: 14 * HOUR + 45 * MIN }), { progress: { positions: atWk('/wk/1') } }), NOON);
        suite.check('a slot shorter than the episode airs both halves back to back and runs over',
            same(wkOn(tiny, 0), [ '2:30:00 PM S03E11a', '2:41:33 PM S03E11b' ]), show(wkOn(tiny, 0)));

        const shuffled = await generate(pool(), daily({ order: 'shuffle' }), NOON);
        const pairs = [ 0, 1, 2, 3, 4, 5, 6 ].map( (n) => wkOn(shuffled, n).map( (x) => x.replace(/^.* /, '') ) );
        const kept = pairs.every( (list) => list.every( (t, i) => ! /b$/.test(t) || ( (i > 0) && (list[i - 1] === t.replace(/b$/, 'a')) ) ) );
        suite.check('Shuffle: every b half airs right after its a, in the same slot', kept, show(pairs));
    }

    suite.log('-- hand edits and the program on air --');
    {
        // A row kept as it is at 2:45: only a whole episode fits before it, and 11a+11b don't.
        const swap = Object.assign(episode('Recess', 30, 11 * MIN), { title: 'Recess Special', kept: { edits: [ { id: 'e1', kind: 'swap', made: '2026-10-08T00:00:00.000Z' } ] } });
        const keptRow = await generate(pool(), Object.assign(daily(), { progress: { positions: atWk('/wk/1') } }), NOON,
            { pins: [ { at: day(0, 14, 45), program: swap, kept: true } ] });
        suite.check('a kept row at 2:45 leaves the slot to Flex rather than 11a alone', same(wkOn(keptRow, 0), []), show(wkOn(keptRow, 0)));
        suite.check('...and the next day starts with 11a and 11b', same(wkOn(keptRow, 1), [ '2:30:00 PM S03E11a', '2:45:00 PM S03E11b' ]), show(wkOn(keptRow, 1)));

        // 11a on air at 2:40, carried; the planner leaves the place on 11b, which follows it.
        const a = wk()[1];
        const carried = await generate(pool(), Object.assign(daily(), { progress: { positions: atWk('/wk/2') } }), day(0, 14, 40),
            { carry: { start: day(0, 14, 30), program: Object.assign({}, a, { slotPosition: 'next|' }) } });
        suite.check('with 11a on air, 11b follows it in the same slot', same(wkOn(carried, 0), [ '2:30:00 PM S03E11a', '2:45:00 PM S03E11b' ]), show(wkOn(carried, 0)));
    }

    suite.log('-- special days --');
    {
        const sd = (extra) => Object.assign({
            id: 'sd_t', name: 'Marathon', from: { date: '2026-10-09', time: 14 * HOUR }, to: { date: '2026-10-09', time: 16 * HOUR },
            blockId: null, positions: 'advance', layout: 'back', slots: [ { showId: WK, order: 'next' }, { showId: 'tv.Recess', order: 'next' } ],
        }, extra || {});
        const quarter = await generate(pool(), Object.assign(daily(), { specialDays: [ sd({ rounding: 'quarter' }) ], progress: { positions: atWk('/wk/1') } }), NOON);
        suite.check('Back to back on the quarter hour: the row plays 12a and 12b before the next row',
            same(wkOn(quarter, 1).slice(0, 2), [ '2:00:00 PM S03E12a', '2:15:00 PM S03E12b' ]), show(wkOn(quarter, 1)));

        const jumped = await generate(pool(), Object.assign(daily(), { specialDays: [ sd({ slots: [
            { showId: WK, order: 'next', start: slotProgress.ref(wk()[2], getShowData) }, { showId: 'tv.Recess', order: 'next' } ] }) ] }), NOON);
        suite.check('an Advance day\'s start on 11b jumps to 11a', same(wkOn(jumped, 1).slice(0, 2), [ '2:00:00 PM S03E11a', '2:15:00 PM S03E11b' ]), show(wkOn(jumped, 1)));

        // A 40-minute movie at 2:00 leaves 20 minutes before 3:00: room for an a half, not its b.
        const gym = [ [ 'S01E10a - Supplies Party', ms(12, 2) ], [ 'S01E10b - She\'s Koala That', ms(12, 1) ] ].map( ([ title, duration ], i) => ({
            title, duration, type: 'movie', serverKey: 'srv', key: '/gp/' + i, customShowId: 'gp', customShowName: 'My Gym Partner\'s a Monkey', customOrder: i }) );
        const movie = { title: 'The Short One', duration: 40 * MIN, type: 'movie', serverKey: 'srv', key: '/m/short', customShowId: 'mv', customShowName: 'Movies', customOrder: 0 };
        const filled = await generate(pool().concat([ movie ], gym), Object.assign(daily(), {
            specialDays: [ sd({ slots: [ { showId: 'custom.mv', order: 'next' }, { showId: 'tv.Recess', order: 'next' } ], fillBreaksWith: 'custom.gp' }) ] }), NOON);
        const fillOn = shows(filled).filter( (a) => (a.program.specialRow === 'fill') ).map( (a) => short(a.program.title) );
        suite.check('"Fill long breaks with" never fills 20 minutes with half of a 24-minute episode', same(fillOn, []), show(fillOn));
    }

    suite.log('-- the planner: a place on a b half goes back to its a --');
    {
        // The Nov 2 lineup: 11a alone Friday at 2:35, 11b Saturday at 2:30 with 12a.
        const lineup = (() => {
            const items = wk();
            const programs = [];
            let t = THU;
            [ [ day(1, 14, 35), items[1] ], [ day(2, 14, 30), items[2] ], [ day(2, 14, 45), items[3] ], [ day(3, 14, 30), items[4] ] ].forEach( ([ when, p ]) => {
                programs.push({ isOffline: true, duration: when - t });
                programs.push(Object.assign({}, p, { slotPosition: 'next|' }));
                t = when + p.duration;
            } );
            programs.push({ isOffline: true, duration: THU + 7 * DAY - t });
            return programs;
        })();
        const key = slotProgress.positionKey(WK, 'next', undefined);
        const plan = (now, placesFrom) => slotProgress.planProgress({ programs: lineup, startTime: THU, now, placesFrom,
            openedSchedule: daily(), schedule: daily(), pool: pool(), getShowData });
        const titleOf = (record) => short(wk().find( (p) => 'srv|' + p.key === record.next.key ).title);
        const after = plan(day(1, 16));
        suite.check('after 11a aired alone, the place is 11a again, not 11b', titleOf(after.positions[key]) === 'S03E11a', titleOf(after.positions[key]));
        const onAir = plan(day(1, 14, 40), day(1, 14, 46, 33));
        suite.check('with 11a on air and carried, the place stays on 11b', titleOf(onAir.positions[key]) === 'S03E11b', titleOf(onAir.positions[key]));
        const before = plan(day(1, 10));
        suite.check('before it, the place is 11a as it was', titleOf(before.positions[key]) === 'S03E11a', titleOf(before.positions[key]));
        const picked = slotProgress.planProgress({ programs: lineup, startTime: THU, now: day(1, 16), openedSchedule: daily(), schedule: daily(),
            pool: pool(), getShowData, starts: { [key]: slotProgress.ref(wk()[4], getShowData) } });
        suite.check('an episode start on a b half starts at its a', titleOf(picked.positions[key]) === 'S03E12a', titleOf(picked.positions[key]));
    }

    return suite;
};
