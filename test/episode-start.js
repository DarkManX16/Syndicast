/*
 * Episode start: choosing exactly which episode a position plays next, once.
 * The planner takes `starts` ({ positionKey: episode reference }) and turns
 * each into the position's record - Play Next's place, or a Shuffle or Rerun
 * round with the pick first - and the generators play it. See NOTES.md, Known
 * issues, "Episode start".
 *
 * Fixtures only, in the machine's own zone, with a weekly schedule whose day
 * 0 is a Thursday (slot times count from the epoch week; see slot-week.js).
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const slotProgress = require('../src/slot-progress');
const rounds = require('../src/shuffle-rounds');
const multiPart = require('../src/multi-part');
const timeSlotsService = require('../src/services/time-slots-service');
const getShowData = require('../src/services/get-show-data')();

const WEEK = 7 * DAY;
const THU = new Date('2026-10-08T00:00:00').getTime();
const at = (day, hour, minute) => THU + day * DAY + hour * HOUR + (minute || 0) * MIN;
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
const ref = (p) => slotProgress.ref(p, getShowData);
const fileKey = rounds.fileKey;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
const jbPool = () => seasons(JB, 3, 10);
const schedule = () => ({
    period: WEEK, lateness: 24 * HOUR, maxDays: 21, flexPreference: 'distribute', pad: 5 * MIN,
    slots: [
        { time: slotTime(Thu, 21), showId: 'tv.' + JB, order: 'next' },
        { time: slotTime(Fri, 21), showId: 'tv.' + JB, order: 'next', seasons: { excludeSeasons: [2] } },
        { time: slotTime(Sat, 21), showId: 'tv.' + JB, order: 'next', seasons: { excludeSeasons: [2] } },
    ],
});
const ALL = slotProgress.positionKey('tv.' + JB, 'next', undefined);
const NO2 = slotProgress.positionKey('tv.' + JB, 'next', { excludeSeasons: [2] });

const NOW = at(Fri, 10);
const savedLineup = () => {
    const programs = [];
    let t = THU;
    [[at(Thu, 21), episode(JB, 1, 8)], [at(Fri, 21), episode(JB, 1, 9)], [at(Sat, 21), episode(JB, 1, 10)]].forEach(([when, p]) => {
        programs.push({ isOffline: true, duration: when - t });
        programs.push(p);
        t = when + p.duration;
    });
    programs.push({ isOffline: true, duration: THU + WEEK - t });
    return programs;
};
const plan = (sched, starts, extra) => slotProgress.planProgress(Object.assign({
    programs: savedLineup(), startTime: THU, now: NOW, openedSchedule: schedule(), schedule: sched, pool: jbPool(),
    starts: starts, getShowData,
}, extra || {}));
const titleOfRef = (pool, r) => pool.find((p) => ref(p).key === r.key).title.replace(JB + ' ', '');

module.exports = async function () {
    const suite = new Suite('episode-start');

    suite.log('-- the planner: Play Next --');
    {
        const pool = jbPool();
        const without = plan(schedule());
        suite.check('no starts, empty starts and undefined starts plan the same',
            same(without, plan(schedule(), {})) && same(without, plan(schedule(), undefined)));

        const picked = plan(schedule(), { [NO2]: ref(pool.find((p) => p.title === `${JB} S3E4`)) });
        suite.check('a start sets a Play Next position\'s place',
            titleOfRef(pool, picked.positions[NO2].next) === 'S3E4', titleOfRef(pool, picked.positions[NO2].next));
        suite.check('...and no other position moves',
            same(picked.positions[ALL], without.positions[ALL]) && Object.keys(picked.positions).length === Object.keys(without.positions).length);

        const wrappedBefore = plan(schedule(), {}, { openedSchedule: Object.assign(schedule(), {
            progress: { asOf: new Date(NOW - DAY).toISOString(), positions: { [NO2]: { next: ref(pool[3]), wrapped: true } } } }) });
        const wrappedPick = plan(schedule(), { [NO2]: ref(pool[25]) }, { openedSchedule: Object.assign(schedule(), {
            progress: { asOf: new Date(NOW - DAY).toISOString(), positions: { [NO2]: { next: ref(pool[3]), wrapped: true } } } }) });
        suite.check('...a position that had gone round stays gone round',
            wrappedPick.positions[NO2].wrapped === wrappedBefore.positions[NO2].wrapped, JSON.stringify(wrappedPick.positions[NO2]));

        const excluded = plan(schedule(), { [NO2]: ref(pool.find((p) => p.title === `${JB} S2E3`)) });
        suite.check('a start on an episode the range leaves out moves to the next one',
            titleOfRef(pool, excluded.positions[NO2].next) === 'S3E1', titleOfRef(pool, excluded.positions[NO2].next));

        const earlier = plan(schedule(), { [NO2]: ref(pool.find((p) => p.title === `${JB} S1E2`)) });
        suite.check('a start may go backwards',
            titleOfRef(pool, earlier.positions[NO2].next) === 'S1E2');

        suite.check('a start for a position no slot plays is ignored',
            same(plan(schedule(), { [slotProgress.positionKey('tv.' + JB, 'next', { excludeSeasons: [1] })]: ref(pool[5]) }), without));

        const gone = plan(schedule(), { [NO2]: { key: 'srv|/e/gone', order: 3000004 } });
        suite.check('a start whose file has gone moves to the next episode by order',
            titleOfRef(pool, gone.positions[NO2].next) === 'S3E4', titleOfRef(pool, gone.positions[NO2].next));

        // The catalog, when the editor has one, is what the pick is found in.
        const thin = pool.filter((p) => p.season !== 3);
        const fromCatalog = plan(schedule(), { [NO2]: ref(pool.find((p) => p.title === `${JB} S3E4`)) }, { pool: thin, catalog: pool });
        suite.check('a start is found in the catalog, not only the lineup',
            titleOfRef(pool, fromCatalog.positions[NO2].next) === 'S3E4');

        const seeking = schedule();
        seeking.slots[1].seasons = { excludeSeasons: [2], startSeason: 3 };
        const both = plan(seeking, { [NO2]: ref(pool.find((p) => p.title === `${JB} S1E5`)) });
        suite.check('a start beats a season start on the same position',
            titleOfRef(pool, both.positions[NO2].next) === 'S1E5');
    }

    suite.log('-- the planner: Shuffle and Rerun, "Air next" --');
    {
        // Doug, three seasons of six; S2E2 and S2E3 are one story.
        const doug = seasons('Doug', 3, 6).map((p) => {
            if (p.season === 2 && p.episode === 2) return Object.assign(p, { title: 'The Big One (1)' });
            if (p.season === 2 && p.episode === 3) return Object.assign(p, { title: 'The Big One (2)' });
            return p;
        });
        const D = (title) => doug.find((p) => p.title === title);
        const sched = (order) => ({
            period: WEEK, slots: [{ time: slotTime(Sat, 6), showId: 'tv.Doug', order: order || 'shuffle' }],
        });
        const SHUFFLE = slotProgress.positionKey('tv.Doug', 'shuffle', undefined);
        const RERUN = slotProgress.positionKey('tv.Doug', 'rerun', undefined);
        const stories = multiPart.stories(doug.slice().sort((a, b) => getShowData(a).order - getShowData(b).order));
        const order0 = rounds.roundOrder({ seed: SHUFFLE, round: 0, stories, laterHalf: new Set() });
        const titles = (queue) => queue.map((r) => doug.find((p) => ref(p).key === r.key).title);
        const flat = (list) => [].concat(...list).map((p) => p.title);
        const planDoug = (starts, o) => slotProgress.planProgress(Object.assign({
            programs: savedLineup(), startTime: THU, now: NOW, openedSchedule: { period: WEEK, slots: [] },
            schedule: sched(), pool: doug, starts: starts, getShowData,
        }, o || {}));
        const firstOf = (story) => ref(story[0]);

        const fresh = planDoug({});
        suite.check('a new Shuffle position starts round 0', same(fresh.positions[SHUFFLE], { round: 0, deferred: [] }));

        const pickIndex = 5;
        const picked = planDoug({ [SHUFFLE]: firstOf(order0[pickIndex]) }).positions[SHUFFLE];
        const expected = flat([order0[pickIndex]].concat(order0.filter((_, i) => i !== pickIndex)));
        suite.check('Air next puts the pick first and the rest of the round after it, in order',
            picked.round === 0 && Array.isArray(picked.queue) && same(titles(picked.queue), expected),
            titles(picked.queue).slice(0, 4).join(' | '));
        suite.check('...every episode of the round still once', picked.queue.length === doug.length
            && new Set(picked.queue.map((r) => r.key)).size === doug.length);
        const expectedLater = rounds.laterHalfOf([order0[pickIndex]].concat(order0.filter((_, i) => i !== pickIndex)));
        suite.check('...and the later half is that of the new order',
            same(picked.laterHalf.slice().sort(), [...expectedLater].sort()));

        // From the later half, bringing a story forward shifts the story at the
        // boundary across it, so the later half is not the old one.
        const lateIndex = order0.length - 2;
        const fromLate = planDoug({ [SHUFFLE]: firstOf(order0[lateIndex]) }).positions[SHUFFLE];
        const lateOrder = [order0[lateIndex]].concat(order0.filter((_, i) => i !== lateIndex));
        suite.check('a pick from the later half moves the later half with it',
            same(fromLate.laterHalf.slice().sort(), [...rounds.laterHalfOf(lateOrder)].sort())
                && !same([...rounds.laterHalfOf(order0)].sort(), [...rounds.laterHalfOf(lateOrder)].sort()));

        const bigOne = order0.findIndex((st) => st.length === 2);
        const part2 = planDoug({ [SHUFFLE]: ref(D('The Big One (2)')) }).positions[SHUFFLE];
        suite.check('picking part 2 of a story airs part 1, then part 2',
            same(titles(part2.queue).slice(0, 2), ['The Big One (1)', 'The Big One (2)']) && bigOne !== -1, titles(part2.queue).slice(0, 3).join(' | '));

        const first = planDoug({ [SHUFFLE]: firstOf(order0[0]) }).positions[SHUFFLE];
        suite.check('picking the story that is next anyway leaves the round as it was',
            same(titles(first.queue), flat(order0)));

        suite.check('a pick that is not a candidate does not apply',
            same(planDoug({ [SHUFFLE]: { key: 'srv|/e/nobody', order: 1 } }).positions[SHUFFLE], fresh.positions[SHUFFLE]));
        suite.check('...nor does one for an Ordered shuffle position',
            same(planDoug({ [slotProgress.positionKey('tv.Doug', 'ordered', undefined)]: firstOf(order0[3]) }, { schedule: sched('ordered') }).positions,
                planDoug({}, { schedule: sched('ordered') }).positions));

        // Part way through round 0: order0[3] is on air at the click, labelled.
        const midway = (mode, key) => lineupOf([[at(Sat, 6), Object.assign({}, order0[3][0], { slotPosition: `${mode}||0` })]]);
        const mid = (starts, mode, extra) => slotProgress.planProgress(Object.assign({
            programs: midway(mode), startTime: THU, now: NOW, openedSchedule: sched(mode), schedule: sched(mode), pool: doug, starts, getShowData,
        }, extra || {}));
        const before = mid({}, 'shuffle').positions[SHUFFLE];
        suite.check('mid-round, the place is the airing on air or ahead', before.round === 0 && before.next.key === ref(order0[3][0]).key);
        const jump = mid({ [SHUFFLE]: firstOf(order0[7]) }, 'shuffle').positions[SHUFFLE];
        suite.check('...Air next brings a later story forward, ahead of the one that was next',
            same(titles(jump.queue), flat([order0[7]].concat(order0.slice(3, 7), order0.slice(8)))), titles(jump.queue).slice(0, 3).join(' | '));
        suite.check('...a story that has aired this round does not apply',
            same(mid({ [SHUFFLE]: firstOf(order0[1]) }, 'shuffle').positions[SHUFFLE], before));
        suite.check('...and the later half counts the episodes already aired',
            same(jump.laterHalf.slice().sort(), [...rounds.laterHalfOf(order0.slice(0, 3).concat([order0[7]], order0.slice(3, 7), order0.slice(8)))].sort()));

        // A story under way finishes before the pick comes on.
        const underWayStory = order0.find((st) => st.length === 2);
        const underWayAt = order0.indexOf(underWayStory);
        const pickAfter = order0.find((st, i) => i > underWayAt + 1);
        const underWay = slotProgress.planProgress({
            programs: lineupOf([[at(Sat, 6), Object.assign({}, underWayStory[1], { slotPosition: 'shuffle||0' })]]),
            startTime: THU, now: NOW, openedSchedule: sched(), schedule: sched(), pool: doug,
            starts: { [SHUFFLE]: firstOf(pickAfter) }, getShowData,
        }).positions[SHUFFLE];
        suite.check('a story under way finishes before the pick airs',
            titles(underWay.queue)[0] === underWayStory[1].title && titles(underWay.queue)[1] === pickAfter[0].title,
            titles(underWay.queue).slice(0, 3).join(' | '));

        // A Rerun keeps what it has aired this round.
        const rerunSchedule = { period: WEEK, slots: [
            { time: slotTime(Sat, 6), showId: 'tv.Doug', order: 'rerun' },
            { time: slotTime(Mon, 6), showId: 'tv.Doug', order: 'next' },
        ] };
        const rerun = slotProgress.planProgress({
            programs: lineupOf([[at(Sat, 6), Object.assign({}, order0[3][0], { slotPosition: 'rerun||0' })]]),
            startTime: THU, now: NOW, openedSchedule: rerunSchedule, schedule: rerunSchedule, pool: doug, starts: {}, getShowData,
        }).positions[RERUN];
        const rerunPicked = slotProgress.planProgress({
            programs: lineupOf([[at(Sat, 6), Object.assign({}, order0[3][0], { slotPosition: 'rerun||0' })]]),
            startTime: THU, now: NOW, openedSchedule: rerunSchedule, schedule: rerunSchedule, pool: doug,
            starts: { [RERUN]: firstOf(order0[8]) }, getShowData,
        }).positions[RERUN];
        suite.check('a Rerun pick keeps the episodes it has aired this round',
            Array.isArray(rerunPicked.queue) && same(rerunPicked.aired, rerun.aired) && titles(rerunPicked.queue)[0] === order0[8][0].title,
            JSON.stringify(rerun.aired));

        // A carried round: the pick comes forward in the queue.
        const queueKey = SHUFFLE;
        const carried = order0.slice(2).map((st) => st.map(ref)).reduce((a, b) => a.concat(b), []);
        const openedQueue = Object.assign(sched(), { progress: { asOf: new Date(NOW - DAY).toISOString(), positions: {
            [queueKey]: { round: 0, queue: carried, laterHalf: [] },
        } } });
        const fromQueue = (starts) => slotProgress.planProgress({
            programs: lineupOf([[at(Sat, 6), Object.assign({}, order0[4][0], { slotPosition: 'shuffle||0' })]]),
            startTime: THU, now: NOW, openedSchedule: openedQueue, schedule: sched(), pool: doug, starts, getShowData,
        }).positions[queueKey];
        const queueBefore = fromQueue({});
        const queuePicked = fromQueue({ [queueKey]: firstOf(order0[9]) });
        suite.check('a carried round plays on from the airing on air',
            Array.isArray(queueBefore.queue) && titles(queueBefore.queue)[0] === order0[4][0].title, titles(queueBefore.queue).slice(0, 2).join(' | '));
        suite.check('...and Air next moves the pick to its front',
            same(titles(queuePicked.queue), flat([order0[9]].concat(order0.slice(4, 9), order0.slice(10)))));
    }

    suite.log('-- the generator plays the pick, then carries on --');
    {
        // Daily slots, a half hour each, for Doug (Shuffle) and Johnny Bravo
        // (Play Next, no Season 2); flex after each.
        const doug = seasons('Doug', 3, 6);
        const pool = doug.concat(jbPool());
        const sched = () => {
            const slots = [];
            for (let d = 0; d < 7; d++) {
                slots.push({ time: slotTime(d, 6), showId: 'tv.Doug', order: 'shuffle' });
                slots.push({ time: slotTime(d, 6, 30), showId: 'flex.', order: 'next' });
                slots.push({ time: slotTime(d, 21), showId: 'tv.' + JB, order: 'next', seasons: { excludeSeasons: [2] } });
                slots.push({ time: slotTime(d, 21, 30), showId: 'flex.', order: 'next' });
            }
            return { period: WEEK, lateness: 24 * HOUR, maxDays: 40, flexPreference: 'distribute', pad: 5 * MIN, slots };
        };
        const SHUF = slotProgress.positionKey('tv.Doug', 'shuffle', undefined);
        const JBK = slotProgress.positionKey('tv.' + JB, 'next', { excludeSeasons: [2] });
        const run = async (starts) => {
            const s = sched();
            s.progress = slotProgress.planProgress({ programs: lineupOf([]), startTime: THU, now: NOW, openedSchedule: { period: WEEK, slots: [] },
                schedule: s, pool, starts, getShowData });
            return withStarts(await generate(pool, s, NOW)).filter((a) => !a.program.isOffline);
        };
        const showAirings = (list, title) => list.filter((a) => a.program.showTitle === title).map((a) => a.program.title);

        const plain = await run({});
        const stories0 = multiPart.stories(doug.slice().sort((a, b) => getShowData(a).order - getShowData(b).order));
        const round0 = rounds.roundOrder({ seed: SHUF, round: 0, stories: stories0, laterHalf: new Set() });
        const pickAt = 9;
        const pick = round0[pickAt][0];
        const jumped = await run({ [SHUF]: ref(pick), [JBK]: ref(jbPool().find((p) => p.title === `${JB} S3E4`)) });

        suite.check('without a start the Shuffle plays its round in order',
            same(showAirings(plain, 'Doug').slice(0, 10), [].concat(...round0).map((p) => p.title).slice(0, 10)));
        const dougJumped = showAirings(jumped, 'Doug');
        suite.check('with a pick the Shuffle airs it first',
            dougJumped[0] === pick.title, dougJumped.slice(0, 2).join(' | '));
        suite.check('...and then the rest of the round in its own order, nothing twice',
            same(dougJumped.slice(0, round0.length), [pick.title].concat([].concat(...round0.filter((_, i) => i !== pickAt)).map((p) => p.title)))
                && new Set(dougJumped.slice(0, round0.length)).size === round0.length);
        suite.check('...and the next round is a whole round afterwards',
            dougJumped.length > round0.length && new Set(dougJumped.slice(round0.length, 2 * round0.length)).size === Math.min(round0.length, dougJumped.length - round0.length));

        const jbPlain = showAirings(plain, JB);
        const jbJumped = showAirings(jumped, JB);
        suite.check('without a start Play Next begins at the first episode of its range',
            jbPlain[0] === `${JB} S1E1` && jbPlain[1] === `${JB} S1E2`, jbPlain.slice(0, 2).join(' | '));
        suite.check('with a pick Play Next airs it, then carries on in order, round the range',
            same(jbJumped.slice(0, 4), [`${JB} S3E4`, `${JB} S3E5`, `${JB} S3E6`, `${JB} S3E7`]) , jbJumped.slice(0, 4).join(' | '));
        suite.check('...the airings of every other position are unchanged',
            same(showAirings(plain, 'Doug').slice(0, 5), showAirings(await run({ [JBK]: ref(jbPool()[29]) }), 'Doug').slice(0, 5)));
        suite.check('...and the labels still name their positions',
            jumped.filter((a) => a.program.showTitle === 'Doug').every((a) => a.program.slotPosition.startsWith('shuffle||'))
                && jumped.filter((a) => a.program.showTitle === JB).every((a) => a.program.slotPosition === 'next|2'));

        // The lineup it makes carries on: planned again later, the position
        // continues from the pick's successors, with no start given.
        const second = sched();
        // The schedule as saved after the first run: its records come with it.
        const saved = sched();
        saved.progress = slotProgress.planProgress({ programs: lineupOf([]), startTime: THU, now: NOW, openedSchedule: { period: WEEK, slots: [] },
            schedule: saved, pool, starts: { [SHUF]: ref(pick), [JBK]: ref(jbPool().find((p) => p.title === `${JB} S3E4`)) }, getShowData });
        const madeFirst = await generate(pool, saved, NOW);
        const later = at(Sat, 12);
        second.progress = slotProgress.planProgress({ programs: madeFirst.programs, startTime: Date.parse(madeFirst.startTime), now: later,
            openedSchedule: saved, schedule: second, pool, getShowData });
        const afterwards = withStarts(await generate(pool, second, later)).filter((a) => !a.program.isOffline);
        const firstRun = withStarts(madeFirst).filter((a) => !a.program.isOffline);
        const firstAtLater = firstRun.filter((a) => a.start >= later);
        suite.check('planned again later with no start, every position continues where the first lineup had it',
            same(afterwards.slice(0, 20).map((a) => a.program.title), firstAtLater.slice(0, 20).map((a) => a.program.title)),
            afterwards.slice(0, 4).map((a) => a.program.title).join(' | ') + '  vs  ' + firstAtLater.slice(0, 4).map((a) => a.program.title).join(' | '));
    }

    return suite;
};

// A one-week lineup from Thursday with the given airings, flex around them.
function lineupOf(entries) {
    const programs = [];
    let t = THU;
    entries.slice().sort((a, b) => a[0] - b[0]).forEach(([when, p]) => {
        programs.push({ isOffline: true, duration: when - t });
        programs.push(p);
        t = when + p.duration;
    });
    programs.push({ isOffline: true, duration: THU + WEEK - t });
    return programs;
}
