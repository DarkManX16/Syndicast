/*
 * The Nov 1, 2026 fall-back night, for everything that reads the wall clock:
 * the slot generator, day-parts and blocks (including "shift with daylight
 * saving"), weeklySegments, and the guide built from a generated lineup. In
 * US Central, 2:00am CDT becomes 1:00am CST at 07:00Z, so 1:00-2:00am
 * happens twice - first at 06:00-07:00Z, again at 07:00-08:00Z. Instants
 * below are written in UTC for exactly that reason: "1:30am" names two of
 * them.
 *
 * Every check here is about one named night in one named zone, so unlike the
 * rest of the suite (fixtures in "the machine's own zone") this file pins
 * America/Chicago - in-process when the machine is already there, otherwise
 * by re-running itself in a child with TZ set. Setting TZ in-process would
 * not be enough: day-parts.js caches each year's standard offset, and an
 * earlier file in the same run may already have filled it under another zone.
 *
 * Driven against the real code - time-slots-service with the clock frozen,
 * TVGuideService#getChannelPrograms, the resolver - using a fixture shaped
 * like channel 1's Saturday-night/Sunday-morning stretch rather than the
 * channel file itself, since npm test reads no data folder. The day-parts and
 * block airings are channel 1's own; the slot schedule is one show per half
 * hour, named by its wall-clock time, so "which slot airs" is readable
 * straight off a program's title.
 *
 * On the repeated hour's second pass, the slots inside it air again: the
 * 1:00 slot at 1:00am CST, the 1:30 at 1:30am CST, so everything after keeps
 * its clock time. Day-part starts follow the same wall clock, except a
 * shifted one, which is fixed in standard time and happens exactly once; the
 * day-part in effect is the one whose start happened last, in real time, and
 * the spring change is checked for that too.
 */
const { spawnSync } = require('child_process');
const TVGuideService = require('../src/services/tv-guide-service');
const timeSlotsService = require('../src/services/time-slots-service');
const slotWeek = require('../src/slot-week');
const slotProgress = require('../src/slot-progress');
const { helperFuncs, dayParts, MIN, HOUR, DAY, mix, Suite, liftSource } = require('./support');

const ZONE = 'America/Chicago';
const WEEK = 7 * DAY;
const Z = (iso) => Date.parse(iso);

// Sat Oct 31 11:00pm CDT to Sun Nov 1 4:00am CST: the window walked by hand.
const NIGHT_FROM = Z('2026-11-01T04:00:00Z');
const NIGHT_TO = Z('2026-11-01T10:00:00Z');
const FALL_BACK = Z('2026-11-01T07:00:00Z');

function label(t) {
    const d = new Date(t);
    const h = d.getHours() % 12 || 12;
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}${d.getHours() < 12 ? 'am' : 'pm'} ${d.getTimezoneOffset() === 300 ? 'CDT' : 'CST'}`;
}

// The show owning a wall-clock half hour, by name: 'S 20:00' airs at 8pm.
function showAt(t) {
    const d = new Date(t);
    const hh = String(d.getHours()).padStart(2, '0');
    return `S ${hh}:${d.getMinutes() < 30 ? '00' : '30'}`;
}

/*
 * One show per half hour, the same every day of the week - the shape a
 * daily schedule has after being cloned to weekly, as channel 1's was.
 * 22-minute episodes in 30-minute slots, padded to 5 minutes, which is what
 * channel 1's Saturday night carries.
 */
function slotFixture() {
    const programs = [];
    const slots = [];
    for (let half = 0; half < 48; half++) {
        const title = `S ${String(Math.floor(half / 2)).padStart(2, '0')}:${half % 2 ? '30' : '00'}`;
        for (let e = 1; e <= 20; e++) {
            programs.push({
                type: 'episode', showTitle: title, title: `${title} e${e}`,
                season: 1, episode: e, key: `/k/${title}/${e}`, serverKey: 'srv',
                duration: 22 * MIN,
            });
        }
        for (let day = 0; day < 7; day++) {
            slots.push({ time: day * DAY + half * 30 * MIN, showId: `tv.${title}`, order: 'next' });
        }
    }
    const schedule = {
        period: WEEK, lateness: DAY, maxDays: 14, flexPreference: 'distribute',
        pad: 5 * MIN, slots,
    };
    return { programs, schedule };
}

// Channel 1's own day-parts and blocks, starts and airings unchanged.
function overlayFixture() {
    return {
        dayParts: [
            { name: 'CCN', fillerCollections: mix([['Powerhouse', 589], ['CN Groovies', 31]]),
              starts: [{ days: [1, 2, 3, 4, 5], time: 6 * HOUR }, { days: [6], time: 0 }] },
            { name: 'Adult Swim', fillerCollections: mix([['Adult Swim', 300]]),
              starts: [{ days: [2, 3, 4, 5], time: 0 }] },
            { name: 'Adult Swim (Sun.)', fillerCollections: mix([['Adult Swim Sunday', 300]]),
              starts: [{ days: [0], time: 22 * HOUR }] },
            { name: 'CN City (Day)', fillerCollections: mix([['CN City Day', 300]]),
              starts: [{ days: [6], time: 6 * HOUR }, { days: [0], time: 10 * HOUR }] },
            { name: 'CN City (Night)', fillerCollections: mix([['CN City Night', 300]]),
              starts: [{ days: [6, 0], time: 19 * HOUR }] },
            { name: 'Toonami AcTN', fillerCollections: mix([['Toonami AcTN', 300]]),
              starts: [{ days: [0], time: 0 }] },
            { name: 'Checkerboard Era', fillerCollections: mix([['Checkerboard', 300]]),
              starts: [{ days: [0], time: 6 * HOUR }] },
        ],
        blocks: [
            { name: 'Toonami', fillerCollections: mix([['Toonami', 300]]),
              airings: [{ days: [1, 2, 3, 5], start: 14 * HOUR + 50 * MIN, end: 17 * HOUR }] },
            { name: 'Toonami Midnight Run', fillerCollections: mix([['Toonami', 300]]),
              airings: [{ days: [6], start: 1 * HOUR, end: 3 * HOUR }] },
            { name: 'Miguzi', fillerCollections: mix([['Miguzi', 450], ['CN City Day', 300]]),
              airings: [
                  { days: [6], start: 14 * HOUR + 30 * MIN, end: 19 * HOUR },
                  { days: [0], start: 14 * HOUR + 45 * MIN, end: 19 * HOUR },
              ] },
        ],
    };
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const nameAt = (channel, t) => {
    const context = dayParts.resolveContext(channel, t);
    return context ? context.name : 'Flex';
};

// Runs the real generator with `new Date()` frozen at `now`, the way 8d72c52
// was verified: "with the clock moved to each transition".
async function generate(programs, schedule, now) {
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) {
                super(now);
            } else {
                super(...args);
            }
        }
        static now() {
            return now;
        }
    }
    global.Date = FrozenDate;
    try {
        return await timeSlotsService(programs, clone(schedule));
    } finally {
        global.Date = RealDate;
    }
}

function programStarts(channel) {
    let t = Date.parse(channel.startTime);
    return channel.programs.map( (program, index) => {
        const start = t;
        t += program.duration;
        return { start, program, index };
    } );
}

async function guideFor(channel, t0, t1) {
    const g = new TVGuideService(null, null, null, null, null);
    g._throttle = async () => {};
    g.channelsByNumber = { [channel.number]: channel };
    g.accumulateTable = { [channel.number]: await g.makeAccumulated(channel) };
    return await g.getChannelPrograms(t0, t1, channel);
}

async function checks() {
    const suite = new Suite('dst-fall-back');

    suite.check(`Runs in ${ZONE}, where 2:00am CDT falls back to 1:00am CST at 07:00Z`,
        new Date(FALL_BACK - 1).getTimezoneOffset() === 300
            && new Date(FALL_BACK).getTimezoneOffset() === 360,
        Intl.DateTimeFormat().resolvedOptions().timeZone);

    // ---- slots ----------------------------------------------------------
    suite.log('-- slots, generated on Wed Oct 28 --');
    const { programs, schedule } = slotFixture();
    const generated = await generate(programs, schedule, Z('2026-10-28T17:00:00Z'));
    const lineupOk = suite.check('The slot generator runs across the change',
        Array.isArray(generated.programs) && generated.programs.length > 0,
        generated.userError);
    if (!lineupOk) {
        return suite;
    }
    const channel = Object.assign(overlayFixture(), {
        number: 70, name: 'Fall-back', icon: '/icon.png',
        guideMinimumDurationSeconds: 300,
        startTime: generated.startTime,
        programs: generated.programs,
        duration: generated.programs.reduce( (a, p) => a + p.duration, 0 ),
    });
    const starts = programStarts(channel);
    const realStarts = starts.filter( (s) => s.program.isOffline !== true );

    // The 8d72c52 regression, pinned to this night: before that fix the whole
    // schedule used one offset, so every slot after the change aired an hour
    // early. The repeated hour's second pass is included - each slot in it
    // airs again, so it too reads straight off the wall clock.
    const around = realStarts.filter( (s) => s.start >= Z('2026-10-31T05:00:00Z')
        && s.start < Z('2026-11-03T06:00:00Z') );
    const misplaced = around.filter( (s) => s.program.showTitle !== showAt(s.start) );
    suite.check('Oct 31 to Nov 2, every program starts in the slot for its own wall-clock time, both 1-2ams included',
        around.length > 100 && misplaced.length === 0,
        `${around.length} programs` + misplaced.slice(0, 3).map(
            (s) => ` | ${label(s.start)} ${s.program.showTitle}, wanted ${showAt(s.start)}`).join(''));

    const airingAt = (t) => {
        const s = realStarts.find( (x) => x.start === t );
        return s ? s.program.showTitle : '(nothing starts)';
    };
    [
        ['2026-10-31T01:00:00Z', 'S 20:00', 'Fri 8:00pm CDT'],
        ['2026-11-01T06:00:00Z', 'S 01:00', 'Sun 1:00am CDT'],
        ['2026-11-01T06:30:00Z', 'S 01:30', 'Sun 1:30am CDT'],
        ['2026-11-01T07:00:00Z', 'S 01:00', 'Sun 1:00am CST, the repeat - the 1:00 slot airs again'],
        ['2026-11-01T07:30:00Z', 'S 01:30', 'Sun 1:30am CST, the repeat - the 1:30 slot airs again'],
        ['2026-11-01T08:00:00Z', 'S 02:00', 'Sun 2:00am CST, the first hour after the repeat'],
        ['2026-11-02T02:00:00Z', 'S 20:00', 'Sun 8:00pm CST, aired an hour early before 8d72c52'],
    ].forEach( ([iso, want, when]) => {
        suite.check(`${when}: ${want} airs`, airingAt(Z(iso)) === want, airingAt(Z(iso)));
    } );

    // A slot that spans the change has nothing to air again: the clock falls
    // back into the same slot. It must run on as one block. Cut at the jump
    // instead, it would be re-entered an hour "late", and with lateness at 0
    // the rest of it would go to flex. Sunday's 12:00am slot, stretched here
    // to 3:00am by dropping the four after it.
    const sunday = slotWeek.slotDayOf(0) * DAY;
    const stretched = clone(schedule);
    stretched.lateness = 0;
    stretched.slots = stretched.slots.filter( (x) => ! (x.time > sunday && x.time < sunday + 3 * HOUR) );
    const long = await generate(programs, stretched, Z('2026-10-28T17:00:00Z'));
    const longStarts = programStarts({ startTime: long.startTime, programs: long.programs })
        .filter( (s) => s.start >= Z('2026-11-01T05:00:00Z') && s.start < Z('2026-11-01T09:00:00Z') );
    const strays = longStarts.filter( (s) => (s.program.isOffline !== true) && (s.program.showTitle !== 'S 00:00') );
    const longestFlex = Math.max(0, ...longStarts.filter( (s) => s.program.isOffline === true )
        .map( (s) => s.program.duration ));
    suite.check('A 12-3am slot runs on through the repeat as one block, not cut to flex',
        strays.length === 0 && longestFlex < 30 * MIN
            && longStarts.filter( (s) => s.program.isOffline !== true ).length >= 9,
        `longest flex ${Math.round(longestFlex / MIN)}min`
            + strays.slice(0, 2).map( (s) => ` | ${label(s.start)} ${s.program.showTitle}` ).join(''));

    // ---- guide against playback ----------------------------------------
    suite.log('-- guide and playback, 11pm CDT to 4am CST --');
    const guide = await guideFor(channel, NIGHT_FROM, NIGHT_TO);
    const seams = [];
    for (let i = 1; i < guide.programs.length; i++) {
        if (guide.programs[i].start !== guide.programs[i - 1].stop) {
            seams.push(`${guide.programs[i - 1].stop} -> ${guide.programs[i].start}`);
        }
    }
    suite.check('The guide covers the night with no gaps or overlaps',
        guide.programs.length > 0
            && Date.parse(guide.programs[0].start) <= NIGHT_FROM
            && Date.parse(guide.programs[guide.programs.length - 1].stop) >= NIGHT_TO
            && seams.length === 0,
        seams.slice(0, 3).join(' | '));

    // Sampled half a minute past each minute, clear of the up-to-10-second
    // early handover getCurrentProgramAndTimeElapsed makes at a boundary.
    // A break under 30 minutes is melded into the show before it in the
    // guide, so playback's Flex under a show's entry is agreement.
    const disagreements = [];
    for (let t = NIGHT_FROM + 30 * 1000; t < NIGHT_TO; t += MIN) {
        const playing = helperFuncs.getCurrentProgramAndTimeElapsed(t, channel).program;
        const entry = guide.programs.find( (e) => Date.parse(e.start) <= t && t < Date.parse(e.stop) );
        const agree = (entry != null) && (playing.isOffline === true
            ? true
            : (entry.title === playing.showTitle && entry.sub.title === playing.title));
        if (! agree) {
            disagreements.push(`${label(t)} plays ${playing.isOffline ? 'Flex' : playing.title}, `
                + `guide ${entry ? entry.title : 'nothing'}`);
        }
    }
    suite.check('Guide and playback agree every minute of the night, both 1:00-2:00ams included',
        disagreements.length === 0, disagreements.slice(0, 3).join(' | '));

    // What the XMLTV file actually writes for the two 1:30ams. The guide is
    // unambiguous only because every time goes out in UTC.
    const xmltvDate = new Function('d',
        liftSource('src/xmltv.js', '_createXMLTVDate') + '\nreturn _createXMLTVDate(d);');
    const at130 = guide.programs.filter( (e) => label(Date.parse(e.start)).startsWith('1:30am') )
        .map( (e) => xmltvDate(e.start) );
    suite.check('XMLTV writes the two 1:30ams as distinct UTC times an hour apart',
        at130.length === 2 && at130[0] === '20261101063000 +0000' && at130[1] === '20261101073000 +0000',
        at130.join(', '));

    // ---- day-parts and blocks, as channel 1 configures them -------------
    suite.log('-- day-parts and blocks as configured --');
    const wrong = [];
    for (let t = NIGHT_FROM; t < NIGHT_TO; t += 5 * MIN) {
        const want = t < Z('2026-11-01T05:00:00Z') ? 'CN City (Night)' : 'Toonami AcTN';
        if (nameAt(channel, t) !== want) {
            wrong.push(`${label(t)} ${nameAt(channel, t)}`);
        }
    }
    suite.check('CN City (Night) until midnight, then Toonami AcTN through both passes of 1-2am',
        wrong.length === 0, wrong.slice(0, 3).join(' | '));

    // The neighbour rule on this night: each break takes the mix of the show
    // after it, so the one before midnight is already Toonami AcTN's.
    const breaks = starts.filter( (s) => s.program.isOffline === true
        && s.start >= NIGHT_FROM && s.start < NIGHT_TO );
    const wrongBreaks = breaks.filter( (s) => {
        const next = starts[s.index + 1];
        const want = next.start < Z('2026-11-01T05:00:00Z') ? 'CN City Night' : 'Toonami AcTN';
        const collections = dayParts.resolveCollections(channel, s.start,
            { program: s.program, timeElapsed: 0, programIndex: s.index });
        return (collections === null) || (collections[0].id !== want);
    } );
    suite.check('Every break takes the mix of the show after it, including the one before midnight',
        breaks.length > 5 && wrongBreaks.length === 0,
        `${breaks.length} breaks` + wrongBreaks.slice(0, 3).map( (s) => ` | ${label(s.start)}` ).join(''));

    // ---- shift with daylight saving ------------------------------------
    suite.log('-- shift with daylight saving (none of the real starts use it) --');
    const coverage = (ch, name, from = NIGHT_FROM, to = NIGHT_TO) => {
        const minutes = [];
        for (let t = from; t < to; t += MIN) {
            if (nameAt(ch, t) === name) {
                minutes.push(t);
            }
        }
        return minutes;
    };
    const exactly = (minutes, spans) => {
        const want = [];
        spans.forEach( ([a, b]) => {
            for (let t = Z(a); t < Z(b); t += MIN) {
                want.push(t);
            }
        } );
        return minutes.length === want.length && minutes.every( (t, i) => t === want[i] );
    };
    const spanText = (minutes) => {
        const runs = [];
        minutes.forEach( (t) => {
            const last = runs[runs.length - 1];
            if (last && last[1] === t) {
                last[1] = t + MIN;
            } else {
                runs.push([t, t + MIN]);
            }
        } );
        return runs.map( ([a, b]) => `${label(a)}-${label(b)}` ).join(', ');
    };

    // Toonami AcTN's 12am start marked shifted: 1am in summer, so on this
    // night it takes over at 1:00am CDT - 06:00Z, which is 12am standard -
    // exactly once, and does not let go when the clock falls back.
    const shiftedStart = clone(channel);
    shiftedStart.dayParts.find( (d) => d.name === 'Toonami AcTN' ).starts[0].shiftWithDst = true;
    const actn = coverage(shiftedStart, 'Toonami AcTN');
    suite.check('A shifted 12am start takes over once, at 1:00am CDT, and holds through the change',
        exactly(actn, [['2026-11-01T06:00:00Z', '2026-11-01T10:00:00Z']]), spanText(actn));

    // A shifted airing is fixed in standard time: 12-2am standard is 06:00Z
    // to 08:00Z, which reads 1:00am CDT to 2:00am CST - two real hours.
    const shiftedAiring = clone(channel);
    Object.assign(shiftedAiring.blocks.find( (b) => b.name === 'Toonami Midnight Run' ).airings[0],
        { days: [0], start: 0, end: 2 * HOUR, shiftWithDst: true });
    const run = coverage(shiftedAiring, 'Toonami Midnight Run');
    suite.check('A shifted 12-2am airing covers 1:00am CDT to 2:00am CST, two real hours',
        exactly(run, [['2026-11-01T06:00:00Z', '2026-11-01T08:00:00Z']]), spanText(run));

    // An ordinary airing follows the wall clock honestly: 1:30am comes round
    // twice and so does its start, with the half hour between them outside it.
    const plainAiring = clone(channel);
    Object.assign(plainAiring.blocks.find( (b) => b.name === 'Toonami Midnight Run' ).airings[0],
        { days: [0], start: 90 * MIN, end: 3 * HOUR });
    const plain = coverage(plainAiring, 'Toonami Midnight Run');
    suite.check('An unshifted 1:30-3am airing covers both 1:30ams, not the half hour between them',
        exactly(plain, [['2026-11-01T06:30:00Z', '2026-11-01T07:00:00Z'],
            ['2026-11-01T07:30:00Z', '2026-11-01T09:00:00Z']]), spanText(plain));

    // A shifted start and an ordinary one half an hour apart. The day-part in
    // effect is the one whose start happened last, in real time. Placing the
    // shifted start by the offset at the moment being resolved - as the
    // resolver once did - moves a start that already happened under the other
    // offset, and after a change swaps the two.
    const reordered = clone(shiftedStart);
    reordered.dayParts.push({ name: 'Late Adult Swim', fillerCollections: mix([['Adult Swim', 300]]),
        starts: [{ days: [0], time: 30 * MIN }] });

    // Autumn: 12:30am CDT the ordinary start, 1:00am CDT the shifted one.
    // Nothing starts at 1:00am CST, so Toonami AcTN holds.
    const autumn = coverage(reordered, 'Toonami AcTN');
    suite.check('Autumn: a shifted 12am start keeps its place after an ordinary 12:30am start',
        exactly(autumn, [['2026-11-01T06:00:00Z', '2026-11-01T10:00:00Z']]), spanText(autumn));

    // Spring, Mar 14 2027: the shifted start is 12:00am CST, the ordinary one
    // 12:30am CST, and the clock jumps to 3:00am CDT at 08:00Z. Nothing
    // starts at the jump, so Late Adult Swim holds.
    const lateSpring = coverage(reordered, 'Late Adult Swim',
        Z('2027-03-14T05:00:00Z'), Z('2027-03-14T09:00:00Z'));
    suite.check('Spring: an ordinary 12:30am start keeps its place after a shifted 12am start',
        exactly(lateSpring, [['2027-03-14T06:30:00Z', '2027-03-14T09:00:00Z']]), spanText(lateSpring));

    // A shifted start inside the first pass happens once. 12:30am standard is
    // 1:30am CDT, 06:30Z; the second pass must not undo it.
    const shiftedInRepeat = clone(channel);
    Object.assign(shiftedInRepeat.dayParts.find( (d) => d.name === 'Toonami AcTN' ).starts[0],
        { time: 30 * MIN, shiftWithDst: true });
    const once = coverage(shiftedInRepeat, 'Toonami AcTN');
    suite.check('A shifted start at 1:30am CDT happens once and holds through the second pass',
        exactly(once, [['2026-11-01T06:30:00Z', '2026-11-01T10:00:00Z']]), spanText(once));

    // An ordinary start inside the repeated hour replays with the wall clock,
    // the same as the slots and block airings around it.
    const ordinaryInRepeat = clone(channel);
    ordinaryInRepeat.dayParts.find( (d) => d.name === 'Toonami AcTN' ).starts[0].time = 90 * MIN;
    const twice = coverage(ordinaryInRepeat, 'Toonami AcTN');
    suite.check('An ordinary 1:30am start happens at both 1:30ams, CN City (Night) between them',
        exactly(twice, [['2026-11-01T06:30:00Z', '2026-11-01T07:00:00Z'],
            ['2026-11-01T07:30:00Z', '2026-11-01T10:00:00Z']]), spanText(twice));

    // ---- weeklySegments -------------------------------------------------
    suite.log('-- weeklySegments --');
    const week = dayParts.weeklySegments(channel, Z('2026-11-04T18:00:00Z'));
    const holes = [];
    week.forEach( (segments, day) => {
        let at = 0;
        segments.forEach( (s) => {
            if (s.startMs !== at) {
                holes.push(`day ${day} at ${at / HOUR}h`);
            }
            at = s.endMs;
        } );
        if (at !== DAY) {
            holes.push(`day ${day} ends at ${at / HOUR}h`);
        }
    } );
    suite.check('The week of Nov 1 draws every day from 0 to 24h with no holes',
        week.length === 7 && holes.length === 0, holes.slice(0, 3).join(' | '));

    const flat = (w) => JSON.stringify(w.map( (segments) => segments.map(
        (s) => [s.context ? s.context.name : 'Flex', s.startMs, s.endMs] ) ));
    suite.check('As configured, the week of Nov 1 draws the same as the week before it',
        flat(week) === flat(dayParts.weeklySegments(channel, Z('2026-10-28T17:00:00Z'))));

    // ---- stored progress ------------------------------------------------
    /*
     * A lineup saved before airings carried labels is read by matching each
     * airing to the slot it starts in, so that matching has to agree with the
     * generator's own, minute by minute, through both passes of 1-2am. Both
     * generator functions are lifted rather than transcribed.
     */
    suite.log('-- stored progress: reading old lineups by slot --');
    const generatorSlotAt = new Function('schedule', 'MINUTE', 's', 'instant',
        liftSource('src/services/time-slots-service.js', 'localMsIntoPeriod') + '\n'
        + liftSource('src/services/time-slots-service.js', 'findSlot') + '\n'
        + 'let found = findSlot(localMsIntoPeriod(instant));\n'
        + 'return found === null ? null : found.slot;');
    const fixture = slotFixture().schedule;
    const sorted = fixture.slots.slice().sort((a, b) => a.time - b.time);
    const slotDisagreements = [];
    for (let t = Z('2026-11-01T05:00:00Z'); t <= Z('2026-11-01T09:00:00Z'); t += MIN) {
        const ours = slotProgress.slotAt(fixture, t);
        const theirs = generatorSlotAt(fixture, MIN, sorted, t);
        if ((ours && ours.time) !== (theirs && theirs.time)) {
            slotDisagreements.push(`${label(t)}: ${ours && ours.showId} vs ${theirs && theirs.showId}`);
        }
    }
    suite.check('slotAt agrees with the generator through the fall-back hour',
        slotDisagreements.length === 0, slotDisagreements.slice(0, 3).join(' | '));

    // A 1:00am Repeat of Saturday's 9pm: 1:00 comes round twice, and both times
    // it repeats the same Saturday evening.
    const repeatShow = [];
    for (let e = 1; e <= 8; e++) {
        repeatShow.push({ type: 'episode', showTitle: 'Nine', title: `Nine e${e}`, season: 1, episode: e,
            key: `/k/nine/${e}`, serverKey: 'srv', duration: 22 * MIN });
    }
    const satNine = 2 * DAY + 21 * HOUR, sunOne = 3 * DAY + 1 * HOUR;
    const repeatSchedule = { period: WEEK, lateness: 0, maxDays: 14, flexPreference: 'distribute', pad: 5 * MIN, slots: [
        { time: satNine, showId: 'tv.Nine', order: 'next' },
        { time: satNine + 30 * MIN, showId: 'flex.', order: 'next' },
        { time: sunOne, showId: 'tv.Nine', order: 'repeat', repeatOf: satNine },
        { time: sunOne + 30 * MIN, showId: 'flex.', order: 'next' },
    ] };
    const repeated = await generate(repeatShow, repeatSchedule, Z('2026-10-28T17:00:00Z'));
    let tr = Date.parse(repeated.startTime);
    const repeatAirings = repeated.programs.map( (pr) => { const a = { start: tr, program: pr }; tr += pr.duration; return a; } )
        .filter( (a) => ! a.program.isOffline );
    const titleAt = (iso) => (repeatAirings.find( (a) => a.start === Z(iso) ) || { program: { title: 'nothing' } }).program.title;
    const saturday = titleAt('2026-11-01T02:00:00Z');
    suite.check('On the fall-back night a 1:00 repeat airs twice, the same episode',
        saturday !== 'nothing' && titleAt('2026-11-01T06:00:00Z') === saturday && titleAt('2026-11-01T07:00:00Z') === saturday,
        `Sat 9pm ${saturday}; 1:00 CDT ${titleAt('2026-11-01T06:00:00Z')}; 1:00 CST ${titleAt('2026-11-01T07:00:00Z')}`);

    return suite;
}

/*
 * Anywhere but America/Chicago, re-run this file under it in a child and
 * fold the child's count into a Suite for test/run.js.
 */
function inChild() {
    const suite = new Suite('dst-fall-back');
    const result = spawnSync(process.execPath, [__filename, '--child'],
        { env: Object.assign({}, process.env, { TZ: ZONE }), encoding: 'utf8' });
    const tally = /^RESULT (\d+) (\d+)$/m.exec(result.stdout || '');
    process.stdout.write((result.stdout || '').replace(/^RESULT .*\r?\n?/m, ''));
    if (tally === null) {
        suite.check(`Re-ran under TZ=${ZONE}`, false, (result.stderr || '').trim().split('\n').pop());
        return suite;
    }
    suite.count = Number(tally[1]);
    suite.failures = Number(tally[2]);
    return suite;
}

module.exports = async function () {
    if (Intl.DateTimeFormat().resolvedOptions().timeZone !== ZONE) {
        return inChild();
    }
    return await checks();
};

// Allow `node test/dst-fall-back.js` on its own during development.
if (require.main === module) {
    module.exports().then((suite) => {
        if (process.argv.includes('--child')) {
            console.log(`RESULT ${suite.count} ${suite.failures}`);
        }
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
