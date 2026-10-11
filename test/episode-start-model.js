/*
 * Episode start, the editor's side: when a position first airs, each row's
 * next episode (from the generators' own orderers), what the picker offers
 * and why an episode can't be picked, and the two warnings. Pure - the
 * directive only draws what src/episode-start.js answers. See NOTES.md, Known
 * issues, "Episode start".
 *
 * Fixtures only, in the machine's own zone, with a weekly schedule whose day
 * 0 is a Thursday.
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const slotProgress = require('../src/slot-progress');
const episodeStart = require('../src/episode-start');
const rounds = require('../src/shuffle-rounds');
const multiPart = require('../src/multi-part');
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const JB = 'Johnny Bravo';

module.exports = async function () {
    const suite = new Suite('episode-start-model');

    suite.log('-- when a position first airs --');
    {
        const sched = (lateness) => ({ period: WEEK, lateness: lateness, slots: [
            { time: slotTime(Fri, 21), showId: 'tv.A', order: 'next' },
            { time: slotTime(Fri, 21, 30), showId: 'flex.', order: 'next' },
            { time: slotTime(Sun, 9), showId: 'tv.A', order: 'next' },
            { time: slotTime(Mon, 9), showId: 'tv.B', order: 'next' },
        ] });
        const slotsOf = (s, showId) => s.slots.filter((x) => x.showId === showId);
        const first = (lateness, now, showId) => episodeStart.firstAiring({ slots: slotsOf(sched(lateness), showId || 'tv.A'), schedule: sched(lateness), now });

        let r = first(0, at(Fri, 10));
        suite.check('the next start of the position\'s earliest slot ahead', r.at === at(Fri, 21) && r.now === false, new Date(r.at).toString());
        r = first(0, at(Fri, 22));
        suite.check('...after the last this week it is the next slot round', r.at === at(Sun, 9) && r.now === false);
        r = first(0, at(Sun, 10));
        suite.check('...and past both it wraps to next week', r.at === at(Fri, 21) + WEEK, new Date(r.at).toString());
        r = first(24 * HOUR, at(Fri, 21, 10));
        suite.check('a slot under way airs it right away when lateness allows', r.now === true && r.at === at(Fri, 21, 10));
        r = first(0, at(Fri, 21, 10));
        suite.check('...and at the next start when it does not', r.now === false && r.at === at(Sun, 9));
        r = first(0, at(Fri, 21));
        suite.check('a slot starting this very moment airs now', r.now === true && r.at === at(Fri, 21));
        suite.check('a position with no slots never airs',
            episodeStart.firstAiring({ slots: [], schedule: sched(0), now: at(Fri, 10) }) === null);

        // The wall clock is what a slot follows, across the autumn change.
        const fall = { period: WEEK, lateness: 0, slots: [{ time: slotTime(Sun, 21), showId: 'tv.A', order: 'next' }] };
        const from = new Date('2026-10-31T12:00:00').getTime();
        r = episodeStart.firstAiring({ slots: fall.slots, schedule: fall, now: from });
        suite.check('across the clocks changing it is still 9pm on the wall',
            r.at === new Date('2026-11-01T21:00:00').getTime(), new Date(r.at).toString());
    }

    suite.log('-- every row\'s next episode --');
    const pool = seasons(JB, 3, 10).concat(seasons('Doug', 3, 6, {}).map((p) => {
        if (p.season === 2 && p.episode === 2) return Object.assign(p, { title: 'The Big One (1)' });
        if (p.season === 2 && p.episode === 3) return Object.assign(p, { title: 'The Big One (2)' });
        return p;
    }));
    const D = (title) => pool.find((p) => p.title === title);
    const schedule = () => ({
        period: WEEK, lateness: 24 * HOUR, maxDays: 14, flexPreference: 'distribute', pad: 5 * MIN,
        slots: [
            { time: slotTime(Thu, 21), showId: 'tv.' + JB, order: 'next' },
            { time: slotTime(Fri, 21), showId: 'tv.' + JB, order: 'next', seasons: { excludeSeasons: [2] } },
            { time: slotTime(Sat, 21), showId: 'tv.' + JB, order: 'next', seasons: { excludeSeasons: [2] } },
            { time: slotTime(Sun, 10), showId: 'tv.' + JB, order: 'rerun' },
            { time: slotTime(Thu, 21, 30), showId: 'flex.', order: 'next' },
            { time: slotTime(Fri, 21, 30), showId: 'flex.', order: 'next' },
            { time: slotTime(Sat, 21, 30), showId: 'flex.', order: 'next' },
            { time: slotTime(Sun, 10, 30), showId: 'flex.', order: 'next' },
            { time: slotTime(Sat, 6), showId: 'tv.Doug', order: 'shuffle' },
            { time: slotTime(Sat, 7), showId: 'flex.', order: 'next' },
            { time: slotTime(Mon, 6), showId: 'tv.Doug', order: 'repeat', repeatOf: slotTime(Sat, 6) },
        ],
    });
    const ALL = slotProgress.positionKey('tv.' + JB, 'next', undefined);
    const NO2 = slotProgress.positionKey('tv.' + JB, 'next', { excludeSeasons: [2] });
    const SHUF = slotProgress.positionKey('tv.Doug', 'shuffle', undefined);
    const RERUN = slotProgress.positionKey('tv.' + JB, 'rerun', undefined);
    const NOW = at(Fri, 10);
    const lineup = [
        { isOffline: true, duration: at(Thu, 21) - THU },
        Object.assign(episode(JB, 1, 8), { slotPosition: 'next|' }),
        { isOffline: true, duration: at(Fri, 21) - at(Thu, 21) - 22 * MIN },
        Object.assign(episode(JB, 1, 9), { slotPosition: 'next|2' }),
        { isOffline: true, duration: WEEK - (at(Fri, 21) - THU) - 22 * MIN },
    ];
    const plan = (starts) => slotProgress.planProgress({
        programs: lineup, startTime: THU, now: NOW, openedSchedule: schedule(), schedule: schedule(), pool, starts, getShowData,
    });
    {
        const sched = schedule();
        const rows = episodeStart.describe({ schedule: sched, progress: plan({}), pool, now: NOW });
        const titleOf = (key) => (rows.get(key) && rows.get(key).program) ? rows.get(key).program.title : 'none';
        suite.check('each Play Next position shows the episode its place says',
            titleOf(ALL) === `${JB} S1E8` && titleOf(NO2) === `${JB} S1E9`, `${titleOf(ALL)}, ${titleOf(NO2)}`);
        suite.check('...and when it first airs',
            rows.get(ALL).at === at(Thu, 21) + WEEK && rows.get(NO2).at === at(Fri, 21),
            `${new Date(rows.get(ALL).at)} ${new Date(rows.get(NO2).at)}`);
        suite.check('...the first of the position\'s slots, not the row\'s own',
            rows.get(NO2).at === Math.min(at(Fri, 21), at(Sat, 21)));
        suite.check('a Shuffle shows the first story of its round',
            rows.has(SHUF) && rounds.fileKey(rows.get(SHUF).program) === rounds.fileKey(
                rounds.roundOrder({ seed: SHUF, round: 0, stories: multiPart.stories(pool.filter((p) => p.showTitle === 'Doug').sort((a, b) => getShowData(a).order - getShowData(b).order)), laterHalf: new Set() })[0][0]));
        suite.check('...and a Rerun with nothing aired yet shows what it will play as a Shuffle',
            rows.has(RERUN) && rows.get(RERUN).program !== null);
        suite.check('Flex and a Repeat have none', rows.size === 4, [...rows.keys()].join(' ; '));

        const picked = episodeStart.describe({ schedule: sched, progress: plan({ [NO2]: ref(D(`${JB} S3E4`)) }), pool, now: NOW });
        suite.check('a start changes that position\'s row and no other',
            picked.get(NO2).program.title === `${JB} S3E4` && picked.get(ALL).program.title === `${JB} S1E8`);
    }

    suite.log('-- the picker --');
    {
        const sched = schedule();
        const base = plan({});
        const play = episodeStart.options({ key: NO2, mode: 'next', record: base.positions[NO2], pool, getShowData });
        suite.check('Play Next offers its range, without the seasons it leaves out',
            play.episodes.length === 20 && play.episodes.every((e) => e.program.season !== 2), String(play.episodes.length));
        suite.check('...marks the episode that is next and offers the rest',
            play.episodes.filter((e) => e.state === 'current').length === 1 && play.episodes.find((e) => e.state === 'current').program.title === `${JB} S1E9`
                && play.episodes.every((e) => e.state === 'current' || e.state === 'ok'));
        suite.check('...in the show\'s order', play.episodes.every((e, i, a) => i === 0 || getShowData(a[i - 1].program).order < getShowData(e.program).order));

        // A round in progress for Doug: some aired, some held to the end.
        const stories = multiPart.stories(pool.filter((p) => p.showTitle === 'Doug').sort((a, b) => getShowData(a).order - getShowData(b).order));
        const order1 = rounds.roundOrder({ seed: SHUF, round: 1, stories, laterHalf: new Set(rounds.laterHalfOf(stories.slice(0, 8))) });
        const held = new Set(rounds.laterHalfOf(stories.slice(0, 8)));
        const record = { round: 1, next: ref(order1[4][0]), deferred: [...held] };
        const shuffle = episodeStart.options({ key: SHUF, mode: 'shuffle', record, pool, aired: null, getShowData });
        const stateOf = (title) => shuffle.episodes.find((e) => e.program.title === title).state;
        suite.check('Shuffle: the story that is next is marked',
            stateOf(order1[4][0].title) === 'current', stateOf(order1[4][0].title));
        suite.check('...stories already aired this round are out',
            order1.slice(0, 4).every((st) => st.every((p) => stateOf(p.title) === 'aired')));
        const heldAhead = order1.slice(5).filter((st) => st.some((p) => held.has(rounds.fileKey(p))));
        suite.check('...stories held to the end of the round for airing late in the last one are out',
            heldAhead.length > 0 && heldAhead.every((st) => st.every((p) => stateOf(p.title) === 'held')));
        const open = order1.slice(5).filter((st) => !st.some((p) => held.has(rounds.fileKey(p))));
        suite.check('...and the rest are open',
            open.length > 0 && open.every((st) => st.every((p) => stateOf(p.title) === 'ok')));
        suite.check('...both parts of a story share one answer',
            stateOf('The Big One (1)') === stateOf('The Big One (2)'));
        suite.check('...every reason is told in words',
            shuffle.episodes.filter((e) => e.state !== 'ok' && e.state !== 'current').every((e) => typeof(e.why) === 'string' && e.why.length > 0));

        const fresh = episodeStart.options({ key: SHUF, mode: 'shuffle', record: null, pool, aired: null, getShowData });
        suite.check('a position with no record offers its whole first round',
            fresh.episodes.filter((e) => e.state === 'ok' || e.state === 'current').length === 18);

        const airedByNext = slotProgress.playNextAired({ schedule: sched, progress: plan({}), showId: 'tv.' + JB, pool, getShowData });
        const rerun = episodeStart.options({ key: RERUN, mode: 'rerun', record: { round: 0, deferred: [] }, pool, aired: airedByNext, getShowData });
        const rs = (title) => rerun.episodes.find((e) => e.program.title === title).state;
        suite.check('Rerun offers only what the show\'s Play Next has aired',
            rs(`${JB} S1E2`) === 'ok' || rs(`${JB} S1E2`) === 'current', rs(`${JB} S1E2`));
        suite.check('...the rest are told apart from a round\'s own reasons',
            rs(`${JB} S3E9`) === 'notAired' && rerun.episodes.find((e) => e.state === 'notAired').why.indexOf('Play Next') !== -1, rs(`${JB} S3E9`));
        const none = episodeStart.options({ key: RERUN, mode: 'rerun', record: { round: 0, deferred: [] }, pool,
            aired: { any: true, aired: new Set() }, getShowData });
        suite.check('...and with nothing aired anywhere it plays as a Shuffle, so everything is open',
            none.episodes.every((e) => e.state === 'ok' || e.state === 'current'));
        suite.check('Ordered shuffle and Repeat have no picker',
            episodeStart.options({ key: SHUF, mode: 'ordered', record: null, pool, getShowData }) === null
                && episodeStart.options({ key: SHUF, mode: 'repeat', record: null, pool, getShowData }) === null);
    }

    suite.log('-- the warnings --');
    {
        const sched = schedule();
        const rows = episodeStart.describe({ schedule: sched, progress: plan({}), pool, now: NOW });
        suite.check('two ranges of one show at different places are fine',
            episodeStart.doubling({ rows, schedule: sched, nameOf: (id) => id.replace(/^tv\./, '') }).size === 0);
        const samePlace = episodeStart.describe({ schedule: sched, progress: plan({ [NO2]: ref(D(`${JB} S1E8`)) }), pool, now: NOW });
        const doubled = episodeStart.doubling({ rows: samePlace, schedule: sched, nameOf: (id) => id.replace(/^tv\./, '') });
        suite.check('two ranges at the same place each say so, and name the other',
            doubled.size === 2 && doubled.get(NO2).indexOf('Johnny Bravo, all seasons') !== -1 && doubled.get(ALL).indexOf('no Season 2') !== -1
                && doubled.get(ALL).indexOf('same episodes') !== -1, doubled.get(NO2));
        suite.check('...Shuffle positions are not compared',
            episodeStart.doubling({ rows: samePlace, schedule: sched, nameOf: (id) => id }).has(SHUF) === false);
        const A = slotProgress.positionKey('tv.Doug', 'shuffle', undefined);
        const B = slotProgress.positionKey('tv.Doug', 'shuffle', { excludeSeasons: [3] });
        suite.check('...even when two of them happen to start on one episode',
            episodeStart.doubling({ schedule: sched, nameOf: (id) => id, rows: new Map([
                [A, { mode: 'shuffle', showId: 'tv.Doug', program: D('Doug S1E1') }],
                [B, { mode: 'shuffle', showId: 'tv.Doug', program: D('Doug S1E1') }],
            ]) }).size === 0);

        const skip = (pick) => episodeStart.skipNote({ key: NO2, current: D(`${JB} S1E9`), pick: D(pick), schedule: sched, pool, getShowData });
        const note = skip(`${JB} S3E4`);
        suite.check('a jump forward in a show with a Rerun slot says the Rerun may replay what it skips',
            typeof(note) === 'string' && note.indexOf('Rerun') !== -1 && note.indexOf('S01E09') !== -1 && note.indexOf('S03E03') !== -1 && note.indexOf('replay') !== -1, note);
        suite.check('...counting them', /skips 5 episodes/.test(note), note);
        suite.check('...a jump back, or a pick that is next, says nothing',
            skip(`${JB} S1E2`) === null && skip(`${JB} S1E9`) === null);
        const noRerun = sched.slots.filter((s) => s.order !== 'rerun');
        suite.check('...nor does a show with no Rerun slot',
            episodeStart.skipNote({ key: NO2, current: D(`${JB} S1E9`), pick: D(`${JB} S3E4`), schedule: { slots: noRerun }, pool, getShowData }) === null);
    }

    suite.log('-- the words --');
    {
        suite.check('an episode is its season, episode and title',
            episodeStart.episodeLabel(episode(JB, 1, 24, { title: 'Substitute Teacher' })) === 'S01E24 Substitute Teacher');
        suite.check('a custom show\'s item is its place in the list',
            episodeStart.episodeLabel(episode('X', 1, 1, { customShowId: 'abc', customOrder: 11, title: 'Dino' })) === '#12 Dino');
        suite.check('a range is told in words',
            episodeStart.rangeLabel([]) === 'all seasons' && episodeStart.rangeLabel([2]) === 'no Season 2' && episodeStart.rangeLabel([1, 3]) === 'no Seasons 1, 3');
        const t = new Date('2026-10-12T18:00:00').getTime();
        suite.check('a time is the day, date and hour',
            episodeStart.whenLabel({ at: t, now: false }) === 'Mon Oct 12, 6:00pm', episodeStart.whenLabel({ at: t, now: false }));
        suite.check('...or "right away" when the slot is under way',
            /right away/.test(episodeStart.whenLabel({ at: t, now: true })));
        suite.check('...and the half hour keeps its minutes',
            episodeStart.whenLabel({ at: new Date('2026-10-12T09:30:00').getTime(), now: false }) === 'Mon Oct 12, 9:30am');
    }

    return suite;
};
