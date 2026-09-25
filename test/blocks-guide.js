/*
 * Stage 2 generalises guideFlexPlaceholder per-context (docs/blocks-spec.md),
 * but the guide never runs through createLineup - the earlier investigation
 * that shaped this session's plan found it goes through
 * TVGuideService#getChannelPrograms instead, so this hook needed its own
 * tests rather than piggybacking on blocks-acceptance.js.
 *
 * Driven directly against TVGuideService, the way NOTES.md's testing notes
 * drive createLineup directly: _throttle stubbed to a no-op and
 * accumulateTable/channelsByNumber built by hand, so this needs no data
 * folder, no xmltv settings and no eventService - genuinely no I/O, the same
 * property day-parts.js itself has. getChannelPrograms is the one method
 * that does real work without either of those, which is what makes this
 * possible; refresh()/refreshXML() are not exercised here.
 *
 * Every break below is well over 30 minutes
 * (constants.TVGUIDE_MAXIMUM_PADDING_LENGTH_MS): a shorter one is melded into
 * the neighbouring show as padding and never becomes its own guide entry at
 * all, so it would never reach guideNameFor - see the earlier investigation's
 * finding that an ordinary inter-show break never surfaces in the guide,
 * only a long one does. blocks-acceptance.js's 8-minute breaks are the
 * picker's own convention and do not carry over here for that reason.
 */
const TVGuideService = require('../src/services/tv-guide-service');
const { at, HOUR, MIN, flex, Suite } = require('./support');

// The guide reads a real program's title from showTitle, not title (that's
// the picker's field, on support.js's show() builder) - kept local rather
// than adding a second meaning to that shared helper.
function realShow(title, mins) {
    return { showTitle: title, type: 'episode', duration: mins * MIN };
}

async function guideFor(channel, t0, t1) {
    const g = new TVGuideService(null, null, null, null, null);
    g._throttle = async () => {};
    g.channelsByNumber = { [channel.number]: channel };
    g.accumulateTable = { [channel.number]: await g.makeAccumulated(channel) };
    return await g.getChannelPrograms(t0, t1, channel);
}

// A day-part covering all weekday daytime with no guideName of its own (so
// it must fall through to the placeholder), and a block - Toonami,
// Wednesday 15:00-17:00 - that does have one. Mirrors the ccn fixture in
// blocks-acceptance.js closely enough to reuse the same intuition, but kept
// separate: that file exercises createLineup, this one getChannelPrograms,
// and the two shapes (channel.programs as a cyclic array vs a guide build's
// own windowed program list) don't share fixtures cleanly.
function channelWithPrograms(programs, startTime) {
    const ch = {
        number: 60, name: 'GuideCCN', icon: '/icon.png',
        guideFlexPlaceholder: 'GuideCCN Filler',
        guideMinimumDurationSeconds: 60,
        dayParts: [
            { name: 'Weekday', guideName: '', fillerCollections: [],
              starts: [{ days: [1, 2, 3, 4, 5], time: 6 * HOUR }] },
        ],
        blocks: [
            { name: 'Toonami', guideName: 'Toonami Filler', fillerCollections: [],
              airings: [ { days: [3], start: 15 * HOUR, end: 17 * HOUR } ] },
        ],
        startTime,
        programs,
    };
    ch.duration = programs.reduce((a, p) => a + p.duration, 0);
    return ch;
}

module.exports = async function run() {
    const suite = new Suite('blocks-guide');

    // 1. Identity: a channel with neither dayParts nor blocks must produce
    // exactly the title it always has - the channel-wide placeholder, read
    // the same way makeEntry has always read it. This is the guide's version
    // of blocks-unchanged.js's identity guarantee.
    {
        const ch = {
            number: 61, name: 'Plain', icon: '/icon.png',
            guideFlexPlaceholder: 'Plain Filler',
            guideMinimumDurationSeconds: 60,
            startTime: at('2026-01-05T09:00:00'),
            programs: [ realShow('X', 22), flex(90), realShow('Y', 22) ],
        };
        ch.duration = ch.programs.reduce((a, p) => a + p.duration, 0);
        const t0 = at('2026-01-05T09:00:00');
        const res = await guideFor(ch, t0, t0 + 3 * HOUR);
        suite.check('no overlay: the Flex entry still gets the channel\'s own placeholder',
            res.programs[1].title === 'Plain Filler', `-> ${res.programs.map((p) => p.title).join(' | ')}`);
    }

    // 2. Opt-in: a day-part with no guideName of its own falls through to the
    // channel's placeholder - never to the day-part's own name. This is the
    // fallback chain the earlier plan settled on (guideName, then
    // guideFlexPlaceholder, then channel name) rather than falling back to
    // the day-part/block's name, which would have relabelled every existing
    // channel's guide the moment blocks shipped, with nobody having typed
    // anything.
    {
        // Monday: only the Weekday day-part is in force here, Toonami's
        // airing is Wednesday-only, so this is purely the day-part path.
        const ch = channelWithPrograms(
            [ realShow('Before', 22), flex(90), realShow('After', 22) ],
            at('2026-01-05T09:00:00'));
        const t0 = at('2026-01-05T09:00:00');
        const res = await guideFor(ch, t0, t0 + 3 * HOUR);
        suite.check('day-part with no guideName falls through to the placeholder, not "Weekday"',
            res.programs[1].title === 'GuideCCN Filler', `-> ${res.programs.map((p) => p.title).join(' | ')}`);
    }

    // 3. The block's own guideName wins over the day-part's placeholder
    // fallback, and does so via the incoming-neighbour rule rather than the
    // clock: the Flex run below starts at 13:50 Wednesday, comfortably
    // before Toonami's 15:00 start, but its real neighbour (Three) starts at
    // 15:20 - inside Toonami - so the whole run, including its own,
    // earlier-than-15:00 start, shows Toonami's name. This is the same
    // discriminating shape as blocks-acceptance.js's "break between the 2:30
    // and 3:00 shows" row, through the guide instead of the picker. It also
    // is the block-beats-day-part precedence case: 13:50-15:20 sits inside
    // the Weekday day-part throughout, which would win if the block were not
    // checked first.
    {
        const ch = channelWithPrograms(
            [ realShow('TwoThirty', 22), flex(90), realShow('Three', 22) ],
            at('2026-01-07T13:28:00'));
        const t0 = at('2026-01-07T13:28:00');
        const res = await guideFor(ch, t0, t0 + 3 * HOUR);
        const flexEntry = res.programs[1];
        suite.check('block guideName wins via the incoming neighbour, for the whole run',
            (flexEntry.title === 'Toonami Filler') && (new Date(flexEntry.start).getTime() === t0 + 22 * MIN),
            `-> ${res.programs.map((p) => p.title).join(' | ')}`);
    }

    // 4. Window-boundedness: nextRealStart only sees as far as this guide
    // build's own window - it cannot reach past t1 even though a real
    // neighbour exists later in the channel's cycle. The 10-hour Flex run
    // below never reaches "After" (which starts at 22:22, long past t1), so
    // the melded program list this build works from never contains it at
    // all - proven structurally, not just by the answer it produces - and
    // the chunk must fall back to the clock rather than pretending to know
    // about a neighbour this build cannot see.
    {
        const ch = channelWithPrograms(
            [ realShow('Before', 22), flex(10 * HOUR), realShow('After', 22) ],
            at('2026-01-07T12:00:00'));   // Wednesday
        const t0 = at('2026-01-07T12:00:00');
        const res = await guideFor(ch, t0, t0 + 3 * HOUR);   // t1 = 15:00, "After" starts 22:22
        suite.check('the build never fetched a program past t1 to use as a neighbour',
            res.programs.length === 2, `-> ${res.programs.map((p) => p.title).join(' | ')}`);
        const flexEntry = res.programs[1];
        // The clock at the run's own start (12:22, Wednesday) is before
        // Toonami's 15:00 start, so this must read the day-part placeholder,
        // not Toonami.
        suite.check('no neighbour inside the build window falls back to the clock, not a peek past t1',
            flexEntry.title === 'GuideCCN Filler', `-> ${res.programs.map((p) => p.title).join(' | ')}`);
    }

    // 5. All-Flex-in-window: with no real neighbour anywhere, each split
    // chunk (the guide's own pre-existing 6-hour display granularity, reused
    // here rather than resolving any more finely) reads the clock afresh, so
    // the name changes chunk to chunk as the clock crosses Toonami's
    // boundary - the guide's equivalent of day-parts.js's open question 2
    // finding that an all-Flex channel changes mix as the clock crosses one.
    // Chunk boundaries land at +0h/+6h/+12h/+18h from t0=Wed 09:00, so the
    // second chunk starts exactly at 15:00, Toonami's own start.
    {
        const ch = channelWithPrograms([ flex(20 * HOUR) ], at('2026-01-07T09:00:00'));
        const t0 = at('2026-01-07T09:00:00');
        const res = await guideFor(ch, t0, t0 + 20 * HOUR);
        const titles = res.programs.map((p) => p.title);
        suite.check('an all-Flex run changes name chunk to chunk as the clock crosses a block boundary',
            JSON.stringify(titles) === JSON.stringify(
                ['GuideCCN Filler', 'Toonami Filler', 'GuideCCN Filler', 'GuideCCN Filler']),
            `-> ${titles.join(' | ')}`);
    }

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
