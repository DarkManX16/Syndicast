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
const rounds = require('../src/shuffle-rounds');
const multiPart = require('../src/multi-part');
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

    suite.log('-- the planner --');
    {
        // Johnny Bravo seasons 1-3, ten episodes each, as the editor's pool.
        const pool = [];
        for (let s = 1; s <= 3; s++) for (let e = 1; e <= 10; e++) pool.push(episode(JB, s, e));
        pool.push(...[1, 2, 3].map((e) => episode('Doug', 1, e)));
        const savedLineup = () => lineup(THU, [
            [at(Thu, 21), episode(JB, 1, 8)],
            [at(Fri, 21), episode(JB, 2, 7)],
            [at(Sat, 21), episode(JB, 2, 8)],
            [at(Sun, 21), episode(JB, 1, 4)],
        ]);
        const NOW = at(Fri, 10);
        const plan = (schedule, opened, programs) => slotProgress.planProgress({
            programs: programs || savedLineup(), startTime: THU, now: NOW,
            openedSchedule: opened || jbSlots(), schedule, pool, getShowData,
        });
        const nextOf = (result, key) => {
            const r = result.positions[key];
            if (!r || !r.next) return r ? JSON.stringify(r) : 'none';
            return pool.find((p) => slotProgress.ref(p, getShowData).key === r.next.key).title.replace(JB + ' ', '');
        };
        const NO12 = slotProgress.positionKey('tv.' + JB, 'next', { excludeSeasons: [1, 2] });
        const NO3 = slotProgress.positionKey('tv.' + JB, 'next', { excludeSeasons: [3] });
        const NO13 = slotProgress.positionKey('tv.' + JB, 'next', { excludeSeasons: [1, 3] });

        const same = plan(jbSlots());
        suite.check('the lineup sets each place (rule 2)',
            nextOf(same, ALL) === 'S1E8' && nextOf(same, NO1) === 'S2E7' && nextOf(same, NO2) === 'S1E4'
                && same.asOf === new Date(NOW).toISOString(),
            [ALL, NO1, NO2].map((k) => nextOf(same, k)).join(', '));

        const seeking = jbSlots();
        seeking.slots[1].seasons = { excludeSeasons: [1], startSeason: 3 };
        suite.check('a seek beats the lineup (rule 1)', nextOf(plan(seeking), NO1) === 'S3E1', nextOf(plan(seeking), NO1));

        // Sunday's no-S2 slots were taken out at an earlier run; its record stayed.
        const opened = jbSlots();
        opened.slots = opened.slots.filter((s) => s.time !== slotTime(Sun, 21));
        opened.progress = { asOf: new Date(NOW - DAY).toISOString(), positions: {
            [NO2]: { next: slotProgress.ref(episode(JB, 1, 5), getShowData), wrapped: false },
        } };
        const withoutSunday = lineup(THU, [[at(Thu, 21), episode(JB, 1, 8)], [at(Fri, 21), episode(JB, 2, 7)]]);
        suite.check('a range taken out and put back resumes from its record (rule 3)',
            nextOf(plan(jbSlots(), opened, withoutSunday), NO2) === 'S1E5');

        const narrowed = jbSlots();
        narrowed.slots[1].seasons = { excludeSeasons: [1, 2] };
        narrowed.slots[2].seasons = { excludeSeasons: [1, 2] };
        narrowed.slots[0].seasons = { excludeSeasons: [3] };
        const n = plan(narrowed);
        suite.check('narrowing a range keeps the slot\'s place, moved forward (rule 4)',
            nextOf(n, NO12) === 'S3E1' && nextOf(n, NO3) === 'S1E8', `${nextOf(n, NO12)}, ${nextOf(n, NO3)}`);

        // Full catalogs: the lineup lacks S3E1, the show's catalog has it.
        const thinned = pool.filter((p) => !(p.showTitle === JB && p.season === 3 && p.episode === 1));
        const fromCatalog = slotProgress.planProgress({ programs: savedLineup(), startTime: THU, now: NOW,
            openedSchedule: jbSlots(), schedule: narrowed, pool: thinned, catalog: pool, getShowData });
        const fromLineup = slotProgress.planProgress({ programs: savedLineup(), startTime: THU, now: NOW,
            openedSchedule: jbSlots(), schedule: narrowed, pool: thinned, getShowData });
        suite.check('a narrowed range moves forward through the catalog, not only the lineup',
            nextOf(fromCatalog, NO12) === 'S3E1' && nextOf(fromLineup, NO12) === 'S3E2', `${nextOf(fromCatalog, NO12)}, ${nextOf(fromLineup, NO12)}`);
        const noS1E1 = pool.filter((p) => !(p.showTitle === JB && p.season === 2 && p.episode === 1));
        const brandNew = jbSlots();
        brandNew.slots.push({ time: slotTime(Mon, 21), showId: 'tv.' + JB, order: 'next', seasons: { excludeSeasons: [1, 3] } });
        suite.check('...and a brand-new slot starts at the catalog\'s first episode of its range',
            nextOf(slotProgress.planProgress({ programs: savedLineup(), startTime: THU, now: NOW, openedSchedule: jbSlots(), schedule: brandNew,
                pool: noS1E1, catalog: pool, getShowData }), NO13) === 'S2E1');
        const neverAired = pool.filter((p) => p.showTitle === JB && !(p.season === 1 && p.episode === 8));
        const placeOnIt = plan(jbSlots()).positions[ALL].next;
        suite.check('a Play Next place on a never-air episode moves to the next',
            neverAired[slotProgress.resolveRef(placeOnIt, neverAired, getShowData)].title === JB + ' S1E9');

        const added = jbSlots();
        added.slots.push({ time: slotTime(Mon, 21), showId: 'tv.' + JB, order: 'next', seasons: { excludeSeasons: [1, 3] } });
        suite.check('a brand-new slot starts at the first episode of its range (rule 5)', nextOf(plan(added), NO13) === 'S2E1');

        const doug = { period: WEEK, slots: [{ time: slotTime(Sat, 6), showId: 'tv.Doug', order: 'shuffle' }] };
        const dougNext = { period: WEEK, slots: [{ time: slotTime(Sat, 6), showId: 'tv.Doug', order: 'next' }] };
        const dougLineup = lineup(THU, [[at(Sat, 6), episode('Doug', 1, 3, { shuffleOrder: 2 })]]);
        const modeChange = slotProgress.planProgress({ programs: dougLineup, startTime: THU, now: NOW,
            openedSchedule: doug, schedule: dougNext, pool, getShowData });
        suite.check('a mode change starts at the first episode',
            modeChange.positions[slotProgress.positionKey('tv.Doug', 'next', undefined)].next.key === slotProgress.ref(episode('Doug', 1, 1), getShowData).key);
        const DOUG = slotProgress.positionKey('tv.Doug', 'shuffle', undefined);
        const dougSorted = [1, 2, 3].map((e) => episode('Doug', 1, e));
        const kept = slotProgress.planProgress({ programs: dougLineup, startTime: THU, now: NOW,
            openedSchedule: doug, schedule: doug, pool, getShowData }).positions[DOUG];
        const oldRound = rounds.legacyRound(dougSorted, 'tv.Doug', 0);
        suite.check('a Shuffle position\'s old number becomes the rest of its round',
            kept && kept.round === 0 && kept.queue.map((r) => r.key).join() === oldRound.slice(2).map((p) => slotProgress.ref(p, getShowData).key).join()
                && kept.laterHalf.length === 1 && kept.laterHalf[0] === slotProgress.ref(oldRound[2], getShowData).key,
            JSON.stringify(kept));

        const widerDoug = pool.concat([4, 5].map((e) => episode('Doug', 1, e)));
        const keptWider = slotProgress.planProgress({ programs: dougLineup, startTime: THU, now: NOW,
            openedSchedule: doug, schedule: doug, pool, catalog: widerDoug, getShowData }).positions[DOUG];
        suite.check('a carried round is rebuilt from the lineup\'s list, not the catalog',
            JSON.stringify(keptWider) === JSON.stringify(kept), JSON.stringify(keptWider));

        // A labelled lineup: the place's round, and the deferred stories of that round.
        const dougStories = multiPart.stories(dougSorted);
        const labelledDoug = lineup(THU, [[at(Sat, 6), episode('Doug', 1, 2, { slotPosition: 'shuffle||4' })]]);
        const asOfDoug = (record) => Object.assign({}, doug, { progress: { asOf: new Date(NOW - DAY).toISOString(), positions: { [DOUG]: record } } });
        const k3 = slotProgress.ref(episode('Doug', 1, 3), getShowData).key;
        const same4 = slotProgress.planProgress({ programs: labelledDoug, startTime: THU, now: NOW,
            openedSchedule: asOfDoug({ round: 4, next: slotProgress.ref(episode('Doug', 1, 1), getShowData), deferred: [k3] }), schedule: doug, pool, getShowData }).positions[DOUG];
        suite.check('a labelled Shuffle place gives its round, next and deferred',
            same4.round === 4 && same4.next.key === slotProgress.ref(episode('Doug', 1, 2), getShowData).key && same4.deferred.join() === k3,
            JSON.stringify(same4));
        const chained = slotProgress.planProgress({ programs: labelledDoug, startTime: THU, now: NOW,
            openedSchedule: asOfDoug({ round: 2, next: slotProgress.ref(episode('Doug', 1, 1), getShowData), deferred: [] }), schedule: doug, pool, getShowData }).positions[DOUG];
        const r2 = rounds.roundOrder({ seed: DOUG, round: 2, stories: dougStories, laterHalf: new Set() });
        const r3 = rounds.roundOrder({ seed: DOUG, round: 3, stories: dougStories, laterHalf: rounds.laterHalfOf(r2) });
        suite.check('...and rounds that passed in the lineup chain their later halves',
            chained.round === 4 && chained.deferred.join() === [...rounds.laterHalfOf(r3)].join(), JSON.stringify(chained));
        const queued = slotProgress.planProgress({ programs: labelledDoug, startTime: THU, now: NOW,
            openedSchedule: asOfDoug({ round: 4, queue: [3, 2, 1].map((e) => slotProgress.ref(episode('Doug', 1, e), getShowData)), laterHalf: [k3] }), schedule: doug, pool, getShowData }).positions[DOUG];
        suite.check('...a place inside a carried round keeps the rest of it',
            queued.round === 4 && queued.queue.map((r) => r.key).join() === [2, 1].map((e) => slotProgress.ref(episode('Doug', 1, e), getShowData).key).join()
                && queued.laterHalf.join() === k3, JSON.stringify(queued));

        // Saturday's Shuffle slot gets a range: the rest of its old round, minus what the range leaves out.
        const twoSeasons = pool.concat([1, 2].map((e) => episode('Doug', 2, e)));
        const dougTwo = { period: WEEK, slots: [{ time: slotTime(Sat, 6), showId: 'tv.Doug', order: 'shuffle' }] };
        const dougRanged = { period: WEEK, slots: [{ time: slotTime(Sat, 6), showId: 'tv.Doug', order: 'shuffle', seasons: { excludeSeasons: [2] } }] };
        const allDoug = multiPart.stories([1, 2, 3].map((e) => episode('Doug', 1, e)).concat([1, 2].map((e) => episode('Doug', 2, e))));
        const oldOrder = rounds.roundOrder({ seed: DOUG, round: 4, stories: allDoug, laterHalf: new Set() });
        const placeStory = oldOrder[1];
        const rangeChange = slotProgress.planProgress({ programs: lineup(THU, [[at(Sat, 6), Object.assign({}, placeStory[0], { slotPosition: 'shuffle||4' })]]),
            startTime: THU, now: NOW, openedSchedule: dougTwo, schedule: dougRanged, pool: twoSeasons, getShowData })
            .positions[slotProgress.positionKey('tv.Doug', 'shuffle', { excludeSeasons: [2] })];
        const expectedQueue = oldOrder.slice(1).map((s) => s[0]).filter((p) => p.season === 1).map((p) => slotProgress.ref(p, getShowData).key);
        suite.check('a Shuffle slot\'s range change carries the rest of its old round',
            rangeChange && rangeChange.queue.map((r) => r.key).join() === expectedQueue.join(), JSON.stringify(rangeChange));

        // Saturday and Sunday share one Shuffle; only Saturday gets the range. Sunday
        // still plays the old round, so Saturday starts a round of its own rather
        // than the same rest of it (Ron, Oct 10).
        const dougWeekend = { period: WEEK, slots: [
            { time: slotTime(Sat, 6), showId: 'tv.Doug', order: 'shuffle' },
            { time: slotTime(Sun, 6), showId: 'tv.Doug', order: 'shuffle' },
        ] };
        const satRanged = JSON.parse(JSON.stringify(dougWeekend));
        satRanged.slots[0].seasons = { excludeSeasons: [2] };
        const split = slotProgress.planProgress({ programs: lineup(THU, [[at(Sat, 6), Object.assign({}, placeStory[0], { slotPosition: 'shuffle||4' })]]),
            startTime: THU, now: NOW, openedSchedule: dougWeekend, schedule: satRanged, pool: twoSeasons, getShowData });
        suite.check('narrowing one slot of a shared Shuffle starts a round of its own',
            JSON.stringify(split.positions[slotProgress.positionKey('tv.Doug', 'shuffle', { excludeSeasons: [2] })]) === JSON.stringify({ round: 0, deferred: [] })
                && split.positions[DOUG] && split.positions[DOUG].round === 4,
            JSON.stringify(split.positions));
        const rerunWeekend = JSON.parse(JSON.stringify(dougWeekend).replace(/"shuffle"/g, '"rerun"'));
        const rerunRanged = JSON.parse(JSON.stringify(satRanged).replace(/"shuffle"/g, '"rerun"'));
        const rerunSplit = slotProgress.planProgress({ programs: lineup(THU, [[at(Sat, 6), Object.assign({}, placeStory[0], { slotPosition: 'rerun||4' })]]),
            startTime: THU, now: NOW, openedSchedule: rerunWeekend, schedule: rerunRanged, pool: twoSeasons, getShowData })
            .positions[slotProgress.positionKey('tv.Doug', 'rerun', { excludeSeasons: [2] })];
        suite.check('...and so does a Rerun', !rerunSplit || (rerunSplit.round === 0 && !Array.isArray(rerunSplit.queue)), JSON.stringify(rerunSplit));

        const newShuffle = slotProgress.planProgress({ programs: savedLineup(), startTime: THU, now: NOW,
            openedSchedule: jbSlots(), schedule: { period: WEEK, slots: jbSlots().slots.concat([{ time: slotTime(Mon, 6), showId: 'tv.Doug', order: 'shuffle' }]) }, pool, getShowData });
        suite.check('a new Shuffle position starts its first round',
            JSON.stringify(newShuffle.positions[DOUG]) === JSON.stringify({ round: 0, deferred: [] }));

        const unused = jbSlots();
        unused.progress = { asOf: new Date(NOW - DAY).toISOString(), positions: { '["tv.Gone","next",[]]': { next: { key: 'srv|/gone', order: 5 }, wrapped: true } } };
        const fewer = jbSlots();
        fewer.slots = fewer.slots.filter((s) => s.time !== slotTime(Sun, 21));
        const u = plan(fewer, unused);
        suite.check('an unused position\'s record is kept',
            JSON.stringify(u.positions['["tv.Gone","next",[]]']) === JSON.stringify(unused.progress.positions['["tv.Gone","next",[]]']));
        suite.check('...and one taken out now keeps its place from the lineup', nextOf(u, NO2) === 'S1E4');

        // Thursday's slot has no airing ahead in this lineup: the founder rule, not the first episode.
        const noAiring = lineup(THU, [[at(Fri, 21), episode(JB, 2, 7)], [at(Sat, 21), episode(JB, 2, 8)], [at(Sun, 21), episode(JB, 1, 4)]]);
        suite.check('a position with no airing ahead gets no record, so the founder rule applies',
            typeof plan(jbSlots(), jbSlots(), noAiring).positions[ALL] === 'undefined');

        const random = slotProgress.planProgress({ programs: savedLineup(), startTime: THU, now: NOW,
            openedSchedule: { slots: [{ duration: 30 * MIN, showId: 'tv.' + JB, order: 'next' }] },
            schedule: { slots: [{ duration: 30 * MIN, showId: 'tv.' + JB, order: 'next' }] }, pool, getShowData });
        suite.check('Random Slots without labels: no record', Object.keys(random.positions).length === 0);

        // A labelled lineup made at the last run: the strip went from S3E10 to S1E1 since.
        const sinceLast = { period: WEEK, slots: [Thu, Fri, Sat].map((d) => ({ time: slotTime(d, 21), showId: 'tv.' + JB, order: 'next' })) };
        sinceLast.progress = { asOf: new Date(THU).toISOString(), positions: { [ALL]: { next: slotProgress.ref(episode(JB, 3, 10), getShowData), wrapped: false } } };
        const went = lineup(THU, [
            [at(Thu, 21), episode(JB, 3, 10, { slotPosition: 'next|' })],
            [at(Fri, 21), episode(JB, 1, 1, { slotPosition: 'next|' })],
            [at(Sat, 21), episode(JB, 1, 2, { slotPosition: 'next|' })],
        ]);
        const wrap = slotProgress.planProgress({ programs: went, startTime: THU, now: at(Sat, 12),
            openedSchedule: sinceLast, schedule: sinceLast, pool, getShowData });
        suite.check('a strip that went round since the last run is wrapped',
            wrap.positions[ALL].wrapped === true && nextOf(wrap, ALL) === 'S1E2');
        suite.check('...a carried-over strip is not', same.positions[ALL].wrapped === false);
    }

    suite.log('-- the planner reads what aired since the last run once --');
    {
        // 24 Play Next positions and a lineup made 20 days ago: each position's
        // airings since then come from one walk of the lineup, not one each.
        const shows = Array.from({ length: 24 }, (_, h) => 'Show' + h);
        const pool = [];
        shows.forEach((s) => { for (let e = 1; e <= 40; e++) pool.push(episode(s, 1, e, { duration: HOUR })); });
        const schedule = { period: DAY, slots: shows.map((s, h) => ({ time: h * HOUR, showId: 'tv.' + s, order: 'next' })) };
        const programs = [];
        for (let d = 0; d < 30; d++) shows.forEach((s) => programs.push(episode(s, 1, d + 1, { duration: HOUR, slotPosition: 'next|' })));
        const onAir = new Set(programs);
        let reads = 0;
        const counting = (p) => { if (onAir.has(p)) reads++; return getShowData(p); };
        const opened = Object.assign(JSON.parse(JSON.stringify(schedule)), { progress: { asOf: new Date(THU).toISOString(), positions: {} } });
        const result = slotProgress.planProgress({ programs, startTime: THU, now: THU + 20 * DAY + 30 * MIN,
            openedSchedule: opened, schedule, pool, getShowData: counting });
        suite.check('the planner reads the lineup since the last run once, not once per position',
            reads <= 4 * programs.length && Object.keys(result.positions).length === 24
                && result.positions[slotProgress.positionKey('tv.Show3', 'next', undefined)].next.key === 'srv|/e/Show3/1/21',
            `${reads} reads of a ${programs.length}-airing lineup`);
    }

    suite.log('-- Rerun records --');
    {
        const kp = [1, 2, 3, 4, 5].map((e) => episode('Kim Possible', 1, e));
        const RERUN = slotProgress.positionKey('tv.Kim Possible', 'rerun', undefined);
        const sched = { period: WEEK, slots: [
            { time: slotTime(Sat, 15, 30), showId: 'tv.Kim Possible', order: 'rerun' },
            { time: slotTime(Sun, 18), showId: 'tv.Kim Possible', order: 'rerun' },
        ] };
        const k = (e) => slotProgress.ref(kp[e - 1], getShowData).key;
        const lab = (e, r) => Object.assign({}, kp[e - 1], { slotPosition: 'rerun||' + r });
        // Made at Friday's run; Saturday and Sunday aired round 2's S1E1 and S1E2.
        const made = lineup(THU, [[at(Sat, 15, 30), lab(1, 2)], [at(Sun, 18), lab(2, 2)], [at(Sat, 15, 30) + WEEK - 1, lab(3, 2)]]);
        const opened = Object.assign({}, sched, { progress: { asOf: new Date(at(Fri, 12)).toISOString(), positions: {
            [RERUN]: { round: 2, next: slotProgress.ref(kp[0], getShowData), deferred: [k(5)], aired: [k(4)] },
        } } });
        const r = slotProgress.planProgress({ programs: made, startTime: THU, now: at(Mon, 12), openedSchedule: opened,
            schedule: sched, pool: kp, getShowData }).positions[RERUN];
        suite.check('a Rerun record keeps what aired this round',
            r.round === 2 && r.next.key === k(3) && r.aired.join() === [k(4), k(1), k(2)].join() && r.deferred.join() === k(5),
            JSON.stringify(r));

        // Round 3 began on Sunday: round 2 ended with S1E4, S1E1; its later half goes last.
        const next = lineup(THU, [[at(Sat, 15, 30), lab(1, 2)], [at(Sun, 18), lab(2, 3)], [at(Sat, 15, 30) + WEEK - 1, lab(3, 3)]]);
        const r3 = slotProgress.planProgress({ programs: next, startTime: THU, now: at(Mon, 12), openedSchedule: opened,
            schedule: sched, pool: kp, getShowData }).positions[RERUN];
        suite.check('...and the later half of what aired goes last in the next round',
            r3.round === 3 && r3.aired.join() === k(2) && r3.deferred.join() === k(1), JSON.stringify(r3));
    }

    suite.log('-- the Rerun note --');
    {
        const kp = [];
        for (let s = 1; s <= 2; s++) for (let e = 1; e <= 4; e++) kp.push(episode('Kim Possible', s, e));
        const rerun = { time: slotTime(Sat, 15, 30), showId: 'tv.Kim Possible', order: 'rerun' };
        const rerunS2 = { time: slotTime(Sun, 18), showId: 'tv.Kim Possible', order: 'rerun', seasons: { excludeSeasons: [1] } };
        const strip = { time: slotTime(Thu, 16, 30), showId: 'tv.Kim Possible', order: 'next' };
        const STRIP_KEY = slotProgress.positionKey('tv.Kim Possible', 'next', undefined);
        const note = (slots, positions, slot) => slotProgress.rerunNote({ schedule: { period: WEEK, slots },
            progress: { positions: positions || {} }, slot, pool: kp, getShowData });
        suite.check('no Play Next: the Rerun says it plays as a Shuffle, and why',
            /no Play Next/.test(note([rerun], {}, rerun) || ''), note([rerun], {}, rerun));
        suite.check('a strip that hasn\'t aired anything: it says so',
            /hasn't aired/.test(note([rerun, strip], { [STRIP_KEY]: { next: slotProgress.ref(kp[0], getShowData), wrapped: false } }, rerun) || ''));
        suite.check('...nor anything in the Rerun\'s seasons',
            /hasn't aired/.test(note([rerunS2, strip], { [STRIP_KEY]: { next: slotProgress.ref(kp[2], getShowData), wrapped: false } }, rerunS2) || ''));
        suite.check('a strip that has aired some: no note',
            note([rerun, strip], { [STRIP_KEY]: { next: slotProgress.ref(kp[2], getShowData), wrapped: false } }, rerun) === null);
        suite.check('...nor once it has gone round',
            note([rerunS2, strip], { [STRIP_KEY]: { next: slotProgress.ref(kp[0], getShowData), wrapped: true } }, rerunS2) === null);
    }

    suite.log('-- Repeat a slot, in the editor --');
    {
        const thu = { time: slotTime(Thu, 18, 30), showId: "tv.That's So Raven", order: 'next' };
        const fri = { time: slotTime(Fri, 18), showId: "tv.That's So Raven", order: 'next' };
        const sat = { time: slotTime(Sat, 18, 30), showId: "tv.That's So Raven", order: 'repeat', repeatOf: thu.time };
        const sun = { time: slotTime(Sun, 17), showId: "tv.That's So Raven", order: 'repeat', repeatOf: fri.time };
        const late = { time: slotTime(Fri, 1), showId: 'tv.Pooh', order: 'next' };
        const schedule = { period: WEEK, slots: [thu, fri, sat, sun, late] };
        const sources = slotProgress.repeatSources(schedule, sat);
        suite.check('the sources are every slot that isn\'t a Repeat, with how far back each is',
            sources.length === 3 && !sources.some((x) => x.slot.order === 'repeat')
                && sources.find((x) => x.slot === thu).back === 2 * DAY
                && sources.find((x) => x.slot === late).back === DAY + 17 * HOUR + 30 * MIN,
            JSON.stringify(sources.map((x) => [x.slot.time, x.back / HOUR])));
        suite.check('...a source later in the week is last week\'s',
            slotProgress.repeatSources(schedule, { time: slotTime(Thu, 10), order: 'repeat' }).find((x) => x.slot === sun) === undefined
                && slotProgress.repeatSources(schedule, { time: slotTime(Thu, 10), order: 'repeat' }).find((x) => x.slot === fri).back === 6 * DAY - 8 * HOUR);
        suite.check('a Repeat with a source has no problem', slotProgress.repeatProblem(schedule, sat) === null);
        suite.check('...one without a source must choose one',
            /Choose/.test(slotProgress.repeatProblem(schedule, { time: slotTime(Mon, 9), order: 'repeat' }) || ''));
        suite.check('...one whose source is gone says so',
            /gone/.test(slotProgress.repeatProblem(schedule, { time: slotTime(Mon, 9), order: 'repeat', repeatOf: slotTime(Mon, 3) }) || ''));
        suite.check('...and one whose source is itself a Repeat',
            /itself a Repeat/.test(slotProgress.repeatProblem(schedule, { time: slotTime(Mon, 9), order: 'repeat', repeatOf: sat.time }) || ''));

        const moved = JSON.parse(JSON.stringify(schedule));
        slotProgress.followRetime(moved, thu.time, slotTime(Thu, 19));
        suite.check('retiming a source moves its repeats with it',
            moved.slots[2].repeatOf === slotTime(Thu, 19) && moved.slots[3].repeatOf === fri.time);

        // Daily to weekly clones every slot onto seven days, as the editor does:
        // each day's "1am repeats 9pm" repeats the 9pm four hours before it.
        const daily = { period: DAY, slots: [
            { time: 21 * HOUR, showId: 'tv.Pooh', order: 'next' },
            { time: HOUR, showId: 'tv.Pooh', order: 'repeat', repeatOf: 21 * HOUR },
        ] };
        const weekly = { period: WEEK, slots: [] };
        daily.slots.forEach((s) => {
            for (let j = 0; j < 7; j++) {
                const c = Object.assign({}, s, { time: s.time + j * DAY });
                if (c.order === 'repeat') c.repeatOf = slotProgress.movedRepeatOf(s, c.time, DAY, WEEK);
                weekly.slots.push(c);
            }
        });
        const backs = weekly.slots.filter((r) => r.order === 'repeat').map((r) => {
            if (slotProgress.repeatProblem(weekly, r) !== null) return 'problem';
            const source = weekly.slots.find((s) => s.time === r.repeatOf);
            return slotProgress.repeatSources(weekly, r).find((x) => x.slot === source).back / HOUR;
        });
        suite.check('daily to weekly: every day\'s 1am repeats the 9pm before it', backs.join() === '4,4,4,4,4,4,4', backs.join());
        suite.check('weekly to daily: Friday 1am repeating Thursday 9pm becomes 1am repeating 9pm',
            slotProgress.movedRepeatOf({ time: slotTime(Fri, 1), repeatOf: slotTime(Thu, 21) }, HOUR, WEEK, DAY) === 21 * HOUR);
        const farBack = { time: 10 * HOUR, showId: 'tv.Doug', order: 'repeat' };
        farBack.repeatOf = slotProgress.movedRepeatOf({ time: slotTime(Thu, 10), repeatOf: slotTime(Sat, 10) }, farBack.time, WEEK, DAY);
        suite.check('...and one further back than a day asks for a new source',
            /gone/.test(slotProgress.repeatProblem({ period: DAY, slots: [farBack] }, farBack) || ''));
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
