/*
 * What the end of the list holds never moves what aired (NOTES.md, Resolved,
 * "Create Lineup moved a special day's swaps that had aired"). The editor rotates
 * its list to start at the program on air, so what aired sits at the end of the
 * array; the library's add, Add Flex and Add Redirect go after it. Read through the
 * loop, an add would push what aired back by its own length, and Create Lineup's
 * readings of the past - a special day's count of its airings, the program carried,
 * Repeat history - would read the add in its place. Each add on a Time Slots channel
 * is marked with when it was added (`addedAt`), and the lineup the Time Slots
 * dialog reads (`lineupOnAir`, through pins.asAired) leaves a marked row out where
 * the loop would have it airing before it was added.
 *
 * The channel page's pieces are lifted from channel-config.js and run with
 * stand-ins, as test/kept-editor.js does; the rest is the real code, with the
 * clock frozen.
 */
const fs = require('fs');
const path = require('path');
const { MIN, HOUR, DAY, Suite } = require('./support');
const timeSlotsService = require('../src/services/time-slots-service');
const randomSlotsService = require('../src/services/random-slots-service');
const TVGuideService = require('../src/services/tv-guide-service');
const slotProgress = require('../src/slot-progress');
const pinTools = require('../src/pins');
const keptRows = require('../src/kept-rows');
const dayEdits = require('../src/day-edits');
const getShowData = require('../web/services/get-show-data')();

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'directives', 'channel-config.js'), 'utf8');

// A `let name = (...) => { ... };` (or `scope.name = ...`) from channel-config.js, by brace-matching.
function liftArrow(src, name, owner = 'let ') {
    const head = `${owner}${name} = `;
    const at = src.indexOf(head);
    if (at === -1) {
        throw new Error(`channel-config.js no longer declares ${name}`);
    }
    let i = src.indexOf('{', at);
    for (let depth = 0; i < src.length; i++) {
        if (src[i] === '{') {
            depth++;
        } else if ( (src[i] === '}') && (--depth === 0) ) {
            break;
        }
    }
    return src.slice(at + head.length, i + 1);
}

const RealDate = Date;
function frozen(at, f) {
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(at); else super(...a); }
        static now() { return at; }
    }
    global.Date = FrozenDate;
    try {
        return f();
    } finally {
        global.Date = RealDate;
    }
}
async function frozenAsync(at, f) {
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(at); else super(...a); }
        static now() { return at; }
    }
    global.Date = FrozenDate;
    try {
        return await f();
    } finally {
        global.Date = RealDate;
    }
}

// The channel page, on a stand-in: what the Time Slots dialog reads, and the three
// ways something goes at the end of the list.
function page(channel, timeSlots) {
    const scope = {
        channel: channel,
        hasTimeSlots: () => timeSlots, hasNoTimeSlots: () => ! timeSlots,
        currentStartIndex: 0, selectedProgram: -1, $apply: (f) => f(),
    };
    const stand = {
        document: { getElementById: () => ({ scrollTo: () => {} }) },
        insertFromLibrary: () => { throw new Error('insertFromLibrary called'); },
        scrollToLast: () => {}, updateChannelDuration: () => {}, setTimeout: (f) => f(),
    };
    const lift = (name, owner) => new Function('scope', 'pinTools', ...Object.keys(stand), `return ${liftArrow(SRC, name, owner)};`)(
        scope, pinTools, ...Object.values(stand));
    return {
        scope,
        lineupOnAir: lift('lineupOnAir'),
        importPrograms: lift('importPrograms', 'scope.'),
        finishedAddingOffline: lift('finishedAddingOffline', 'scope.'),
        finishRedirect: lift('finishRedirect', 'scope.'),
    };
}

// adjustStartTimeToCurrentProgram (channel-config.js), not on demand: the list starts at the program on air.
function rotate(programs, startTime, at) {
    const total = programs.reduce( (a, p) => a + p.duration, 0 );
    const m = (at - startTime) % total;
    let x = 0, running = 0, offset = 0;
    for (let i = 0; i < programs.length; i++) {
        if (x + programs[i].duration > m) { running = i; offset = m - x; break; }
        x += programs[i].duration;
    }
    return { programs: programs.slice(running).concat(programs.slice(0, running)), startTime: new Date(at - offset) };
}

function episode(show, season, n, duration) {
    return { type: 'episode', showTitle: show, title: `${show} S${season}E${n}`, season, episode: n,
        duration: duration || 22 * MIN, serverKey: 'srv', key: `/e/${show}/${season}/${n}` };
}
const seasons = (show, count, duration) => Array.from({ length: count }, (x, i) => episode(show, 1, i + 1, duration));
const pool = () => seasons('A', 80).concat(seasons('B', 80), seasons('C', 80), seasons('D', 80), seasons('X', 60));
const SWAPS = seasons('K', 16);

const fri = (h, m, s) => new Date(2026, 9, 9, h, m || 0, s || 0).getTime();
const NOW0 = new Date(2026, 9, 8, 12, 0).getTime();               // Thu Oct 8, noon: the lineup is made
// DarkManX16's House of Mouse day in small: 1-9pm, one row until 9pm, a swap on each of its 16 airings.
const MARATHON = {
    id: 'sd_m', name: 'Marathon', from: { date: '2026-10-09', time: 13 * HOUR }, to: { date: '2026-10-09', time: 21 * HOUR },
    blockId: null, positions: 'apart', layout: 'back', rounding: 'half', fillBreaksWith: null, holiday: null,
    slots: [ { showId: 'tv.X', order: 'next', until: 21 * HOUR,
        changes: SWAPS.map( (p, i) => ({ id: 'ch' + (i + 1), n: i + 1, kind: 'swap', item: { program: p } }) ) } ],
};
function schedule() {
    const slots = [];
    for (let k = 0; k < 48; k++) {
        slots.push({ time: k * 30 * MIN, showId: 'tv.' + 'ABCD'[k % 4], order: 'next' });
    }
    // A Repeat: 11pm plays again what 1am played.
    slots[46] = { time: 23 * HOUR, showId: 'tv.A', order: 'repeat', repeatOf: 1 * HOUR };
    return { period: DAY, lateness: 24 * HOUR, maxDays: 4, flexPreference: 'distribute', pad: 5 * MIN, slots, specialDays: [ MARATHON ] };
}

async function generate(schedule0, at, history, pins, carry, programs) {
    return frozenAsync(at, () => timeSlotsService(JSON.parse(JSON.stringify(programs || pool())), JSON.parse(JSON.stringify(schedule0)),
        history ? JSON.parse(JSON.stringify(history)) : undefined, pins ? JSON.parse(JSON.stringify(pins)) : undefined,
        carry ? JSON.parse(JSON.stringify(carry)) : undefined));
}

// Create Lineup at `at` as time-slots-schedule-editor.js runs it (planLineup and makeLineup), from
// the lineup the page hands the dialog then (`lineupOnAir`).
async function createLineup(pg, opened, at) {
    const lineup = frozen(at, () => pg.lineupOnAir());
    const programs = lineup.programs, startTime = new Date(lineup.startTime).getTime();
    const s = JSON.parse(JSON.stringify(opened));
    let carry = pinTools.carryAt({ programs, startTime, now: at, schedule: s });
    s.progress = slotProgress.planProgress({ programs, startTime, now: at,
        placesFrom: (carry !== null) ? Math.max(at, carry.start + carry.program.duration) : undefined,
        openedSchedule: opened, schedule: s, pool: pool(), getShowData });
    const h = slotProgress.repeatHistory({ programs, startTime, now: at, spanMs: DAY + HOUR, opened, schedule: s, getShowData });
    s.progress.history = h.keep;
    let keep = keptRows.keptAhead({ programs, startTime, now: at });
    if ( (carry !== null) && (carry.program.pin || keptRows.keptKind(carry.program)) ) {
        keep = keep.filter( (x) => x.program !== carry.program );
    }
    const res = await generate(s, at, h.history, keep, carry || undefined);
    let t = Date.parse(res.startTime);
    const total = res.programs.reduce( (a, p) => a + p.duration, 0 );
    while (t > at) {
        t -= total;
    }
    const airings = [];
    res.programs.forEach( (p) => { airings.push({ start: t, program: p }); t += p.duration; } );
    return { res, airings, carry, history: h.history, plan: s.progress.specialDays };
}

const clock = (t) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
// What airs from `from` on: start and title, for a whole lineup compared airing for airing.
const ahead = (made, from) => made.airings.filter( (a) => (a.start >= from) && ! a.program.isOffline ).map( (a) => `${a.start} ${a.program.title}` );
const dayOf = (made) => made.airings.filter( (a) => ! a.program.isOffline && (a.program.specialDay === 'sd_m') );
const hasMark = (p) => (p != null) && Object.prototype.hasOwnProperty.call(p, 'addedAt');

module.exports = async function () {
    const suite = new Suite('added-at-end');
    const opened = schedule();
    const saved = await generate(opened, NOW0);
    const savedStart = Date.parse(saved.startTime);
    const savedDay = (() => {
        let t = savedStart;
        return saved.programs.map( (p) => { const a = { start: t, program: p }; t += p.duration; return a; } )
            .filter( (a) => ! a.program.isOffline && (a.program.specialDay === 'sd_m') );
    })();
    suite.check('the fixture: the day airs its 16 swaps, 1:00pm to 8:30pm',
        (savedDay.length === 16) && savedDay.every( (a, i) => (a.start === fri(13, 30 * i)) && (a.program.title === `K S1E${i + 1}`) ),
        savedDay.slice(0, 3).map( (a) => `${clock(a.start)} ${a.program.title}` ).join(' / '));
    const added = seasons('Z', 20);                                      // 20 episodes: 7h20m

    // The editor opened at `open`; with `add`, the library's add at the end right after.
    const editorAt = (open, add) => {
        const r = rotate(saved.programs, savedStart, open);
        const pg = page({ programs: r.programs.slice(), startTime: r.startTime, scheduleBackup: opened }, true);
        if (add) {
            frozen(open + 10 * 1000, () => pg.importPrograms(JSON.parse(JSON.stringify(added)), 'end'));
        }
        return pg;
    };

    suite.log('-- the library\'s add, then Create Lineup, at moments across the day --');
    const moments = [];
    for (let k = 0; k < 9; k++) {
        const s = fri(13, 30 * k);
        moments.push({ label: `${clock(s + MIN)}, during airing ${k + 1}`, open: s + 30 * 1000, at: s + MIN });
        moments.push({ label: `${clock(s + 23 * MIN)}, in the break after it`, open: s + 22 * MIN + 30 * 1000, at: s + 23 * MIN });
        moments.push({ label: `${clock(s + 30 * MIN - 1000)}, a second before the next`, open: s + 22 * MIN + 30 * 1000, at: s + 30 * MIN - 1000 });
    }
    let bad = [], aired = [];
    for (const m of moments) {
        const plain = await createLineup(editorAt(m.open, false), opened, m.at);
        const withAdd = await createLineup(editorAt(m.open, true), opened, m.at);
        const a = ahead(plain, m.at - DAY), b = ahead(withAdd, m.at - DAY);
        if ( (a.length !== b.length) || a.some( (x, i) => x !== b[i] ) ) {
            const i = a.findIndex( (x, j) => x !== b[j] );
            bad.push(`${m.label}: ${a[i]} became ${b[i]}`);
        }
        // Every swap still to air where the list had it.
        const from = plain.carry ? plain.carry.start + plain.carry.program.duration : m.at;
        const day = dayOf(withAdd);
        savedDay.filter( (s) => s.start >= from ).forEach( (s) => {
            const g = day.find( (x) => x.start === s.start );
            if (! g || (g.program.title !== s.program.title)) {
                aired.push(`${m.label}: ${clock(s.start)} ${s.program.title} -> ${g ? g.program.title : 'nothing'}`);
            }
        } );
    }
    suite.check(`at all ${moments.length} moments (during each airing, in each break, a second before the next) Create Lineup makes the same lineup with the add as without`,
        bad.length === 0, bad.slice(0, 3).join(' | '));
    suite.check('...and every swap still to air stays where the list had it', aired.length === 0, aired.slice(0, 3).join(' | '));

    // The failing moment, as on Nov 19: open in the break before airing 9, Create Lineup a minute later.
    {
        const open = fri(16, 53), at = fri(16, 54);
        const plain = await createLineup(editorAt(open, false), opened, at);
        const withAdd = await createLineup(editorAt(open, true), opened, at);
        suite.check('4:54pm, opened in the break: the day\'s count is 8 with the add, as without',
            JSON.stringify(withAdd.plan) === JSON.stringify(plain.plan) && (withAdd.plan.sd_m.counts[0] === 8), JSON.stringify(withAdd.plan));
        suite.check('...the program carried is airing 8 (K S1E8), not the last episode added',
            withAdd.carry && (withAdd.carry.program.title === 'K S1E8') && (withAdd.carry.start === fri(16, 30)),
            withAdd.carry ? `${clock(withAdd.carry.start)} ${withAdd.carry.program.title}` : 'none');
        suite.check('...Repeat history reads what aired, the same as without the add',
            JSON.stringify(withAdd.history.map( (x) => [ x.start, x.program.title ] )) === JSON.stringify(plain.history.map( (x) => [ x.start, x.program.title ] )),
            `${withAdd.history.length} vs ${plain.history.length}`);
        const five = dayOf(withAdd).find( (x) => x.start === fri(17) );
        suite.check('...5:00pm is still K S1E9', five && five.program.title === 'K S1E9', five ? five.program.title : 'nothing');
    }

    suite.log('-- added and saved, the editor opened again later --');
    {
        const first = editorAt(fri(14, 23), true);                       // added at 2:23pm, in a break; Update Channel
        const savedAgain = { programs: first.scope.channel.programs, startTime: first.scope.channel.startTime };
        const reopen = (open) => {
            const r = rotate(savedAgain.programs, new Date(savedAgain.startTime).getTime(), open);
            return page({ programs: r.programs, startTime: r.startTime, scheduleBackup: opened }, true);
        };
        for (const [ open, at, label ] of [ [ fri(16, 53), fri(16, 54), '4:54pm, opened in a break' ], [ fri(17, 5), fri(17, 6), '5:06pm, opened during an airing' ] ]) {
            const plain = await createLineup(editorAt(open, false), opened, at);
            const again = await createLineup(reopen(open), opened, at);
            const a = ahead(plain, at - DAY), b = ahead(again, at - DAY);
            suite.check(`${label}: the same lineup as with nothing added, the count, the carry and Repeat history too`,
                a.join() === b.join() && JSON.stringify(again.plan) === JSON.stringify(plain.plan)
                && again.carry.program.title === plain.carry.program.title
                && again.history.map( (x) => x.program.title ).join() === plain.history.map( (x) => x.program.title ).join(),
                `${JSON.stringify(again.plan)} / ${again.carry && again.carry.program.title}`);
        }
    }

    suite.log('-- what the mark leaves alone --');
    {
        // A marked row the loop has airing after it was added is an airing like any other.
        const pg = editorAt(fri(16, 53), true);
        pg.scope.channel.programs.slice(-added.length).forEach( (p) => { p.addedAt = NOW0 - 30 * DAY; } );
        const read = frozen(fri(16, 54), () => pg.lineupOnAir());
        const c = pinTools.carryAt({ programs: read.programs, startTime: new Date(read.startTime).getTime(), now: fri(16, 54), schedule: opened });
        suite.check('a marked row the loop has airing after it was added stays in what Create Lineup reads: carried, as any airing whose break is on air',
            (read.programs.length === pg.scope.channel.programs.length) && c && (c.program.title === 'Z S1E20'), c ? c.program.title : 'none');
    }
    {
        // ...and so is one on air now: the loop brought it round to the list's start.
        const r = rotate(saved.programs, savedStart, fri(16, 31));
        r.programs[0] = Object.assign( {}, r.programs[0], { addedAt: fri(16, 29) } );
        const pg = page({ programs: r.programs, startTime: r.startTime, scheduleBackup: opened }, true);
        const read = frozen(fri(16, 40), () => pg.lineupOnAir());
        const c = pinTools.carryAt({ programs: read.programs, startTime: new Date(read.startTime).getTime(), now: fri(16, 40), schedule: opened });
        suite.check('a marked row on air now stays: it is the program carried', (read.programs.length === r.programs.length) && c && (c.program === r.programs[0]),
            c ? `${clock(c.start)} ${c.program.title}` : 'none');
    }
    {
        const pg = editorAt(fri(16, 53), false);
        suite.check('with nothing added, Create Lineup reads the list itself', frozen(fri(16, 54), () => pg.lineupOnAir()).programs === pg.scope.channel.programs);
    }
    {
        // A marked episode swapped in, or a marked row dragged into the lineup, is no longer an add.
        const pg = editorAt(fri(16, 53), true);
        const lineup = { programs: pg.scope.channel.programs, startTime: new Date(pg.scope.channel.startTime).getTime() };
        const rows = [];
        let t = lineup.startTime;
        lineup.programs.forEach( (p, i) => { rows.push({ i, start: t, p }); t += p.duration; } );
        const target = rows.find( (r) => (r.start >= fri(23)) && ! r.p.isOffline && (r.p.slotPosition || '').startsWith('next') );
        // The first of the 20 added, marked as the add marks it.
        const first = lineup.programs.length - added.length;
        lineup.programs[first] = Object.assign( {}, lineup.programs[first], { addedAt: fri(16, 53, 10) } );
        const item = lineup.programs[first];
        const swapped = frozen(fri(16, 54), () => keptRows.swap({ lineup, index: target.i, item, now: fri(16, 54), schedule: opened }));
        const row = swapped.programs ? swapped.programs.find( (p) => keptRows.keptKind(p) === 'swap' ) : null;
        suite.check('Swap with an episode added at the end: the swapped-in row carries no add mark', row && ! hasMark(row), row ? JSON.stringify(row.addedAt) : JSON.stringify(swapped));
        const moved = frozen(fri(16, 54), () => keptRows.move({ lineup, from: first, to: target.i, now: fri(16, 54), sure: true, schedule: opened }));
        const dragged = moved.programs ? moved.programs.find( (p) => keptRows.keptKind(p) === 'moved' ) : null;
        suite.check('a row added at the end, dragged into the lineup: it carries no add mark', dragged && ! hasMark(dragged), dragged ? JSON.stringify(dragged.addedAt) : JSON.stringify(moved));
        suite.check('an item a day\'s Swap keeps carries no add mark', ! hasMark(dayEdits.plainItem(item)));
    }

    suite.log('-- the three adds --');
    {
        const at = fri(16, 53, 10);
        const pg = editorAt(fri(16, 53), false);
        const n = pg.scope.channel.programs.length;
        frozen(at, () => pg.importPrograms(JSON.parse(JSON.stringify(added.slice(0, 3))), 'end'));
        frozen(at, () => pg.finishedAddingOffline({ durationSeconds: 600 }));
        frozen(at, () => pg.finishRedirect({ isOffline: true, type: 'redirect', channel: 2, duration: HOUR }));
        const tail = pg.scope.channel.programs.slice(n);
        suite.check('on a Time Slots channel the library\'s add, Add Flex and Add Redirect at the end each mark the row with when it was added',
            (tail.length === 5) && tail.every( (p) => p.addedAt === at ), JSON.stringify(tail.map( (p) => p.addedAt )));
    }
    for (const point of [ 'end', 'start', 'current' ]) {
        const list = seasons('A', 3);
        const pg = page({ programs: list.slice(), startTime: new Date(NOW0) }, false);
        frozen(NOW0, () => pg.importPrograms(JSON.parse(JSON.stringify(added.slice(0, 2))), point));
        const want = (point === 'start') ? added.slice(0, 2).concat(list) : (point === 'current') ? added.slice(0, 2).concat(list) : list.concat(added.slice(0, 2));
        suite.check(`not a Time Slots channel: the library's add (${point}) leaves exactly what it did`,
            JSON.stringify(pg.scope.channel.programs) === JSON.stringify(want), JSON.stringify(pg.scope.channel.programs.map( (p) => p.title )));
    }
    {
        const pg = page({ programs: seasons('A', 3), startTime: new Date(NOW0) }, false);
        frozen(NOW0, () => pg.finishedAddingOffline({ durationSeconds: 600 }));
        frozen(NOW0, () => pg.finishRedirect({ isOffline: true, type: 'redirect', channel: 2, duration: HOUR }));
        suite.check('not a Time Slots channel: Add Flex and Add Redirect leave exactly what they did',
            JSON.stringify(pg.scope.channel.programs.slice(3)) === JSON.stringify([ { duration: 600000, isOffline: true }, { isOffline: true, type: 'redirect', channel: 2, duration: HOUR } ]),
            JSON.stringify(pg.scope.channel.programs.slice(3)));
    }
    {
        const pg = page({ programs: [], startTime: new Date(NOW0) }, true);
        frozen(NOW0, () => pg.importPrograms(JSON.parse(JSON.stringify(added.slice(0, 2))), 'end'));
        suite.check('a Time Slots channel with an empty list: the first add is not marked (nothing has aired to move)',
            pg.scope.channel.programs.length === 2 && ! pg.scope.channel.programs.some(hasMark));
    }

    suite.log('-- the mark never leaves the list --');
    {
        // What the Time Slots dialog's pickers offer (a special day's item among them) and Create Lineup lays.
        const commonProgramTools = require('../web/services/common-program-tools')(getShowData);
        const list = seasons('A', 3);
        list[2] = Object.assign( {}, list[2], { addedAt: NOW0 } );
        const offered = commonProgramTools.slotPool(list);
        suite.check('the Time Slots pool carries no add mark, and the rest are the list\'s own rows',
            (offered.length === 3) && ! offered.some(hasMark) && (offered[0] === list[0]) && (list[2].addedAt === NOW0),
            JSON.stringify(offered.map( (p) => p.addedAt )));
    }
    {
        // A pool of marked episodes, a marked kept row and a marked program carried: Create Lineup saves none of the marks.
        const marked = (p) => Object.assign( {}, p, { addedAt: NOW0 - HOUR } );
        const markedPool = pool().map(marked);
        const kept = Object.assign(marked(episode('Q', 1, 1)), { kept: { edits: [ { id: 'e1', kind: 'swap', made: new Date(NOW0).toISOString() } ] } });
        const carry = { start: NOW0 - 10 * MIN, program: marked(episode('Q', 1, 2)) };
        const res = await generate(opened, NOW0, undefined, [ { at: NOW0 + 2 * HOUR, program: kept, kept: true } ], carry, markedPool);
        const left = res.programs.filter(hasMark);
        suite.check('Create Lineup (Time Slots) lays marked pool episodes, a marked kept row and a marked program on air with no mark',
            (left.length === 0) && res.programs.some( (p) => p.title === 'Q S1E1' ) && res.programs.some( (p) => p.title === 'Q S1E2' ),
            `${left.length} marked: ${left.slice(0, 3).map( (p) => p.title ).join(', ')}`);
        const random = await frozenAsync(NOW0, () => randomSlotsService(markedPool, { period: DAY, maxDays: 2, pad: 5 * MIN, flexPreference: 'distribute', padStyle: 'slot',
            slots: [ { duration: 30 * MIN, showId: 'tv.A', order: 'next', cooldown: 0, weight: 1 } ] }));
        suite.check('Create Lineup (Random Slots) lays marked pool episodes with no mark',
            Array.isArray(random.programs) && (random.programs.length > 0) && ! random.programs.some(hasMark), `${(random.programs || []).filter(hasMark).length} marked`);
    }
    {
        // The guide and XMLTV build each entry from named fields: a marked row airing in the window shows none of it.
        const ch = { number: 70, name: 'Marked', icon: '/icon.png', guideFlexPlaceholder: 'Filler', guideMinimumDurationSeconds: 60,
            startTime: new Date(NOW0), programs: [ Object.assign(episode('A', 1, 1), { addedAt: NOW0 - HOUR }), { isOffline: true, duration: 8 * MIN } ] };
        ch.duration = ch.programs.reduce( (a, p) => a + p.duration, 0 );
        const g = new TVGuideService(null, null, null, null, null);
        g._throttle = async () => {};
        g.channelsByNumber = { [ch.number]: ch };
        g.accumulateTable = { [ch.number]: await g.makeAccumulated(ch) };
        const res = await g.getChannelPrograms(NOW0, NOW0 + 3 * HOUR, ch);
        suite.check('the guide shows a marked row with no mark in any entry',
            res.programs.length > 0 && ! JSON.stringify(res.programs).includes('addedAt'), JSON.stringify(res.programs[0]));
    }

    return suite;
};
