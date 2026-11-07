/*
 * Insert before (Ron, Nov 6, 2026): a clip goes in right before an airing, after the
 * break in front of it - the break shrinks by the clip's length and nothing else
 * moves - and a row dropped right after its own break moves past it. See NOTES.md,
 * "What you see is what airs", "Insert before, and a drop past a row's own break".
 */
const { MIN, HOUR, Suite } = require('./support');
const kept = require('../src/kept-rows');

const SEC = 1000;
const START = new Date('2026-11-06T00:00:00').getTime(); // a Friday night
const NOW = START - HOUR;
const at = (h, m, s) => START + h * HOUR + (m || 0) * MIN + (s || 0) * SEC;

const flex = (d) => ({ duration: d, isOffline: true });
function episode(show, n, duration) {
    return { type: 'episode', showTitle: show, title: `${show} ${n}`, season: 1, episode: n, duration: duration,
        serverKey: 'srv', key: `/e/${show}/${n}`, slotPosition: 'next|' };
}
const clip = (title, duration) => ({ type: 'movie', title: title, duration: duration, serverKey: 'srv', key: `/m/${title}` });
const intro = clip('Toonami Movie Intro', 7 * SEC);

// Futurama 12:00am and Family Guy 12:30am, each with 7:30 of Flex after it; a 75 minute
// movie at 1:00am with 15 minutes after it; Robot Chicken at 2:30am; Flex to the end.
function lineup() {
    return { startTime: START, programs: [
        episode('Futurama', 1, 22 * MIN + 30 * SEC), flex(7 * MIN + 30 * SEC),
        episode('Family Guy', 1, 22 * MIN + 30 * SEC), flex(7 * MIN + 30 * SEC),
        { type: 'movie', title: 'The Batman vs. Dracula', duration: 75 * MIN, serverKey: 'srv', key: '/m/batman', slotPosition: 'next|' }, flex(15 * MIN),
        episode('Robot Chicken', 1, 22 * MIN + 30 * SEC), flex(7 * MIN + 30 * SEC),
        flex(2 * 24 * HOUR),
    ] };
}
const l0 = lineup();
const startsOf = (l) => {
    const out = [];
    l.programs.reduce( (t, p) => { out.push(t); return t + p.duration; }, l.startTime );
    return out;
};
const indexOf = (l, title) => l.programs.findIndex( (p) => p.title === title );
// Every airing's start by title (Flex left out).
const airs = (l) => {
    const s = startsOf(l);
    const out = {};
    l.programs.forEach( (p, i) => { if (! p.isOffline) { out[p.title] = s[i]; } } );
    return out;
};
const lineOf = (programs) => ({ programs: programs, startTime: START });
const names = (l) => l.programs.map( (p) => p.isOffline ? `Flex ${p.duration / SEC}` : p.title );
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Two airing maps, whatever order their keys came in.
const sameAirs = (a, b) => same(Object.keys(a).sort().map( (k) => [ k, a[k] ] ), Object.keys(b).sort().map( (k) => [ k, b[k] ] ));

module.exports = async function () {
    const suite = new Suite('insert-before');

    suite.log('-- Insert before: the clip goes right before the airing, after its break --');
    {
        const i = indexOf(l0, 'Family Guy 1');
        const got = kept.insertBefore({ lineup: l0, index: i, item: intro, now: NOW });
        suite.check('insertBefore is there', typeof(kept.insertBefore) === 'function', '');
        const list = lineOf(got.programs || []);
        suite.check('the break before the airing shrinks by the clip, the clip sits against the airing',
            same(names(list).slice(0, 5), [ 'Futurama 1', 'Flex 443', 'Toonami Movie Intro', 'Family Guy 1', 'Flex 450' ]),
            names(list).slice(0, 6).join(', ') + ' ' + (got.refused || ''));
        suite.check('...and nothing else moves: every airing at its time, the clip 7 s before Family Guy',
            sameAirs(Object.assign({}, airs(list), { 'Toonami Movie Intro': 0 }), Object.assign({}, airs(l0), { 'Toonami Movie Intro': 0 }))
                && airs(list)['Toonami Movie Intro'] === at(0, 30) - 7 * SEC,
            JSON.stringify(airs(list)));
        suite.check('...the clip kept as an insert; the rest of the list is the same objects',
            kept.keptKind(list.programs[2]) === 'insert' && list.programs.length === l0.programs.length + 1
                && list.programs[0] === l0.programs[0] && list.programs[3] === l0.programs[2] && list.programs[5] === l0.programs[4], '');
        suite.check('...and says so in one line',
            got.text === 'Toonami Movie Intro goes in right before Family Guy 1 at 12:30am; the break before it is 7:23 now.', got.text);

        const back = kept.putBack({ lineup: list, index: 2, now: NOW });
        suite.check('Put back takes it out and gives the break its length: the list exactly as before',
            same(back.programs, l0.programs), back.refused || names(lineOf(back.programs || [])).join(', '));
    }

    suite.log('-- a break exactly the clip\'s length, and one too short --');
    {
        const i = indexOf(l0, 'Family Guy 1');
        const exact = clip('Seven and a half', 7 * MIN + 30 * SEC);
        const got = kept.insertBefore({ lineup: l0, index: i, item: exact, now: NOW });
        suite.check('a clip as long as the break leaves no Flex, and still nothing moves',
            same(names(lineOf(got.programs || [])).slice(0, 4), [ 'Futurama 1', 'Seven and a half', 'Family Guy 1', 'Flex 450' ])
                && airs(lineOf(got.programs || []))['Family Guy 1'] === at(0, 30),
            got.refused || '');
        const back = kept.putBack({ lineup: lineOf(got.programs || []), index: 1, now: NOW });
        suite.check('...Put back gives the whole break back', same(back.programs, l0.programs), back.refused || '');

        const long = kept.insertBefore({ lineup: l0, index: i, item: clip('Eight minutes', 8 * MIN), now: NOW });
        suite.check('a clip longer than the break is refused, in a line, and nothing is returned to apply',
            ! long.programs && long.refused === 'Eight minutes is longer than the 7:30 break before Family Guy 1.', long.refused);
    }

    suite.log('-- no break before it, or a break that has begun --');
    {
        const first = kept.insertBefore({ lineup: l0, index: 0, item: intro, now: NOW });
        suite.check('the first row has no break before it: refused',
            ! first.programs && first.refused === 'There is no break before Futurama 1.', first.refused);

        const once = kept.insertBefore({ lineup: l0, index: indexOf(l0, 'Family Guy 1'), item: intro, now: NOW });
        const twice = kept.insertBefore({ lineup: lineOf(once.programs), index: indexOf(lineOf(once.programs), 'Family Guy 1'), item: clip('Second', 3 * SEC), now: NOW + 1 });
        suite.check('...and neither has an airing the clip already sits against',
            ! twice.programs && twice.refused === 'There is no break before Family Guy 1.', twice.refused);
        const aboveClip = kept.insertBefore({ lineup: lineOf(once.programs), index: indexOf(lineOf(once.programs), 'Toonami Movie Intro'), item: clip('Second', 3 * SEC), now: NOW + 1 });
        suite.check('...a clip can go before the clip, in the break before it',
            Array.isArray(aboveClip.programs) && same(names(lineOf(aboveClip.programs)).slice(1, 5), [ 'Flex 440', 'Second', 'Toonami Movie Intro', 'Family Guy 1' ]),
            aboveClip.refused || names(lineOf(aboveClip.programs || [])).join(', '));

        const onAir = kept.insertBefore({ lineup: l0, index: indexOf(l0, 'Family Guy 1'), item: intro, now: at(0, 35) });
        suite.check('an airing on air can\'t have a clip put before it',
            ! onAir.programs && /is on air now/.test(onAir.refused || ''), onAir.refused);
        const aired = kept.insertBefore({ lineup: l0, index: indexOf(l0, 'Family Guy 1'), item: intro, now: at(1, 0) });
        suite.check('...nor one that has aired', ! aired.programs && /already aired/.test(aired.refused || ''), aired.refused);

        // 12:29:57am: the 7 s clip would have begun at 12:29:53.
        const begun = kept.insertBefore({ lineup: l0, index: indexOf(l0, 'Family Guy 1'), item: intro, now: at(0, 29, 57) });
        suite.check('a break that has begun too far for the clip is refused: the clip would start in the past',
            ! begun.programs && begun.refused === 'The break before Family Guy 1 has already begun.', begun.refused);
        const fits = kept.insertBefore({ lineup: l0, index: indexOf(l0, 'Family Guy 1'), item: clip('Short', 2 * SEC), now: at(0, 29, 57) });
        suite.check('...a clip that still starts in the future goes in', Array.isArray(fits.programs), fits.refused);

        const flexRow = kept.insertBefore({ lineup: l0, index: 1, item: intro, now: NOW });
        suite.check('a Flex row isn\'t an airing to put a clip before', ! flexRow.programs && flexRow.refused === 'Pick a program to insert before.', flexRow.refused);
    }

    suite.log('-- the library\'s several items, and a special day --');
    {
        const i = indexOf(l0, 'Family Guy 1');
        const a = clip('First clip', 2 * MIN);
        const b = clip('Second clip', 1 * MIN);
        const many = kept.insertManyBefore({ lineup: l0, index: i, items: [ a, b ], now: NOW });
        const list = lineOf(many.programs || []);
        suite.check('insertManyBefore: the items in order, the last against the airing, the break shrunk by all',
            same(names(list).slice(0, 5), [ 'Futurama 1', 'Flex 270', 'First clip', 'Second clip', 'Family Guy 1' ])
                && airs(list)['Family Guy 1'] === at(0, 30) && airs(list)['First clip'] === at(0, 27) && many.texts.length === 2,
            (many.refused || '') + names(list).slice(0, 6).join(', '));
        const undone = kept.putBack({ lineup: list, index: indexOf(list, 'First clip'), now: NOW });
        const undone2 = kept.putBack({ lineup: lineOf(undone.programs || []), index: indexOf(lineOf(undone.programs || []), 'Second clip'), now: NOW });
        suite.check('...and Put back of each, first or last, gives the list exactly as before',
            same(undone2.programs, l0.programs), undone.refused || undone2.refused || '');
        const lastFirst = kept.putBack({ lineup: list, index: indexOf(list, 'Second clip'), now: NOW });
        const lastFirst2 = kept.putBack({ lineup: lineOf(lastFirst.programs || []), index: indexOf(lineOf(lastFirst.programs || []), 'First clip'), now: NOW });
        suite.check('...in either order', same(lastFirst2.programs, l0.programs), lastFirst.refused || lastFirst2.refused || '');

        const tooMany = kept.insertManyBefore({ lineup: l0, index: i, items: [ clip('Four', 4 * MIN), clip('Four again', 4 * MIN) ], now: NOW });
        suite.check('together longer than the break: none goes in, and it says so in a line',
            ! tooMany.programs && tooMany.refused === 'They are 8:00 together, longer than the 7:30 break before Family Guy 1.', tooMany.refused);
        const none = kept.insertManyBefore({ lineup: l0, index: i, items: [ clip('Eight', 8 * MIN) ], now: NOW });
        suite.check('...and one that is too long says why',
            ! none.programs && /longer than the 7:30 break/.test(none.refused || ''), none.refused);

        const day = { id: 'sd', name: "New Year's Toonami Marathon", from: { date: '2026-11-06', time: 0 }, to: { date: '2026-11-06', time: 2 * HOUR },
            blockId: null, positions: 'advance', layout: 'back', slots: [ { showId: 'tv.Futurama', order: 'next' } ] };
        const sched = { period: 7 * 24 * HOUR, lateness: 24 * HOUR, pad: 5 * MIN, slots: [], specialDays: [ day ] };
        suite.check('refused inside a special day, as Insert after is',
            kept.insertBefore({ lineup: l0, index: i, item: intro, now: NOW, schedule: sched }).refused === "Change this in Time Slots, New Year's Toonami Marathon."
                && kept.insertManyBefore({ lineup: l0, index: i, items: [ intro ], now: NOW, schedule: sched }).refused === "Change this in Time Slots, New Year's Toonami Marathon.", '');

        suite.check('breakBefore: the break in front of an airing, 0 when there is none',
            kept.breakBefore({ lineup: l0, index: i }) === 7 * MIN + 30 * SEC && kept.breakBefore({ lineup: l0, index: 0 }) === 0
                && kept.breakBefore({ lineup: lineOf(many.programs || []), index: indexOf(list, 'Family Guy 1') }) === 0, '');
    }

    suite.log('-- a drop right after the row\'s own break moves it past the break --');
    {
        // Ron, Nov 6: the library's "Insert into the lineup here" put the intro after the
        // airing before the movie - ahead of the commercials. Dragging it to just before the
        // movie did nothing: it already sat directly in front of it, with its Flex after it.
        const ins = kept.insertAfter({ lineup: l0, index: indexOf(l0, 'Family Guy 1'), item: intro, now: NOW });
        const after = lineOf(ins.programs);
        const movie = indexOf(after, 'The Batman vs. Dracula');
        const from = indexOf(after, 'Toonami Movie Intro');
        suite.check('the setup: the clip right after Family Guy, its break after it, then the movie',
            same(names(after).slice(2, 6), [ 'Family Guy 1', 'Toonami Movie Intro', 'Flex 443', 'The Batman vs. Dracula' ]), names(after).join(', '));

        const got = kept.move({ lineup: after, from: from, to: movie, now: NOW });
        const moved = lineOf(got.programs || []);
        suite.check('dropped just before the movie, after the break: the clip sits against the movie',
            same(names(moved).slice(2, 6), [ 'Family Guy 1', 'Flex 443', 'Toonami Movie Intro', 'The Batman vs. Dracula' ]),
            got.refused || names(moved).join(', '));
        suite.check('...and nothing else moves: the movie and every airing where they were, the clip 7 s before the movie',
            sameAirs(Object.assign({}, airs(moved), { 'Toonami Movie Intro': 0 }), Object.assign({}, airs(after), { 'Toonami Movie Intro': 0 }))
                && airs(moved)['Toonami Movie Intro'] === at(1, 0) - 7 * SEC, JSON.stringify(airs(moved)));
        suite.check('...kept as it is (a moved insert), and says so in one line',
            kept.keptKind(moved.programs[moved.programs.findIndex( (p) => p.title === 'Toonami Movie Intro' )]) === 'moved'
                && got.text === 'Toonami Movie Intro moves past its 7:23 of Flex, to 12:59:53am; nothing else moves.', got.text);

        const back = kept.putBack({ lineup: moved, index: indexOf(moved, 'Toonami Movie Intro'), now: NOW });
        suite.check('Put back on it: the clip and its break exactly where they were',
            same(back.programs, after.programs), back.refused || names(lineOf(back.programs || [])).join(', '));
        const gone = kept.putBack({ lineup: lineOf(back.programs || []), index: indexOf(lineOf(back.programs || []), 'Toonami Movie Intro'), now: NOW });
        suite.check('...and Put back again takes the insert out: the list as it was',
            same(gone.programs, l0.programs), gone.refused || '');

        // A row with no break of its own, dropped between a Flex and the airing after it.
        const plainEnd = lineOf(moved.programs);
        const toRobot = kept.move({ lineup: plainEnd, from: indexOf(plainEnd, 'Toonami Movie Intro'), to: indexOf(plainEnd, 'Robot Chicken 1'), now: NOW });
        const atRobot = lineOf(toRobot.programs || []);
        suite.check('a row with no break, dropped between a Flex and the airing after it, lands there',
            same(names(atRobot).slice(-6, -1), [ 'The Batman vs. Dracula', 'Flex 900', 'Toonami Movie Intro', 'Robot Chicken 1', 'Flex 450' ]),
            toRobot.refused || names(atRobot).join(', '));

        suite.check('a drop onto the row itself, or right after a row with no break, is still nothing',
            kept.move({ lineup: after, from: from, to: from, now: NOW }).programs === undefined
                && kept.move({ lineup: moved, from: indexOf(moved, 'Toonami Movie Intro'), to: indexOf(moved, 'The Batman vs. Dracula'), now: NOW }).programs === undefined, '');

        // The old drop: a row with a break dropped elsewhere keeps its break after it.
        const fg = kept.move({ lineup: l0, from: indexOf(l0, 'The Batman vs. Dracula'), to: indexOf(l0, 'Family Guy 1'), now: NOW });
        suite.check('a row with a break dropped in front of another airing still goes there with its break after it',
            same(names(lineOf(fg.programs || [])).slice(0, 6), [ 'Futurama 1', 'Flex 450', 'The Batman vs. Dracula', 'Flex 900', 'Family Guy 1', 'Flex 450' ])
                && fg.text.indexOf('moves to') !== -1, fg.refused || names(lineOf(fg.programs || [])).join(', '));

        // On air or aired: refused as any drag of it.
        const onAirClip = kept.move({ lineup: after, from: from, to: movie, now: at(0, 52, 33) });
        suite.check('the clip itself on air: refused as any drag of it is', ! onAirClip.programs && /is on air now/.test(onAirClip.refused || ''), onAirClip.refused);
        const airedClip = kept.move({ lineup: after, from: from, to: movie, now: at(0, 53) });
        suite.check('...or aired', ! airedClip.programs && /already aired/.test(airedClip.refused || ''), airedClip.refused);
        const backLate = kept.putBack({ lineup: moved, index: indexOf(moved, 'Toonami Movie Intro'), now: at(0, 53) });
        suite.check('Put back when the clip\'s old time has passed is refused, as any drag\'s is',
            ! backLate.programs && /that time has passed/.test(backLate.refused || ''), backLate.refused);
    }

    return suite;
};
