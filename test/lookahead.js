/*
 * The break look-ahead. A stream that reaches the end of a show early is
 * handed the break before the break has really started (the SLACK hand-off in
 * getCurrentProgramAndTimeElapsed). The break's mix and its length have to be
 * worked out from where the break really starts in the lineup, not from the
 * hand-off instant - otherwise the first clip of a break before a new day-part
 * or block comes from the old mix. Measured on channel 1 before this was
 * fixed: 15 of 28 boundary breaks in a week opened with one outgoing clip.
 * See NOTES.md, the Stage 4 entry on the 1.0 list.
 */
const { helperFuncs, dayParts, MIN, HOUR, at, freshStore, clip, show, flex, mix, Suite } = require('./support');

const SEC = 1000;

// Every clip is named after its list, so a pick's owner is never in doubt.
const LISTS = {
    Outgoing: [1, 2, 3, 4].map((i) => clip(`Outgoing#${i}`, 0.5)),
    Incoming: [1, 2, 3, 4].map((i) => clip(`Incoming#${i}`, 0.5)),
};
function ownerOf(title) {
    return title.split('#')[0];
}

/*
 * A show, a 3 minute break, then a show starting `offsetMs` after a day-part
 * boundary at Fri 12:30am. Channel 1's real Friday Adult Swim boundary has
 * Family Guy starting 0.92s after the minute, which is why the offset is
 * there: the lineup's starts drift by milliseconds from the slot times.
 */
function boundaryChannel(offsetMs) {
    const boundary = at('2026-10-02T00:30:00');
    const before = show('Before', 22);
    const brk = flex(3);
    const after = show('After', 22);
    return {
        boundary,
        breakStart: boundary + offsetMs - brk.duration,
        channel: {
            number: 7, name: 'Lookahead', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0,
            fillerCollections: [],
            dayParts: [
                { name: 'Outgoing', fillerCollections: mix([['Outgoing', 100]]),
                  starts: [{ days: [1, 2, 3, 4, 5], time: 6 * HOUR }] },
                { name: 'Incoming', fillerCollections: mix([['Incoming', 100]]),
                  starts: [{ days: [5], time: 30 * MIN }] },
            ],
            programs: [before, brk, after],
            duration: before.duration + brk.duration + after.duration,
            startTime: new Date(boundary + offsetMs - brk.duration - before.duration).toISOString(),
        },
    };
}
function fillersFor(channel) {
    return dayParts.allFillerCollections(channel).map((c) => ({
        id: c.id, content: LISTS[c.id] || [], weight: c.weight, cooldown: c.cooldown,
    }));
}

module.exports = async function run() {
    const suite = new Suite('lookahead');

    // -------------------------------------------------- the hand-off itself
    {
        const { channel, breakStart } = boundaryChannel(0);
        const handed = helperFuncs.getCurrentProgramAndTimeElapsed(breakStart - 4 * SEC, channel);
        suite.check('4s before a show ends, the break is handed over at 0 elapsed (unchanged)',
            handed.programIndex === 1 && handed.timeElapsed === 0,
            `index ${handed.programIndex}, elapsed ${handed.timeElapsed}`);
        suite.check('... and says it really starts in 4s',
            handed.startsIn === 4 * SEC, `startsIn ${handed.startsIn}`);

        const inside = helperFuncs.getCurrentProgramAndTimeElapsed(breakStart + 30 * SEC, channel);
        suite.check('30s into the break, nothing was handed early: startsIn 0',
            inside.programIndex === 1 && inside.timeElapsed === 30 * SEC && inside.startsIn === 0,
            `index ${inside.programIndex}, elapsed ${inside.timeElapsed}, startsIn ${inside.startsIn}`);

        const mid = helperFuncs.getCurrentProgramAndTimeElapsed(breakStart - 5 * MIN, channel);
        suite.check('mid-show, startsIn 0',
            mid.programIndex === 0 && mid.startsIn === 0, `index ${mid.programIndex}, startsIn ${mid.startsIn}`);
    }

    // ------------------------------------- the first clip's mix at a boundary
    for (const offsetMs of [0, 920]) {
        for (const early of [0.5, 2, 5, 9.9]) {
            const { channel, breakStart } = boundaryChannel(offsetMs);
            const t0 = breakStart - early * SEC;
            const obj = helperFuncs.getCurrentProgramAndTimeElapsed(t0, channel);
            const fillers = fillersFor(channel);
            const owners = {};
            for (let i = 0; i < 50; i++) {
                const item = helperFuncs.createLineup(freshStore(), obj, channel, fillers, false, t0).shift();
                const owner = item.type === 'commercial' ? ownerOf(item.title) : `<${item.type}>`;
                owners[owner] = (owners[owner] || 0) + 1;
            }
            suite.check(`next show ${offsetMs}ms after the boundary, stream ${early}s early: the first clip is from the incoming mix`,
                Object.keys(owners).length === 1 && owners.Incoming === 50, JSON.stringify(owners));
        }
    }

    // ------------------------------- findNextProgram counts from the real start
    {
        const { channel, breakStart, boundary } = boundaryChannel(0);
        const t0 = breakStart - 6 * SEC;
        const obj = helperFuncs.getCurrentProgramAndTimeElapsed(t0, channel);
        const next = dayParts.findNextProgram(channel, t0, obj);
        suite.check('findNextProgram puts the next show at its real start, not 6s early',
            next !== null && next.startTime === boundary, next ? `${next.startTime - boundary}ms off` : 'null');
    }

    // ------------------------------------------- the break's honest length
    {
        // A 60s break handed over 8s early really has 68s left. The only clip
        // in the mix runs 75s: today's picker allows up to SLACK past the
        // time left, so it fits 68s but not the 60s the hand-off reports.
        const boundary = at('2026-10-02T03:00:00');
        const brk = flex(1);
        const before = show('Before', 22);
        const channel = {
            number: 8, name: 'Length', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0,
            fillerCollections: mix([['Long', 100]]),
            programs: [before, brk, show('After', 22)],
            startTime: new Date(boundary - brk.duration - before.duration).toISOString(),
        };
        channel.duration = channel.programs.reduce((a, p) => a + p.duration, 0);
        const long = { title: 'Long#1', key: '/f/Long#1', duration: 75 * SEC, serverKey: 'srv' };
        const fillers = [{ id: 'Long', content: [long], weight: 100, cooldown: 0 }];
        const t0 = boundary - brk.duration - 8 * SEC;
        const obj = helperFuncs.getCurrentProgramAndTimeElapsed(t0, channel);
        const item = helperFuncs.createLineup(freshStore(), obj, channel, fillers, false, t0).shift();
        suite.check('a break handed over 8s early is filled as 68s long: the 75s clip fits',
            item.type === 'commercial' && item.title === 'Long#1', `${item.type} ${item.title}`);
    }

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
