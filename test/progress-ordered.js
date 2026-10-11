/*
 * Ordered shuffle: a series at random, and that series' next episode in
 * order - for custom shows that join several series. Each round is a random
 * interleaving of the series, each keeping its list order, so a series airs in
 * proportion to its size and every item once per round (Ron, Oct 9). See
 * NOTES.md, Known issues, "Per-position stored progress, and the shuffles
 * built on it".
 *
 * The real time-slots-service with the clock frozen, on a custom show shaped
 * like channel 1's Tom & Jerry.
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const timeSlotsService = require('../src/services/time-slots-service');
const slotProgress = require('../src/slot-progress');
const rounds = require('../src/shuffle-rounds');
const getShowData = require('../src/services/get-show-data')();

const WEEK = 7 * DAY;
const THU = new Date('2026-10-08T00:00:00').getTime();
const NOW = THU + 10 * HOUR;
const key = (p) => p.serverKey + '|' + p.key;

// Three series, in list order: Tom and Jerry (6), The New Tom & Jerry Show (3,
// with a two-parter), The Tom and Jerry Comedy Show (1).
function tomAndJerry() {
    const items = [];
    const add = (series, title) => items.push({
        type: 'episode', showTitle: series, title, season: 1, episode: items.length + 1, duration: 7 * MIN,
        serverKey: 'srv', key: '/tj/' + items.length, customShowId: 'tj', customShowName: 'Tom & Jerry', customOrder: items.length,
    });
    ['Puss Gets the Boot', 'The Midnight Snack', 'The Night Before Christmas', 'Fraidy Cat', 'Dog Trouble', 'Puss n Toots']
        .forEach((t) => add('Tom and Jerry', t));
    ['Big Cheese (Part 1)', 'Big Cheese (Part 2)', 'Ghost Party'].forEach((t) => add('The New Tom & Jerry Show', t));
    add('The Tom and Jerry Comedy Show', 'Snowbrawl');
    return items;
}
const SERIES = { 'Tom and Jerry': 6, 'The New Tom & Jerry Show': 3, 'The Tom and Jerry Comedy Show': 1 };

function schedule() {
    return {
        period: WEEK, lateness: 0, maxDays: 28, flexPreference: 'end', pad: MIN,
        slots: [0, 1, 2, 3, 4, 5, 6].flatMap((d) => [
            { time: d * DAY + 8 * HOUR, showId: 'custom.tj', order: 'ordered' },
            { time: d * DAY + 8 * HOUR + 30 * MIN, showId: 'flex.', order: 'next' },
        ]),
    };
}
async function generate(sched, now) {
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(now); else super(...a); }
        static now() { return now; }
    }
    global.Date = FrozenDate;
    try {
        return await timeSlotsService(tomAndJerry(), JSON.parse(JSON.stringify(sched)));
    } finally {
        global.Date = RealDate;
    }
}
function airingsOf(res) {
    let t = Date.parse(res.startTime);
    return res.programs.map((p) => { const a = { start: t, program: p }; t += p.duration; return a; })
        .filter((a) => /^ordered\|/.test(a.program.slotPosition || ''));
}

module.exports = async function () {
    const suite = new Suite('progress-ordered');

    suite.check('seriesOf is the show title, else the title',
        rounds.seriesOf({ showTitle: 'Tom and Jerry', title: 'x' }) === 'Tom and Jerry' && rounds.seriesOf({ type: 'movie', title: 'Hocus Pocus' }) === 'Hocus Pocus');

    const res = await generate(schedule(), NOW);
    const aired = airingsOf(res);
    const byRound = new Map();
    aired.forEach((a) => {
        const r = slotProgress.parseLabel(a.program.slotPosition).round;
        if (!byRound.has(r)) byRound.set(r, []);
        byRound.get(r).push(a.program);
    });
    const whole = [...byRound.entries()].filter(([r]) => r !== Math.max(...byRound.keys()));
    suite.check('a generated month has whole rounds', aired.length > 30 && whole.length >= 3, `${aired.length} airings, ${byRound.size} rounds`);

    const inOrder = whole.every(([, list]) => Object.keys(SERIES).every((s) => {
        const orders = list.filter((p) => p.showTitle === s).map((p) => p.customOrder);
        return orders.every((o, i) => i === 0 || o === orders[i - 1] + 1);
    }));
    suite.check('each series plays in list order', inOrder);
    suite.check('every item once per round',
        whole.every(([, list]) => new Set(list.map(key)).size === 10 && list.length === 10));
    suite.check('per-round counts equal series sizes',
        whole.every(([, list]) => Object.entries(SERIES).every(([s, n]) => list.filter((p) => p.showTitle === s).length === n)));
    suite.check('...and the series interleave, not one after another',
        whole.some(([, list]) => list.map((p) => p.showTitle).join() !== list.slice().sort((a, b) => a.customOrder - b.customOrder).map((p) => p.showTitle).join()));
    suite.check('a series\' multi-part story stays together',
        aired.every((a, i) => a.program.title !== 'Big Cheese (Part 1)' || (aired[i + 1] && aired[i + 1].program.title === 'Big Cheese (Part 2)')));

    // Regenerated mid-round from that lineup, two days in: everything after airs as before.
    const later = NOW + 2 * DAY + 3 * HOUR;
    const progress = slotProgress.planProgress({ programs: res.programs, startTime: Date.parse(res.startTime), now: later,
        openedSchedule: schedule(), schedule: schedule(), pool: tomAndJerry(), getShowData });
    const again = schedule();
    again.progress = progress;
    const resumed = airingsOf(await generate(again, later));
    const before = aired.filter((a) => a.start >= later);
    const n = Math.min(before.length, resumed.length, 40);
    suite.check('a regeneration mid-round continues',
        n >= 30 && resumed.slice(0, n).map((a) => key(a.program)).join() === before.slice(0, n).map((a) => key(a.program)).join(),
        `${n} compared; first ${resumed.slice(0, 3).map((a) => a.program.title).join(', ')} vs ${before.slice(0, 3).map((a) => a.program.title).join(', ')}`);

    return suite;
};
