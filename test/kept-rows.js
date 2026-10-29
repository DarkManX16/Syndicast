/*
 * src/kept-rows.js: hand edits kept where they sit in the list - the first
 * open, swap in place, insert, remove, drag, Put back, and what each says.
 * See NOTES.md, Known issues, "What you see is what airs: hand edits kept in
 * the list".
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const kept = require('../src/kept-rows');
const getShowData = require('../web/services/get-show-data')();

const SEC = 1000;
const THU = new Date('2026-10-29T00:00:00').getTime();
const NOW = new Date('2026-10-29T05:05:00').getTime();
const fri = (h, m) => new Date(`2026-10-30T${String(h).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}:00`).getTime();

// Channel 1's Friday night, as the generator lays it: half hours of 22:30 and 7:30
// of Flex, Robot Chicken in two halves of 11:35, Waynehead the rest of the week.
const NIGHT = [
    [ 0, 'Futurama' ], [ 30, 'Family Guy' ], [ 60, 'Robot Chicken', 2 ], [ 90, 'Aqua Teen Hunger Force' ],
    [ 120, 'Space Ghost Coast to Coast' ], [ 150, 'Sealab 2021' ], [ 180, 'Home Movies' ], [ 210, 'The Venture Bros.' ],
    [ 240, 'Harvey Birdman, Attorney at Law' ], [ 270, 'Waynehead' ],
];
const WEEKS = 6;

function schedule() {
    return {
        period: 7 * DAY, lateness: DAY, pad: 5 * MIN,
        slots: NIGHT.map( ([ m, show ]) => ({ time: DAY + m * MIN, showId: 'tv.' + show, order: 'next' }) ),
    };
}

function episode(show, n, duration, extra) {
    return Object.assign({
        type: 'episode', showTitle: show, title: `${show} ${n}`, season: 1, episode: n,
        duration: duration, serverKey: 'srv', key: `/e/${show}/${n}`, slotPosition: 'next|',
    }, extra || {});
}
// As the generator writes a break.
const flex = (d) => ({ duration: d, isOffline: true });

// Six weeks from Thu Oct 29 00:00, each slot's episodes and Flex to its end.
function lineup() {
    let programs = [];
    let count = {};
    let next = (show, d) => {
        count[show] = (count[show] || 0) + 1;
        return episode(show, count[show], d);
    };
    let t = THU;
    let end = THU + WEEKS * 7 * DAY;
    let add = (p) => { programs.push(p); t += p.duration; };
    while (t < end) {
        let local = new Date(t);
        let weekday = local.getDay();
        let minutes = local.getHours() * 60 + local.getMinutes();
        let slot = (weekday === 5) ? NIGHT.find( ([ m ], i) => (m <= minutes) && ( (i === NIGHT.length - 1) || (NIGHT[i + 1][0] > minutes) ) ) : null;
        let show = (slot === null || typeof(slot) === 'undefined') ? 'Waynehead' : slot[1];
        if ( (show !== 'Waynehead') && (slot[2] === 2) ) {
            add(next(show, 11 * MIN + 35 * SEC)); add(flex(3 * MIN + 25 * SEC));
            add(next(show, 11 * MIN + 35 * SEC)); add(flex(3 * MIN + 25 * SEC));
        } else {
            add(next(show, 22 * MIN + 30 * SEC)); add(flex(7 * MIN + 30 * SEC));
        }
    }
    return { programs, startTime: THU };
}

// Every entry's start, by index.
function starts(l) {
    let out = [];
    l.programs.reduce( (t, p) => { out.push(t); return t + p.duration; }, l.startTime );
    return out;
}
const indexAt = (l, t) => starts(l).findIndex( (s, i) => (s === t) && ! l.programs[i].isOffline );
// The non-Flex rows from..to, as "start show".
function night(l, from, to) {
    let s = starts(l);
    return l.programs.map( (p, i) => ({ p, t: s[i] }) )
        .filter( (x) => (x.t >= from) && (x.t < to) && (! x.p.isOffline || x.p.kept) )
        .map( (x) => `${new Date(x.t).toTimeString().slice(0, 8)} ${x.p.isOffline ? 'Flex' : x.p.title}` );
}
// Ron's drag of the Venture special in the list, before this design: the row and its
// Flex spliced in front of Futurama.
function dragged(l, fromIndex, beforeIndex) {
    let programs = l.programs.slice();
    let block = programs.splice(fromIndex, 2);
    programs.splice(beforeIndex, 0, ...block);
    return { programs, startTime: l.startTime };
}
function withPin(l, at, special, extra) {
    let i = indexAt(l, at);
    let programs = l.programs.slice();
    let was = programs[i];
    programs[i] = Object.assign(episode('The Venture Bros.', 0, special.duration, { title: special.title, season: 0, episode: 4 }), {
        pin: Object.assign({ at: at, kind: 'swap', then: 'take', was: `The Venture Bros. S01E${String(was.episode).padStart(2, '0')} ${was.title}`,
            slotShow: 'tv.The Venture Bros.', made: '2026-10-29T05:28:00.000Z' }, extra || {}),
    });
    delete programs[i].slotPosition;
    if (special.duration !== was.duration) {
        programs[i + 1] = flex(was.duration + programs[i + 1].duration - special.duration);
    }
    return { programs, startTime: l.startTime };
}

module.exports = async function () {
    const suite = new Suite('kept-rows');
    const base = lineup();
    const sched = schedule();

    suite.log('-- the first open --');
    {
        const none = kept.firstOpen({ programs: base.programs, startTime: base.startTime, now: NOW, schedule: sched, getShowData });
        suite.check('a list with no pins and nothing placed by hand: nothing to show',
            none.keep.length === 0 && none.letGo.length === 0 && none.needed === false, JSON.stringify(none.lines));

        const special = { title: 'A Very Venture Halloween', duration: 22 * MIN + 30 * SEC };
        const inPlace = withPin(base, fri(3, 30), special);
        const sorted = kept.firstOpen({ programs: inPlace.programs, startTime: inPlace.startTime, now: NOW, schedule: sched, getShowData });
        suite.check('a pin at its time is kept where it is',
            sorted.needed && sorted.keep.length === 1 && sorted.keep[0].why === 'pin' && sorted.keep[0].start === fri(3, 30)
                && sorted.letGo.length === 0,
            JSON.stringify(sorted.keep.map( (x) => [ x.why, x.program.title ] )));

        // The night as Ron left it: the special dragged from 3:30 to 12:00, still pinned to 3:30.
        const moved = dragged(inPlace, indexAt(inPlace, fri(3, 30)), indexAt(inPlace, fri(0)));
        const r = kept.firstOpen({ programs: moved.programs, startTime: moved.startTime, now: NOW, schedule: sched, getShowData });
        const shifted = r.keep.filter( (x) => x.why === 'shifted' );
        suite.check('a pin moved earlier is kept where it sits, and the airings between it and its pinned time kept in time',
            r.keep.length === 9 && r.keep[0].why === 'pin' && r.keep[0].start === fri(0) && r.keep[0].pinnedAt === fri(3, 30)
                && shifted.length === 8 && shifted[0].start === fri(0, 30) && shifted[7].start === fri(3, 30)
                && shifted.every( (x) => x.by === r.keep[0].program ),
            JSON.stringify(r.keep.map( (x) => [ x.why, x.program.title, new Date(x.start).toTimeString().slice(0, 5) ] )));
        suite.check('...and Harvey Birdman, back on time at 4:00, is not',
            ! r.keep.some( (x) => x.start === fri(4) ));

        // An aired pin coming round as the list loops, and a promo no slot made.
        const thuPin = indexAt(moved, new Date('2026-10-29T03:00:00').getTime());
        const programs = moved.programs.slice();
        programs[thuPin] = Object.assign({}, programs[thuPin], { title: 'Aired special',
            pin: { at: new Date('2026-10-29T03:00:00').getTime(), kind: 'swap', then: 'take', was: 'Waynehead 1', slotShow: 'tv.Waynehead' } });
        delete programs[thuPin].slotPosition;
        const promoAt = indexAt(moved, new Date('2026-10-31T10:00:00').getTime());
        programs.splice(promoAt + 1, 1, { type: 'movie', title: 'NEXT - SGC2C', duration: 10 * SEC, serverKey: 'srv', key: '/promo' },
            flex(programs[promoAt + 1].duration - 10 * SEC));
        const both = { programs, startTime: moved.startTime };
        const g = kept.firstOpen({ programs, startTime: both.startTime, now: NOW, schedule: sched, getShowData });
        suite.check('an aired pin coming round is let go, and so is an airing no slot made',
            g.letGo.length === 2 && g.letGo.some( (x) => (x.why === 'aired') && (x.program.title === 'Aired special') && (x.start > NOW + 5 * 7 * DAY) )
                && g.letGo.some( (x) => (x.why === 'placed') && (x.program.title === 'NEXT - SGC2C') )
                && g.keep.length === 9,
            JSON.stringify(g.letGo.map( (x) => [ x.why, x.program.title, new Date(x.start).toString().slice(0, 21) ] )));

        // Channel 2, Oct 29: a pin dragged from its pinned 5:30am to 5:00am has aired by
        // 5:35 though its pinned time hasn't passed; one dragged from a pinned time now
        // past to an airing still on is on air, and kept; one dragged later than a
        // pinned time now past is still to air, and kept.
        {
            const p = base.programs.slice();
            const at = (iso) => new Date(iso).getTime();
            const pinAt = (iso, pinned, name) => {
                let k = indexAt(base, at(iso));
                p[k] = Object.assign({}, p[k], { title: name, pin: { at: at(pinned), kind: 'swap', then: 'take' } });
                delete p[k].slotPosition;
            };
            pinAt('2026-10-29T04:30:00', '2026-10-29T05:30:00', 'Fonsillectomy');
            pinAt('2026-10-29T05:00:00', '2026-10-29T03:00:00', 'Fright Night');
            pinAt('2026-10-29T07:00:00', '2026-10-29T04:00:00', 'Lunatic Lake');
            const r2 = kept.firstOpen({ programs: p, startTime: base.startTime, now: NOW, schedule: sched, getShowData });
            const why = (name) => r2.keep.concat(r2.letGo).filter( (x) => x.program.title === name ).map( (x) => x.why ).join();
            suite.check('a pin whose airing in the list has ended is aired, whatever its pinned time; on air or moved later, it is kept',
                why('Fonsillectomy') === 'aired' && why('Fright Night') === 'pin' && why('Lunatic Lake') === 'pin'
                    && r2.keep.filter( (x) => x.why === 'shifted' ).every( (x) => x.start < at('2026-10-29T08:00:00') ),
                JSON.stringify(r2.keep.concat(r2.letGo).map( (x) => [ x.why, x.program.title, new Date(x.start).toString().slice(0, 21) ] )));
        }

        suite.check('the lines say what is kept and what is let go, plainly',
            JSON.stringify(g.lines) === JSON.stringify([
                'Keeping, as they sit in your list:',
                'The Venture Bros. S00E04 A Very Venture Halloween at Fri Oct 30, 12:00am, where you moved it (it was pinned to 3:30am), and the 8 airings it moved, until 4:00am.',
                'Letting go - Create Lineup replaces these:',
                'Waynehead S01E07 Aired special, a swap that aired Thu Oct 29, 3:00am and only comes round again as the list loops.',
                '1 airing no slot made: NEXT - SGC2C, Sat Oct 31, 10:22:30am.',
            ]),
            JSON.stringify(g.lines));

        const out = kept.applyFirstOpen({ programs, startTime: both.startTime, now: NOW, schedule: sched, getShowData });
        const s = starts({ programs: out, startTime: both.startTime });
        const sp = out.find( (p) => p.title === 'A Very Venture Halloween' );
        const edits = sp.kept && sp.kept.edits;
        suite.check('applyFirstOpen: the pin becomes a kept swap and a kept move from its pinned time, with no pin left',
            ! ('pin' in sp) && edits.length === 2 && edits[0].kind === 'swap' && edits[0].was === 'The Venture Bros. S01E01 The Venture Bros. 1'
                && edits[0].show === 'tv.The Venture Bros.' && edits[1].kind === 'moved' && edits[1].from === fri(3, 30),
            JSON.stringify(sp.kept));
        const marked = out.filter( (p) => p.kept && kept.keptKind(p) === 'shifted' );
        suite.check('...the airings it moved are kept in time by that move',
            marked.length === 8 && marked.every( (p) => (p.kept.edits.length === 1) && (p.kept.edits[0].id === edits[1].id) ),
            marked.map( (p) => p.title ).join(', '));
        suite.check('...the aired pin loses its pin and nothing keeps it; the promo is left as it is',
            ! out.some( (p) => p.title === 'Aired special' && (p.pin || p.kept) )
                && out.some( (p) => p.title === 'NEXT - SGC2C' && ! p.kept ),
            '');
        suite.check('...and nothing moves: every entry where it was',
            out.length === programs.length && out.every( (p, i) => p.duration === programs[i].duration )
                && s[out.indexOf(sp)] === fri(0), '');
    }

    suite.log('-- swap in place --');
    {
        const at = fri(0);
        const i = indexAt(base, at);
        const before = starts(base);
        const short = kept.swap({ lineup: base, index: i, item: episode('Futurama', 99, 20 * MIN, { title: 'Anthology of Interest' }), now: NOW });
        const after = starts({ programs: short.programs, startTime: base.startTime });
        const row = short.programs[i];
        suite.check('a shorter item: the Flex after it grows, every other row where it was',
            row.title === 'Anthology of Interest' && short.programs[i + 1].duration === 10 * MIN
                && short.programs.length === base.programs.length
                && after.every( (t, k) => (k === i + 1) ? true : t === before[k] ),
            JSON.stringify([ row.title, short.programs[i + 1].duration / SEC ]));
        suite.check('...the row is a kept swap of Futurama\'s airing, with no label',
            kept.keptKind(row) === 'swap' && row.kept.edits[0].was === 'Futurama S01E01 Futurama 1' && row.kept.edits[0].show === 'tv.Futurama'
                && ! ('slotPosition' in row) && base.programs[i].kept === undefined,
            JSON.stringify(row.kept));
        suite.check('...and says so in one sentence',
            short.text === 'Anthology of Interest replaces Futurama 1 at 12:00am.', short.text);

        const longer = kept.swap({ lineup: base, index: i, item: episode('Futurama', 98, 25 * MIN), now: NOW });
        suite.check('a longer item that fits: the Flex after it shrinks',
            longer.programs[i + 1].duration === 5 * MIN && starts({ programs: longer.programs, startTime: base.startTime })[i + 2] === fri(0, 30), '');

        const special = episode('Specials', 1, 44 * MIN + 9 * SEC, { title: "'Twas the Fight Before Christmas" });
        const ask = kept.swap({ lineup: base, index: i, item: special, now: NOW });
        suite.check('too long with no choice: it asks, Run late or Take the next row',
            ! ask.programs && JSON.stringify(ask.choices) === '["late","take"]' && ask.overrun === 14 * MIN + 9 * SEC,
            JSON.stringify(ask));

        const late = kept.swap({ lineup: base, index: i, item: special, choice: 'late', now: NOW });
        const ls = starts({ programs: late.programs, startTime: base.startTime });
        const lateNight = night({ programs: late.programs, startTime: base.startTime }, fri(0), fri(1, 31));
        suite.check('late: the rows after shift later, breaks shorter, until one starts on time',
            JSON.stringify(lateNight) === JSON.stringify([ "00:00:00 'Twas the Fight Before Christmas", '00:44:09 Family Guy 1',
                '01:06:39 Robot Chicken 1', '01:18:14 Robot Chicken 2', '01:30:00 Aqua Teen Hunger Force 1' ])
                && ls[ls.length - 1] === before[before.length - 1],
            JSON.stringify(lateNight));
        suite.check('...each row it shifted kept in time by the swap',
            [ 'Family Guy 1', 'Robot Chicken 1', 'Robot Chicken 2' ].every( (t) => {
                let p = late.programs.find( (x) => x.title === t );
                return kept.keptKind(p) === 'shifted' && p.kept.edits[0].id === late.programs[i].kept.edits[0].id;
            } ) && ! late.programs.find( (x) => x.title === 'Aqua Teen Hunger Force 1' ).kept, '');
        suite.check('...and says so',
            late.text === "'Twas the Fight Before Christmas replaces Futurama 1 at 12:00am. Runs 14:09 long: Family Guy starts 12:44:09am, back on time at 1:30am.",
            late.text);

        const take = kept.swap({ lineup: base, index: i, item: special, choice: 'take', now: NOW });
        const takeNight = night({ programs: take.programs, startTime: base.startTime }, fri(0), fri(1, 1));
        suite.check('take: the next row is gone, its time the swap\'s, Flex to the next row',
            JSON.stringify(takeNight) === JSON.stringify([ "00:00:00 'Twas the Fight Before Christmas", '01:00:00 Robot Chicken 1' ])
                && take.programs[i + 1].isOffline && take.programs[i + 1].duration === 15 * MIN + 51 * SEC
                && take.taken.length === 1 && take.taken[0].title === 'Family Guy 1',
            JSON.stringify(takeNight));
        suite.check('...and says so',
            take.text === "'Twas the Fight Before Christmas replaces Futurama 1 at 12:00am and takes Family Guy's 12:30am.", take.text);

        const onAir = indexAt(base, new Date('2026-10-29T05:00:00').getTime());
        const refused = kept.swap({ lineup: base, index: onAir, item: special, now: NOW });
        suite.check('the airing on air is refused, in plain words',
            ! refused.programs && /is on air now/.test(refused.refused), refused.refused);
    }

    suite.log('-- insert and remove --');
    {
        const i = indexAt(base, fri(0));
        const clip = { type: 'movie', title: 'The Night Before Christmas (1933)', duration: 5 * MIN, serverKey: 'srv', key: '/m/1' };
        const ins = kept.insertAfter({ lineup: base, index: i, item: clip, now: NOW });
        suite.check('insert into a break it fits: item, then what is left of the Flex, next row on time',
            ins.programs[i + 1].title === clip.title && kept.keptKind(ins.programs[i + 1]) === 'insert'
                && ins.programs[i + 2].duration === 2 * MIN + 30 * SEC
                && starts({ programs: ins.programs, startTime: base.startTime })[i + 3] === fri(0, 30),
            ins.text);
        suite.check('...and says so',
            ins.text === 'The Night Before Christmas (1933) goes in after Futurama 1 at 12:22:30am; Family Guy stays at 12:30am.', ins.text);

        const long = Object.assign({}, clip, { duration: 7 * MIN + 41 * SEC });
        const over = kept.insertAfter({ lineup: base, index: i, item: long, now: NOW });
        suite.check('insert 11 s too long: the next row starts 11 s late and its break absorbs it',
            JSON.stringify(night({ programs: over.programs, startTime: base.startTime }, fri(0), fri(1, 1))) === JSON.stringify([ '00:00:00 Futurama 1', '00:22:30 The Night Before Christmas (1933)',
                '00:30:11 Family Guy 1', '01:00:00 Robot Chicken 1' ])
                && over.text === 'The Night Before Christmas (1933) goes in after Futurama 1 at 12:22:30am. Runs 0:11 long: Family Guy starts 12:30:11am, back on time at 1:00am.',
            over.text);
        const back = kept.putBack({ lineup: { programs: over.programs, startTime: base.startTime }, index: i + 1, now: NOW });
        suite.check('Put back on the insert: the list exactly as before, marks and all',
            JSON.stringify(back.programs) === JSON.stringify(base.programs), back.text);

        const j = indexAt(base, fri(0, 30));
        const rem = kept.removeOnly({ lineup: base, index: j, now: NOW });
        suite.check('remove this airing only: kept Flex of its length, every row where it was',
            rem.programs[j].isOffline && rem.programs[j].duration === 22 * MIN + 30 * SEC && kept.keptKind(rem.programs[j]) === 'remove'
                && rem.programs[j].kept.edits[0].was === 'Family Guy S01E01 Family Guy 1'
                && JSON.stringify(starts({ programs: rem.programs, startTime: base.startTime })) === JSON.stringify(starts(base)),
            rem.text);
        suite.check('...and says so', rem.text === 'Leaves 22:30 of Flex at 12:30am in place of Family Guy 1.', rem.text);

        // Channel 2, Oct 29 proof: a long insert just before a removal's Flex.
        const r2 = { programs: rem.programs, startTime: base.startTime };
        const longer = Object.assign({}, clip, { duration: 22 * MIN });
        const before = kept.insertAfter({ lineup: r2, index: i, item: longer, now: NOW });
        suite.check('a run-late whose first row is a removal\'s Flex names the first program that runs late',
            before.text === 'The Night Before Christmas (1933) goes in after Futurama 1 at 12:22:30am. Runs 14:30 long: Robot Chicken starts 1:07am, back on time at 2:00am.',
            before.text);
    }

    suite.log('-- drag --');
    {
        const from = indexAt(base, fri(3, 30));
        const to = indexAt(base, fri(0));
        const m = kept.move({ lineup: base, from, to, now: NOW });
        const l = { programs: m.programs, startTime: base.startTime };
        suite.check('earlier: the row where it is dropped, the rows between later by its half hour, back on time where it came from',
            JSON.stringify(night(l, fri(0), fri(4, 1))) === JSON.stringify([ '00:00:00 The Venture Bros. 1', '00:30:00 Futurama 1', '01:00:00 Family Guy 1',
                '01:30:00 Robot Chicken 1', '01:45:00 Robot Chicken 2', '02:00:00 Aqua Teen Hunger Force 1', '02:30:00 Space Ghost Coast to Coast 1',
                '03:00:00 Sealab 2021 1', '03:30:00 Home Movies 1', '04:00:00 Harvey Birdman, Attorney at Law 1' ]),
            JSON.stringify(night(l, fri(0), fri(4, 1))));
        const v = m.programs.find( (p) => p.title === 'The Venture Bros. 1' );
        suite.check('...the dragged row kept as it is, from 3:30; the rows between kept in time; Harvey Birdman not',
            kept.keptKind(v) === 'moved' && v.kept.edits[0].from === fri(3, 30) && v.slotPosition === 'next|'
                && m.programs.filter( (p) => kept.keptKind(p) === 'shifted' ).length === 8
                && ! m.programs.find( (p) => p.title === 'Harvey Birdman, Attorney at Law 1' ).kept, '');
        suite.check('...and says so',
            m.text === 'The Venture Bros. 1 moves to Fri Oct 30, 12:00am; 8 airings shift 30 minutes later, back on time at 4:00am.', m.text);

        const later = kept.move({ lineup: base, from: to, to: indexAt(base, fri(4)), now: NOW });
        suite.check('later: the mirror - rows between earlier, the row just before where it was dropped',
            JSON.stringify(night({ programs: later.programs, startTime: base.startTime }, fri(0), fri(4, 1)).slice(-3))
                === JSON.stringify([ '03:00:00 The Venture Bros. 1', '03:30:00 Futurama 1', '04:00:00 Harvey Birdman, Attorney at Law 1' ])
                && later.text === 'Futurama 1 moves to Fri Oct 30, 3:30am; 8 airings shift 30 minutes earlier, back on time at 4:00am.',
            later.text);

        suite.check('onto its own row, or the row after it: nothing',
            kept.move({ lineup: base, from, to: from, now: NOW }).programs === undefined
                && kept.move({ lineup: base, from, to: from + 2, now: NOW }).programs === undefined, '');

        const back = kept.putBack({ lineup: l, index: m.programs.indexOf(v), now: NOW });
        suite.check('Put back on the dragged row: the list exactly as before',
            JSON.stringify(back.programs) === JSON.stringify(base.programs)
                && back.text === 'The Venture Bros. 1 goes back to Fri Oct 30, 3:30am.', back.text);

        // Another edit after the drag, elsewhere the same night, survives Put back.
        const h = indexAt(l, fri(4));
        const clip = { type: 'movie', title: 'Clip', duration: 2 * MIN, serverKey: 'srv', key: '/c' };
        const both = kept.insertAfter({ lineup: l, index: h, item: clip, now: NOW + 1 });
        const undone = kept.putBack({ lineup: { programs: both.programs, startTime: base.startTime },
            index: both.programs.findIndex( (p) => p.title === 'The Venture Bros. 1' ), now: NOW + 2 });
        const u = { programs: undone.programs, startTime: base.startTime };
        suite.check('Put back on the drag after a later insert: the drag undone, the insert where it was',
            JSON.stringify(night(u, fri(0), fri(4, 30))).includes('"04:22:30 Clip"')
                && night(u, fri(3, 30), fri(3, 31))[0] === '03:30:00 The Venture Bros. 1'
                && kept.keptKind(u.programs.find( (p) => p.title === 'Clip' )) === 'insert'
                && ! u.programs.some( (p) => kept.keptKind(p) === 'shifted' || kept.keptKind(p) === 'moved' ),
            JSON.stringify(night(u, fri(3, 30), fri(4, 30))));

        // Sun Nov 1, 2026: 1:00-2:00am happens twice. Starts are instants, so a drag
        // across it lands each row exactly.
        const sunTwoAm = new Date('2026-11-01T02:00:00').getTime();
        const firstOne = new Date('2026-11-01T01:00:00').getTime(); // the first 1:00am, CDT
        const fromSun = indexAt(base, sunTwoAm);
        const toSun = indexAt(base, firstOne);
        const ss = starts(base);
        const dst = kept.move({ lineup: base, from: fromSun, to: toSun, now: NOW });
        const ds = starts({ programs: dst.programs, startTime: base.startTime });
        suite.check('across the fall-back night: the row at the first 1:00am, each row between exactly half an hour later',
            ds[toSun] === firstOne && sunTwoAm - firstOne === 2 * HOUR
                && dst.programs[toSun].title === base.programs[fromSun].title
                && ds[toSun + 2] === ss[toSun] + 30 * MIN && ds[fromSun + 2] === ss[fromSun + 2], '');

        const far = kept.move({ lineup: base, from: indexAt(base, fri(3, 30) + 14 * DAY), to, now: NOW });
        suite.check('a drag across two weeks asks first',
            ! far.programs && far.ask === 'This shifts 682 airings over 14 days. Move it?', far.ask);
        const sure = kept.move({ lineup: base, from: indexAt(base, fri(3, 30) + 14 * DAY), to, now: NOW, sure: true });
        suite.check('...and goes ahead when asked again with sure', Array.isArray(sure.programs), '');

        const onAir = indexAt(base, new Date('2026-10-29T05:00:00').getTime());
        suite.check('a drop before the airing on air is refused',
            /on air/.test(kept.move({ lineup: base, from, to: onAir, now: NOW }).refused || ''),
            kept.move({ lineup: base, from, to: onAir, now: NOW }).refused);
        suite.check('...and so is dragging the airing on air',
            /on air/.test(kept.move({ lineup: base, from: onAir, to, now: NOW }).refused || ''), '');

        const untouched = kept.putBack({ lineup: base, index: indexAt(base, fri(1)), now: NOW });
        suite.check('Put back on an airing nobody edited says so',
            ! untouched.programs && untouched.refused === 'Nothing to put back: Robot Chicken 1 is as Create Lineup made it.', untouched.refused);
        const shiftedOnly = kept.putBack({ lineup: l, index: indexAt(l, fri(1)), now: NOW });
        suite.check('...and on a row that only moved with the rows around it, which drag moved it',
            ! shiftedOnly.programs && shiftedOnly.refused === 'Family Guy 1 only moved with the rows around it. Put back The Venture Bros. 1 to move it back.',
            shiftedOnly.refused);
    }

    suite.check('nothing above changed the list it was given', JSON.stringify(base.programs) === JSON.stringify(lineup().programs), '');
    return suite;
};
