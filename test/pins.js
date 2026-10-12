/*
 * src/pins.js: swaps and inserts pinned to their date and time, and what the
 * editor says about them. See NOTES.md, Known issues, "Swaps, inserts and
 * Flex that keeps time".
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const pins = require('../src/pins');
const getShowData = require('../web/services/get-show-data')();
const commonProgramTools = require('../web/services/common-program-tools')(getShowData);

const THU = new Date('2026-10-08T00:00:00').getTime();
const NOW = Date.parse('2026-10-11T08:00:00.000Z');

function episode(show, season, n, extra) {
    return Object.assign({
        type: 'episode', showTitle: show, title: `${show} S${season}E${n}`,
        season, episode: n, duration: 22 * MIN, serverKey: 'srv', key: `/e/${show}/${season}/${n}`,
    }, extra || {});
}

module.exports = async function () {
    const suite = new Suite('pins');

    suite.log('-- the mark --');
    {
        const from = episode('Hey Arnold!', 3, 23, { title: 'Best Man / Cool Party', slotPosition: 'next|', shuffleOrder: 4,
            start: new Date(THU), stop: new Date(THU), $index: 9 });
        const special = episode('Hey Arnold!', 0, 7, { title: "Arnold's Christmas", slotPosition: 'shuffle||2', shuffleOrder: 3 });
        const at = THU + 19.5 * HOUR;
        const p = pins.makePin({ program: special, at, kind: 'swap', then: 'take', was: pins.label(from), slotShow: 'tv.Hey Arnold!', now: NOW });
        suite.check('makePin strips labels and numbers and records the pin',
            p !== special && typeof p.slotPosition === 'undefined' && typeof p.shuffleOrder === 'undefined'
                && JSON.stringify(p.pin) === JSON.stringify({ at, kind: 'swap', then: 'take', was: 'Hey Arnold! S03E23 Best Man / Cool Party',
                    slotShow: 'tv.Hey Arnold!', made: '2026-10-11T08:00:00.000Z' })
                && typeof special.pin === 'undefined',
            JSON.stringify(p.pin));
        const insert = pins.makePin({ program: special, at, kind: 'insert', then: 'late', slotShow: 'tv.Rugrats', now: NOW });
        suite.check('...and leaves out what it replaced for an insert', ! ('was' in insert.pin));

        const r = pins.removalPin({ airing: from, at, slotShow: 'tv.Hey Arnold!', now: NOW });
        suite.check('removalPin is Flex of the airing\'s length, kind remove',
            r.isOffline === true && r.duration === 22 * MIN && r.pin.kind === 'remove' && r.pin.then === 'take'
                && r.pin.was === 'Hey Arnold! S03E23 Best Man / Cool Party' && r.pin.at === at && Object.keys(r).length === 3,
            JSON.stringify(r));

        suite.check('label names an episode, a custom-show item and a movie',
            pins.label(from) === 'Hey Arnold! S03E23 Best Man / Cool Party'
                && pins.label({ type: 'movie', title: 'The Night Before Christmas (1933)', customShowId: 'x', customShowName: 'Silly Symphonies', customOrder: 11 })
                    === 'Silly Symphonies #12 The Night Before Christmas (1933)'
                && pins.label({ type: 'movie', title: 'The Iron Giant' }) === 'The Iron Giant',
            pins.label(from));
    }

    suite.log('-- pins still to air --');
    {
        const mark = (title, at, then) => episode('X', 0, 1, { title, duration: 30 * MIN, pin: { at, kind: 'swap', then: then || 'take' } });
        const flex = (d) => ({ isOffline: true, duration: d });
        const later = mark('Later', NOW + 2 * DAY, 'late');
        const soon = mark('Soon', NOW + HOUR);
        const aired = mark('Aired', NOW - HOUR);
        const onAir = mark('On air', NOW - 10 * MIN);
        const programs = [flex(HOUR), later, flex(HOUR), aired, episode('A', 1, 1), soon, onAir, flex(DAY)];
        const ahead = pins.pinsAhead({ programs, startTime: NOW - 3 * DAY, now: NOW });
        suite.check('pinsAhead reads pins that end after now, in time order',
            ahead.map((x) => x.program.title).join() === 'On air,Soon,Later' && ahead[2].then === 'late' && ahead[1].at === NOW + HOUR
                && ahead[0].program === onAir,
            ahead.map((x) => x.program.title).join());
        suite.check('...and not one that has aired', ! ahead.some((x) => x.program.title === 'Aired'));

        const fresh = pins.makePin({ program: episode('B', 0, 1), at: NOW + 3 * HOUR, kind: 'swap', then: 'late', slotShow: 'tv.B', now: NOW });
        const keep = pins.withPin(ahead, fresh);
        suite.check('withPin adds a new pin in the generator\'s shape, in time order',
            keep.length === 4 && keep[2].program === fresh && keep[2].at === NOW + 3 * HOUR && keep[2].then === 'late'
                && keep.map((x) => x.at).every((t, i, all) => i === 0 || all[i - 1] <= t),
            JSON.stringify(keep.map((x) => [x.program.title, x.at, x.then])));
    }

    suite.log('-- the pool --');
    {
        const rotation = episode('Kim Possible', 2, 15, { title: 'A Very Possible Christmas' });
        const pinned = Object.assign({}, rotation, { pin: { at: NOW, kind: 'swap', then: 'take' } });
        const pool = commonProgramTools.slotPool([pinned, { isOffline: true, duration: MIN }, rotation, episode('Kim Possible', 2, 16)]);
        suite.check('slotPool leaves pinned airings out',
            pool.length === 2 && pool[0] === rotation && ! pool.some((p) => p.pin),
            pool.map((p) => p.title + (p.pin ? ' [pin]' : '')).join(', '));
    }

    suite.log('-- where an item fits, and what a re-lay did --');
    {
        const lineup = async (pinList, extraBefore) => {
            const res = await generate(fixturePool(), fixtureSchedule(), NOON8, pinList);
            const programs = res.programs;
            return { programs, startTime: Date.parse(res.startTime) };
        };
        const plain = await lineup();
        const schedule = fixtureSchedule();
        const christmas = episode('Hey Arnold!', 0, 7, { title: "Arnold's Christmas", duration: 24 * MIN + 6 * SEC });
        const special = episode('Specials', 0, 1, { title: "'Twas the Fight Before Christmas", duration: 44 * MIN + 9 * SEC });

        const fit = pins.fitAt({ programs: plain.programs, startTime: plain.startTime, schedule, at: thu(19, 30), duration: christmas.duration });
        suite.check('fitAt: fits, with the space to the slot\'s end',
            fit.slotEnd === thu(20) && fit.space === 30 * MIN && fit.overrun === 0 && fit.runsInto.program.showTitle === 'Are You Afraid of the Dark?'
                && fit.runsInto.start === thu(20),
            JSON.stringify({ space: fit.space, overrun: fit.overrun }));
        const over = pins.fitAt({ programs: plain.programs, startTime: plain.startTime, schedule, at: thu(19), duration: special.duration });
        suite.check('fitAt: runs into the next slot by 14:09, naming it',
            over.slotEnd === thu(19, 30) && over.overrun === 14 * MIN + 9 * SEC && over.runsInto.program.showTitle === 'Hey Arnold!',
            JSON.stringify({ overrun: over.overrun, into: over.runsInto && over.runsInto.program.title }));

        const swapped = await lineup([mark(christmas, thu(19, 30), 'take')]);
        const moved = pins.relayEffects({ before: plain, after: swapped, from: NOON8, to: NOON8 + 7 * DAY, schedule, getShowData });
        suite.check('relayEffects names the episode that moved along and where it airs now',
            moved.movedAlong.length === 1 && moved.movedAlong[0].name === 'Hey Arnold!' && moved.movedAlong[0].program.title === 'Best Man / Cool Party'
                && moved.movedAlong[0].wasAt === thu(19, 30) && moved.movedAlong[0].nowAt === thu(19, 30) + DAY
                && moved.late.length === 0 && moved.dropped.length === 0,
            JSON.stringify(moved.movedAlong.map((m) => [m.name, m.program.title, new Date(m.nowAt).toString()])));

        const late = await lineup([mark(special, thu(19), 'late')]);
        const ran = pins.relayEffects({ before: plain, after: late, from: NOON8, to: NOON8 + 7 * DAY, schedule, getShowData });
        suite.check('relayEffects names the shows that ran late and when the schedule is back on time',
            ran.late.map((l) => l.program.showTitle + '@' + clock(l.nowAt)).join() === 'Hey Arnold!@7:44:09 PM,Are You Afraid of the Dark?@8:06:47 PM'
                && ran.backOnTime === thu(20, 30) && ran.movedAlong.map((m) => m.name).join() === 'Rugrats',
            ran.late.map((l) => l.program.showTitle + '@' + clock(l.nowAt)).join() + ' back ' + (ran.backOnTime && clock(ran.backOnTime)));

        // The old way: a 10-second clip inserted by hand in the break after Thursday's 7:30.
        const bumper = { type: 'movie', title: 'NEXT - SGC2C', duration: 10 * SEC, serverKey: 'srv', key: '/b/next' };
        const byHand = { programs: plain.programs.slice(), startTime: plain.startTime };
        let t = plain.startTime, i = 0;
        while (t < thu(19, 52, 38)) { t += byHand.programs[i].duration; i++; }
        const flex = byHand.programs[i];
        byHand.programs.splice(i, 1, bumper, { isOffline: true, duration: flex.duration - bumper.duration });
        const dropped = pins.relayEffects({ before: byHand, after: plain, from: NOON8, to: NOON8 + 7 * DAY, schedule, getShowData });
        suite.check('relayEffects lists a hand-placed bumper the re-lay drops, and not the airings that moved along',
            dropped.dropped.length === 1 && dropped.dropped[0].program.title === 'NEXT - SGC2C' && dropped.dropped[0].start === thu(19, 52, 38)
                && dropped.movedAlong.length === 0,
            JSON.stringify(dropped.dropped.map((d) => d.program.title)));

        // Near a lineup's end its last day can sit off the slots: not hand-placed, and past any re-lay's reach.
        const total = plain.programs.reduce((a, p) => a + p.duration, 0);
        const nearEnd = { programs: plain.programs.slice(), startTime: plain.startTime };
        let u = plain.startTime, j = 0;
        while (u < plain.startTime + total - 2 * DAY) { u += nearEnd.programs[j].duration; j++; }
        nearEnd.programs.splice(j, 0, bumper);
        const atEnd = pins.relayEffects({ before: nearEnd, after: plain, from: NOON8, to: NOON8 + 400 * DAY, schedule, getShowData });
        suite.check('relayEffects stops two weeks before either lineup comes round its loop',
            atEnd.dropped.length === 0, JSON.stringify(atEnd.dropped.map((d) => [d.program.title, new Date(d.start).toString()])));

        const fitText = pins.sayFit({ programs: plain.programs, startTime: plain.startTime, schedule, at: thu(19, 30), item: christmas, kind: 'swap' });
        const overText = pins.sayFit({ programs: plain.programs, startTime: plain.startTime, schedule, at: thu(19), item: special, kind: 'swap' });
        const movedText = pins.sayEffects(moved);
        const lateText = pins.sayEffects(ran);
        const droppedText = pins.sayDropped(dropped.dropped);
        const firstText = pins.sayFirstSwap({ dropped: [] });
        const keptText = pins.sayKept(pins.pinsAhead({ programs: swapped.programs, startTime: swapped.startTime, now: NOON8 }));
        suite.check('the sentences read as the spec\'s examples',
            fitText === "Arnold's Christmas runs 24:06. The space is 30:00 - Best Man / Cool Party and the 7:22 of Flex after it. It fits: 5:54 of Flex after it, and Are You Afraid of the Dark? starts at 8:00."
                && overText === "'Twas the Fight Before Christmas runs 44:09. The space is 30:00 - Home Movies and the 6:12 of Flex after it. It runs 14:09 past 7:30, into Hey Arnold!'s slot."
                && movedText === "Best Man / Cool Party airs Fri Oct 9, 7:30pm, and Hey Arnold!'s later airings move one along."
                && lateText === "Home Movies airs Fri Oct 9, 7:00pm, and Rugrats' later airings move one along. Hey Arnold! starts at 7:44:09 and Are You Afraid of the Dark? at 8:06:47; back on time at 8:30."
                && droppedText === 'This also drops what was placed in the list by hand: Thu Oct 8, 7:52pm NEXT - SGC2C (0:10).'
                && firstText === 'Swapping re-makes the lineup from your Time Slots schedule, as Create Lineup does, so anything placed in the list by hand - bumpers, promos, episodes inserted from the library - is dropped. Nothing placed by hand from now on would be lost.'
                && keptText === "Keeping your swaps and inserts: Thu Oct 8, 7:30pm Arnold's Christmas (Hey Arnold!).",
            [fitText, overText, movedText, lateText, droppedText, firstText, keptText].join(' | '));
    }

    suite.log('-- go to --');
    {
        const a = episode('A', 1, 1, { duration: 20 * MIN });
        const b = episode('B', 1, 1, { duration: 25 * MIN });
        const programs = [a, { isOffline: true, duration: 15 * MIN }, b, { isOffline: true, duration: DAY - 60 * MIN }];
        const start = THU;
        const found = pins.airingAt({ programs, startTime: start, at: THU + 3 * DAY + 37 * MIN });
        const flex = pins.airingAt({ programs, startTime: start, at: THU + 25 * MIN });
        suite.check('airingAt finds the airing on at an instant, round the loop',
            found && found.index === 2 && found.program === b && found.start === THU + 3 * DAY + 35 * MIN
                && flex && flex.index === 1 && flex.start === THU + 20 * MIN,
            JSON.stringify(found && { index: found.index, start: new Date(found.start).toString() }));
        const late = pins.airingAt({ programs, startTime: start + 979, at: THU + 35 * MIN });
        suite.check('...and the airing starting within 2 seconds of it, when a lineup runs a second behind the minute',
            late && late.index === 2 && late.start === THU + 35 * MIN + 979,
            JSON.stringify(late && { index: late.index, start: late.start - THU }));
        suite.check('...and a local date and time on the fall-back night is the first of the two',
            pins.localInstant('2026-11-01', '01:30') === Date.parse('2026-11-01T06:30:00.000Z')
                && pins.localInstant('2026-10-31', '16:00') === new Date('2026-10-31T16:00:00').getTime(),
            new Date(pins.localInstant('2026-11-01', '01:30')).toISOString());
    }

    return suite;
};

// A small lineup made by the real generator, for the readers above.
const timeSlotsService = require('../src/services/time-slots-service');
const SEC = 1000;
const NOON8 = THU + 12 * HOUR;
const thu = (hour, minute, second) => THU + hour * HOUR + (minute || 0) * MIN + (second || 0) * SEC;
const clock = (t) => new Date(t).toLocaleTimeString('en-US');
function fixtureSchedule() {
    return {
        period: DAY, lateness: 24 * HOUR, maxDays: 60, flexPreference: 'distribute', pad: 5 * MIN,
        slots: [
            { time: 19 * HOUR, showId: 'tv.Rugrats', order: 'next' },
            { time: 19 * HOUR + 30 * MIN, showId: 'tv.Hey Arnold!', order: 'next' },
            { time: 20 * HOUR, showId: 'tv.Are You Afraid of the Dark?', order: 'next' },
            { time: 20 * HOUR + 30 * MIN, showId: 'tv.Shelby Woo', order: 'next' },
            { time: 21 * HOUR, showId: 'flex.', order: 'next' },
        ],
    };
}
function fixturePool() {
    const out = [];
    for (let n = 1; n <= 30; n++) {
        out.push(episode('Rugrats', 1, n, { title: n === 1 ? 'Home Movies' : `Rugrats ${n}`, duration: 23 * MIN + 48 * SEC }));
        out.push(episode('Hey Arnold!', 1, n, { title: n === 1 ? 'Best Man / Cool Party' : `Hey Arnold ${n}`, duration: 22 * MIN + 38 * SEC }));
        out.push(episode('Are You Afraid of the Dark?', 1, n, { duration: 22 * MIN }));
        out.push(episode('Shelby Woo', 1, n, { duration: 22 * MIN }));
    }
    return out;
}
function mark(program, at, then) {
    const p = pins.makePin({ program, at, kind: 'swap', then, slotShow: 'tv.' + program.showTitle, now: NOW });
    return { at, then, program: p };
}
async function generate(programs, schedule, now, pinList) {
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(now); else super(...a); }
        static now() { return now; }
    }
    global.Date = FrozenDate;
    try {
        return await timeSlotsService(JSON.parse(JSON.stringify(programs)), JSON.parse(JSON.stringify(schedule)), undefined, pinList);
    } finally {
        global.Date = RealDate;
    }
}
