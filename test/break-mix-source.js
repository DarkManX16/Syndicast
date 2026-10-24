/*
 * "Commercials in the break into it come from: this day-part (or block) /
 * the one before" - an opt-in on each day-part and block (`commercialsFrom:
 * 'previous'`) that changes which mix fills a *boundary* break into it,
 * without touching which transition sequence plays there. See
 * docs/blocks-spec.md, "Which mix fills a break".
 *
 * Today's behaviour (resolveCollections always uses the incoming context's
 * own mix) is `commercialsFrom` absent or 'this', and must stay byte-for-byte
 * what it always was - the acceptance rows below prove that before touching
 * the new option at all. Self-contained, in the style of
 * test/blocks-unchanged.js, rather than reusing test/blocks-acceptance.js's
 * fixtures - this feature isn't one of that file's own spec-table stages,
 * and mutating its shared nickPicks/ccn fixtures to add commercialsFrom would
 * risk disturbing rows that already pass there.
 */
const { helperFuncs, dayParts, MIN, HOUR, at, freshStore, clip, show, flex, mix, Suite } = require('./support');
const transitions = require('../src/transitions');
const ChannelDB = require('../src/dao/channel-db');

const LISTS = {
    Day: [clip('Day#1', 2), clip('Day#2', 2), clip('Day#3', 2)],
    Night: [clip('Night#1', 2), clip('Night#2', 2), clip('Night#3', 2)],
    Base: [clip('Base#1', 2)],
    Cooled: [clip('Cooled#1', 2)],
};
function ownerOf(title) {
    return title.split('#')[0];
}
function fillersFor(channel) {
    return dayParts.allFillerCollections(channel).map((c) => ({
        id: c.id, content: LISTS[c.id] || [], weight: c.weight, cooldown: c.cooldown,
    }));
}

// A channel with two day-parts covering the whole week: Day (00:00) and
// Night (20:00) - the same shape as the real "00s NICK" / "Nick@Nite Friday"
// pair the Fri 9:54pm break is about, just named for the test instead of the
// day of week.
function dayNightChannel(nightFields) {
    return {
        number: 90, name: 'DayNight', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0,
        fillerCollections: mix([['Base', 100]]),
        dayParts: [
            { name: 'Day', fillerCollections: mix([['Day', 100]]),
              starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 0 }] },
            Object.assign({ name: 'Night', fillerCollections: mix([['Night', 100]]),
                starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 20 * HOUR }] }, nightFields || {}),
        ],
    };
}

// Draws picks for the break ending exactly at `when` - i.e. the next real
// show starts at `when` - programIndex 1 of a 3-entry [show, flex, show]
// lineup, the same phrasing test/blocks-acceptance.js's breakEndingAt uses.
// `noNeighbour: true` instead runs an all-Flex channel, with nothing on
// either side, so the break resolves from the clock at `when` itself.
function draw(channel, when, opts) {
    opts = opts || {};
    const breakMins = opts.breakMins || 8;
    const elapsedMins = opts.elapsedMins || 3;
    const programs = opts.noNeighbour
        ? [flex(breakMins)]
        : [show('Before', 30), flex(breakMins), show('After', 30)];
    const channelWithBreak = Object.assign({}, channel, { programs });
    const obj = {
        program: programs[opts.noNeighbour ? 0 : 1],
        timeElapsed: elapsedMins * MIN,
        programIndex: opts.noNeighbour ? 0 : 1,
    };
    const fillers = fillersFor(channelWithBreak);
    const t0 = when - breakMins * MIN + elapsedMins * MIN;
    const store = freshStore();
    const tally = {};
    for (let i = 0; i < (opts.n || 300); i++) {
        const item = helperFuncs.createLineup(store, obj, channelWithBreak, fillers, false, t0).shift();
        const key = (item.type === 'commercial') ? ownerOf(item.title) : `<${item.type}>`;
        tally[key] = (tally[key] || 0) + 1;
    }
    return tally;
}
function listsIn(tally) {
    return Object.keys(tally).sort();
}

module.exports = async function run() {
    const suite = new Suite('break-mix-source');

    // --------------------------------------------------- default, unchanged
    {
        const ch = dayNightChannel(); // no commercialsFrom at all
        suite.check('default (no commercialsFrom): the boundary break still gets the incoming context\'s own mix',
            JSON.stringify(listsIn(draw(ch, at('2026-01-05T20:00:00')))) === JSON.stringify(['Night']));
        const ch2 = dayNightChannel({ commercialsFrom: 'this' });
        suite.check('commercialsFrom: "this" is the same as leaving it out',
            JSON.stringify(listsIn(draw(ch2, at('2026-01-05T20:00:00')))) === JSON.stringify(['Night']));
    }

    // ------------------------------------------------- the one before: core
    {
        const ch = dayNightChannel({ commercialsFrom: 'previous' });
        suite.check('"previous": a boundary break into Night gets Day\'s mix instead',
            JSON.stringify(listsIn(draw(ch, at('2026-01-05T20:00:00')))) === JSON.stringify(['Day']));

        // Inside Night, no boundary: the program before the break is also
        // Night, so "the one before" and "this one" land on the same answer.
        suite.check('"previous" has no effect on a break that is not a boundary',
            JSON.stringify(listsIn(draw(ch, at('2026-01-05T21:00:00')))) === JSON.stringify(['Night']));

        // The setting only lives on the incoming context. Day has no
        // commercialsFrom of its own, so the midnight boundary (Night -> Day)
        // still uses Day's own mix, unaffected by Night's setting.
        suite.check('the setting does not leak to the other side of a boundary',
            JSON.stringify(listsIn(draw(ch, at('2026-01-06T00:00:00')))) === JSON.stringify(['Day']));
    }

    // ---------------------------------------------- both sides set to "previous"
    {
        const ch = dayNightChannel({ commercialsFrom: 'previous' });
        ch.dayParts[0] = Object.assign({}, ch.dayParts[0], { commercialsFrom: 'previous' });
        suite.check('"previous" on Day too: the midnight boundary (Night -> Day) now reads Night\'s mix, the context right before it',
            JSON.stringify(listsIn(draw(ch, at('2026-01-06T00:00:00')))) === JSON.stringify(['Night']));
    }

    // ------------------------------------------------------- no neighbour at all
    {
        // A break at programIndex 0 of a one-entry [flex] array: findPreviousProgram
        // (and findNextProgram) can never walk past it to a real program, so
        // the context is resolved from the clock, same as always, and there
        // is nothing to borrow from - "previous" falls back to the clock-
        // resolved context's own mix. The clock itself must land inside
        // Night's window for this to test anything.
        const ch = dayNightChannel({ commercialsFrom: 'previous' });
        suite.check('"previous" with no program before the break falls back to the (clock-resolved) incoming context\'s own mix',
            JSON.stringify(listsIn(draw(ch, at('2026-01-05T21:00:00'), { noNeighbour: true, breakMins: 60 })))
                === JSON.stringify(['Night']));
    }

    // ------------------------------------------- the fallback: previous context is null
    {
        // Only a block, no day-parts: nothing covers the day before the block
        // starts, so the context right before a "previous" boundary is null -
        // "nothing time-scoped governs this moment", the same answer
        // resolveCollections/resolveMixContext already give a channel with no
        // overlay at all (test/blocks-unchanged.js's own "declines to
        // intervene" check) - and not the block's own mix, which would be
        // "this", not "the one before".
        const ch = {
            number: 91, name: 'BlockOnly', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0,
            fillerCollections: mix([['Base', 100]]),
            blocks: [
                { name: 'Night Block', fillerCollections: mix([['Night', 100]]), commercialsFrom: 'previous',
                  airings: [{ days: [0, 1, 2, 3, 4, 5, 6], start: 20 * HOUR, end: 24 * HOUR }] },
            ],
        };
        const breakMins = 8, elapsedMins = 3;
        const when = at('2026-01-05T20:00:00');
        const programs = [show('Before', 30), flex(breakMins), show('After', 30)];
        const channelWithBreak = Object.assign({}, ch, { programs });
        const obj = { program: programs[1], timeElapsed: elapsedMins * MIN, programIndex: 1 };
        const t0 = when - breakMins * MIN + elapsedMins * MIN;
        suite.check('"previous" whose context resolves to null is read as "nothing time-scoped governs this moment", not the block\'s own mix',
            dayParts.resolveMixContext(channelWithBreak, t0, obj) === null);
        suite.check('...so resolveCollections declines to intervene here too, exactly as it does with no overlay at all',
            dayParts.resolveCollections(channelWithBreak, t0, obj) === null);
    }

    // --------------------------------------------------------------- cooldowns
    {
        // The borrowed mix is read through the ordinary picker, so a list
        // cooldown on it is honoured exactly as it would be on the incoming
        // context's own mix - checked both inside and outside the cooldown.
        // List/clip play times are real wall-clock timestamps regardless of
        // the synthetic `t0` driving day-part resolution (see
        // channel-cache.js), so these are set from the real clock, the same
        // way test/shared-breaks.js's own cooldown checks are.
        const ch = dayNightChannel({ commercialsFrom: 'previous' });
        ch.dayParts[0] = Object.assign({}, ch.dayParts[0], { fillerCollections: mix([['Cooled', 100, 10 * MIN]]) });
        const programs = [show('Before', 30), flex(8), show('After', 30)];
        const channelWithBreak = Object.assign({}, ch, { programs });
        const t0 = at('2026-01-05T20:00:00') - 8 * MIN + 1 * MIN; // the boundary break into Night, 1 minute in
        const fillers = fillersFor(channelWithBreak);
        const obj = { program: programs[1], timeElapsed: 1 * MIN, programIndex: 1 };

        const stillCooling = freshStore();
        const recentPlay = Date.now() - 7 * MIN;
        stillCooling.update(90, '!fillerList!|Cooled', recentPlay);
        stillCooling.update(90, 'plex|srv|/f/Cooled#1', recentPlay);
        const refused = helperFuncs.createLineup(stillCooling, obj, channelWithBreak, fillers, false, t0)[0];
        suite.check('a list cooldown on the borrowed ("previous") mix still refuses its only clip while it is cooling down',
            refused.type === 'offline', JSON.stringify(refused));

        const doneWaiting = freshStore();
        const olderPlay = Date.now() - 11 * MIN;
        doneWaiting.update(90, '!fillerList!|Cooled', olderPlay);
        doneWaiting.update(90, 'plex|srv|/f/Cooled#1', olderPlay);
        const allowed = helperFuncs.createLineup(doneWaiting, obj, channelWithBreak, fillers, false, t0)[0];
        suite.check('...and plays it once the same cooldown has elapsed',
            allowed.type === 'commercial' && allowed.title === 'Cooled#1', JSON.stringify(allowed));
    }

    // ------------------------------------------------------- stable through a break
    {
        // The comment on resolveMixContext promises a long break spanning a
        // boundary plays one mix throughout, same as the incoming-context
        // case always has - checked here for "previous" specifically: calls
        // at different points through the break (t0 and timeElapsed both
        // advancing, their difference - the break's own start - fixed) must
        // keep resolving to the same context.
        const ch = dayNightChannel({ commercialsFrom: 'previous' });
        const programs = [show('Before', 30), flex(120), show('After', 30)];
        const chWithBreak = Object.assign({}, ch, { programs });
        const breakStart = at('2026-01-05T19:30:00');
        const names = [0, 30, 60, 90, 119].map((elapsedMin) => {
            const obj = { program: programs[1], timeElapsed: elapsedMin * MIN, programIndex: 1 };
            const context = dayParts.resolveMixContext(chWithBreak, breakStart + elapsedMin * MIN, obj);
            return context && context.name;
        });
        suite.check('the borrowed context stays the same for the whole break, not just at its start',
            names.every((n) => n === 'Day'), names.join(','));
    }

    // ----------------------------------------------------- transitions unaffected
    {
        // The real point of the feature: the Flex mix changes, but Night's
        // own entering sequence (the "sign-on after the commercials") still
        // fires exactly as it would under "this" - transitions.js never reads
        // commercialsFrom at all.
        const ch = dayNightChannel({ commercialsFrom: 'previous',
            transitions: { entering: { out: [], in: [{ id: 'signon', kind: 'list', listId: 'SignOn', match: 'any', keyedOn: 'next', fallbackListId: null }] } } });
        const programs = [show('Before', 30), flex(5), show('After', 30)];
        const flexStart = at('2026-01-05T20:00:00') - 5 * MIN;
        const channel = Object.assign({}, ch, { programs,
            duration: programs.reduce((a, p) => a + p.duration, 0),
            startTime: new Date(flexStart - programs[0].duration).toISOString() });
        const brk = transitions.findBreak(channel, 1, flexStart);
        const env = { getList: (id) => (id === 'SignOn') ? [{ title: 'Sign On', key: '/c/signon', duration: 10 * 1000, serverKey: 'srv' }] : null,
            lastPlayed: () => 0, featuresShows: () => false };
        const plan = transitions.buildPlan(channel, brk, env);
        suite.check('the boundary\'s entering sequence still fires, unchanged by commercialsFrom',
            plan.situation === 'boundary' && plan.in.length === 1 && plan.in[0].clip.title === 'Sign On',
            JSON.stringify(plan));
        suite.check('...while the Flex itself draws from Day, not Night',
            JSON.stringify(listsIn(draw(ch, at('2026-01-05T20:00:00')))) === JSON.stringify(['Day']));
    }

    // ------------------------------------------- shared breaks: one array, not two
    {
        // resolveCollections is called once per filler clip in a break
        // (docs/blocks-spec.md, "Long breaks spanning several contexts"); the
        // array it hands back for "previous" must be the same every time
        // within one break, which is what the picker's per-break cooldown
        // bookkeeping (and the shared-Flex-pick list in src/shared-breaks.js)
        // depends on.
        const ch = dayNightChannel({ commercialsFrom: 'previous' });
        const programs = [show('Before', 30), flex(10), show('After', 30)];
        const chWithBreak = Object.assign({}, ch, { programs });
        const breakStart = at('2026-01-05T20:00:00') - 10 * MIN;
        const calls = [0, 2, 5, 9].map((elapsedMin) => {
            const obj = { program: programs[1], timeElapsed: elapsedMin * MIN, programIndex: 1 };
            return dayParts.resolveCollections(chWithBreak, breakStart + elapsedMin * MIN, obj);
        });
        suite.check('resolveCollections returns the same list through the whole break',
            calls.every((c) => JSON.stringify(c) === JSON.stringify(calls[0])), calls.map((c) => JSON.stringify(c)).join(' | '));
    }

    // -------------------------------------------------------- save-time warning
    {
        const db = new ChannelDB('unused');
        function warningsFor(contextFields, onBlock) {
            const lines = [];
            const real = console.error;
            console.error = (...args) => lines.push(args.join(' '));
            try {
                const context = Object.assign({ name: 'X' },
                    onBlock ? { airings: [{ days: [1], start: 0, end: HOUR }] } : { starts: [{ days: [1], time: 0 }] },
                    contextFields);
                db.validateChannelJson(7, onBlock ? { blocks: [context] } : { dayParts: [context] });
            } finally {
                console.error = real;
            }
            return lines.filter((l) => /commercialsFrom/.test(l));
        }
        suite.check('a day-part with no commercialsFrom is not warned about', warningsFor({}).length === 0);
        suite.check('commercialsFrom "this" is not warned about', warningsFor({ commercialsFrom: 'this' }).length === 0);
        suite.check('commercialsFrom "previous" is not warned about', warningsFor({ commercialsFrom: 'previous' }).length === 0);
        suite.check('an unknown commercialsFrom is warned about', warningsFor({ commercialsFrom: 'yesterday' }).length === 1);
        suite.check('a block with an unknown commercialsFrom is warned about too', warningsFor({ commercialsFrom: 'yesterday' }, true).length === 1);
    }

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
