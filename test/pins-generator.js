/*
 * Pins in the Time Slots generator: a swap or insert fixed to its date and
 * time, the Flex around it keeping everything after on time, and whatever it
 * pushes out airing at its show's next slot. See NOTES.md, Known issues,
 * "Swaps, inserts and Flex that keeps time" - the four rules.
 *
 * The real time-slots-service with the clock frozen, on fixtures in the
 * machine's own zone.
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const timeSlotsService = require('../src/services/time-slots-service');

const SEC = 1000;
const WEEK = 7 * DAY;
const THU = new Date('2026-10-08T00:00:00').getTime();
const NOON = THU + 12 * HOUR;
const slotTime = (day, hour, minute) => day * DAY + hour * HOUR + (minute || 0) * MIN;
const [Thu, , Sat] = [0, 1, 2];
const thu = (hour, minute, second) => THU + hour * HOUR + (minute || 0) * MIN + (second || 0) * SEC;

function episode(show, season, n, duration) {
    return {
        type: 'episode', showTitle: show, title: `${show} S${season}E${n}`,
        season, episode: n, duration: duration || 22 * MIN, serverKey: 'srv', key: `/e/${show}/${season}/${n}`,
    };
}
function seasons(show, count, duration) {
    const out = [];
    for (let e = 1; e <= count; e++) {
        out.push(episode(show, 1, e, duration));
    }
    return out;
}
function item(title, duration, show) {
    return Object.assign(episode(show || 'Specials', 0, 1, duration), { title, key: '/x/' + title });
}
function pin(program, at, then) {
    const p = Object.assign({}, program, { pin: { at, kind: 'swap', then: then || 'take', made: '2026-10-08T12:00:00.000Z' } });
    return { at, then: then || 'take', program: p };
}

// A, B, C, D on the half hour from 7pm, Flex the rest of the day.
function daily(first) {
    return {
        period: DAY, lateness: 24 * HOUR, maxDays: 14, flexPreference: 'distribute', pad: 5 * MIN,
        slots: [
            { time: 19 * HOUR, showId: 'tv.' + (first || 'A'), order: 'next' },
            { time: 19 * HOUR + 30 * MIN, showId: 'tv.B', order: 'next' },
            { time: 20 * HOUR, showId: 'tv.C', order: 'next' },
            { time: 20 * HOUR + 30 * MIN, showId: 'tv.D', order: 'next' },
            { time: 21 * HOUR, showId: 'flex.', order: 'next' },
        ],
    };
}
function pool(first, firstDuration) {
    return seasons(first || 'A', 40, firstDuration).concat(seasons('B', 40), seasons('C', 40), seasons('D', 40));
}

async function generate(programs, schedule, now, pins, carry) {
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(now); else super(...a); }
        static now() { return now; }
    }
    global.Date = FrozenDate;
    try {
        const args = [JSON.parse(JSON.stringify(programs)), JSON.parse(JSON.stringify(schedule)), undefined];
        if ( (typeof pins !== 'undefined') || (typeof carry !== 'undefined') ) {
            args.push( (typeof pins === 'undefined') ? undefined : JSON.parse(JSON.stringify(pins)) );
        }
        if (typeof carry !== 'undefined') {
            args.push(JSON.parse(JSON.stringify(carry)));
        }
        return await timeSlotsService(...args);
    } finally {
        global.Date = RealDate;
    }
}

function withStarts(res) {
    let t = Date.parse(res.startTime);
    return res.programs.map((p) => { const a = { start: t, program: p }; t += p.duration; return a; });
}
const shows = (res) => withStarts(res).filter((a) => !a.program.isOffline);
const startOf = (res, title) => { const a = shows(res).find((x) => x.program.title === title); return a ? a.start : null; };
const firstAt = (res, from) => shows(res).find((a) => a.start >= from - 2 * SEC);
const titlesOf = (res, show, from) => shows(res).filter((a) => a.program.showTitle === show && a.start >= from).map((a) => a.program.title);
const flexBetween = (res, from, to) => withStarts(res)
    .filter((a) => a.program.isOffline && a.start >= from - SEC && a.start < to - SEC).reduce((s, a) => s + a.program.duration, 0);
const clock = (t) => new Date(t).toLocaleTimeString('en-US');

module.exports = async function () {
    const suite = new Suite('pins-generator');
    const plain = await generate(pool(), daily(), NOON);
    const bThu = titlesOf(plain, 'B', thu(19, 30))[0];
    const aThu = titlesOf(plain, 'A', thu(19))[0];

    suite.log('-- no pins --');
    {
        const empty = await generate(pool(), daily(), NOON, []);
        suite.check('no pins: the same lineup as without the argument',
            JSON.stringify(empty) === JSON.stringify(plain));
    }

    suite.log('-- a swap that fits --');
    {
        const special = item('B Special', 24 * MIN + 6 * SEC, 'B');
        const res = await generate(pool(), daily(), NOON, [pin(special, thu(19, 30))]);
        const s = startOf(res, 'B Special');
        suite.check('a swap that fits: at its time, Flex to the next slot, the next slot on time',
            s === thu(19, 30) && firstAt(res, thu(19, 54, 6)).start === thu(20) && flexBetween(res, thu(19, 54, 6), thu(20)) === 5 * MIN + 54 * SEC,
            `special ${s && clock(s)}, next ${clock(firstAt(res, thu(19, 54, 6)).start)}, flex ${flexBetween(res, thu(19, 54, 6), thu(20)) / SEC}s`);
        const after = titlesOf(res, 'B', thu(19, 31));
        const before = titlesOf(plain, 'B', thu(19, 30));
        suite.check("...and the episode it pushed out airs at its show's next slot",
            startOf(res, bThu) === thu(19, 30) + DAY && after.slice(0, 10).join() === before.slice(0, 10).join(),
            `${bThu} at ${startOf(res, bThu) && new Date(startOf(res, bThu)).toString()}`);
        const placed = (shows(res).find((a) => a.program.title === 'B Special') || { program: {} }).program;
        suite.check('the pinned airing keeps its pin and no label',
            placed.pin && placed.pin.at === thu(19, 30) && typeof placed.slotPosition === 'undefined' && typeof placed.shuffleOrder === 'undefined');
    }

    suite.log('-- too long --');
    {
        const long = item('Long Special', 44 * MIN + 9 * SEC);
        const take = await generate(pool(), daily(), NOON, [pin(long, thu(19), 'take')]);
        suite.check('too long, take: the slot it runs into is Flex and its episode waits',
            !shows(take).some((a) => a.start > thu(19) && a.start < thu(20)) && firstAt(take, thu(19, 44)).start === thu(20)
                && startOf(take, bThu) === thu(19, 30) + DAY && startOf(take, aThu) === thu(19) + DAY,
            `C ${clock(firstAt(take, thu(19, 44)).start)}, ${bThu} ${startOf(take, bThu) && new Date(startOf(take, bThu)).toString()}`);

        const late = await generate(pool(), daily(), NOON, [pin(long, thu(19), 'late')]);
        const b = startOf(late, bThu);
        const c = firstAt(late, thu(20)).start;
        const d = firstAt(late, thu(20, 29)).start;
        suite.check("too long, late: the next show starts the moment it ends, then back on time",
            b === thu(19, 44, 9) && c === thu(20, 6, 9) && d === thu(20, 30),
            `B ${b && clock(b)}, C ${clock(c)}, D ${clock(d)}`);

        const movie = item('Movie', 76 * MIN + 40 * SEC);
        const whole = await generate(pool(), daily(), NOON, [pin(movie, thu(19), 'late')]);
        suite.check('a slot it covers whole is taken over, even running late',
            !shows(whole).some((a) => a.program.showTitle === 'B' && a.start >= thu(19) && a.start < THU + DAY)
                && firstAt(whole, thu(20)).start === thu(20, 16, 40) && firstAt(whole, thu(20)).program.showTitle === 'C',
            `${firstAt(whole, thu(20)).program.title} at ${clock(firstAt(whole, thu(20)).start)}`);
    }

    suite.log('-- two halves --');
    {
        const halves = pool('H', 11 * MIN);
        const plainH = await generate(halves, daily('H'), NOON);
        const [h1, h2] = titlesOf(plainH, 'H', thu(19));
        const res = await generate(halves, daily('H'), NOON, [pin(item('H Christmas', 22 * MIN + 38 * SEC, 'H'), thu(19))]);
        suite.check('two halves: a pin over the first takes the slot and both halves wait',
            flexBetween(res, thu(19, 22, 38), thu(19, 30)) === 7 * MIN + 22 * SEC && firstAt(res, thu(19, 23)).start === thu(19, 30)
                && startOf(res, h1) === thu(19) + DAY && startOf(res, h2) === thu(19, 15) + DAY,
            `${h1} ${startOf(res, h1) && new Date(startOf(res, h1)).toString()}, ${h2} ${startOf(res, h2) && new Date(startOf(res, h2)).toString()}`);
    }

    suite.log('-- inserts --');
    {
        const short = item('Short', 5 * MIN);
        const res = await generate(pool(), daily(), NOON, [pin(short, thu(19, 22), 'late')]);
        suite.check('an insert after a program takes its time from the break',
            startOf(res, 'Short') === thu(19, 22) && startOf(res, bThu) === thu(19, 30) && flexBetween(res, thu(19, 27), thu(19, 30)) === 3 * MIN,
            `short ${clock(startOf(res, 'Short'))}, B ${clock(startOf(res, bThu))}`);

        const over = item('Over', 8 * MIN + 11 * SEC);
        const lateRes = await generate(pool(), daily(), NOON, [pin(over, thu(19, 22), 'late')]);
        suite.check('an insert 11 seconds too long, late: the next show starts 11 seconds late',
            startOf(lateRes, bThu) === thu(19, 30, 11) && firstAt(lateRes, thu(20)).start === thu(20),
            `B ${clock(startOf(lateRes, bThu))}, C ${clock(firstAt(lateRes, thu(20)).start)}`);

        const waits = await generate(pool(), daily(), NOON, [pin(item('Two', 2 * MIN), thu(19, 20))]);
        suite.check('a pin waits for a program still on at its time',
            startOf(waits, 'Two') === thu(19, 22) && startOf(waits, aThu) === thu(19), `at ${clock(startOf(waits, 'Two'))}`);
    }

    suite.log('-- edges --');
    {
        const special = item('Off Minute', 24 * MIN + 6 * SEC, 'B');
        const res = await generate(pool(), daily(), NOON, [pin(special, thu(19, 30) + 645)]);
        const s = startOf(res, 'Off Minute');
        suite.check("a pin 0.645 seconds after a slot's start is that slot's",
            !shows(res).some((a) => a.program.showTitle === 'B' && ! a.program.pin && a.start >= thu(19) && a.start < THU + DAY) && Math.abs(s - thu(19, 30)) <= SEC,
            `special ${s && clock(s)}`);

        const flex = { isOffline: true, duration: 22 * MIN };
        const fres = await generate(pool(), daily(), NOON, [pin(flex, thu(19, 30))]);
        const entries = withStarts(fres);
        const i = entries.findIndex((a) => a.program.pin);
        suite.check('a pinned Flex keeps its own entry and length',
            i !== -1 && entries[i].start === thu(19, 30) && entries[i].program.duration === 22 * MIN
                && entries[i + 1].program.isOffline && ! entries[i + 1].program.pin && entries[i + 1].program.duration === 8 * MIN
                && entries[i + 2].start === thu(20),
            i === -1 ? 'no pinned entry' : `pinned ${entries[i].program.duration / MIN} min, then ${entries[i + 1].program.duration / MIN} min`);

        const now = thu(19, 40);
        const done = item('Done', 24 * MIN);
        const onAir = item('On Air', 24 * MIN + 6 * SEC, 'B');
        const ores = await generate(pool(), daily(), now, [pin(done, thu(19)), pin(onAir, thu(19, 30))]);
        suite.check('a pin that has aired is gone; one on air starts again now',
            startOf(ores, 'Done') === null && startOf(ores, 'On Air') === now,
            `done ${startOf(ores, 'Done')}, on air ${startOf(ores, 'On Air') && clock(startOf(ores, 'On Air'))}`);
    }

    suite.log('-- the program on air is left alone --');
    {
        const onAir = shows(plain).find((a) => a.start === thu(19, 30)).program;
        const programAt = (res, from, to) => shows(res).filter((a) => a.start >= from && a.start < to);
        const mid = await generate(pool(), daily(), thu(19, 40), undefined, { start: thu(19, 30), program: onAir });
        suite.check('a lineup made while a program is on air carries it at its real start, and its slot\'s next episode waits',
            startOf(mid, onAir.title) === thu(19, 30) && programAt(mid, thu(19, 31), thu(20)).length === 0 && firstAt(mid, thu(19, 31)).start === thu(20),
            `${onAir.title} at ${startOf(mid, onAir.title) && clock(startOf(mid, onAir.title))}; next ${clock(firstAt(mid, thu(19, 31)).start)}`);
        const brk = await generate(pool(), daily(), thu(19, 55), undefined, { start: thu(19, 30), program: onAir });
        suite.check('...and during the break after it, nothing starts before the next slot',
            programAt(brk, thu(19, 31), thu(20)).length === 0 && firstAt(brk, thu(19, 31)).start === thu(20),
            programAt(brk, thu(19, 31), thu(20)).map((a) => a.program.title + ' ' + clock(a.start)).join(', '));
        // A daily schedule's period starts at its first slot, 7pm: a program from before then,
        // still on air, is kept all the same, and the lineup's length stays whole days.
        const late = { period: DAY, lateness: 24 * HOUR, maxDays: 14, flexPreference: 'distribute', pad: 5 * MIN,
            slots: [ { time: 0, showId: 'tv.A', order: 'next' }, { time: 19 * HOUR, showId: 'tv.B', order: 'next' }, { time: 19 * HOUR + 30 * MIN, showId: 'flex.', order: 'next' } ] };
        const overnight = Object.assign({}, item('Overnight Movie', 90 * MIN, 'A'));
        const across = await generate(pool(), late, thu(0, 20), undefined, { start: thu(0) - 30 * MIN, program: overnight });
        const acrossTotal = across.programs.reduce((x, q) => x + q.duration, 0);
        suite.check('...and one that began before the lineup\'s period, still on air, is kept, the length whole days',
            startOf(across, 'Overnight Movie') === thu(0) - 30 * MIN && acrossTotal % DAY === 0,
            `movie at ${startOf(across, 'Overnight Movie') && new Date(startOf(across, 'Overnight Movie')).toString()}, length ${acrossTotal / DAY} days`);
        const longOne = item('Long One', 44 * MIN + 9 * SEC, 'A');
        const ranInto = await generate(pool(), daily(), thu(19, 40), undefined, { start: thu(19), program: longOne });
        suite.check('...and a show it ran into starts as the generator always made it, on the 5-minute mark',
            startOf(ranInto, 'Long One') === thu(19) && startOf(ranInto, bThu) === thu(19, 45),
            `B at ${startOf(ranInto, bThu) && clock(startOf(ranInto, bThu))}`);
        // A carry that isn't one is ignored: the same lineup as with none.
        const same = (x, y) => JSON.stringify(x.programs) === JSON.stringify(y.programs) && x.startTime === y.startTime;
        const bad = await generate(pool(), daily(), thu(19, 40), undefined, { start: thu(19, 30), program: { type: 'episode', duration: 'long' } });
        const none = await generate(pool(), daily(), thu(19, 40));
        suite.check('...a carry with no length is ignored, as is no carry', same(bad, none));
        const sched = { period: DAY, lateness: 24 * HOUR, maxDays: 14, flexPreference: 'distribute', pad: 5 * MIN, slots: [
            { time: 19 * HOUR, showId: 'tv.A', order: 'next' }, { time: 19 * HOUR + 30 * MIN, showId: 'flex.', order: 'next' },
            { time: 21 * HOUR, showId: 'tv.D', order: 'next' } ] };
        const longOver = await generate(pool(), sched, thu(21, 15), undefined, { start: thu(19), program: onAir });
        const noCarry = await generate(pool(), sched, thu(21, 15));
        suite.check('...and so is a program whose own slot is long over, with Flex on air: nothing is laid in the past',
            same(longOver, noCarry) && ! shows(longOver).some((a) => a.start < thu(21, 15) - 2 * SEC && a.start >= thu(19, 30)),
            shows(longOver).filter((a) => a.start < thu(21, 15)).map((a) => a.program.title + ' ' + clock(a.start)).join(', '));
        const pinned = Object.assign({}, item('Pinned Special', 24 * MIN, 'B'), { pin: { at: thu(19, 30), kind: 'swap', then: 'take' } });
        const pres = await generate(pool(), daily(), thu(19, 40), undefined, { start: thu(19, 30), program: pinned });
        const placed = shows(pres).find((a) => a.program.title === 'Pinned Special');
        suite.check('...a carried pinned airing keeps its pin',
            placed && placed.start === thu(19, 30) && placed.program.pin && placed.program.pin.at === thu(19, 30));
    }

    suite.log('-- a removal keeps its slot --');
    {
        const halves = pool('H', 11 * MIN);
        const plainH = await generate(halves, daily('H'), NOON);
        const [h1, h2] = titlesOf(plainH, 'H', thu(19));
        const removal = { at: thu(19), then: 'take', program: { isOffline: true, duration: 11 * MIN,
            pin: { at: thu(19), kind: 'remove', then: 'take', was: h1, slotShow: 'tv.H', made: '2026-10-08T12:00:00.000Z' } } };
        const res = await generate(halves, daily('H'), NOON, [removal]);
        suite.check('a removed half of a two-halves slot is not refilled: no H airs in that slot, and both halves air the next day',
            titlesOf(res, 'H', thu(19)).length > 0 && ! shows(res).some((a) => a.program.showTitle === 'H' && a.start < thu(19, 30))
                && startOf(res, h1) === thu(19) + DAY && startOf(res, h2) === thu(19, 15) + DAY,
            `${h1} ${startOf(res, h1) && new Date(startOf(res, h1)).toString()}`);
        const kept = res.programs.find((p) => p.pin);
        suite.check('...the pinned Flex is kept as its own entry, its slot Flex to the end',
            kept && kept.pin.kind === 'remove' && kept.duration === 11 * MIN && flexBetween(res, thu(19), thu(19, 30)) === 30 * MIN);
    }

    suite.log('-- a Repeat --');
    {
        const weekly = {
            period: WEEK, lateness: 24 * HOUR, maxDays: 14, flexPreference: 'distribute', pad: 5 * MIN,
            slots: [
                { time: slotTime(Thu, 19, 30), showId: 'tv.B', order: 'next' },
                { time: slotTime(Thu, 20), showId: 'flex.', order: 'next' },
                { time: slotTime(Sat, 19, 30), showId: 'tv.B', order: 'repeat', repeatOf: slotTime(Thu, 19, 30) },
                { time: slotTime(Sat, 20), showId: 'flex.', order: 'next' },
            ],
        };
        const special = item('B Repeat Special', 22 * MIN, 'B');
        const res = await generate(seasons('B', 40), weekly, NOON, [pin(special, thu(19, 30))]);
        const sat = shows(res).find((a) => a.start === thu(19, 30) + 2 * DAY);
        suite.check('a Repeat of a slot holding a pin of its show re-airs it without the pin',
            sat && sat.program.title === 'B Repeat Special' && sat.program.slotPosition === 'repeat' && typeof sat.program.pin === 'undefined',
            sat ? `${sat.program.title} ${sat.program.slotPosition} pin=${JSON.stringify(sat.program.pin)}` : 'nothing Sat 7:30');
    }

    suite.log('-- the fall-back night --');
    {
        const night = {
            period: DAY, lateness: 24 * HOUR, maxDays: 7, flexPreference: 'distribute', pad: 5 * MIN,
            slots: [
                { time: 1 * HOUR, showId: 'tv.E', order: 'next' },
                { time: 1 * HOUR + 30 * MIN, showId: 'tv.F', order: 'next' },
                { time: 2 * HOUR, showId: 'flex.', order: 'next' },
            ],
        };
        const cst = Date.parse('2026-11-01T07:30:00Z');
        const cdt = Date.parse('2026-11-01T06:30:00Z');
        const res = await generate(seasons('E', 40).concat(seasons('F', 40)), night, new Date('2026-10-31T12:00:00').getTime(),
            [pin(item('Night Special', 20 * MIN, 'F'), cst)]);
        const specials = shows(res).filter((a) => a.program.title === 'Night Special');
        const first = shows(res).find((a) => a.start === cdt);
        suite.check('on the fall-back night a pin in the repeated hour airs once, at its instant',
            specials.length === 1 && specials[0].start === cst && first && first.program.showTitle === 'F',
            `${specials.length} airings${specials[0] ? ' at ' + new Date(specials[0].start).toISOString() : ''}; 06:30Z ${first ? first.program.title : 'nothing'}`);
    }

    return suite;
};
