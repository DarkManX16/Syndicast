/*
 * src/pins.js: what's left of the clock-time pin path after "What you see is
 * what airs" moved swaps and inserts to kept rows (src/kept-rows.js) - the
 * walk over a lineup by clock time, the slot and schedule readers, and the
 * clock-word formatters.
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

        suite.check('label names an episode, a custom-show item and a movie',
            pins.label(from) === 'Hey Arnold! S03E23 Best Man / Cool Party'
                && pins.label({ type: 'movie', title: 'The Night Before Christmas (1933)', customShowId: 'x', customShowName: 'Silly Symphonies', customOrder: 11 })
                    === 'Silly Symphonies #12 The Night Before Christmas (1933)'
                && pins.label({ type: 'movie', title: 'The Iron Giant' }) === 'The Iron Giant',
            pins.label(from));
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

    suite.log('-- hand-placed items, deleting, and this show --');
    {
        const lineup = async (pinList) => {
            const res = await generate(fixturePool(), fixtureSchedule(), NOON8, pinList);
            return { programs: res.programs, startTime: Date.parse(res.startTime) };
        };
        const plain = await lineup();
        const schedule = fixtureSchedule();
        const christmas = episode('Hey Arnold!', 0, 7, { title: "Arnold's Christmas", duration: 24 * MIN + 6 * SEC });
        const swapped = await lineup([mark(christmas, thu(19, 30), 'take')]);

        // The old way: a 10-second clip inserted by hand in the break after Thursday's 7:30.
        const bumper = { type: 'movie', title: 'NEXT - SGC2C', duration: 10 * SEC, serverKey: 'srv', key: '/b/next' };
        const byHand = { programs: plain.programs.slice(), startTime: plain.startTime };
        let t = plain.startTime, i = 0;
        while (t < thu(19, 52, 38)) { t += byHand.programs[i].duration; i++; }
        const flex = byHand.programs[i];
        byHand.programs.splice(i, 1, bumper, { isOffline: true, duration: flex.duration - bumper.duration });

        // Ron, Oct 16: House of Mouse re-added from the library - 212 episodes in one go - and then
        // an episode deleted. Every one of them is "placed by hand".
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

        // As the library's "Insert at the end of list" lands: past where handPlaced reaches
        // (two weeks before the loop's end).
        const sealed = plain.programs.concat([{ isOffline: true, duration: 5 * DAY }]);
        const reachNow = { from: plain.startTime + 30 * MIN, to: plain.startTime + 400 * DAY, schedule, getShowData };
        const listEnd = { programs: sealed.concat(mouse.slice(0, 12)), startTime: plain.startTime };
        suite.check('...and handPlaced cannot see what was added after its end Flex',
            pins.handPlaced(Object.assign({ programs: listEnd.programs, startTime: listEnd.startTime }, reachNow)).length === 0);
        const afterDelete = listEnd.programs.slice();
        const gone = afterDelete[afterDelete.length - 11];
        const rest = afterDelete.filter((p) => p !== gone);
        suite.check('removeAiring takes just the one airing out of the list: every other airing, added or not, stays in order',
            pins.removeAiring(afterDelete, gone) === true && afterDelete.length === rest.length && afterDelete.every((p, i) => p === rest[i])
                && afterDelete.slice(-11).every((p, i) => p === mouse.slice(0, 12).filter((m) => m !== gone)[i]),
            afterDelete.length + ' of ' + rest.length);

        // Ron, Oct 29: "This show" is the airing's own show, whatever slot it sits in now.
        const futurama = episode('Futurama', 2, 14, { title: 'How Hermes Requisitioned His Groove Back' });
        suite.check('swapShow: the airing\'s own show, not the slot\'s it sits in',
            pins.swapShow({ airing: futurama, slotShow: 'tv.Family Guy', getShowData }) === 'tv.Futurama');
        suite.check('...and the slot\'s for an airing of no show',
            pins.swapShow({ airing: { title: 'A Movie', type: 'movie', duration: 90 * MIN }, slotShow: 'tv.Family Guy', getShowData }) === 'tv.Family Guy');

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
        // Since kept rows (src/kept-rows.js) it asks with one sentence: Put back, a long drag, a whole-list tool.
        suite.check('the prompt that asks first scrolls, and says its one sentence',
            /class="modal"[^>]*overflow-y:\s*auto/.test(undoModal) && /modal-body[^>]*max-height/.test(undoModal)
                && /\{\{undoPrompt\.text\}\}/.test(undoModal), undoModal.slice(0, 200));
    }

    suite.log('-- inserts: where a break fits one --');
    {
        const day = await generate(fixturePool(), fixtureSchedule(), NOON8);
        const lineupNow = { programs: day.programs, startTime: Date.parse(day.startTime) };
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
