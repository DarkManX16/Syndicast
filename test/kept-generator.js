/*
 * Create Lineup keeps kept rows (src/kept-rows.js keptAhead, and the Time
 * Slots generator placing them): every row kept as it is at its time in the
 * list, every row kept in time airing its position's next episode at its
 * time, and the rest filled from the slots as before. See NOTES.md, Known
 * issues, "What you see is what airs: hand edits kept in the list".
 *
 * The real generator with the clock frozen, Create Lineup's path as the
 * editor runs it (each position's place read from the list, the program on
 * air carried), on fixtures in the machine's own zone.
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const timeSlotsService = require('../src/services/time-slots-service');
const kept = require('../src/kept-rows');
const pinTools = require('../src/pins');
const slotProgress = require('../src/slot-progress');
const getShowData = require('../web/services/get-show-data')();
const commonProgramTools = require('../web/services/common-program-tools')(getShowData);

const SEC = 1000;
const THU = new Date('2026-10-08T00:00:00').getTime();
const NOON = THU + 12 * HOUR;
const thu = (hour, minute, second) => THU + hour * HOUR + (minute || 0) * MIN + (second || 0) * SEC;

function episode(show, n, duration) {
    return {
        type: 'episode', showTitle: show, title: `${show} S1E${n}`,
        season: 1, episode: n, duration: duration || 22 * MIN, serverKey: 'srv', key: `/e/${show}/1/${n}`,
    };
}
const seasonOf = (show, count) => Array.from({ length: count }, (x, i) => episode(show, i + 1));
const item = (title, duration, show) => Object.assign(episode(show || 'Specials', 0, duration), { title, season: 0, key: '/x/' + title });

// A, B, C, D on the half hour from 7pm, Flex the rest of the day.
function daily() {
    return {
        period: DAY, lateness: 24 * HOUR, maxDays: 14, flexPreference: 'distribute', pad: 5 * MIN,
        slots: [
            { time: 19 * HOUR, showId: 'tv.A', order: 'next' },
            { time: 19 * HOUR + 30 * MIN, showId: 'tv.B', order: 'next' },
            { time: 20 * HOUR, showId: 'tv.C', order: 'next' },
            { time: 20 * HOUR + 30 * MIN, showId: 'tv.D', order: 'next' },
            { time: 21 * HOUR, showId: 'flex.', order: 'next' },
        ],
    };
}
const POOL = seasonOf('A', 40).concat(seasonOf('B', 40), seasonOf('C', 40), seasonOf('D', 40));

async function generate(programs, schedule, now, keep, carry) {
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(now); else super(...a); }
        static now() { return now; }
    }
    global.Date = FrozenDate;
    try {
        return await timeSlotsService(JSON.parse(JSON.stringify(programs)), JSON.parse(JSON.stringify(schedule)), undefined,
            (typeof keep === 'undefined') ? undefined : JSON.parse(JSON.stringify(keep)), (carry === null) ? undefined : carry);
    } finally {
        global.Date = RealDate;
    }
}
const listOf = (res) => ({ programs: res.programs, startTime: Date.parse(res.startTime) });

// Create Lineup as the editor runs it on `list` at `now`: places read from the list,
// the program on air carried, the kept rows ahead handed to the generator.
async function createLineup(list, schedule, now) {
    const s = JSON.parse(JSON.stringify(schedule));
    const carry = pinTools.carryAt({ programs: list.programs, startTime: list.startTime, now, schedule: s });
    s.progress = slotProgress.planProgress({ programs: list.programs, startTime: list.startTime, now,
        placesFrom: carry ? Math.max(now, carry.start + carry.program.duration) : undefined,
        openedSchedule: s, schedule: s, pool: POOL, getShowData });
    const keep = kept.keptAhead({ programs: list.programs, startTime: list.startTime, now });
    return listOf(await generate(commonProgramTools.slotPool(list.programs).concat(POOL), s, now, keep, carry));
}

// Every program and kept row from..to, as "7:30:00 PM B S1E1 [swap]".
function night(list, from, to) {
    const out = [];
    const total = list.programs.reduce( (a, p) => a + p.duration, 0 );
    let t = list.startTime;
    list.programs.forEach( (p) => {
        let at = t;
        while (at < from) {
            at += total;
        }
        if ( (at < to) && (! p.isOffline || p.kept) ) {
            out.push({ at, line: `${new Date(at).toLocaleTimeString('en-US')} ${p.isOffline ? 'Flex' : p.title}${kept.keptKind(p) ? ' [' + kept.keptKind(p) + ']' : ''}` });
        }
        t += p.duration;
    } );
    return out.sort( (a, b) => a.at - b.at ).map( (x) => x.line );
}
const sameNight = (a, b, from, to) => JSON.stringify(night(a, from, to)) === JSON.stringify(night(b, from, to));
const indexAt = (list, at) => {
    let t = list.startTime;
    for (let i = 0; i < list.programs.length; i++) {
        if ( (t === at) && ! list.programs[i].isOffline ) {
            return i;
        }
        t += list.programs[i].duration;
    }
    return -1;
};
const rowAt = (list, at) => list.programs[indexAt(list, at)];

module.exports = async function () {
    const suite = new Suite('kept-generator');
    const sched = daily();
    const base = listOf(await generate(POOL, sched, NOON));
    const DAYS = [ NOON, NOON + 4 * DAY ];

    suite.log('-- nothing kept --');
    {
        suite.check('a list with nothing kept has nothing to keep', kept.keptAhead({ programs: base.programs, startTime: base.startTime, now: NOON }).length === 0);
        const again = await generate(POOL, sched, NOON, []);
        suite.check('...and an empty list of kept rows makes the same lineup as none', JSON.stringify(again.programs) === JSON.stringify(base.programs));
        const made = await createLineup(base, sched, NOON);
        suite.check('Create Lineup on a list nothing kept, places read from it: the same nights',
            sameNight(made, base, ...DAYS), JSON.stringify(night(made, thu(19), thu(21))));
    }

    suite.log('-- a kept swap --');
    {
        const at = thu(19, 30);
        const r = kept.swap({ lineup: base, index: indexAt(base, at), item: item('B Special', 24 * MIN + 6 * SEC, 'B'), now: NOON, schedule: sched });
        const list = listOf({ programs: r.programs, startTime: new Date(base.startTime).toISOString() });
        const made = await createLineup(list, sched, NOON);
        suite.check('a kept swap at its list time, its slot Flex after it, the next slot on time; the night as the list has it',
            rowAt(made, at) && rowAt(made, at).title === 'B Special' && kept.keptKind(rowAt(made, at)) === 'swap'
                && rowAt(made, thu(20)).title === 'C S1E1' && sameNight(made, list, ...DAYS),
            JSON.stringify(night(made, thu(19), thu(21))));
        suite.check('...and the episode it pushed out at its show\'s next slot, as the list has it',
            rowAt(made, thu(19, 30) + DAY).title === 'B S1E1', rowAt(made, thu(19, 30) + DAY) && rowAt(made, thu(19, 30) + DAY).title);
        const again = await createLineup(made, sched, NOON);
        suite.check('regenerated from its own output: identical, JSON for JSON',
            JSON.stringify(again.programs) === JSON.stringify(made.programs) && again.startTime === made.startTime, '');

        // Ron changes the 7:30 slot to D: the swap stays, and says so.
        const changed = JSON.parse(JSON.stringify(sched));
        changed.slots[1].showId = 'tv.D';
        const notes = kept.scheduleNotes({ programs: made.programs, startTime: made.startTime, now: NOON, schedule: changed });
        const after = await createLineup(made, changed, NOON);
        suite.check('a schedule change under a kept swap: the swap stays where it is',
            rowAt(after, at) && rowAt(after, at).title === 'B Special', JSON.stringify(night(after, thu(19), thu(21))));
        suite.check('...and the Time Slots dialog says so, in one sentence',
            JSON.stringify(notes) === JSON.stringify([ "B Special at Thu Oct 8, 7:30pm is now in D's slot; it stays." ]), JSON.stringify(notes));

        const onAir = await createLineup(made, sched, thu(19, 40));
        suite.check('a kept row on air is carried: at its time, once',
            rowAt(onAir, at) && rowAt(onAir, at).title === 'B Special'
                && onAir.programs.filter( (p) => p.title === 'B Special' ).length === 1 && rowAt(onAir, thu(20)).title === 'C S1E1',
            JSON.stringify(night(onAir, thu(19), thu(21))));
        const aired = kept.keptAhead({ programs: made.programs, startTime: made.startTime, now: thu(20) });
        const later = await createLineup(made, sched, thu(20, 10));
        suite.check('once it has aired, nothing keeps it: the loop bringing it round again doesn\'t',
            aired.length === 0 && ! later.programs.some( (p) => p.title === 'B Special' ), JSON.stringify(aired.map( (x) => x.program.title )));
    }

    suite.log('-- a drag: one row moved, the rows between kept in time --');
    {
        // C and its break to 7pm (D's break is the night's Flex, until the next evening).
        const m = kept.move({ lineup: base, from: indexAt(base, thu(20)), to: indexAt(base, thu(19)), now: NOON });
        const list = { programs: m.programs, startTime: base.startTime };
        const made = await createLineup(list, sched, NOON);
        suite.check('every row at its instant in the list, the next slot on time',
            JSON.stringify(night(made, thu(19), thu(21))) === JSON.stringify([ '7:00:00 PM C S1E1 [moved]', '7:30:00 PM A S1E1 [shifted]',
                '8:00:00 PM B S1E1 [shifted]', '8:30:00 PM D S1E1' ])
                && sameNight(made, list, ...DAYS),
            JSON.stringify(night(made, thu(19), thu(21))));

        // A row kept in time is its position's one-off slot: it airs that position's next episode.
        const s = JSON.parse(JSON.stringify(sched));
        const res = await (async () => {
            const keep = kept.keptAhead({ programs: list.programs, startTime: list.startTime, now: NOON });
            s.progress = { asOf: new Date(NOON).toISOString(), positions: { [slotProgress.positionKey('tv.A', 'next', undefined)]: { next: slotProgress.ref(episode('A', 5), getShowData), wrapped: false } } };
            return listOf(await generate(POOL, s, NOON, keep));
        })();
        suite.check('a row kept in time airs its position\'s next episode at its instant',
            rowAt(res, thu(19, 30)).title === 'A S1E5' && kept.keptKind(rowAt(res, thu(19, 30))) === 'shifted' && rowAt(res, thu(19, 30)).slotPosition === 'next|',
            rowAt(res, thu(19, 30)) && rowAt(res, thu(19, 30)).title);

        // An insert before the stretch runs late into it: Create Lineup finds every row where the list now has it.
        const ins = kept.insertAfter({ lineup: list, index: indexAt(list, thu(19)), item: item('Clip', 12 * MIN), now: NOON });
        const l2 = { programs: ins.programs, startTime: base.startTime };
        const m2 = await createLineup(l2, sched, NOON);
        suite.check('an edit before a kept row, then Create Lineup: each row where the list has it',
            sameNight(m2, l2, ...DAYS) && rowAt(m2, thu(19, 34)) && rowAt(m2, thu(19, 34)).title === 'A S1E1',
            JSON.stringify(night(m2, thu(19), thu(21))));
    }

    suite.log('-- run late and take, as rows --');
    {
        const special = item('Long Special', 44 * MIN + 9 * SEC, 'A');
        for (const choice of [ 'late', 'take' ]) {
            const r = kept.swap({ lineup: base, index: indexAt(base, thu(19)), item: special, choice, now: NOON, schedule: sched });
            const list = { programs: r.programs, startTime: base.startTime };
            const made = await createLineup(list, sched, NOON);
            suite.check(`${choice}: the night as the list has it`,
                sameNight(made, list, ...DAYS), JSON.stringify(night(made, thu(19), thu(21))) + ' vs ' + JSON.stringify(night(list, thu(19), thu(21))));
        }
    }

    suite.log('-- a removal --');
    {
        const r = kept.removeOnly({ lineup: base, index: indexAt(base, thu(19, 30)), now: NOON, schedule: sched });
        const list = { programs: r.programs, startTime: base.startTime };
        const made = await createLineup(list, sched, NOON);
        suite.check('a removal\'s Flex stays, its slot Flex to the end, the episode at its next slot',
            sameNight(made, list, ...DAYS) && rowAt(made, thu(19, 30) + DAY).title === 'B S1E1', JSON.stringify(night(made, thu(19), thu(21))));
    }

    suite.log('-- a kept row is never moved by what is before it --');
    {
        // Kept at 7:20pm, in A's slot: A's 22 minutes don't fit before it, so they wait for A's next slot.
        const clip = Object.assign(item('Kept Clip', 5 * MIN), { kept: { edits: [ { id: 'e1', kind: 'insert', made: 'x' } ] } });
        const res = listOf(await generate(POOL, sched, NOON, [ { at: thu(19, 20), program: clip, kept: true } ]));
        suite.check('a slot before a kept row is filled only with what fits whole before it; the rest is Flex',
            rowAt(res, thu(19, 20)) && rowAt(res, thu(19, 20)).title === 'Kept Clip' && ! rowAt(res, thu(19))
                && rowAt(res, thu(19) + DAY).title === 'A S1E1' && rowAt(res, thu(19, 30)).title === 'B S1E1',
            JSON.stringify(night(res, thu(19), thu(21))));
    }

    suite.log('-- marks stay on their rows --');
    {
        // A Repeat re-airs a kept swap's item, but nothing keeps the Repeat.
        const weekly = {
            period: 7 * DAY, lateness: 24 * HOUR, maxDays: 14, flexPreference: 'distribute', pad: 5 * MIN,
            slots: [
                { time: 19 * HOUR + 30 * MIN, showId: 'tv.B', order: 'next' },
                { time: 20 * HOUR, showId: 'flex.', order: 'next' },
                { time: 2 * DAY + 19 * HOUR + 30 * MIN, showId: 'tv.B', order: 'repeat', repeatOf: 19 * HOUR + 30 * MIN },
                { time: 2 * DAY + 20 * HOUR, showId: 'flex.', order: 'next' },
            ],
        };
        const special = Object.assign(item('B Repeat Special', 22 * MIN, 'B'), { kept: { edits: [ { id: 'e1', kind: 'swap', show: 'tv.B', made: 'x' } ] } });
        const res = listOf(await generate(seasonOf('B', 40), weekly, NOON, [ { at: thu(19, 30), program: special, kept: true } ]));
        const sat = rowAt(res, thu(19, 30) + 2 * DAY);
        suite.check('a Repeat of a kept row re-airs it, and nothing keeps the Repeat',
            sat && sat.title === 'B Repeat Special' && sat.slotPosition === 'repeat' && ! sat.kept && kept.keptKind(rowAt(res, thu(19, 30))) === 'swap',
            sat ? JSON.stringify(sat) : 'nothing Sat 7:30');

        // An episode from a row kept in time, in the pool: aired by its slot, it carries no mark.
        const marked = seasonOf('A', 40).map( (p, i) => (i === 0) ? Object.assign({}, p, { kept: { edits: [ { id: 'e2', kind: 'shifted', made: 'x' } ] } }) : p );
        const plain = listOf(await generate(marked.concat(seasonOf('B', 40), seasonOf('C', 40), seasonOf('D', 40)), sched, NOON));
        suite.check('an episode a kept row left in the pool airs in its slot with no mark',
            rowAt(plain, thu(19)).title === 'A S1E1' && ! plain.programs.some( (p) => p.kept ), JSON.stringify(rowAt(plain, thu(19))));
    }

    return suite;
};
