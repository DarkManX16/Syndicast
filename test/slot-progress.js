/*
 * src/slot-progress.js: position keys, airing labels, episode references and
 * reading each position's place from a lineup - by label, or, for a lineup
 * saved before labels existed, by matching each airing to the slot it starts
 * in. See NOTES.md, Known issues, "Per-position stored progress, and the
 * shuffles built on it".
 *
 * Fixtures only, in the machine's own zone, with a weekly schedule whose day
 * 0 is a Thursday (slot times count from the epoch week; see slot-week.js).
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const slotProgress = require('../src/slot-progress');
const getShowData = require('../src/services/get-show-data')();

const WEEK = 7 * DAY;
// A local Thursday midnight, so slot day 0 lines up with the lineup's start.
const THU = new Date('2026-10-08T00:00:00').getTime();
const at = (day, hour, minute) => THU + day * DAY + hour * HOUR + (minute || 0) * MIN;
const slotTime = (day, hour, minute) => day * DAY + hour * HOUR + (minute || 0) * MIN;
const [Thu, Fri, Sat, Sun, Mon, Tue] = [0, 1, 2, 3, 4, 5];

function episode(show, season, n, extra) {
    return Object.assign({
        type: 'episode', showTitle: show, title: `${show} S${season}E${n}`,
        season, episode: n, duration: 22 * MIN, serverKey: 'srv', key: `/e/${show}/${season}/${n}`,
    }, extra || {});
}

// One week of programs from `start`, flex in every gap, airings at the given
// instants. Entries: [instant, program].
function lineup(start, entries) {
    const programs = [];
    let t = start;
    entries.slice().sort((a, b) => a[0] - b[0]).forEach(([when, program]) => {
        if (when > t) {
            programs.push({ isOffline: true, duration: when - t });
            t = when;
        }
        programs.push(program);
        t += program.duration;
    });
    if (start + WEEK > t) {
        programs.push({ isOffline: true, duration: start + WEEK - t });
    }
    return programs;
}

const JB = 'Johnny Bravo';
const jbSlots = () => ({
    period: WEEK,
    slots: [
        { time: slotTime(Thu, 21), showId: 'tv.' + JB, order: 'next' },
        { time: slotTime(Fri, 21), showId: 'tv.' + JB, order: 'next', seasons: { excludeSeasons: [1] } },
        { time: slotTime(Sat, 21), showId: 'tv.' + JB, order: 'next', seasons: { excludeSeasons: [1] } },
        { time: slotTime(Sun, 21), showId: 'tv.' + JB, order: 'next', seasons: { excludeSeasons: [2] } },
    ],
});
const ALL = slotProgress.positionKey('tv.' + JB, 'next', undefined);
const NO1 = slotProgress.positionKey('tv.' + JB, 'next', { excludeSeasons: [1] });
const NO2 = slotProgress.positionKey('tv.' + JB, 'next', { excludeSeasons: [2] });

const read = (programs, start, now, schedule) =>
    slotProgress.readPlaces({ programs, startTime: start, now, schedule, getShowData });
const titleOf = (place) => (place ? place.program.title : 'none');

module.exports = async function () {
    const suite = new Suite('slot-progress');

    suite.log('-- keys and labels --');
    suite.check('positionKey ignores startSeason',
        slotProgress.positionKey('tv.A', 'next', { excludeSeasons: [2, 1], startSeason: 3 }) === '["tv.A","next",[1,2]]',
        slotProgress.positionKey('tv.A', 'next', { excludeSeasons: [2, 1], startSeason: 3 }));
    suite.check('A constraint that asks for nothing keys like none at all',
        slotProgress.positionKey('tv.A', 'next', { excludeSeasons: [] }) === slotProgress.positionKey('tv.A', 'next', undefined));
    const shuffleLabel = slotProgress.label('shuffle', { excludeSeasons: [1] }, 4);
    suite.check('label round-trips', shuffleLabel === 'shuffle|1|4'
        && JSON.stringify(slotProgress.parseLabel(shuffleLabel)) === JSON.stringify({ mode: 'shuffle', excluded: [1], round: 4 }),
        shuffleLabel);
    suite.check('A Play Next label has no round',
        JSON.stringify(slotProgress.parseLabel('next|')) === JSON.stringify({ mode: 'next', excluded: [], round: null })
            && slotProgress.label('next', { excludeSeasons: [2] }) === 'next|2');
    suite.check('A repeat label is just "repeat"',
        slotProgress.label('repeat', undefined) === 'repeat'
            && slotProgress.parseLabel('repeat').mode === 'repeat');
    suite.check('Anything unparseable is null',
        [undefined, '', 'next', 'bogus|1', 'shuffle|1', 'next|x', 'shuffle||-1'].every((s) => slotProgress.parseLabel(s) === null));
    suite.check('constraintOf prefers the slot, then the old per-show map',
        slotProgress.constraintOf({ showId: 'tv.A', seasons: { excludeSeasons: [1] } }, { showConstraints: { 'tv.A': { excludeSeasons: [2] } } }).excludeSeasons[0] === 1
            && slotProgress.constraintOf({ showId: 'tv.A' }, { showConstraints: { 'tv.A': { excludeSeasons: [2] } } }).excludeSeasons[0] === 2
            && slotProgress.constraintOf({ showId: 'tv.A' }, {}) === undefined);
    suite.check('ref is the file key and getShowData\'s order',
        JSON.stringify(slotProgress.ref(episode(JB, 2, 7), getShowData)) === JSON.stringify({ key: `srv|/e/${JB}/2/7`, order: 2000007 }));

    suite.log('-- reading places from a lineup saved before labels --');
    {
        const programs = lineup(THU, [
            [at(Thu, 21), episode(JB, 1, 28)],
            [at(Fri, 21), episode(JB, 2, 7)],
            [at(Sat, 21), episode(JB, 2, 8)],
            [at(Sun, 21), episode(JB, 1, 34)],
        ]);
        const places = read(programs, THU, at(Fri, 10), jbSlots());
        suite.check('two ranges of one show read separately',
            places.size === 3 && titleOf(places.get(ALL)) === `${JB} S1E28`
                && titleOf(places.get(NO1)) === `${JB} S2E7` && titleOf(places.get(NO2)) === `${JB} S1E34`,
            [ALL, NO1, NO2].map((k) => titleOf(places.get(k))).join(', '));
        suite.check('...and the wrapped one starts a cycle later',
            places.get(ALL).start === at(Thu, 21) + WEEK);

        const onAir = read(programs, THU, at(Fri, 21, 5), jbSlots()).get(NO1);
        suite.check('the airing on air counts as not aired',
            titleOf(onAir) === `${JB} S2E7` && onAir.start === at(Fri, 21), titleOf(onAir));

        // The rotation point the editor would leave behind is Fri 9pm; an hour
        // and a half later S2E7 has finished, so the place is Saturday's.
        const rotated = lineup(at(Fri, 21), [
            [at(Fri, 21), episode(JB, 2, 7)],
            [at(Sat, 21), episode(JB, 2, 8)],
            [at(Sun, 21), episode(JB, 1, 34)],
            [at(Thu, 21) + WEEK, episode(JB, 1, 28)],
        ]);
        suite.check('now is the click, not programs[0]',
            titleOf(read(rotated, at(Fri, 21), at(Fri, 22, 30), jbSlots()).get(NO1)) === `${JB} S2E8`);

        const window = slotProgress.airings({
            programs, startTime: THU, from: at(Fri, 10), to: at(Sun, 23), schedule: jbSlots(), getShowData,
        });
        suite.check('airings lists each airing in a window with its position',
            JSON.stringify(window.map((a) => [titleOf(a), a.start, a.key])) === JSON.stringify([
                [`${JB} S2E7`, at(Fri, 21), NO1], [`${JB} S2E8`, at(Sat, 21), NO1], [`${JB} S1E34`, at(Sun, 21), NO2],
            ]), JSON.stringify(window.map((a) => [titleOf(a), a.key])));

        const once = read(programs, THU, at(Fri, 10) + WEEK, jbSlots());
        const twice = read(programs, THU, at(Fri, 10) + 2 * WEEK, jbSlots());
        suite.check('a looped lineup reads the cycle',
            [ALL, NO1, NO2].every((k) => titleOf(once.get(k)) === titleOf(twice.get(k))
                && twice.get(k).start - once.get(k).start === WEEK)
                && once.size === 3 && twice.size === 3);
    }
    {
        const schedule = {
            period: WEEK,
            slots: [
                { time: slotTime(Thu, 18), showId: 'tv.Doug', order: 'next' },
                { time: slotTime(Sat, 6), showId: 'tv.Doug', order: 'shuffle' },
                { time: slotTime(Sat, 7), showId: 'tv.Recess', order: 'next' },
            ],
        };
        const programs = lineup(THU, [
            [at(Thu, 18), episode('Doug', 1, 4)],
            [at(Sat, 6), episode('Doug', 5, 26, { shuffleOrder: 7 })],
            // a different show sitting in Recess's slot: not Recess's place
            [at(Sat, 7), episode('Doug', 3, 3)],
            [at(Sat, 7, 30), episode('Recess', 1, 2)],
        ]);
        const places = read(programs, THU, at(Thu, 12), schedule);
        const dougShuffle = places.get(slotProgress.positionKey('tv.Doug', 'shuffle', undefined));
        suite.check('old lineups are read by slot',
            titleOf(places.get(slotProgress.positionKey('tv.Doug', 'next', undefined))) === 'Doug S1E4'
                && titleOf(places.get(slotProgress.positionKey('tv.Recess', 'next', undefined))) === 'Recess S1E2',
            JSON.stringify([...places.keys()]));
        suite.check('...a Shuffle airing gives its old number',
            dougShuffle && dougShuffle.legacyShuffleOrder === 7 && dougShuffle.round === null);
        suite.check('...an airing of another show in a slot is nobody\'s place', places.size === 3);

        // Friday's and Saturday's Shuffle slots share a position. From Friday
        // noon, Saturday's airing comes first, but it has no number - Ron
        // replaced it by hand - so the place is next Friday's.
        const extended = { period: WEEK, slots: schedule.slots.concat([{ time: slotTime(Fri, 6), showId: 'tv.Doug', order: 'shuffle' }]) };
        const fromHand = read(lineup(THU, [
            [at(Fri, 6), episode('Doug', 1, 9, { shuffleOrder: 1 })],
            [at(Sat, 6), episode('Doug', 5, 5)],
        ]), THU, at(Fri, 12), extended).get(slotProgress.positionKey('tv.Doug', 'shuffle', undefined));
        suite.check('...a Shuffle airing with no number was placed by hand and is skipped',
            titleOf(fromHand) === 'Doug S1E9' && fromHand.legacyShuffleOrder === 1 && fromHand.start === at(Fri, 6) + WEEK,
            titleOf(fromHand));
    }

    suite.log('-- reading places from a labelled lineup --');
    {
        const schedule = {
            period: WEEK,
            slots: [Thu, Fri, Sat].map((d) => ({ time: slotTime(d, 21), showId: 'tv.' + JB, order: 'next' })),
        };
        const programs = lineup(THU, [
            [at(Thu, 21), episode(JB, 1, 3, { slotPosition: 'next|' })],
            [at(Fri, 21), episode(JB, 9, 9)],
            [at(Sat, 21), episode(JB, 1, 4, { slotPosition: 'next|' })],
        ]);
        suite.check('a hand-replaced airing is skipped',
            titleOf(read(programs, THU, at(Thu, 22), schedule).get(ALL)) === `${JB} S1E4`);

        const withRepeat = lineup(THU, [
            [at(Thu, 21), episode(JB, 1, 3, { slotPosition: 'next|' })],
            [at(Fri, 21), episode(JB, 1, 3, { slotPosition: 'repeat' })],
            [at(Sat, 21), episode(JB, 1, 4, { slotPosition: 'next|' })],
        ]);
        suite.check('a repeat-labelled airing is ignored',
            titleOf(read(withRepeat, THU, at(Thu, 22), schedule).get(ALL)) === `${JB} S1E4`);

        // Labels name the position even when the schedule has moved on since.
        const shuffled = lineup(THU, [
            [at(Fri, 21), episode(JB, 4, 2, { slotPosition: 'shuffle|1,2|3' })],
        ]);
        const place = read(shuffled, THU, at(Thu, 22), { period: WEEK, slots: [] })
            .get(slotProgress.positionKey('tv.' + JB, 'shuffle', { excludeSeasons: [2, 1] }));
        suite.check('a label gives the position and its round, whatever the schedule says now',
            titleOf(place) === `${JB} S4E2` && place.round === 3 && place.legacyShuffleOrder === null);

        // Until rounds replace the old shuffler, its airings carry a label and
        // its number, and the next run needs the number.
        const oldShuffler = lineup(THU, [
            [at(Fri, 21), episode(JB, 4, 2, { slotPosition: 'shuffle||0', shuffleOrder: 12 })],
        ]);
        const kept = read(oldShuffler, THU, at(Thu, 22), { period: WEEK, slots: [] })
            .get(slotProgress.positionKey('tv.' + JB, 'shuffle', undefined));
        suite.check('a labelled Shuffle airing keeps its old number',
            titleOf(kept) === `${JB} S4E2` && kept.legacyShuffleOrder === 12);
    }

    suite.log('-- season start is a seek --');
    {
        const seasonConstraints = require('../web/services/season-constraints')();
        const a = { time: slotTime(Mon, 9), showId: 'tv.A', order: 'next', seasons: { excludeSeasons: [1], startSeason: 2 } };
        const b = { time: slotTime(Tue, 9), showId: 'tv.A', order: 'next', seasons: { excludeSeasons: [1], startSeason: 3 } };
        suite.check('slots with one range and different seeks share a position',
            seasonConstraints.sharingPosition([a, b], a) === 2 && seasonConstraints.sameRange(a, b));
        const seeking = { time: slotTime(Mon, 9), showId: 'tv.A', order: 'next', seasons: { excludeSeasons: [], startSeason: 3 } };
        seasonConstraints.tidy(seeking);
        suite.check('...and a slot that only seeks keeps its seek',
            seeking.seasons && seeking.seasons.startSeason === 3 && seasonConstraints.isConstrained(seeking));
        const none = { time: slotTime(Mon, 9), showId: 'tv.A', order: 'next', seasons: { excludeSeasons: [] } };
        seasonConstraints.tidy(none);
        suite.check('...while one asking for nothing is tidied away', typeof none.seasons === 'undefined');

        const schedule = { period: WEEK, slots: [a, b, { time: slotTime(Sat, 9), showId: 'tv.A', order: 'next', seasons: { excludeSeasons: [1] } }] };
        // From Monday noon, Tuesday's slot airs before next Monday's.
        suite.check('seekOf picks the slot airing first from now',
            slotProgress.seekOf(schedule.slots, schedule, at(Mon, 12)) === 3
                && slotProgress.seekOf(schedule.slots, schedule, at(Sun, 12)) === 2,
            `${slotProgress.seekOf(schedule.slots, schedule, at(Mon, 12))}, ${slotProgress.seekOf(schedule.slots, schedule, at(Sun, 12))}`);
        suite.check('...and is null when no slot seeks',
            slotProgress.seekOf([schedule.slots[2]], schedule, at(Mon, 12)) === null);
    }

    suite.log('-- references --');
    {
        const custom = (title, order) => ({
            type: 'episode', showTitle: 'Tom and Jerry', title, season: 1, episode: order + 1,
            customShowId: 'tj', customShowName: 'Tom & Jerry', customOrder: order,
            duration: 7 * MIN, serverKey: 'srv', key: '/tj/' + title,
        });
        const before = ['Puss Gets the Boot', 'The Midnight Snack', 'The Night Before Christmas', 'Fraidy Cat']
            .map((title, i) => custom(title, i));
        const place = slotProgress.ref(before[2], getShowData);
        // An item inserted at the front of the custom show moves every order on by one.
        const after = [custom('Dog Trouble', 0)].concat(before.map((p, i) => custom(p.title, i + 1)));
        const index = slotProgress.resolveRef(place, after, getShowData);
        suite.check('a reference resolves by key', after[index].title === 'The Night Before Christmas' && index === 3,
            `${index}: ${after[index] && after[index].title}`);

        const seasons = [episode(JB, 1, 1), episode(JB, 1, 3), episode(JB, 2, 1)];
        const gone = { key: `srv|/e/${JB}/1/2`, order: 1000002 };
        suite.check('a gone episode resolves to the next one',
            slotProgress.resolveRef(gone, seasons, getShowData) === 1);
        suite.check('past the end wraps to the first',
            slotProgress.resolveRef({ key: 'srv|/gone', order: 9000001 }, seasons, getShowData) === 0);
    }

    suite.log('-- slotAt --');
    {
        const schedule = jbSlots();
        suite.check('slotAt finds the slot covering an instant',
            slotProgress.slotAt(schedule, at(Fri, 23)).time === slotTime(Fri, 21)
                && slotProgress.slotAt(schedule, at(Thu, 3)).time === slotTime(Sun, 21));
        suite.check('slotAt leaves the schedule alone',
            JSON.stringify(schedule) === JSON.stringify(jbSlots()));
        suite.check('slotAt with no slots is null', slotProgress.slotAt({ period: WEEK, slots: [] }, at(Fri, 23)) === null);
    }

    return suite;
};
