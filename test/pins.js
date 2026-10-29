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

        // As Ron's saved lineups are: content, then days of Flex where the loop
        // comes round, and the editor rotates its start to now. Past that Flex the
        // loop's first day sits off the slots.
        const seamed = plain.programs.concat([{ isOffline: true, duration: 5 * DAY }]);
        seamed.unshift(Object.assign({}, bumper, { title: 'Off-slot opener' }));
        const seamedStart = plain.startTime - bumper.duration;
        const nowLater = NOON8 + 20 * DAY;
        const rotatedAt = pins.airingAt({ programs: seamed, startTime: seamedStart, at: nowLater });
        const rotated = { programs: seamed.slice(rotatedAt.index).concat(seamed.slice(0, rotatedAt.index)), startTime: rotatedAt.start };
        const fresh = await generate(fixturePool(), fixtureSchedule(), nowLater);
        const seamCheck = pins.relayEffects({ before: rotated, after: { programs: fresh.programs, startTime: Date.parse(fresh.startTime) },
            from: nowLater, to: nowLater + 400 * DAY, schedule, getShowData });
        suite.check('relayEffects stops before a rotated lineup\'s real end, its longest Flex',
            ! seamCheck.dropped.some((d) => d.program.title === 'Off-slot opener'),
            JSON.stringify(seamCheck.dropped.map((d) => [d.program.title, new Date(d.start).toString()])));

        // Undo: the swap's lineup re-laid without it.
        const undone = pins.relayEffects({ before: swapped, after: plain, from: NOON8, to: NOON8 + 7 * DAY, schedule, getShowData });
        suite.check('relayEffects names an episode moving back to its own slot when a swap is undone',
            undone.movedAlong.length === 1 && undone.movedAlong[0].program.title === 'Best Man / Cool Party'
                && undone.movedAlong[0].wasAt === thu(19, 30) + DAY && undone.movedAlong[0].nowAt === thu(19, 30) && undone.movedAlong[0].back === true,
            JSON.stringify(undone.movedAlong.map((m) => [m.program.title, new Date(m.nowAt).toString(), m.back])));
        const undoText = pins.sayUndo({ label: "Hey Arnold! S00E07 Arnold's Christmas", at: thu(19, 30), effects: undone, anyway: '',
            dropped: [ { start: thu(19, 52, 38), program: bumper } ] });
        suite.check('sayUndo says what comes back and what is dropped',
            undoText === "Undo Hey Arnold! S00E07 Arnold's Christmas, pinned to Thu Oct 8, 7:30pm? The slot's own programming comes back: "
                + "Best Man / Cool Party airs Thu Oct 8, 7:30pm instead, and Hey Arnold!'s later airings move back one. "
                + 'This also drops what was placed in the list by hand: Thu Oct 8, 7:52pm NEXT - SGC2C (0:10).',
            undoText);

        // Undoing a run-late pin: the shows that ran late are back on time.
        const unlate = pins.relayEffects({ before: late, after: plain, from: NOON8, to: NOON8 + 7 * DAY, schedule, getShowData });
        suite.check('relayEffects names shows back on time when a run-late pin is undone',
            unlate.early.map((e) => e.program.showTitle + '@' + clock(e.nowAt)).join() === 'Hey Arnold!@7:30:00 PM,Are You Afraid of the Dark?@8:00:00 PM'
                && unlate.late.length === 0 && unlate.movedAlong.map((m) => m.name + (m.back ? ' back' : '')).join() === 'Rugrats back',
            JSON.stringify({ early: unlate.early.map((e) => e.program.title + '@' + clock(e.nowAt)), late: unlate.late.length,
                moved: unlate.movedAlong.map((m) => m.name + ' ' + new Date(m.nowAt).toString()) }));
        suite.check('...in plain words',
            pins.sayEffects(unlate) === "Home Movies airs Thu Oct 8, 7:00pm instead, and Rugrats' later airings move back one. "
                + 'Hey Arnold! and Are You Afraid of the Dark? are back on time, at 7:30 and 8:00.',
            pins.sayEffects(unlate));

        // A slot of two halves whose show moved one along: each half airs 15 minutes later the
        // same night, which is moving along, not running late - something else starts at its time.
        const halfA = episode('Rugrats', 1, 1, { title: 'Half A', duration: 11 * MIN });
        const halfB = episode('Rugrats', 1, 2, { title: 'Half B', duration: 11 * MIN });
        const halfZ = episode('Rugrats', 1, 3, { title: 'Half Z', duration: 11 * MIN });
        // Three weeks, as a real lineup is shaped: a show every evening, then days of Flex.
        const build = (entries) => {
            const all = entries.slice();
            for (let d = 0; d < 21; d++) {
                all.push([thu(20, 30) + d * DAY, episode('Shelby Woo', 1, d + 1)]);
            }
            all.sort((a, b) => a[0] - b[0]);
            const programs = [];
            let t = THU;
            all.forEach(([when, p]) => {
                if (when > t) { programs.push({ isOffline: true, duration: when - t }); t = when; }
                programs.push(p); t += p.duration;
            });
            programs.push({ isOffline: true, duration: THU + 26 * DAY - t });
            return { programs, startTime: THU };
        };
        const halvesBefore = build([[thu(19), halfA], [thu(19, 15), halfB], [thu(19) + DAY, halfZ]]);
        const halvesAfter = build([[thu(19), halfZ], [thu(19, 15), halfA], [thu(19) + DAY, halfB]]);
        const shifted = pins.relayEffects({ before: halvesBefore, after: halvesAfter, from: THU, to: THU + 2 * DAY, schedule, getShowData });
        suite.check('relayEffects calls a same-night shift of a show moving along, not running late',
            shifted.late.length === 0 && shifted.movedAlong.length === 1 && shifted.movedAlong[0].program.title === 'Half A',
            JSON.stringify({ late: shifted.late.map((l) => l.program.title), moved: shifted.movedAlong.map((m) => m.program.title) }));

        suite.check('placedIn finds a re-lay that holds the pin, and not one that dropped it',
            pins.placedIn(swapped, thu(19, 30)) && ! pins.placedIn(plain, thu(19, 30)) && ! pins.placedIn(swapped, thu(20)));

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
                && firstText === 'A swap or an insert re-makes the lineup from your Time Slots schedule, as Create Lineup does, so anything placed in the list by hand - bumpers, promos, episodes inserted from the library - is dropped. Nothing placed by hand from now on would be lost.'
                && keptText === "Keeping your swaps and inserts: Thu Oct 8, 7:30pm Arnold's Christmas (Hey Arnold!).",
            [fitText, overText, movedText, lateText, droppedText, firstText, keptText].join(' | '));

        // Ron, Oct 24: a swap pushed late by the show before it ran into the next slot and took
        // it over, and the dialog said it fit. Whatever pushes a pin late or costs a show its
        // slot is said first, in plain words.
        suite.log('-- a pin pushed late, a slot lost: said first --');
        {
            const ride = episode('Are You Afraid of the Dark?', 3, 1, { title: 'The Tale of the Midnight Ride', duration: 24 * MIN + 23 * SEC });
            const lateFirst = await lineup([mark(special, thu(19), 'late')]);
            const pushedBoth = await lineup([mark(special, thu(19), 'late'), mark(ride, thu(20), 'take')]);
            const w = pins.slotWarnings({ before: lateFirst, after: pushedBoth, from: NOON8, to: NOON8 + 3 * DAY, schedule, getShowData, own: thu(20) });
            suite.check('slotWarnings names a pin pushed late and the show still on at its time',
                w.pushed.length === 1 && w.pushed[0].program.title === ride.title && w.pushed[0].at === thu(20) && w.pushed[0].start === thu(20, 6, 47)
                    && w.pushed[0].behind.program.showTitle === 'Hey Arnold!' && w.lost.length === 0,
                JSON.stringify({ pushed: w.pushed.map((x) => [x.program.title, clock(x.start)]), lost: w.lost.map((x) => x.name) }));
            suite.check('...in plain words',
                pins.sayWarnings(w).join(' ') === 'The Tale of the Midnight Ride, pinned to Thu Oct 8, 8:00pm, would start late, at 8:06:47: Hey Arnold! is still on until then.',
                pins.sayWarnings(w).join(' '));

            const takeOver = await lineup([mark(special, thu(20), 'take')]);
            const lost = pins.slotWarnings({ before: plain, after: takeOver, from: NOON8, to: NOON8 + 3 * DAY, schedule, getShowData, own: thu(20) });
            suite.check('slotWarnings names the show whose slot a take-over costs, and not the slot the pin is in',
                lost.lost.length === 1 && lost.lost[0].name === 'Shelby Woo' && lost.lost[0].start === thu(20, 30) && lost.pushed.length === 0,
                JSON.stringify(lost.lost.map((x) => [x.name, new Date(x.start).toString()])));
            suite.check('...in plain words', pins.sayWarnings(lost).join(' ') === 'Shelby Woo loses its Thu Oct 8, 8:30pm slot.', pins.sayWarnings(lost).join(' '));

            const fifty = episode('Specials', 0, 2, { title: 'Fifty', duration: 50 * MIN });
            const whole = await lineup([mark(special, thu(19), 'late'), mark(fifty, thu(20), 'take')]);
            const both = pins.slotWarnings({ before: lateFirst, after: whole, from: NOON8, to: NOON8 + 3 * DAY, schedule, getShowData, own: thu(20) });
            suite.check('...and a slot a pushed pin covers whole is lost, and said',
                both.pushed.length === 1 && both.lost.map((x) => x.name).join() === 'Shelby Woo',
                JSON.stringify({ pushed: both.pushed.length, lost: both.lost.map((x) => x.name) }));

            const quiet = pins.slotWarnings({ before: plain, after: swapped, from: NOON8, to: NOON8 + 3 * DAY, schedule, getShowData, own: thu(19, 30) });
            suite.check('a swap that fits on time warns of nothing', quiet.pushed.length === 0 && quiet.lost.length === 0 && pins.sayWarnings(quiet).length === 0);

            // Ron, Oct 29: the Venture Bros. special pinned to Fri 3:30am sat at 12:00am in the list,
            // moved there by hand with its Flex. The next swap re-laid it back at 3:30am, the shows
            // between came back 30 minutes earlier, and nothing said why: it read as the pin lost.
            const handMoved = moveRows(swapped, thu(19, 30), thu(19));
            const back = pins.slotWarnings({ before: handMoved, after: swapped, from: NOON8, to: NOON8 + 3 * DAY, schedule, getShowData });
            suite.check('slotWarnings names a pin moved by hand in the list that a re-lay puts back at its time',
                Array.isArray(back.moved) && back.moved.length === 1 && back.moved[0].program.title === christmas.title && back.moved[0].wasAt === thu(19)
                    && back.moved[0].nowAt === thu(19, 30) && back.pushed.length === 0 && back.lost.length === 0,
                JSON.stringify({ moved: (back.moved || []).map((x) => [x.program.title, clock(x.wasAt), x.nowAt && clock(x.nowAt)]), pushed: back.pushed.length, lost: back.lost.length }));
            suite.check('...in plain words',
                pins.sayWarnings(back).join(' ') === "Arnold's Christmas is at Thu Oct 8, 7:00pm in the list, but it is pinned to Thu Oct 8, 7:30pm: re-making puts it back at its pinned time.",
                pins.sayWarnings(back).join(' '));
            const relaid = pins.slotWarnings({ before: swapped, after: swapped, from: NOON8, to: NOON8 + 3 * DAY, schedule, getShowData });
            suite.check('...and a pin already at its time is not named', Array.isArray(relaid.moved) && relaid.moved.length === 0, JSON.stringify(relaid.moved));

            const gone = pins.slotWarnings({ before: swapped, after: plain, from: NOON8, to: NOON8 + 3 * DAY, schedule, getShowData });
            suite.check('slotWarnings names a pin still to air that the re-lay does not hold',
                Array.isArray(gone.moved) && gone.moved.length === 1 && gone.moved[0].nowAt === null && gone.moved[0].wasAt === thu(19, 30),
                JSON.stringify((gone.moved || []).map((x) => [x.program.title, x.nowAt])));
            suite.check('...in plain words', pins.sayWarnings(gone).join(' ') === "Arnold's Christmas, pinned to Thu Oct 8, 7:30pm, would be dropped.",
                pins.sayWarnings(gone).join(' '));
            // Moved by hand past its own time (to 8:00, before Shelby Woo): the re-lay keeps only pins
            // still to air by their time.
            const later = moveRows(swapped, thu(19, 30), thu(20, 30));
            const passed = pins.slotWarnings({ before: later, after: plain, from: thu(20), to: thu(20) + 3 * DAY, schedule, getShowData });
            suite.check('...one moved by hand past its pinned time, said so',
                pins.sayWarnings(passed).join(' ') === "Arnold's Christmas is at Thu Oct 8, 8:00pm in the list, but it is pinned to Thu Oct 8, 7:30pm, which has passed: re-making drops it.",
                pins.sayWarnings(passed).join(' '));

            const worker = require('../src/relay-worker');
            const base = worker.baselineSay({ current: handMoved, base: swapped, now: NOON8, at: thu(20), schedule, getShowData });
            suite.check('the swap dialog says it first, red, with or without the swap',
                base.alerts.includes("Arnold's Christmas is at Thu Oct 8, 7:00pm in the list, but it is pinned to Thu Oct 8, 7:30pm: re-making puts it back at its pinned time."),
                JSON.stringify(base.alerts));
            const replacing = worker.baselineSay({ current: swapped, base: plain, now: NOON8, at: thu(19, 30), schedule, getShowData });
            suite.check('...but not the pin the swap itself replaces', replacing.alerts.length === 0, JSON.stringify(replacing.alerts));

            // Create Lineup and Regenerate re-lay with no dialog of re-lays: the Time Slots dialog
            // reads it from the list alone.
            const listed = pins.outOfPlace({ programs: handMoved.programs, startTime: handMoved.startTime, now: NOON8 });
            suite.check('outOfPlace reads a pin moved by hand from the list alone, for the Time Slots dialog',
                pins.sayMoved(listed).join(' ') === "Arnold's Christmas is at Thu Oct 8, 7:00pm in the list, but it is pinned to Thu Oct 8, 7:30pm: re-making puts it back at its pinned time.",
                pins.sayMoved(listed).join(' '));
            const listedLater = pins.outOfPlace({ programs: later.programs, startTime: later.startTime, now: thu(20) });
            suite.check('...one moved past its pinned time', pins.sayMoved(listedLater).join(' ').endsWith('which has passed: re-making drops it.'), pins.sayMoved(listedLater).join(' '));
            const inPlace = [ swapped, pushedBoth, lateFirst ].map((l) => pins.outOfPlace({ programs: l.programs, startTime: l.startTime, now: NOON8 }).length);
            suite.check('...and not one at its time, or one a program still on pushed late', inPlace.join() === '0,0,0', inPlace.join());

            const undoText = pins.sayUndo({ label: 'X', at: thu(20), effects: { movedAlong: [], late: [], early: [] }, anyway: '', dropped: [], moved: back.moved });
            suite.check('the undo prompt says it too', undoText.endsWith(" Arnold's Christmas is at Thu Oct 8, 7:00pm in the list, but it is pinned to Thu Oct 8, 7:30pm: re-making puts it back at its pinned time."), undoText);

            const said = pins.sayFit({ programs: lateFirst.programs, startTime: lateFirst.startTime, schedule, at: thu(20), item: ride, kind: 'swap', after: pushedBoth });
            suite.check('sayFit, given the re-lay, never says it fits when it would start late and run over',
                ! said.includes('It fits:') && said.includes("can't start until 8:06:47: Hey Arnold! is still on until then")
                    && said.includes("runs 1:10 past 8:30, into Shelby Woo's slot"),
                said);
        }

        // Ron, Oct 16: House of Mouse re-added from the library - 212 episodes in one go - and then
        // an episode deleted. Every one of them is "placed by hand" to a re-lay.
        suite.log('-- hand-added items: what the prompt says, and whether a delete re-lays --');
        const mouse = [];
        for (let n = 1; n <= 212; n++) {
            mouse.push(episode('House of Mouse', 1, n, { title: `House of Mouse - S01E${String(n).padStart(2, '0')}`, duration: 22 * MIN }));
        }
        const withMouse = { programs: plain.programs.slice(), startTime: plain.startTime };
        let at2 = plain.startTime, k = 0;
        while (at2 < thu(20, 30) + DAY) { at2 += withMouse.programs[k].duration; k++; }
        withMouse.programs.splice(k, 0, ...mouse);
        const reach = { from: NOON8, to: NOON8 + 400 * DAY, schedule, getShowData };

        const held = pins.handPlaced(Object.assign({ programs: withMouse.programs, startTime: withMouse.startTime }, reach));
        suite.check('handPlaced finds every airing in the list that no slot made, in order',
            held.length === 212 && held[0].program.title === 'House of Mouse - S01E01' && held[211].program.title === 'House of Mouse - S01E212'
                && held.every((h, i) => i === 0 || held[i - 1].start < h.start),
            held.length + ' ' + (held[0] && held[0].program.title));
        suite.check('...and nothing in a lineup the generator made',
            pins.handPlaced(Object.assign({ programs: plain.programs, startTime: plain.startTime }, reach)).length === 0);
        suite.check('...a pinned airing, a repeat and Flex are not hand-placed',
            pins.handPlaced(Object.assign({ programs: swapped.programs, startTime: swapped.startTime }, reach)).length === 0);
        const oneBumper = pins.handPlaced(Object.assign({ programs: byHand.programs, startTime: byHand.startTime }, reach));
        suite.check('...and one bumper is found as before', oneBumper.length === 1 && oneBumper[0].program.title === 'NEXT - SGC2C');

        const droppedAll = pins.relayEffects({ before: withMouse, after: plain, from: NOON8, to: NOON8 + 400 * DAY, schedule, getShowData }).dropped;
        const shortText = pins.sayDropped(droppedAll);
        suite.check('212 hand-placed airings are a short summary, not 212 times and titles',
            shortText === 'This also drops 212 airings placed in the list by hand.' && shortText.length < 100,
            shortText.slice(0, 160));
        const lines = pins.droppedLines(droppedAll);
        suite.check('...and the list is there to show: one line each, the way the short list reads',
            lines.length === 212 && lines[0] === 'Fri Oct 9, 8:30pm House of Mouse - S01E01 (22:00)' && lines[211].includes('House of Mouse - S01E212'),
            String(lines[0]));
        const few = [ { start: thu(19, 52, 38), program: bumper }, { start: thu(20, 52, 38), program: bumper } ];
        suite.check('a few are still named in the sentence, as before',
            pins.sayDropped(few) === 'This also drops what was placed in the list by hand: Thu Oct 8, 7:52pm NEXT - SGC2C (0:10); Thu Oct 8, 8:52pm NEXT - SGC2C (0:10).');
        suite.check('...and the first-swap warning and the undo prompt stay short too',
            pins.sayFirstSwap({ dropped: droppedAll }).length < 400 && pins.sayUndo({ label: 'x', at: thu(19, 30), effects: undone, anyway: '', dropped: droppedAll }).length < 400);

        suite.check('only a long list goes behind "show them"; a few are named in the sentence',
            pins.droppedBehind(droppedAll).length === 212 && pins.droppedBehind(few).length === 0);
        suite.check('a delete does not re-lay while the list holds something added by hand',
            pins.deleteMode(Object.assign({ programs: withMouse.programs, startTime: withMouse.startTime }, reach)) === 'splice'
                && pins.deleteMode(Object.assign({ programs: byHand.programs, startTime: byHand.startTime }, reach)) === 'splice');
        suite.check('...and re-lays when nothing was',
            pins.deleteMode(Object.assign({ programs: plain.programs, startTime: plain.startTime }, reach)) === 'relay'
                && pins.deleteMode(Object.assign({ programs: swapped.programs, startTime: swapped.startTime }, reach)) === 'relay');

        // Ron, Oct 16, second report: the library's default is "Insert at the end of list", which is
        // past where a re-lay reaches (two weeks before the loop's end), so nothing read as placed by
        // hand, the delete re-laid, and "Remove this airing only" lost every episode added.
        // As Ron's lineups end: the content, then days of Flex where the loop comes round. What is added
        // at the end of the list comes after that Flex.
        const sealed = plain.programs.concat([{ isOffline: true, duration: 5 * DAY }]);
        // The editor rotates a lineup's start to now, so the end of the list is a year out.
        const reachNow = { from: plain.startTime + 30 * MIN, to: plain.startTime + 400 * DAY, schedule, getShowData };
        const listEnd = { programs: sealed.concat(mouse.slice(0, 12)), startTime: plain.startTime };
        const generated = sealed.reduce((a, p) => a + p.duration, 0);
        suite.check('a lineup the generator made is a whole number of periods, and a re-lay is how a delete treats it',
            generated % schedule.period === 0 && pins.deleteMode(Object.assign({ programs: sealed, startTime: plain.startTime }, reachNow)) === 'relay',
            String(generated / schedule.period));
        suite.check('...while a re-lay cannot see what was added after its end Flex (the cause)',
            pins.handPlaced(Object.assign({ programs: listEnd.programs, startTime: listEnd.startTime }, reachNow)).length === 0);
        suite.check('items added at the end of the list hold a delete back too: it takes the airing out and re-makes nothing',
            pins.deleteMode(Object.assign({ programs: listEnd.programs, startTime: listEnd.startTime }, reachNow)) === 'splice',
            pins.deleteMode(Object.assign({ programs: listEnd.programs, startTime: listEnd.startTime }, reachNow)));
        const afterDelete = listEnd.programs.slice();
        const gone = afterDelete[afterDelete.length - 11];
        const rest = afterDelete.filter((p) => p !== gone);
        suite.check('...and the airing that goes is that one: every other airing, added or not, stays in order',
            pins.removeAiring(afterDelete, gone) === true && afterDelete.length === rest.length && afterDelete.every((p, i) => p === rest[i])
                && afterDelete.slice(-11).every((p, i) => p === mouse.slice(0, 12).filter((m) => m !== gone)[i]),
            afterDelete.length + ' of ' + rest.length);
        suite.check('...a lineup with one airing already taken out by hand is not the generator\'s either',
            pins.deleteMode(Object.assign({ programs: plain.programs.slice(0, 50).concat(plain.programs.slice(51)), startTime: plain.startTime }, reachNow)) === 'splice');
        suite.check('...and a schedule with no period leaves it to what is in the list',
            pins.deleteMode({ programs: plain.programs, startTime: plain.startTime, from: plain.startTime + 30 * MIN, to: plain.startTime + 400 * DAY, schedule: {}, getShowData }) === 'relay');

        // The same blind spot in the other direction: a swap, an insert, an undo and the first-swap
        // warning name what the re-lay drops through relayEffects, which stops two weeks before the
        // loop's end, so the same twelve episodes were dropped by a swap without a word.
        suite.log('-- a re-lay names what was added at the end of the list --');
        const lostAtEnd = pins.relayEffects({ before: listEnd, after: plain, from: reachNow.from, to: reachNow.to, schedule, getShowData }).dropped;
        suite.check('a re-lay names the episodes added after the end Flex, which it drops',
            lostAtEnd.length === 12 && lostAtEnd[0].program.title === 'House of Mouse - S01E01' && lostAtEnd[11].program.title === 'House of Mouse - S01E12'
                && lostAtEnd.every((d, i) => i === 0 || lostAtEnd[i - 1].start < d.start && d.start > reachNow.from),
            lostAtEnd.length + ' ' + lostAtEnd.map((d) => d.program.title).join());
        suite.check('...a dozen are counted, with the list behind "show them", in the first-swap warning, the undo prompt and the swap dialog',
            pins.sayDropped(lostAtEnd) === 'This also drops 12 airings placed in the list by hand.' && pins.droppedBehind(lostAtEnd).length === 12
                && pins.sayFirstSwap({ dropped: lostAtEnd }).endsWith('This also drops 12 airings placed in the list by hand.'));
        const fewAtEnd = pins.relayEffects({ before: { programs: sealed.concat(mouse.slice(0, 2)), startTime: plain.startTime }, after: plain,
            from: reachNow.from, to: reachNow.to, schedule, getShowData }).dropped;
        suite.check('...two are named in the sentence',
            fewAtEnd.length === 2 && pins.sayDropped(fewAtEnd).startsWith('This also drops what was placed in the list by hand: '), pins.sayDropped(fewAtEnd));
        // Added at the end, then one airing in the middle taken out by hand (a delete that splices).
        const mixed = { programs: listEnd.programs.slice(0, 50).concat(listEnd.programs.slice(51)), startTime: plain.startTime };
        suite.check('...still all of them when an airing was also taken out of the middle by hand',
            pins.relayEffects({ before: mixed, after: plain, from: reachNow.from, to: reachNow.to, schedule, getShowData }).dropped.length === 12);
        // A lineup the generator made may have an airing past its end Flex that reads as no slot's (Ron's channel 3
        // ends on Tick-Tick-Tick): it is whole, so it is the generator's own and is not named.
        const seamItem = Object.assign({}, bumper, { title: 'Seam item', duration: 22 * MIN });
        const seamLineup = { programs: plain.programs.concat([{ isOffline: true, duration: 5 * DAY - seamItem.duration }, seamItem]), startTime: plain.startTime };
        suite.check('...and nothing in a generator lineup, even with an off-slot airing past its end Flex',
            seamLineup.programs.reduce((a, p) => a + p.duration, 0) % schedule.period === 0
                && pins.relayEffects({ before: seamLineup, after: plain, from: reachNow.from, to: reachNow.to, schedule, getShowData }).dropped.length === 0);
        // As the editor holds it: rotated to start at now, so the end Flex is mid-list, then the seam, then the
        // lineup's first days, and the episodes added from the library at the very end of the array.
        const rotateAt = 300;
        const cut = seamLineup.programs.slice(0, rotateAt).reduce((a, p) => a + p.duration, 0);
        const rotatedList = { programs: seamLineup.programs.slice(rotateAt).concat(seamLineup.programs.slice(0, rotateAt)).concat(mouse.slice(0, 12)),
            startTime: plain.startTime + cut };
        const lostRotated = pins.relayEffects({ before: rotatedList, after: plain, from: plain.startTime + cut + 30 * MIN, to: reachNow.to, schedule, getShowData }).dropped;
        suite.check('...in a list rotated to start at now: the episodes at its end, not the seam item or the first days',
            lostRotated.length === 12 && lostRotated.every((d) => d.program.title.startsWith('House of Mouse')),
            lostRotated.length + ' ' + lostRotated.slice(0, 3).map((d) => d.program.title).join());
        suite.check('...and only the generators own list rotated like that names nothing',
            pins.relayEffects({ before: { programs: rotatedList.programs.slice(0, rotatedList.programs.length - 12), startTime: rotatedList.startTime }, after: plain,
                from: plain.startTime + cut + 30 * MIN, to: reachNow.to, schedule, getShowData }).dropped.length === 0);
        suite.check('...nor in a lineup whose end Flex has nothing after it',
            pins.relayEffects({ before: { programs: sealed, startTime: plain.startTime }, after: plain, from: reachNow.from, to: reachNow.to, schedule, getShowData }).dropped.length === 0);
        // Only what a swap re-lays: pins are kept, so a pinned airing added at the end is not named.
        const pinnedAtEnd = { programs: sealed.concat([Object.assign({}, mouse[0], { pin: { at: reachNow.from + 300 * DAY, kind: 'swap', then: 'take' } })]), startTime: plain.startTime };
        suite.check('...and a pinned airing is not named',
            pins.relayEffects({ before: pinnedAtEnd, after: plain, from: reachNow.from, to: reachNow.to, schedule, getShowData }).dropped.length === 0);

        suite.check('Escape closes the delete prompt, or the undo prompt on top of it, and nothing else',
            pins.escapeAction({ key: 'Escape', deletePrompt: {}, undoPrompt: null }) === 'delete'
                && pins.escapeAction({ key: 'Escape', deletePrompt: null, undoPrompt: {} }) === 'undo'
                && pins.escapeAction({ key: 'Escape', deletePrompt: {}, undoPrompt: {} }) === 'undo'
                && pins.escapeAction({ key: 'Esc', deletePrompt: {}, undoPrompt: null }) === 'delete'
                && pins.escapeAction({ key: 'Enter', deletePrompt: {}, undoPrompt: null }) === null
                && pins.escapeAction({ key: 'Escape', deletePrompt: null, undoPrompt: null }) === null);
    }

    suite.log('-- the dialogs can always be left --');
    {
        const template = require('fs').readFileSync(require('path').join(__dirname, '../web/public/templates/channel-config.html'), 'utf8');
        const modalOf = (marker) => {
            const from = template.indexOf(marker);
            return from === -1 ? '' : template.slice(from, template.indexOf('\n    </div>\n', from));
        };
        const deleteModal = modalOf('<div ng-if="deletePrompt" class="modal"');
        const undoModal = modalOf('<div ng-if="undoPrompt" class="modal"');
        suite.check('the delete prompt scrolls, so its buttons are always reachable',
            /class="modal"[^>]*overflow-y:\s*auto/.test(deleteModal) && /modal-body[^>]*max-height/.test(deleteModal), deleteModal.slice(0, 200));
        suite.check('the undo and delete-confirm prompt scrolls and keeps its list behind "show them"',
            /class="modal"[^>]*overflow-y:\s*auto/.test(undoModal) && /modal-body[^>]*max-height/.test(undoModal)
                && /ng-if="undoPrompt\.items\.length/.test(undoModal) && /show them/.test(undoModal), undoModal.slice(0, 200));
    }

    suite.log('-- inserts --');
    {
        const day = await generate(fixturePool(), fixtureSchedule(), NOON8);
        const lineupNow = { programs: day.programs, startTime: Date.parse(day.startTime) };
        const schedule = fixtureSchedule();
        const near = thu(19, 52, 38);
        const fits = pins.breaksThatFit({ programs: lineupNow.programs, startTime: lineupNow.startTime, near, within: 2 * HOUR, duration: 7 * MIN + 30 * SEC });
        suite.check('breaksThatFit lists the nearest breaks long enough, nearest first',
            fits.length === 2 && fits[0].after.program.showTitle === 'Are You Afraid of the Dark?' && fits[0].start === thu(20, 22)
                && fits[0].length === 8 * MIN && fits[1].after.program.showTitle === 'Shelby Woo' && fits[1].start === thu(20, 52),
            JSON.stringify(fits.map((f) => [f.after.program.showTitle, new Date(f.start).toString(), f.length])));
        suite.check('...none when nothing is long enough',
            pins.breaksThatFit({ programs: lineupNow.programs, startTime: lineupNow.startTime, near, within: 2 * HOUR, duration: 30 * HOUR }).length === 0);
        const many = pins.breaksThatFit({ programs: lineupNow.programs, startTime: lineupNow.startTime, near, within: 4 * DAY, duration: 2 * MIN });
        suite.check('...at most five, still nearest first',
            many.length === 5 && many.every((f, i, all) => i === 0 || Math.abs(all[i - 1].start - near) <= Math.abs(f.start - near)));
        const clip = episode('Specials', 0, 1, { title: 'Silly Symphony', duration: 8 * MIN + 11 * SEC });
        const over = pins.sayFit({ programs: lineupNow.programs, startTime: lineupNow.startTime, schedule, at: near, item: clip, kind: 'insert' });
        suite.check('sayFit for an insert 49 seconds too long names the break and the show whose slot it runs into',
            over === "Silly Symphony runs 8:11. The space is 7:22 - the break after Best Man / Cool Party. It runs 0:49 past 8:00, into Are You Afraid of the Dark?'s slot.",
            over);
        const small = episode('Specials', 0, 2, { title: 'Short', duration: 5 * MIN });
        const ok = pins.sayFit({ programs: lineupNow.programs, startTime: lineupNow.startTime, schedule, at: near, item: small, kind: 'insert' });
        suite.check('...and for one that fits, what is left and when the next show starts',
            ok === 'Short runs 5:00. The space is 7:22 - the break after Best Man / Cool Party. It fits: 2:22 of Flex after it, and Are You Afraid of the Dark? starts at 8:00.',
            ok);
    }

    suite.log('-- a pin in a changed slot --');
    {
        const schedule = fixtureSchedule();
        const christmas = episode('Hey Arnold!', 0, 7, { title: "Arnold's Christmas", duration: 24 * MIN + 6 * SEC });
        const made = (at, slotShow) => ({ at, then: 'take', program: pins.makePin({ program: christmas, at, kind: 'swap', then: 'take', slotShow, now: NOW }) });
        // Thu 7:30pm is Hey Arnold!'s slot in the fixture schedule.
        suite.check('pinNotes says nothing when the slot is still the show\'s it was made in',
            pins.pinNotes({ pins: [ made(thu(19, 30), 'tv.Hey Arnold!') ], schedule }).length === 0);
        const other = { period: DAY, lateness: 24 * HOUR, slots: schedule.slots.map((s) => (s.time === 19 * HOUR + 30 * MIN) ? Object.assign({}, s, { showId: 'tv.Rocket Power' }) : s) };
        const notes = pins.pinNotes({ pins: [ made(thu(19, 30), 'tv.Hey Arnold!') ], schedule: other });
        suite.check('...and names a pin whose slot now holds another show',
            notes.length === 1 && notes[0].text === "Arnold's Christmas, Thu Oct 8, 7:30pm: that slot is Rocket Power's now, not Hey Arnold!'s.",
            notes.map((n) => n.text).join(' | '));
        const flexed = { period: DAY, lateness: 24 * HOUR, slots: schedule.slots.map((s) => (s.time === 19 * HOUR + 30 * MIN) ? Object.assign({}, s, { showId: 'flex.' }) : s) };
        suite.check('...a slot that has become Flex is named so',
            pins.pinNotes({ pins: [ made(thu(19, 30), 'tv.Hey Arnold!') ], schedule: flexed })[0].text
                === "Arnold's Christmas, Thu Oct 8, 7:30pm: that slot is Flex now, not Hey Arnold!'s.");
        suite.check('...and a pin made before slots were recorded gets no note',
            pins.pinNotes({ pins: [ made(thu(19, 30), undefined) ], schedule: other }).length === 0);
    }

    suite.log('-- deleting an airing --');
    {
        const day = await generate(fixturePool(), fixtureSchedule(), NOON8);
        const lineupNow = { programs: day.programs, startTime: Date.parse(day.startTime) };
        const arnold = pins.airingAt({ programs: lineupNow.programs, startTime: lineupNow.startTime, at: thu(19, 30) });
        const gap = pins.sayRemoval({ programs: lineupNow.programs, startTime: lineupNow.startTime, index: arnold.index });
        suite.check('sayRemoval: a 22:38 airing with 7:22 of Flex leaves 30:00, 7:30-8:00pm, and offers Swap',
            gap.flexMs === 30 * MIN && gap.from === thu(19, 30) && gap.to === thu(20) && gap.offerSwap === true
                && gap.text === 'Leaves 30:00 of Flex, 7:30-8:00pm.',
            JSON.stringify({ flexMs: gap.flexMs, text: gap.text, offerSwap: gap.offerSwap }));
        const clip = { type: 'movie', title: 'NEXT - SGC2C', duration: 10 * SEC, serverKey: 'srv', key: '/b/next' };
        const tiny = [ clip, { isOffline: true, duration: 50 * SEC }, episode('A', 1, 1), { isOffline: true, duration: 20 * MIN } ];
        const small = pins.sayRemoval({ programs: tiny, startTime: thu(19, 52, 38), index: 0 });
        suite.check('...a 10-second clip with 50 seconds of Flex leaves 1:00 and no offer of Swap',
            small.flexMs === MIN && small.offerSwap === false && small.text === 'Leaves 1:00 of Flex, 7:53-7:54pm.', JSON.stringify(small));
        const noon = pins.sayRemoval({ programs: [ episode('A', 1, 1), { isOffline: true, duration: 8 * MIN }, episode('B', 1, 1) ], startTime: thu(11, 40), index: 0 });
        suite.check('...and a range across noon says am and pm',
            noon.text === 'Leaves 30:00 of Flex, 11:40am-12:10pm.', noon.text);
    }

    suite.log('-- the program on air --');
    {
        const a = episode('A', 1, 1);
        const b = episode('B', 1, 1);
        const programs = [a, { isOffline: true, duration: 8 * MIN }, b, { isOffline: true, duration: 8 * MIN }, { isOffline: true, duration: 3 * DAY }];
        const on = pins.carryAt({ programs, startTime: THU, now: THU + 40 * MIN });
        const brk = pins.carryAt({ programs, startTime: THU, now: THU + 55 * MIN });
        const none = pins.carryAt({ programs, startTime: THU, now: THU + 2 * DAY });
        suite.check('carryAt is the program on air, the one whose break is on air, or none a day after the last',
            on && on.program === b && on.start === THU + 30 * MIN && brk && brk.program === b && none === null,
            JSON.stringify({ on: on && on.program.showTitle, brk: brk && brk.program.showTitle, none }));
    }

    suite.log('-- the program on air: the schedule says whose break it is --');
    {
        // A 8:30pm (22 min), then a Flex slot from 9:00, D at 11pm.
        const sched = { period: DAY, slots: [ { time: 20 * HOUR + 30 * MIN, showId: 'tv.A', order: 'next' },
            { time: 21 * HOUR, showId: 'flex.', order: 'next' }, { time: 23 * HOUR, showId: 'tv.D', order: 'next' } ] };
        const a = episode('A', 1, 1);
        const programs = [ a, { isOffline: true, duration: 2 * HOUR + 8 * MIN }, episode('D', 1, 1), { isOffline: true, duration: DAY - 3 * HOUR } ];
        const startTime = thu(20, 30);
        const inBreak = pins.carryAt({ programs, startTime, now: thu(20, 55), schedule: sched });
        const inFlexSlot = pins.carryAt({ programs, startTime, now: thu(21, 15), schedule: sched });
        suite.check('with the schedule, a program whose slot is over is not carried - the Flex slot on air is nobody\'s break',
            inBreak && inBreak.program === a && inFlexSlot === null
                && pins.carryAt({ programs, startTime, now: thu(21, 15) }).program === a,
            JSON.stringify({ inBreak: !!inBreak, inFlexSlot }));
    }

    suite.log('-- an airing that is on air, or has aired --');
    {
        const airing = episode('A', 1, 1, { title: 'Pilot', start: new Date(thu(19, 30)), duration: 22 * MIN });
        const ahead = pins.whyNot({ airing: Object.assign({}, airing, { start: new Date(thu(20)) }), now: thu(19, 40), what: 'swap' });
        const onAir = pins.whyNot({ airing, now: thu(19, 40), what: 'swap' });
        suite.check('whyNot: nothing against an airing still ahead; against one on air, in plain words',
            ahead === null && onAir === "A S01E01 Pilot is on air now, so it can't be swapped - it finishes airing first. Pick an airing after it.",
            String(onAir));
        suite.check('...removing and undoing say so too',
            /can't be removed/.test(pins.whyNot({ airing, now: thu(19, 40), what: 'remove' })) && /can't be undone/.test(pins.whyNot({ airing, now: thu(19, 40), what: 'undo' })));
        suite.check('...an airing that has aired cannot be swapped or removed',
            pins.whyNot({ airing, now: thu(20), what: 'swap' }) === 'A S01E01 Pilot has already aired.');
        suite.check('...an insert after one on air is fine, and after one whose break has begun is not',
            pins.whyNot({ airing, now: thu(19, 40), what: 'insert' }) === null
                && pins.whyNot({ airing, now: thu(19, 55), what: 'insert' }) === 'The break after A S01E01 Pilot has already begun - insert after a later airing.');
        suite.check('...Holiday and Never air are never refused', pins.whyNot({ airing, now: thu(19, 40), what: 'leaveOut' }) === null);

        const waiting = { program: airing, working: true };
        suite.check('stillWanted: a prompt still working on that program, and not one cancelled or replaced',
            pins.stillWanted(waiting, airing) === true && pins.stillWanted(null, airing) === false
                && pins.stillWanted({ program: airing, working: false }, airing) === false
                && pins.stillWanted({ program: episode('B', 1, 1), working: true }, airing) === false);
    }

    suite.log('-- breaks that have not begun --');
    {
        const day = await generate(fixturePool(), fixtureSchedule(), NOON8);
        const l = { programs: day.programs, startTime: Date.parse(day.startTime) };
        const all = pins.breaksThatFit({ programs: l.programs, startTime: l.startTime, near: thu(20, 22), within: 2 * HOUR, duration: 7 * MIN });
        const later = pins.breaksThatFit({ programs: l.programs, startTime: l.startTime, near: thu(20, 22), within: 2 * HOUR, duration: 7 * MIN, notBefore: thu(20, 30) });
        suite.check('breaksThatFit leaves out breaks that began before notBefore',
            all.some((b) => b.start < thu(20, 30)) && later.length > 0 && later.every((b) => b.start >= thu(20, 30)),
            JSON.stringify(later.map((b) => new Date(b.start).toString())));
    }

    suite.log('-- a removal leaves its slot --');
    {
        const sched = { period: DAY, lateness: 24 * HOUR, slots: [ { time: 19 * HOUR, showId: 'tv.H', order: 'next' }, { time: 19 * HOUR + 30 * MIN, showId: 'flex.', order: 'next' } ] };
        const h1 = episode('H', 1, 1, { duration: 11 * MIN });
        const h2 = episode('H', 1, 2, { duration: 11 * MIN });
        const programs = [ h1, { isOffline: true, duration: 4 * MIN }, h2, { isOffline: true, duration: 4 * MIN }, { isOffline: true, duration: DAY - 30 * MIN } ];
        const gap = pins.sayRemoval({ programs, startTime: thu(19), index: 0, schedule: sched });
        suite.check('sayRemoval with the schedule: removing one half of a two-halves slot leaves the whole slot',
            gap.flexMs === 30 * MIN && gap.text === 'Leaves 30:00 of Flex, 7:00-7:30pm.' && gap.to === thu(19, 30), JSON.stringify(gap));
        const long = pins.sayRemoval({ programs: [ episode('H', 1, 3, { duration: 44 * MIN }), { isOffline: true, duration: 8 * MIN }, h1 ], startTime: thu(19), index: 0, schedule: sched });
        suite.check('...and one that overran its slot leaves until the next program, as before', long.flexMs === 52 * MIN, JSON.stringify(long));
    }

    suite.log('-- one re-lay at a time --');
    {
        const gate = pins.oneAtATime();
        let release;
        const first = gate.run(() => new Promise((r) => { release = r; }));
        let refused = null;
        try {
            await gate.run(async () => 'second');
        } catch (err) {
            refused = err.message;
        }
        const busyDuring = gate.busy();
        release('first');
        const firstResult = await first;
        const third = await gate.run(async () => 'third');
        suite.check('oneAtATime refuses a second run while one is under way, and frees up after',
            busyDuring && refused === 'busy' && firstResult === 'first' && third === 'third' && ! gate.busy(),
            JSON.stringify({ busyDuring, refused, firstResult, third }));
        const failing = await gate.run(async () => { throw new Error('boom'); }).catch((e) => e.message);
        suite.check('...and frees up after a run that fails', failing === 'boom' && ! gate.busy());
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
// A lineup with the airing starting at `fromAt` and the Flex after it moved by hand to
// just before the airing starting at `toAt`, as dragging the two rows does.
function moveRows(lineup, fromAt, toAt) {
    const starts = [];
    lineup.programs.reduce((t, p) => { starts.push(t); return t + p.duration; }, lineup.startTime);
    const i = starts.indexOf(fromAt);
    let j = starts.indexOf(toAt);
    if (i < 0 || j < 0 || ! lineup.programs[i + 1].isOffline) throw new Error('moveRows: no airing and Flex there');
    const programs = lineup.programs.slice();
    const rows = programs.splice(i, 2);
    if (j > i) j -= 2;
    programs.splice(j, 0, ...rows);
    return { programs, startTime: lineup.startTime };
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
