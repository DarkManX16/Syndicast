/*
 * Rerun: a Shuffle of only the episodes its show's Play Next has already
 * aired, so a weekend never airs an episode before its weekday strip does.
 * With nothing aired yet, or no Play Next at all, it plays as a Shuffle (Ron,
 * Oct 9). See NOTES.md, Known issues, "Per-position stored progress, and the
 * shuffles built on it".
 *
 * The real time-slots-service with the clock frozen, on a fixture shaped like
 * channel 3's Kim Possible: a Thursday-Friday Play Next strip and Saturday and
 * Sunday slots.
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const timeSlotsService = require('../src/services/time-slots-service');
const slotProgress = require('../src/slot-progress');
const getShowData = require('../src/services/get-show-data')();

const WEEK = 7 * DAY;
const THU = new Date('2026-10-08T00:00:00').getTime();
const NOW = THU + 10 * HOUR;
const slotTime = (day, hour, minute) => day * DAY + hour * HOUR + (minute || 0) * MIN;
const KP = 'Kim Possible';
const key = (p) => p.serverKey + '|' + p.key;

function kim() {
    const out = [];
    for (let s = 1; s <= 2; s++) {
        for (let e = 1; e <= 10; e++) {
            let title = `${KP} S${s}E${e}`;
            if (s === 1 && e === 6) title = 'Bad Boy (1)';
            if (s === 1 && e === 7) title = 'Bad Boy (2)';
            out.push({ type: 'episode', showTitle: KP, title, season: s, episode: e, duration: 22 * MIN, serverKey: 'srv', key: `/e/kp/${s}/${e}` });
        }
    }
    return out;
}
const STRIP = slotProgress.positionKey('tv.' + KP, 'next', undefined);

function schedule(withStrip, record) {
    const slots = [
        { time: slotTime(2, 15, 30), showId: 'tv.' + KP, order: 'rerun' },
        { time: slotTime(3, 18), showId: 'tv.' + KP, order: 'rerun' },
        { time: slotTime(2, 16), showId: 'flex.', order: 'next' },
        { time: slotTime(3, 18, 30), showId: 'flex.', order: 'next' },
    ];
    if (withStrip) {
        slots.push({ time: slotTime(0, 16, 30), showId: 'tv.' + KP, order: 'next' });
        slots.push({ time: slotTime(1, 17), showId: 'tv.' + KP, order: 'next' });
        slots.push({ time: slotTime(0, 17), showId: 'flex.', order: 'next' });
        slots.push({ time: slotTime(1, 17, 30), showId: 'flex.', order: 'next' });
    }
    const s = { period: WEEK, lateness: 0, maxDays: 364, flexPreference: 'distribute', pad: 5 * MIN, slots };
    if (record) {
        s.progress = { asOf: new Date(NOW).toISOString(), positions: { [STRIP]: record } };
    }
    return s;
}

async function generate(sched, at) {
    const now = at || NOW;
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(now); else super(...a); }
        static now() { return now; }
    }
    global.Date = FrozenDate;
    try {
        const res = await timeSlotsService(kim(), JSON.parse(JSON.stringify(sched)));
        let t = Date.parse(res.startTime);
        return res.programs.map((p) => { const a = { start: t, program: p }; t += p.duration; return a; })
            .filter((a) => !a.program.isOffline);
    } finally {
        global.Date = RealDate;
    }
}
const refTo = (s, e) => slotProgress.ref(kim().find((p) => p.season === s && p.episode === e), getShowData);
const isRerun = (a) => /^rerun\|/.test(a.program.slotPosition || '');
const isStrip = (a) => /^next\|/.test(a.program.slotPosition || '');

module.exports = async function () {
    const suite = new Suite('progress-rerun');

    // The strip has aired S1E1-4: its next is S1E5.
    const year = await generate(schedule(true, { next: refTo(1, 5), wrapped: false }));
    {
        const aired = new Set(kim().filter((p) => p.season === 1 && p.episode < 5).map(key));
        const ahead = [];
        year.forEach((a) => {
            if (isStrip(a)) aired.add(key(a.program));
            if (isRerun(a) && !aired.has(key(a.program))) ahead.push(a.program.title);
        });
        const reruns = year.filter(isRerun);
        suite.check('a Rerun never airs an episode its show\'s Play Next hasn\'t passed',
            reruns.length > 90 && ahead.length === 0, `${reruns.length} reruns, ${ahead.length} ahead: ${ahead.slice(0, 3).join(', ')}`);
        suite.check('the pool grows as the strip advances',
            reruns.slice(0, 6).every((a) => a.program.season === 1)
                && reruns.some((a) => a.program.season === 2),
            reruns.slice(0, 6).map((a) => a.program.title).join(', '));

        // Bad Boy (1) is aired by the strip a week before (2): neither part reruns until both have.
        const bothAt = year.find((a) => isStrip(a) && a.program.title === 'Bad Boy (2)').start;
        const early = year.filter((a) => isRerun(a) && /^Bad Boy/.test(a.program.title) && a.start < bothAt);
        const together = year.every((a, i) => !(isRerun(a) && a.program.title === 'Bad Boy (1)')
            || (year.slice(i + 1).find(isRerun) || {}).program.title === 'Bad Boy (2)');
        suite.check('a story is rerun only once every part has aired, and then whole',
            early.length === 0 && together && year.some((a) => isRerun(a) && a.program.title === 'Bad Boy (1)'));
        // Rounds, as Shuffle's, counted in stories (Bad Boy's two parts are one):
        // never twice in a round, and nothing back within half of what the
        // round before it aired.
        const stories = reruns.filter((a) => a.program.title !== 'Bad Boy (2)')
            .map((a) => ({ story: a.program.title === 'Bad Boy (1)' ? 'Bad Boy' : key(a.program), round: slotProgress.parseLabel(a.program.slotPosition).round }));
        const byRound = new Map();
        stories.forEach((x) => {
            if (!byRound.has(x.round)) byRound.set(x.round, []);
            byRound.get(x.round).push(x.story);
        });
        const twice = [...byRound.values()].filter((ks) => new Set(ks).size !== ks.length).length;
        const last = new Map();
        let tooSoon = 0;
        stories.forEach((x, i) => {
            if (last.has(x.story)) {
                const before = last.get(x.story);
                const earlier = byRound.get(stories[before].round);
                if (x.round !== stories[before].round && i - before - 1 < Math.floor(earlier.length / 2)) tooSoon++;
            }
            last.set(x.story, i);
        });
        suite.check('Rerun rounds work as Shuffle\'s, over what it may pick', twice === 0 && tooSoon === 0,
            `${twice} rounds with a repeat, ${tooSoon} back too soon`);
        suite.check('Rerun airings carry their position and round',
            reruns.every((a) => slotProgress.parseLabel(a.program.slotPosition).mode === 'rerun'
                && typeof slotProgress.parseLabel(a.program.slotPosition).round === 'number'));
    }
    {
        const wrapped = await generate(schedule(true, { next: refTo(1, 2), wrapped: true }));
        const firstWeeks = wrapped.filter(isRerun).slice(0, 12);
        suite.check('a strip that has gone round makes its whole range eligible',
            firstWeeks.some((a) => a.program.season === 2), firstWeeks.map((a) => a.program.title).join(', '));
    }
    {
        // Friday 6pm, the strip set up to start at S1E1: Saturday's and
        // Sunday's Reruns come before it has aired anything.
        const fresh = await generate(schedule(true, { next: refTo(1, 1), wrapped: false }), THU + DAY + 18 * HOUR);
        const firstStrip = fresh.find(isStrip);
        const before = fresh.filter((a) => isRerun(a) && a.start < firstStrip.start);
        const aired = new Set();
        const afterAhead = [];
        fresh.forEach((a) => {
            if (isStrip(a)) aired.add(key(a.program));
            if (isRerun(a) && a.start > firstStrip.start && !aired.has(key(a.program))) afterAhead.push(a.program.title);
        });
        suite.check('nothing aired yet plays as a Shuffle',
            before.length === 2 && before.every((a) => a.program.showTitle === KP) && afterAhead.length === 0,
            `${before.map((a) => a.program.title).join(', ')}; ${afterAhead.length} ahead once the strip began`);
    }
    {
        const none = (await generate(schedule(false))).filter(isRerun);
        suite.check('no Play Next plays as a Shuffle',
            none.length > 90 && new Set(none.slice(0, 20).map((a) => key(a.program))).size === 20 && none.slice(0, 20).some((a) => a.program.season === 2));
    }

    return suite;
};
