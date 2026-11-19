/*
 * The midroll layout (docs/blocks-spec.md, Stage 6, "Keeping the schedule on time"; build
 * order 5f), pure: where each part of a program, each midroll and the end break sit, worked
 * out from the Flex after the program alone, so every row of the lineup starts exactly when it
 * does with midrolls off; the program on air keeping its layout; and a midroll's steps through
 * the stage 5 planner, keyed on the show on air.
 */
const { Suite } = require('./support');
const midrolls = require('../src/midroll-plan');
const transitions = require('../src/transitions');
const channelCache = require('../src/channel-cache');

const SEC = 1000;
const MIN = 60 * SEC;
const ms = (m, s = 0) => (m * MIN) + (s * SEC);

function episode(show, title, length, extra = {}) {
    return Object.assign( { type: 'episode', showTitle: show, title, key: `${show}|${title}`, file: `D:/${show}/${title}.mkv`, duration: length }, extra );
}
const flex = (length) => ({ isOffline: true, duration: length });
const point = (atS, kind = 'act', strength = 0.8, by = 'auto') => ({ at: atS, kind, strength, by });
const allWeek = (extra = {}) => Object.assign( { name: 'D', starts: [ { days: [0, 1, 2, 3, 4, 5, 6], time: 0 } ] }, extra );

// The stand-ins for the store and the lists: `files` maps a program's file to its points.
function envWith(files, extra = {}) {
    return Object.assign( {
        on: true,
        pointsFor: (program) => {
            const f = files[program.file];
            if (f == null) {
                return null;
            }
            return { durationMs: (f.durationMs != null) ? f.durationMs : program.duration, points: f.points.map( (p, index) => Object.assign( { index }, p ) ) };
        },
        getList: (id) => ( (extra.lists != null) && Array.isArray(extra.lists[id]) ) ? extra.lists[id] : null,
        cardMs: (id) => ( (extra.cards != null) && (typeof(extra.cards[id]) === 'number') ) ? extra.cards[id] : null,
    }, extra.env || {} );
}

// A lineup's row starts, from channel.startTime: what the lineup says, midrolls or none.
function rowStarts(channel) {
    let at = new Date(channel.startTime).getTime();
    return channel.programs.map( (p) => {
        const s = at;
        at += p.duration;
        return s;
    } );
}

// Every piece of a layout end to end, and where it ends: the next row's start.
function contiguous(layout) {
    const pieces = [];
    layout.parts.forEach( (part, k) => {
        pieces.push( { start: part.start, length: part.toMs - part.fromMs } );
        if (k < layout.midrolls.length) {
            pieces.push( { start: layout.midrolls[k].start, length: layout.midrolls[k].lengthMs } );
        }
    } );
    pieces.push( { start: layout.endBreak.start, length: layout.endBreak.lengthMs } );
    let at = layout.start;
    for (const p of pieces) {
        if (p.start !== at) {
            return false;
        }
        at += p.length;
    }
    return at === layout.end;
}

const clock = (t) => {
    const d = new Date(t);
    const h = d.getHours() % 12 || 12;
    return `${h}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
};
const mmss = (len) => `${Math.floor(len / MIN)}:${String(Math.round( (len % MIN) / SEC )).padStart(2, '0')}`;

module.exports = async () => {
    const suite = new Suite('the midroll layout (5f)');

    // ---- the spec's Family Guy table -----------------------------------------------------------
    {
        const start = new Date(2026, 10, 20, 0, 30, 0).getTime();
        const fg = episode('Family Guy', 'Death Is a Bitch', ms(22, 37));
        const rc = episode('Robot Chicken', 'Ep', ms(11, 0));
        const channel = { number: 1, startTime: new Date(start).toISOString(), programs: [ fg, flex(ms(7, 23)), rc, flex(ms(4, 0)) ],
            dayParts: [ allWeek( { midrolls: { count: 2 } } ) ] };
        const layout = midrolls.midrollLayout(channel, 0, start, envWith( { [fg.file]: { points: [ point(5 * 60 + 28), point(15 * 60 + 48) ] } } ));
        const rows = (layout === null) ? [] : [
            `${clock(layout.parts[0].start)} part 1 ${mmss(layout.parts[0].fromMs)}-${mmss(layout.parts[0].toMs)}`,
            `${clock(layout.midrolls[0].start)} midroll ${mmss(layout.midrolls[0].lengthMs)}`,
            `${clock(layout.parts[1].start)} part 2 ${mmss(layout.parts[1].fromMs)}-${mmss(layout.parts[1].toMs)}`,
            `${clock(layout.midrolls[1].start)} midroll ${mmss(layout.midrolls[1].lengthMs)}`,
            `${clock(layout.parts[2].start)} part 3 ${mmss(layout.parts[2].fromMs)}-${mmss(layout.parts[2].toMs)}`,
            `${clock(layout.endBreak.start)} end break ${mmss(layout.endBreak.lengthMs)}`,
            `${clock(layout.end)} Robot Chicken`,
        ];
        const table = [
            '12:30:00 part 1 0:00-5:28',
            '12:35:28 midroll 2:28',
            '12:37:56 part 2 5:28-15:48',
            '12:48:16 midroll 2:28',
            '12:50:44 part 3 15:48-22:37',
            '12:57:33 end break 2:27',
            '1:00:00 Robot Chicken',
        ];
        suite.check('the Family Guy table: two midrolls of 2:28, the end break 2:27, Robot Chicken on time at 1:00',
            JSON.stringify(rows) === JSON.stringify(table), rows.join(' | '));
        suite.check('...and Robot Chicken\'s start is the lineup\'s', (layout !== null) && (layout.end === rowStarts(channel)[2]));
        suite.check('...each midroll says which point it is and who approved it',
            (layout !== null) && (layout.midrolls[0].atMs === ms(5, 28)) && (layout.midrolls[0].by === 'auto') && (layout.midrolls[1].kind === 'act'));
    }

    // ---- shares, one fewer, none ----------------------------------------------------------------
    const half = (flexMs, pts, extra = {}) => {
        const ep = episode('Show', 'Ep', ms(22, 30));
        const start = Date.UTC(2026, 10, 16, 18, 0);
        const channel = Object.assign( { number: 2, startTime: new Date(start).toISOString(),
            programs: (flexMs > 0) ? [ ep, flex(flexMs), episode('Next', 'N', ms(30)) ] : [ ep, episode('Next', 'N', ms(30)) ] }, extra.channel || {} );
        const env = envWith( { [ep.file]: { points: pts, durationMs: extra.durationMs } }, extra );
        return { channel, start, layout: midrolls.midrollLayout(channel, 0, start, env) };
    };
    const three = [ point(6 * 60), point(11 * 60), point(16 * 60) ];
    {
        const { layout } = half(ms(7, 30), three.slice(0, 2));
        suite.check('7:30 of Flex and two points: two midrolls of 2:30 and an end break of 2:30',
            (layout.midrolls.length === 2) && layout.midrolls.every( (m) => m.lengthMs === ms(2, 30) ) && (layout.endBreak.lengthMs === ms(2, 30)),
            JSON.stringify(layout.midrolls.map( (m) => m.lengthMs )) + ' end ' + layout.endBreak.lengthMs);
    }
    {
        const { layout } = half(ms(4, 0), three.slice(0, 2));
        suite.check('4:00 of Flex: shares of 1:20 are under 90 s, so one midroll of 2:00',
            (layout.midrolls.length === 1) && (layout.midrolls[0].lengthMs === ms(2, 0)) && (layout.endBreak.lengthMs === ms(2, 0)), JSON.stringify(layout.midrolls));
    }
    {
        const { layout } = half(ms(4, 30), three);
        suite.check('4:30 of Flex and three points: two midrolls of 1:30 (exactly minMs), not three',
            (layout.midrolls.length === 2) && (layout.midrolls[0].lengthMs === ms(1, 30)), JSON.stringify(layout.midrolls));
    }
    {
        const { layout } = half(60 * SEC, three);
        suite.check('a break cut to 60 s before a kept row: none, and the end break keeps the whole 60 s',
            (layout.midrolls.length === 0) && (layout.endBreak.lengthMs === 60 * SEC) && (layout.parts.length === 1));
    }
    {
        const { layout } = half(0, three);
        suite.check('no Flex after it (a split a half aired back to back): none, nothing moves',
            (layout.midrolls.length === 0) && (layout.endBreak.lengthMs === 0) && (layout.end === layout.start + ms(22, 30)));
    }
    {
        const { layout } = half(ms(7, 30), []);
        suite.check('no airable points: none, and the end break is the whole Flex, as today', (layout.midrolls.length === 0) && (layout.endBreak.lengthMs === ms(7, 30)));
    }
    {
        const { layout } = half(ms(25, 0), three.slice(0, 2));
        suite.check('25 min of Flex: each midroll is capped at 4:00 and the rest stays in the end break',
            (layout.midrolls.length === 2) && layout.midrolls.every( (m) => m.lengthMs === ms(4, 0) ) && (layout.endBreak.lengthMs === ms(17, 0)),
            JSON.stringify(layout.midrolls.map( (m) => m.lengthMs )) + ' end ' + layout.endBreak.lengthMs);
    }
    {
        const day = allWeek( { midrolls: { minMs: ms(5, 0) } } );
        const { layout } = half(ms(25, 0), three.slice(0, 2), { channel: { dayParts: [ day ] } });
        suite.check('...but never under minMs: with minMs 5:00 the cap is 5:00',
            (layout.midrolls.length === 2) && layout.midrolls.every( (m) => m.lengthMs === ms(5, 0) ), JSON.stringify(layout.midrolls.map( (m) => m.lengthMs )));
    }

    // ---- which points ----------------------------------------------------------------------------
    {
        const { layout } = half(ms(10, 0), [ point(119), point(22 * 60 + 30 - 119) ]);
        suite.check('a point under 2 minutes from either end is not used', layout.midrolls.length === 0);
        const edge = half(ms(10, 0), [ point(120) ]).layout;
        suite.check('...one exactly 2 minutes in is', (edge.midrolls.length === 1) && (edge.midrolls[0].atMs === ms(2, 0)));
    }
    {
        const { layout } = half(ms(10, 0), [ point(5 * 60), point(7 * 60 + 59) ]);
        suite.check('two points under 3 minutes apart: one midroll', layout.midrolls.length === 1, JSON.stringify(layout.midrolls));
        const apart = half(ms(10, 0), [ point(5 * 60), point(8 * 60) ]).layout;
        suite.check('...3 minutes apart: both', apart.midrolls.length === 2);
    }
    {
        const day = allWeek( { midrolls: { count: 1 } } );
        const { layout } = half(ms(10, 0), [ point(5 * 60), point(11 * 60), point(18 * 60) ], { channel: { dayParts: [ day ] } });
        suite.check('count 1 and three points: the one nearest the middle (11:15)', (layout.midrolls.length === 1) && (layout.midrolls[0].atMs === ms(11, 0)), JSON.stringify(layout.midrolls));
        const tie = half(ms(10, 0), [ point(10 * 60 + 15, 'act', 0.7), point(12 * 60 + 15, 'act', 0.9) ], { channel: { dayParts: [ day ] } }).layout;
        suite.check('...two as near as each other: the stronger', (tie.midrolls.length === 1) && (tie.midrolls[0].atMs === ms(12, 15)), JSON.stringify(tie.midrolls));
        const two = half(ms(10, 0), [ point(4 * 60), point(7 * 60 + 30), point(8 * 60), point(15 * 60), point(19 * 60) ], { channel: { dayParts: [ allWeek( { midrolls: { count: 2 } } ) ] } }).layout;
        suite.check('count 2: the pair nearest even spacing (7:30 and 15:00 for thirds at 7:30 and 15:00)',
            JSON.stringify(two.midrolls.map( (m) => m.atMs )) === JSON.stringify( [ ms(7, 30), ms(15, 0) ] ), JSON.stringify(two.midrolls.map( (m) => m.atMs )));
    }
    {
        const none = half(ms(10, 0), three, { channel: { dayParts: [ allWeek( { midrolls: { count: 0 } } ) ] } }).layout;
        suite.check('count 0 (none here): none', none.midrolls.length === 0);
        const nulls = half(ms(20, 0), three).layout;
        suite.check('count empty: every point the budget pays for (three)', nulls.midrolls.length === 3);
    }
    {
        const kinds = [ point(3 * 60, 'opening'), point(8 * 60, 'story'), point(14 * 60, 'act'), point(19 * 60, 'credits') ];
        const plain = half(ms(20, 0), kinds).layout;
        suite.check('by default: acts and stories, never the opening or credits',
            JSON.stringify(plain.midrolls.map( (m) => m.kind )) === JSON.stringify( [ 'story', 'act' ] ), JSON.stringify(plain.midrolls.map( (m) => m.kind )));
        const noStory = half(ms(20, 0), kinds, { channel: { dayParts: [ allWeek( { midrolls: { story: false, opening: true } } ) ] } }).layout;
        suite.check('story off and opening on: the opening and the act',
            JSON.stringify(noStory.midrolls.map( (m) => m.kind )) === JSON.stringify( [ 'opening', 'act' ] ), JSON.stringify(noStory.midrolls.map( (m) => m.kind )));
    }
    {
        const off = half(ms(10, 0), three, { durationMs: ms(22, 30) + 2500 }).layout;
        suite.check('a file scanned 2.5 s longer than the program (changed, not scanned again): none', off.midrolls.length === 0);
        const near = half(ms(10, 0), three, { durationMs: ms(22, 30) + 1500 }).layout;
        suite.check('...1.5 s off is the same file', near.midrolls.length > 0);
    }

    // ---- what the steps take: each at its longest clip ------------------------------------------
    {
        const lists = { short: [ { title: 'a', duration: 5 * SEC }, { title: 'b', duration: 12 * SEC } ], long: [ { title: 'c', duration: 30 * SEC } ] };
        const steps = [
            { context: 'X', situation: 'betweenShows', side: 'out', step: { id: 'w', kind: 'list', listId: 'short', fallbackListId: 'long' } },
            { context: 'X', situation: 'betweenShows', side: 'in', step: { id: 'b', kind: 'list', listId: 'short' } },
        ];
        suite.check('a list step counts at its longest clip, its fallback list included (30 s + 12 s)',
            midrolls.stepsMs(steps, envWith( {}, { lists } )) === 42 * SEC, String(midrolls.stepsMs(steps, envWith( {}, { lists } ))));
        const watched = steps.concat( [ { context: 'X', situation: 'betweenShows', side: 'out', step: { id: 'g', kind: 'list', listId: 'long', onlyIfNoMatch: 'w' } } ] );
        suite.check('a step that plays only if another found nothing counts once with it, the longer of the two',
            midrolls.stepsMs(watched, envWith( {}, { lists } )) === 42 * SEC, String(midrolls.stepsMs(watched, envWith( {}, { lists } ))));
        const cascade = steps.concat( [
            { context: 'X', situation: 'betweenShows', side: 'in', step: { id: 'c1', kind: 'list', listId: 'long', onlyIfNothingAbove: true } },
            { context: 'X', situation: 'betweenShows', side: 'in', step: { id: 'c2', kind: 'list', listId: 'short', onlyIfNothingAbove: true } },
        ] );
        suite.check('cascade steps on one side count as the longest of them', midrolls.stepsMs(cascade, envWith( {}, { lists } )) === 72 * SEC, String(midrolls.stepsMs(cascade, envWith( {}, { lists } ))));
        const card = [ { context: 'X', situation: 'leaving', side: 'out', step: { id: 'n', kind: 'generated', templateId: 'T' } } ];
        suite.check('a card step counts at its template\'s length, whole seconds up', midrolls.stepsMs(card, envWith( {}, { cards: { T: 14200 } } )) === 15 * SEC);
    }
    {
        // the end break's own steps come off the budget first; a midroll's steps must fit its share
        const lists = { bump: [ { title: 'b', duration: 30 * SEC } ] };
        const day = allWeek( { transitions: { betweenShows: { out: [ { id: 'o', kind: 'list', listId: 'bump' } ], in: [] } } } );
        const { layout } = half(ms(7, 30), three.slice(0, 2), { lists, channel: { dayParts: [ day ] } });
        suite.check('7:30 of Flex less a 30 s end-break step: shares of 2:20, the end break 2:50 with its step',
            (layout.midrolls.length === 2) && (layout.midrolls[0].lengthMs === ms(2, 20)) && (layout.endBreak.lengthMs === ms(2, 50)) && (layout.endReserveMs === 30 * SEC),
            JSON.stringify(layout.midrolls.map( (m) => m.lengthMs )) + ' end ' + layout.endBreak.lengthMs);
        const heavy = allWeek( { transitions: { midroll: { out: [ { id: 'w', kind: 'list', listId: 'long' } ], in: [] } } } );
        const tooLong = half(ms(7, 30), three.slice(0, 2), { lists: { long: [ { title: 'w', duration: ms(2, 40) } ] }, channel: { dayParts: [ heavy ] } }).layout;
        suite.check('a midroll whose own steps could run 2:40 does not fit a 2:30 share: one midroll of 3:45',
            (tooLong.midrolls.length === 1) && (tooLong.midrolls[0].lengthMs === ms(3, 45)), JSON.stringify(tooLong.midrolls.map( (m) => m.lengthMs )));
    }

    // ---- the cases ------------------------------------------------------------------------------
    {
        const { channel, start } = half(ms(7, 30), three);
        const ep = channel.programs[0];
        const files = { [ep.file]: { points: three } };
        suite.check('the Midrolls switch off: no layout at all', midrolls.midrollLayout(channel, 0, start, envWith(files, { env: { on: false } })) === null);
        const onDemand = Object.assign( {}, channel, { onDemand: { isOnDemand: true } } );
        suite.check('an on-demand channel: no layout', midrolls.midrollLayout(onDemand, 0, start, envWith(files)) === null);
        suite.check('a Flex entry has no layout', midrolls.midrollLayout(channel, 1, start + ep.duration, envWith(files)) === null);
        suite.check('a file never scanned: none', midrolls.midrollLayout(channel, 0, start, envWith( {} )).midrolls.length === 0);
        const redirect = Object.assign( {}, channel, { programs: [ ep, { isOffline: true, type: 'redirect', channel: 3, duration: ms(7, 30) }, channel.programs[2] ] } );
        suite.check('a redirect after it: none', midrolls.midrollLayout(redirect, 0, start, envWith(files)).midrolls.length === 0);
        const twoFlex = Object.assign( {}, channel, { programs: [ ep, flex(ms(3, 0)), flex(ms(4, 30)), channel.programs[2] ] } );
        const run = midrolls.midrollLayout(twoFlex, 0, start, envWith(files));
        suite.check('a break the generator left as two Flex entries is one budget (7:30: three midrolls of 1:53, 1:51 left)',
            (run.flexMs === ms(7, 30)) && (run.midrolls.length === 3) && (run.midrolls[0].lengthMs === ms(1, 53)) && (run.endBreak.lengthMs === ms(1, 51)) && (run.end === start + ms(30, 0)),
            JSON.stringify(run.midrolls.map( (m) => m.lengthMs )) + ' end ' + run.endBreak.lengthMs);
    }
    {
        // split halves: a then b back to back, then Flex; each half has its own file and points
        const a = episode('Weekenders', 'S03E11a', ms(11, 33));
        const b = episode('Weekenders', 'S03E11b', ms(10, 49));
        const start = Date.UTC(2026, 10, 7, 7, 35);
        const channel = { number: 3, startTime: new Date(start).toISOString(), programs: [ a, b, flex(ms(7, 38)), episode('Next', 'N', ms(30)) ] };
        const env = envWith( { [a.file]: { points: [ point(5 * 60) ] }, [b.file]: { points: [ point(5 * 60) ] } } );
        const la = midrolls.midrollLayout(channel, 0, start, env);
        const lb = midrolls.midrollLayout(channel, 1, start + a.duration, env);
        suite.check('split halves back to back: the a half has none, so the b half starts with the lineup',
            (la.midrolls.length === 0) && (la.end === start + a.duration));
        suite.check('...the b half borrows from its own Flex, and the show after it is on time',
            (lb.midrolls.length === 1) && (lb.end === rowStarts(channel)[3]));
    }
    {
        // a special day's block decides the setting for the programs inside it
        const start = new Date(2026, 11, 24, 18, 0).getTime();
        const ep = episode('Show', 'Ep', ms(22, 30));
        const channel = { number: 4, startTime: new Date(start).toISOString(), programs: [ ep, flex(ms(7, 30)), episode('Next', 'N', ms(30)) ],
            dayParts: [ allWeek() ], blocks: [ { id: 'xmas', name: 'Christmas Eve', airings: [], midrolls: { count: 0 } } ],
            scheduleBackup: { specialDays: [ { id: 's', name: 'Christmas Eve', blockId: 'xmas', from: { date: '2026-12-24', time: 6 * 60 * MIN }, to: { date: '2026-12-25', time: 6 * 60 * MIN } } ] } };
        const env = envWith( { [ep.file]: { points: three } } );
        const onTheDay = midrolls.midrollLayout(channel, 0, start, env);
        suite.check('a special day whose block says count 0: none on the day', onTheDay.midrolls.length === 0, JSON.stringify(onTheDay.midrolls));
        const dayBefore = midrolls.midrollLayout(channel, 0, start - 24 * 60 * MIN, env);
        suite.check('...the day before, the day-part\'s default: midrolls', dayBefore.midrolls.length > 0);
    }
    {
        // every row of a lineup starts where it did: each layout ends at the next row's start
        const start = Date.UTC(2026, 10, 16, 12, 0);
        const shows = [ 'A', 'B', 'C', 'D' ];
        const programs = [];
        const files = {};
        let seed = 7;
        const rand = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        for (let i = 0; i < 40; i++) {
            const ep = episode(shows[i % 4], `E${i}`, ms(10 + Math.floor(rand() * 15), Math.floor(rand() * 60)));
            programs.push(ep);
            const pts = [];
            for (let t = 60; t < ep.duration / SEC; t += 60 + Math.floor(rand() * 400)) {
                pts.push(point(t, (rand() < 0.2) ? 'story' : 'act', rand()));
            }
            files[ep.file] = { points: pts };
            if (rand() < 0.8) {
                programs.push(flex(Math.floor(rand() * ms(12, 0))));
            }
        }
        const channel = { number: 5, startTime: new Date(start).toISOString(), programs };
        const starts = rowStarts(channel);
        const env = envWith(files);
        let ok = 0;
        let tight = 0;
        let some = 0;
        const bad = [];
        for (let i = 0; i < programs.length; i++) {
            if (programs[i].isOffline === true) {
                continue;
            }
            const layout = midrolls.midrollLayout(channel, i, starts[i], env);
            const nextRow = (i + 1 < programs.length) ? starts[i + 1] : starts[i] + programs[i].duration;
            let flexEnd = nextRow;
            for (let j = i + 1; (j < programs.length) && (programs[j].isOffline === true); j++) {
                flexEnd = starts[j] + programs[j].duration;
            }
            const same = midrolls.midrollLayout(channel, i, starts[i], env);
            if ( contiguous(layout) && (layout.end === flexEnd) && (JSON.stringify(layout) === JSON.stringify(same))
                && layout.midrolls.every( (m) => (m.lengthMs >= 90 * SEC) && (m.lengthMs % SEC === 0) )
                && ( (layout.midrolls.length === 0) || (layout.endBreak.lengthMs - layout.endReserveMs >= 90 * SEC) ) ) {
                ok++;
            } else {
                bad.push(i);
            }
            tight += (layout.flexMs < 90 * SEC) ? 1 : 0;
            some += (layout.midrolls.length > 0) ? 1 : 0;
        }
        suite.check(`40 programs of random lengths, points and Flex: every layout end to end, ending where the next row starts, worked out twice the same (${some} with midrolls, ${tight} with under 90 s of Flex)`,
            (bad.length === 0) && (some > 5), `bad at ${bad.join(',')}`);
    }

    // ---- where the clock is ----------------------------------------------------------------------
    {
        const { layout } = half(ms(7, 30), three.slice(0, 2));
        const s = layout.start;
        const at = (t) => JSON.stringify(midrolls.whereAt(layout, t));
        suite.check('whereAt: in part 1, three minutes in', at(s + ms(3, 0)) === JSON.stringify( { phase: 'part', k: 0, fileMs: ms(3, 0) } ), at(s + ms(3, 0)));
        suite.check('...in the first midroll', at(s + ms(7, 0)) === JSON.stringify( { phase: 'midroll', k: 0, intoMs: ms(1, 0) } ), at(s + ms(7, 0)));
        suite.check('...in the last part, though the lineup\'s clock is already in the Flex entry',
            at(s + ms(22, 40)) === JSON.stringify( { phase: 'part', k: 2, fileMs: ms(17, 40) } ), at(s + ms(22, 40)));
        suite.check('...in the end break', at(layout.end - 10 * SEC) === JSON.stringify( { phase: 'end', intoMs: ms(2, 20) } ), at(layout.end - 10 * SEC));
        suite.check('...and nowhere outside it', (midrolls.whereAt(layout, layout.end) === null) && (midrolls.whereAt(layout, s - 1) === null));
    }

    // ---- the program on air keeps its layout -------------------------------------------------------
    {
        const ep = episode('Show', 'Ep', ms(22, 30));
        const start = Date.UTC(2026, 10, 16, 18, 0);
        const channel = { number: 6, startTime: new Date(start).toISOString(), programs: [ ep, flex(ms(7, 30)), episode('Next', 'N', ms(30)) ] };
        const nextStart = rowStarts(channel)[2];
        const files = { [ep.file]: { points: [ point(8 * 60) ] } };
        const frozen = {
            held: new Map(),
            get(number, index, s) {
                return this.held.has(`${number}|${index}|${s}`) ? this.held.get(`${number}|${index}|${s}`) : null;
            },
            set(number, index, s, held) {
                this.held.set(`${number}|${index}|${s}`, held);
            },
        };
        const env = envWith(files, { env: { frozen } });
        const before = midrolls.layoutAt(channel, 0, start, env, start - MIN);
        files[ep.file].points.push(point(15 * 60));
        const ahead = midrolls.layoutAt(channel, 0, start, env, start - MIN);
        suite.check('before the program starts, a new approval changes its layout', (before.midrolls.length === 1) && (ahead.midrolls.length === 2));
        files[ep.file].points.pop();
        const onAir = midrolls.layoutAt(channel, 0, start, env, start + MIN);
        files[ep.file].points.push(point(15 * 60));
        const after = midrolls.layoutAt(channel, 0, start, env, start + ms(5, 0));
        suite.check('once it is on, it keeps the layout it was first asked for: an approval waits for the next airing',
            (onAir.midrolls.length === 1) && (after.midrolls.length === 1));
        const switchedOff = midrolls.layoutAt(channel, 0, start, Object.assign( {}, env, { on: false } ), start + ms(6, 0));
        suite.check('the switch turned off during it: it finishes its midrolls', (switchedOff !== null) && (switchedOff.midrolls.length === 1));
        const nextTime = midrolls.layoutAt(channel, 0, start + ms(60, 0), Object.assign( {}, env, { on: false } ), start + ms(31, 0));
        suite.check('...and the next airing has none', nextTime === null);

        // a restart during the airing: the frozen layouts were in memory only (accepted, Nov 19)
        frozen.held.clear();
        const restarted = midrolls.layoutAt(channel, 0, start, env, start + ms(7, 0));
        suite.check('a restart during the airing picks up the new layout (two midrolls) ...', restarted.midrolls.length === 2);
        suite.check('...and still never moves a start: both layouts end where the next program starts, end to end',
            (after.end === nextStart) && (restarted.end === nextStart) && contiguous(after) && contiguous(restarted)
            && (restarted.parts[0].start === start) && JSON.stringify(rowStarts(channel)) === JSON.stringify( [ start, start + ep.duration, nextStart ] ));

        // a save that changes the Flex after it: the frozen layout no longer fits and is not used
        frozen.held.clear();
        delete files[ep.file].points[1];
        files[ep.file].points.length = 1;
        midrolls.layoutAt(channel, 0, start, env, start + MIN);
        const saved = Object.assign( {}, channel, { programs: [ ep, flex(ms(3, 0)), episode('Next', 'N', ms(30)) ] } );
        const fits = midrolls.layoutAt(saved, 0, start, env, start + ms(2, 0));
        suite.check('a save that shortens the Flex after it: the frozen layout is dropped, the next program keeps the new lineup\'s start',
            fits.end === start + ep.duration + ms(3, 0), `${fits.end - start}`);
    }
    {
        // the channel cache's frozen layouts: not dropped by a save or a cache clear, gone on restart
        channelCache.forgetFrozenLayouts();
        channelCache.freezeLayout(7, 0, 1000, { layout: null, fingerprint: 'x|1', end: 5000 }, 2000);
        channelCache.clear();
        const kept = channelCache.getFrozenLayout(7, 0, 1000);
        channelCache.forgetFrozenLayouts();
        suite.check('the channel cache keeps a frozen layout through a cache clear (a save), and forgets it on a restart',
            (kept !== null) && (channelCache.getFrozenLayout(7, 0, 1000) === null));
    }

    // ---- a midroll's steps: the stage 5 planner keyed on the show on air ---------------------------
    {
        const start = new Date(2026, 10, 20, 0, 30, 0).getTime();
        const fg = episode('Family Guy', 'Death Is a Bitch', ms(22, 37));
        const rc = episode('Robot Chicken', 'Ep', ms(11, 0));
        const day = allWeek( { transitions: { midroll: {
            out: [ { id: 'wbrb', kind: 'list', listId: 'wbrb', match: 'show', keyedOn: 'now' } ],
            in: [ { id: 'btts', kind: 'list', listId: 'btts', match: 'show', keyedOn: 'next' }, { id: 'nt', kind: 'generated', templateId: 'T', keyedOn: 'later' } ],
        } } } );
        const channel = { number: 1, startTime: new Date(start).toISOString(), programs: [ fg, flex(ms(7, 23)), rc, flex(ms(4, 0)) ], dayParts: [ day ] };
        const lists = {
            wbrb: [ { title: 'RC WBRB', duration: 4 * SEC, names: [ 'tv.Robot Chicken' ] }, { title: 'FG WBRB', duration: 5 * SEC, names: [ 'tv.Family Guy' ] } ],
            btts: [ { title: 'RC BTTS', duration: 4 * SEC, names: [ 'tv.Robot Chicken' ] }, { title: 'FG BTTS', duration: 6 * SEC, names: [ 'tv.Family Guy' ] } ],
        };
        const wanted = [];
        const env = envWith( { [fg.file]: { points: [ point(5 * 60 + 28), point(15 * 60 + 48) ] } }, { lists, cards: { T: 10 * SEC },
            env: { card: (want) => {
                wanted.push(want);
                return null;
            } } } );
        const layout = midrolls.midrollLayout(channel, 0, start, env);
        suite.check('the midroll\'s own steps (5 s + 6 s + a 10 s card, each at its longest) fit its share', (layout.midrolls.length === 2) && (layout.midrollReserveMs === 21 * SEC), String(layout.midrollReserveMs));
        const plan = midrolls.buildMidrollPlan(channel, layout, 0, env);
        suite.check('a midroll is the Midroll situation', plan.situation === 'midroll');
        suite.check('...its WBRB keyed on now names the show on air (Family Guy\'s)', (plan.out.length === 1) && (plan.out[0].clip.title === 'FG WBRB'), JSON.stringify(plan.out.map( (s) => s.clip.title )));
        suite.check('...and its BTTS keyed on next names the same show coming back', (plan.in.length >= 1) && (plan.in[0].clip.title === 'FG BTTS'), JSON.stringify(plan.in.map( (s) => s.clip.title )));
        const card = wanted.find( (w) => w.stepId === 'nt' );
        suite.check('...a card keyed on later resolves from the program\'s end (Robot Chicken at 1:00), for the midroll\'s start',
            (card != null) && (card.program === rc) && (card.airStart === layout.end) && (card.breakStart === layout.midrolls[0].start), JSON.stringify(card && { p: card.program.title, a: card.airStart - start, b: card.breakStart - start }));
        const again = midrolls.buildMidrollPlan(channel, layout, 0, env);
        suite.check('...built twice, the same', JSON.stringify(again.out.concat(again.in).map( (s) => s.clip.title )) === JSON.stringify(plan.out.concat(plan.in).map( (s) => s.clip.title )));
        const brk = transitions.findBreak(channel, 1, start + fg.duration);
        suite.check('the end break is planned as it is today (Between shows, not a midroll)', transitions.buildPlan(channel, brk, env).situation === 'betweenShows');

        // the week ahead: every layout a card walk would ask about
        const week = midrolls.midrollsBetween(channel, start, start + 2 * ms(45, 0), env);
        suite.check('midrollsBetween lists each airing starting in the window with its layout (Family Guy twice, Robot Chicken twice)',
            (week.length === 4) && (week[0].index === 0) && (week[0].layout.midrolls.length === 2) && (week[2].start === start + ms(45, 0)), JSON.stringify(week.map( (w) => [ w.index, w.start - start ] )));
        suite.check('...and none with the switch off', midrolls.midrollsBetween(channel, start, start + ms(45, 0), Object.assign( {}, env, { on: false } )).length === 0);
    }

    return suite;
};
