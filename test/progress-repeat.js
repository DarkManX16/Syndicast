/*
 * Repeat a slot: re-airs whatever a chosen earlier slot aired, the same day
 * (9pm's episode again at 1am) or another day of the week (channel 3's That's
 * So Raven: Saturday repeats Thursday, Sunday repeats Friday). A source that
 * aired nothing plays a Rerun of the same show (Ron, Oct 9). See NOTES.md,
 * Known issues, "Per-position stored progress, and the shuffles built on it".
 *
 * The real time-slots-service with the clock frozen, on fixtures. The
 * fall-back night's check is in test/dst-fall-back.js, which pins the zone.
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const timeSlotsService = require('../src/services/time-slots-service');
const slotProgress = require('../src/slot-progress');
const getShowData = require('../src/services/get-show-data')();

const WEEK = 7 * DAY;
const THU = new Date('2026-10-08T00:00:00').getTime();
const slotTime = (day, hour, minute) => day * DAY + hour * HOUR + (minute || 0) * MIN;
const [Thu, Fri, Sat, Sun] = [0, 1, 2, 3];
const key = (p) => p.serverKey + '|' + p.key;

function episodes(show, n, mins) {
    const out = [];
    for (let e = 1; e <= n; e++) {
        out.push({ type: 'episode', showTitle: show, title: `${show} S1E${e}`, season: 1, episode: e, duration: (mins || 22) * MIN, serverKey: 'srv', key: `/e/${show}/1/${e}` });
    }
    return out;
}
// Slots, each followed half an hour later by Flex so its window is half an hour.
function slots(list) {
    const out = [];
    list.forEach((s) => {
        out.push(s);
        out.push({ time: s.time + 30 * MIN, showId: 'flex.', order: 'next' });
    });
    return out;
}
function raven() {
    return {
        period: WEEK, lateness: 0, maxDays: 70, flexPreference: 'distribute', pad: 5 * MIN,
        slots: slots([
            { time: slotTime(Thu, 18, 30), showId: 'tv.Raven', order: 'next' },
            { time: slotTime(Fri, 18), showId: 'tv.Raven', order: 'next' },
            { time: slotTime(Sat, 18, 30), showId: 'tv.Raven', order: 'repeat', repeatOf: slotTime(Thu, 18, 30) },
            { time: slotTime(Sun, 17), showId: 'tv.Raven', order: 'repeat', repeatOf: slotTime(Fri, 18) },
        ]),
    };
}

async function generate(programs, schedule, now, history) {
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(now); else super(...a); }
        static now() { return now; }
    }
    global.Date = FrozenDate;
    try {
        return await timeSlotsService(JSON.parse(JSON.stringify(programs)), JSON.parse(JSON.stringify(schedule)), history);
    } finally {
        global.Date = RealDate;
    }
}
function withStarts(res) {
    let t = Date.parse(res.startTime);
    return res.programs.map((p) => { const a = { start: t, program: p }; t += p.duration; return a; }).filter((a) => !a.program.isOffline);
}
const at = (day, hour, minute) => THU + day * DAY + hour * HOUR + (minute || 0) * MIN;
const inSlot = (list, start, mins) => list.filter((a) => a.start >= start && a.start < start + (mins || 30) * MIN);

module.exports = async function () {
    const suite = new Suite('progress-repeat');
    const NOW = at(Thu, 10);

    {
        const aired = withStarts(await generate(episodes('Raven', 20), raven(), NOW));
        let matched = 0;
        let wrong = [];
        // Wall-clock times week by week: the run crosses the Nov 1 fall-back.
        const local = (w, day, hour, minute) => new Date(2026, 9, 8 + day + 7 * w, hour, minute || 0).getTime();
        for (let w = 0; w < 9; w++) {
            const thu = inSlot(aired, local(w, Thu, 18, 30)), sat = inSlot(aired, local(w, Sat, 18, 30));
            const fri = inSlot(aired, local(w, Fri, 18)), sun = inSlot(aired, local(w, Sun, 17));
            [[thu, sat], [fri, sun]].forEach(([src, rep]) => {
                if (src.map((a) => key(a.program)).join() === rep.map((a) => key(a.program)).join() && src.length > 0) matched++;
                else wrong.push(`week ${w}: ${src.map((a) => a.program.title).join('+')} vs ${rep.map((a) => a.program.title).join('+')}`);
            });
        }
        suite.check('Saturday repeats Thursday, Sunday repeats Friday', matched === 18, `${matched} of 18; ${wrong.slice(0, 2).join(' | ')}`);
        suite.check('a repeat re-airs its source\'s episodes, labelled as a repeat',
            inSlot(aired, at(Sat, 18, 30)).every((a) => a.program.slotPosition === 'repeat' && typeof a.program.shuffleOrder === 'undefined')
                && inSlot(aired, at(Sat, 18, 30)).length === 1);

        // Two days later, regenerated from that lineup: the strip's place ignores repeats.
        const later = at(Sat, 20);
        const progress = slotProgress.planProgress({ programs: (await generate(episodes('Raven', 20), raven(), NOW)).programs.map((p) => p),
            startTime: Date.parse((await generate(episodes('Raven', 20), raven(), NOW)).startTime), now: later,
            openedSchedule: raven(), schedule: raven(), pool: episodes('Raven', 20), getShowData });
        const strip = progress.positions[slotProgress.positionKey('tv.Raven', 'next', undefined)];
        const nextThu = inSlot(aired, at(Thu, 18, 30) + WEEK)[0];
        suite.check('a repeat never moves its source\'s position', strip && strip.next.key === key(nextThu.program),
            `${strip && strip.next.key} vs ${key(nextThu.program)}`);
    }
    {
        const pooh = { period: WEEK, lateness: 0, maxDays: 28, flexPreference: 'distribute', pad: 5 * MIN, slots: slots([
            { time: slotTime(Thu, 21), showId: 'tv.Pooh', order: 'next' },
            { time: slotTime(Fri, 1), showId: 'tv.Pooh', order: 'repeat', repeatOf: slotTime(Thu, 21) },
        ]) };
        const aired = withStarts(await generate(episodes('Pooh', 10), pooh, NOW));
        suite.check('a same-day repeat: 9pm again at 1am',
            inSlot(aired, at(Fri, 1))[0].program.title === inSlot(aired, at(Thu, 21))[0].program.title
                && inSlot(aired, at(Fri, 1) + WEEK)[0].program.title === inSlot(aired, at(Thu, 21) + WEEK)[0].program.title);
    }
    {
        const doug = { period: WEEK, lateness: 0, maxDays: 28, flexPreference: 'distribute', pad: 5 * MIN, slots: slots([
            { time: slotTime(Sat, 10), showId: 'tv.Doug', order: 'next' },
            { time: slotTime(Thu, 10), showId: 'tv.Doug', order: 'repeat', repeatOf: slotTime(Sat, 10) },
        ]) };
        const aired = withStarts(await generate(episodes('Doug', 10), doug, NOW));
        suite.check('a source after the repeat in the week repeats last week\'s',
            inSlot(aired, at(Thu, 10) + WEEK)[0].program.title === inSlot(aired, at(Sat, 10))[0].program.title,
            inSlot(aired, at(Thu, 10) + WEEK).map((a) => a.program.title).join());
    }
    {
        const shorts = { period: WEEK, lateness: 0, maxDays: 21, flexPreference: 'distribute', pad: MIN, slots: slots([
            { time: slotTime(Thu, 18), showId: 'tv.Shorts', order: 'next' },
            { time: slotTime(Sat, 9), showId: 'tv.Shorts', order: 'repeat', repeatOf: slotTime(Thu, 18) },
        ]) };
        const aired = withStarts(await generate(episodes('Shorts', 12, 11), shorts, NOW));
        const src = inSlot(aired, at(Thu, 18)), rep = inSlot(aired, at(Sat, 9));
        suite.check('two episodes in the source, two in the repeat, as many as fit',
            src.length === 2 && rep.map((a) => a.program.title).join() === src.map((a) => a.program.title).join());
    }
    {
        // Regenerated Friday 10am: Saturday's source, Thursday 6:30pm, aired before now.
        const history = [{ start: at(Thu, 18, 30), program: Object.assign({}, episodes('Raven', 20)[0], { slotPosition: 'next|' }) }];
        const aired = withStarts(await generate(episodes('Raven', 20), raven(), at(Fri, 10), history));
        suite.check('the first repeat after a regeneration comes from history',
            inSlot(aired, at(Sat, 18, 30)).map((a) => a.program.title).join() === 'Raven S1E1');
        const none = withStarts(await generate(episodes('Raven', 20), raven(), at(Fri, 10), []));
        const fallback = inSlot(none, at(Sat, 18, 30));
        suite.check('nothing in the source plays a Rerun',
            fallback.length === 1 && /^rerun\|/.test(fallback[0].program.slotPosition), fallback.map((a) => a.program.slotPosition).join());
    }

    suite.log('-- reading the lineup on air before now --');
    {
        // A lineup saved Friday 3am, rotated: Thursday is at the end of its cycle.
        const programs = [];
        const startTime = at(Fri, 3);
        // Friday 3am to Thursday 6:30pm is six days fifteen and a half hours.
        programs.push({ isOffline: true, duration: 6 * DAY + 15 * HOUR + 30 * MIN });
        const thursday = Object.assign({}, episodes('Raven', 3)[0], { slotPosition: 'next|' });
        programs.push(thursday);
        programs.push({ isOffline: true, duration: 7 * DAY - programs[0].duration - thursday.duration });
        const recent = slotProgress.recentAirings({ programs, startTime, now: at(Fri, 10), spanMs: WEEK + HOUR });
        suite.check('recentAirings reads back round the loop',
            recent.length === 1 && recent[0].program.title === 'Raven S1E1' && recent[0].start === at(Thu, 18, 30),
            JSON.stringify(recent.map((a) => [a.program.title, new Date(a.start).toString()])));
        suite.check('...and nothing from before the lineup on air was made',
            slotProgress.recentAirings({ programs, startTime, now: at(Fri, 10), spanMs: WEEK + HOUR, since: at(Thu, 20) }).length === 0);
    }

    return suite;
};
