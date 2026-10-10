/*
 * The slot generators and stored progress: every airing carries its
 * position's label, no Play Next airing carries a Shuffle number, a record in
 * schedule.progress sets a position's place, and with no record a position
 * starts where it always did - the founder rule. See NOTES.md, Known issues,
 * "Per-position stored progress, and the shuffles built on it".
 *
 * The real time-slots-service with the clock frozen, on fixtures in the
 * machine's own zone.
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const timeSlotsService = require('../src/services/time-slots-service');
const randomSlotsService = require('../src/services/random-slots-service');
const slotProgress = require('../src/slot-progress');
const getShowData = require('../src/services/get-show-data')();

const WEEK = 7 * DAY;
const THU = new Date('2026-10-08T00:00:00').getTime();
const slotTime = (day, hour, minute) => day * DAY + hour * HOUR + (minute || 0) * MIN;
const [Thu, Fri, Sat, Sun, Mon] = [0, 1, 2, 3, 4];

function episode(show, season, n, extra) {
    return Object.assign({
        type: 'episode', showTitle: show, title: `${show} S${season}E${n}`,
        season, episode: n, duration: 22 * MIN, serverKey: 'srv', key: `/e/${show}/${season}/${n}`,
    }, extra || {});
}
function seasons(show, count, perSeason, extra) {
    const out = [];
    for (let s = 1; s <= count; s++) {
        for (let e = 1; e <= perSeason; e++) {
            out.push(episode(show, s, e, extra));
        }
    }
    return out;
}

async function generate(programs, schedule, now) {
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(now); else super(...a); }
        static now() { return now; }
    }
    global.Date = FrozenDate;
    try {
        return await timeSlotsService(JSON.parse(JSON.stringify(programs)), JSON.parse(JSON.stringify(schedule)));
    } finally {
        global.Date = RealDate;
    }
}

// Each program of a generated lineup with its start.
function withStarts(res) {
    let t = Date.parse(res.startTime);
    return res.programs.map((p) => { const a = { start: t, program: p }; t += p.duration; return a; });
}

const JB = 'Johnny Bravo';
function jbSchedule() {
    return {
        period: WEEK, lateness: 0, maxDays: 21, flexPreference: 'distribute', pad: 5 * MIN,
        slots: [
            { time: slotTime(Thu, 21), showId: 'tv.' + JB, order: 'next' },
            { time: slotTime(Fri, 21), showId: 'tv.' + JB, order: 'next', seasons: { excludeSeasons: [1] } },
            { time: slotTime(Sun, 21), showId: 'tv.' + JB, order: 'next', seasons: { excludeSeasons: [2] } },
            { time: slotTime(Mon, 18), showId: 'tv.Hey Arnold!', order: 'next' },
            { time: slotTime(Fri, 16), showId: 'tv.Hey Arnold!', order: 'shuffle' },
            { time: slotTime(Thu, 22), showId: 'flex.', order: 'next' },
        ],
    };
}
// The pool in the order the editor hands it over: rotated so the program on
// air comes first, so each show's founder is its next airing.
function jbPool(extra) {
    return [episode(JB, 2, 7, extra)].concat(seasons(JB, 3, 10, extra).filter((p) => p.title !== `${JB} S2E7`))
        .concat(seasons('Hey Arnold!', 2, 10, extra));
}
const ALL = slotProgress.positionKey('tv.' + JB, 'next', undefined);
const NO1 = slotProgress.positionKey('tv.' + JB, 'next', { excludeSeasons: [1] });
const NO2 = slotProgress.positionKey('tv.' + JB, 'next', { excludeSeasons: [2] });
// Friday 10am: Friday's no-S1 airing is the next Johnny Bravo.
const NOW = THU + DAY + 10 * HOUR;

function firstBy(res, schedule) {
    const out = new Map();
    for (const a of slotProgress.airings({
        programs: res.programs, startTime: Date.parse(res.startTime), from: NOW, to: NOW + 14 * DAY, schedule, getShowData,
    })) {
        if (a.key !== null && !out.has(a.key)) out.set(a.key, a.program.title);
    }
    return out;
}

module.exports = async function () {
    const suite = new Suite('progress-generators');

    suite.log('-- labels --');
    {
        const schedule = jbSchedule();
        const res = await generate(jbPool({ shuffleOrder: 3 }), schedule, NOW);
        const shows = withStarts(res).filter((a) => !a.program.isOffline);
        const wrong = shows.filter((a) => {
            const parsed = slotProgress.parseLabel(a.program.slotPosition);
            const slot = slotProgress.slotAt(schedule, a.start);
            return parsed === null || slot === null || parsed.mode !== slot.order
                || JSON.stringify(parsed.excluded) !== JSON.stringify(slotProgress.excludedOf(slot.seasons));
        });
        suite.check('every airing carries its position', shows.length > 0 && wrong.length === 0,
            `${shows.length} airings, ${wrong.length} wrong: ` + wrong.slice(0, 3).map((a) => a.program.title + ' ' + a.program.slotPosition).join(', '));

        const nextAirings = shows.filter((a) => /^next\|/.test(a.program.slotPosition));
        suite.check('Play Next airings never carry a Shuffle number',
            nextAirings.length > 0 && nextAirings.every((a) => typeof a.program.shuffleOrder === 'undefined'),
            nextAirings.filter((a) => typeof a.program.shuffleOrder !== 'undefined').length + ' carry one');

        const shuffleAirings = shows.filter((a) => /^shuffle\|/.test(a.program.slotPosition));
        suite.check('...Shuffle airings still carry the old shuffler\'s number',
            shuffleAirings.length > 0 && shuffleAirings.every((a) => typeof a.program.shuffleOrder === 'number'));

        suite.check('...and each airing is its own copy',
            new Set(res.programs.filter((p) => !p.isOffline)).size === res.programs.filter((p) => !p.isOffline).length);
    }

    suite.log('-- where positions start --');
    {
        const res = await generate(jbPool(), jbSchedule(), NOW);
        const first = firstBy(res, jbSchedule());
        suite.check('no record: each range starts as the founder rule says',
            first.get(NO1) === `${JB} S2E7` && first.get(ALL) === `${JB} S2E7` && first.get(NO2) === `${JB} S3E1`,
            [ALL, NO1, NO2].map((k) => first.get(k)).join(', '));

        const schedule = jbSchedule();
        schedule.progress = {
            asOf: new Date(NOW).toISOString(),
            positions: {
                [NO2]: { next: slotProgress.ref(episode(JB, 1, 5), getShowData), wrapped: false },
                [ALL]: { next: slotProgress.ref(episode(JB, 2, 3), getShowData), wrapped: false },
            },
        };
        const placed = firstBy(await generate(jbPool(), schedule, NOW), schedule);
        suite.check('a record sets the place',
            placed.get(NO2) === `${JB} S1E5` && placed.get(ALL) === `${JB} S2E3` && placed.get(NO1) === `${JB} S2E7`,
            [ALL, NO1, NO2].map((k) => placed.get(k)).join(', '));

        // Hey Arnold's weekday strip is founded by Friday's Shuffle airing today;
        // a record keeps it on its own place.
        const arnold = jbSchedule();
        arnold.progress = {
            asOf: new Date(NOW).toISOString(),
            positions: { [slotProgress.positionKey('tv.Hey Arnold!', 'next', undefined)]: { next: slotProgress.ref(episode('Hey Arnold!', 1, 9), getShowData) } },
        };
        const strip = firstBy(await generate([episode('Hey Arnold!', 2, 4)].concat(jbPool()), arnold, NOW), arnold)
            .get(slotProgress.positionKey('tv.Hey Arnold!', 'next', undefined));
        suite.check('...whichever airs first', strip === 'Hey Arnold! S1E9', strip);

        const legacy = jbSchedule();
        legacy.progress = {
            asOf: new Date(NOW).toISOString(),
            positions: { [slotProgress.positionKey('tv.Hey Arnold!', 'shuffle', undefined)]: { legacyShuffleOrder: 5 } },
        };
        const shuffled = withStarts(await generate(jbPool(), legacy, NOW))
            .filter((a) => /^shuffle\|/.test(a.program.slotPosition || '') && a.start >= NOW);
        suite.check('a Shuffle record starts the old shuffler at its number',
            shuffled.length > 0 && shuffled[0].program.shuffleOrder === 5, shuffled.length ? String(shuffled[0].program.shuffleOrder) : 'none');
    }

    suite.log('-- random slots --');
    {
        const RealDate = Date;
        class FrozenDate extends RealDate {
            constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
            static now() { return NOW; }
        }
        global.Date = FrozenDate;
        let res;
        try {
            res = await randomSlotsService(jbPool({ shuffleOrder: 2 }), {
                period: DAY, maxDays: 3, pad: 5 * MIN, flexPreference: 'distribute', padStyle: 'slot',
                slots: [
                    { duration: 30 * MIN, showId: 'tv.' + JB, order: 'next', cooldown: 0, weight: 1 },
                    { duration: 30 * MIN, showId: 'tv.Hey Arnold!', order: 'shuffle', cooldown: 0, weight: 1 },
                ],
            });
        } finally {
            global.Date = RealDate;
        }
        const shows = res.programs.filter((p) => !p.isOffline);
        suite.check('Random Slots airings carry their positions too',
            shows.length > 0 && shows.every((p) => slotProgress.parseLabel(p.slotPosition) !== null)
                && shows.filter((p) => /^next\|/.test(p.slotPosition)).every((p) => typeof p.shuffleOrder === 'undefined'));
    }

    return suite;
};
