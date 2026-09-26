/*
 * Saving a channel that is playing stops the stream: the channel-update listener
 * in video.js kills it 100ms later and the client reconnects. That part is
 * deliberate - an edit has to be able to take effect - and this file does not
 * argue with it.
 *
 * What it covers is where the reconnect lands. channel-cache.js's
 * saveChannelConfig flushes the playback cache, so getCurrentLineupItem cannot
 * take its "closed the stream and opened it again let's not lose seconds for no
 * reason" branch and the position is worked out from the wall clock instead.
 * Measured on the dev channels before the fix: every save skipped forward by
 * exactly the reconnect gap, and by ~31 seconds when the stream had been sitting
 * inside createLineup's 30 second tune-in rewind. Both directions of that are
 * checked below, plus the cases where a hint must *not* be used.
 *
 * `startStream` mirrors the sequence video.js runs for a non-redirect,
 * non-loading request. video.js has no seam to call into - the sequence lives
 * inside its express handler - so this is the same arrangement
 * test/blocks-guide.js has with the guide: close enough to be worth having, and
 * it does not prove the wiring in video.js itself, only the behaviour it relies
 * on. Keep the two in step if either changes.
 *
 * Pass channel JSON paths to also measure against real channels:
 *
 *     node test/save-resume.js .dizquetv-dev/channels/2.json
 */
const fs = require('fs');
const path = require('path');
const { helperFuncs, channelCache, Suite, freshStore, show, flex, MIN, HOUR } = require('./support');
const constants = require('../src/constants');

const SLACK = constants.SLACK;

/*
 * One stream start, as video.js does it: resolve the position, let a resume hint
 * override it if the save left this program in place, build the lineup, record
 * the playback.
 */
function startStream(channel, t, store) {
    const prog = helperFuncs.getCurrentProgramAndTimeElapsed(t, channel);
    const upperBounds = [prog.program.duration - prog.timeElapsed];
    const resumeAt = channelCache.takeResumeHint(
        channel.number,
        t,
        prog.program.isOffline === true ? null : prog.program
    );
    if (resumeAt != null) {
        prog.timeElapsed = resumeAt;
        upperBounds[upperBounds.length - 1] = prog.program.duration - prog.timeElapsed;
    }
    const lineup = helperFuncs.createLineup(store, prog, channel, [], false, t);
    const lineupItem = lineup.shift();
    lineupItem.redirectChannels = [channel];
    lineupItem.upperBounds = upperBounds;
    channelCache.recordPlayback(store, channel.number, t, lineupItem);
    return { prog, lineupItem, usedHint: resumeAt != null };
}

// A save, as far as the playback cache is concerned.
function save(channel) {
    channelCache.saveChannelConfig(channel.number, channel);
}

function fixtureChannel() {
    const programs = [
        show('Aqua Teen', 11), flex(3), show('Futurama', 22), flex(2),
        show('Inuyasha', 24), flex(6), show('Cowboy Bebop', 24), flex(1),
    ];
    return {
        number: 88,
        name: 'Resume Fixture',
        startTime: new Date(Date.now() - 5 * HOUR).toISOString(),
        duration: programs.reduce((a, p) => a + p.duration, 0),
        programs,
        fallback: [],
        fillerCollections: [],
        offlineMode: 'pic',
        transcoding: {},
        onDemand: { isOnDemand: false },
    };
}

// An instant a given number of ms into the channel's first program.
function intoFirstProgram(channel, ms) {
    return new Date(channel.startTime).getTime() + ms;
}

module.exports = async function run() {
    const suite = new Suite('save resume');

    // --- the baseline skip: a save must not cost the reconnect gap -----------
    for (const gap of [200, 1500, 3000]) {
        channelCache.clear();
        const ch = fixtureChannel();
        const tA = intoFirstProgram(ch, 5 * MIN);   // comfortably mid-program
        const a = startStream(ch, tA, freshStore());

        // what a reconnect with the cache intact would have resumed at
        const plain = channelCache.getCurrentLineupItem(ch.number, tA + gap);

        save(ch);
        const b = startStream(ch, tA + gap, freshStore());

        suite.check(`${gap}ms reconnect: the hint is used`,
            b.usedHint === true);
        suite.check(`${gap}ms reconnect: resumes exactly where an unflushed one would`,
            plain != null && b.lineupItem.start === plain.start,
            plain == null ? 'unflushed reconnect returned null'
                : `unflushed ${plain.start}, after save ${b.lineupItem.start}`);
        suite.check(`${gap}ms reconnect: does not skip the gap the stop cost`,
            b.lineupItem.start === a.lineupItem.start,
            `started ${a.lineupItem.start}, resumed ${b.lineupItem.start}`);
    }

    // --- the ~31 second jump: a rewound stream must not snap forward ---------
    {
        channelCache.clear();
        const ch = fixtureChannel();
        // inside createLineup's 30s tune-in rewind, close enough to its edge
        // that a reconnect a couple of seconds later falls outside it
        const tA = intoFirstProgram(ch, 29000);
        const a = startStream(ch, tA, freshStore());
        suite.check('a tune-in 29s in is rewound to the start of the program',
            a.lineupItem.start === 0, `start ${a.lineupItem.start}`);

        save(ch);
        const b = startStream(ch, tA + 2000, freshStore());
        suite.check('after a save it stays at the start of the program',
            b.lineupItem.start === 0, `resumed at ${b.lineupItem.start}`);
        suite.check('rather than snapping forward to the wall clock, ~31s ahead',
            helperFuncs.getCurrentProgramAndTimeElapsed(tA + 2000, ch).timeElapsed === 31000,
            'this is the position it would have used without the hint: 31000ms');
    }

    // --- the item is allowed its full remaining length ----------------------
    {
        channelCache.clear();
        const ch = fixtureChannel();
        const tA = intoFirstProgram(ch, 5 * MIN);
        startStream(ch, tA, freshStore());
        save(ch);
        const b = startStream(ch, tA + 3000, freshStore());
        const remaining = b.prog.program.duration - b.lineupItem.start;
        suite.check('streamDuration is not clipped by the stale upper bound',
            b.lineupItem.streamDuration === remaining,
            `streamDuration ${b.lineupItem.streamDuration}, remaining ${remaining}`);
    }

    // --- when the hint must not be used -------------------------------------
    {
        channelCache.clear();
        const ch = fixtureChannel();
        const tA = intoFirstProgram(ch, 5 * MIN);
        startStream(ch, tA, freshStore());
        save(ch);
        // the save replaced the programming: a different show plays now
        const edited = fixtureChannel();
        edited.programs[0] = show('Home Movies', 11);
        const b = startStream(edited, tA + 1000, freshStore());
        suite.check('a save that changed what plays now gets no hint',
            b.usedHint === false);
        suite.check('and falls back to the wall-clock position',
            b.lineupItem.start === helperFuncs
                .getCurrentProgramAndTimeElapsed(tA + 1000, edited).timeElapsed,
            `start ${b.lineupItem.start}`);
    }

    {
        channelCache.clear();
        const ch = fixtureChannel();
        const tA = intoFirstProgram(ch, 5 * MIN);
        startStream(ch, tA, freshStore());
        save(ch);
        startStream(ch, tA + 500, freshStore());          // consumes the hint
        const c = startStream(ch, tA + 9000, freshStore());
        suite.check('a hint answers one reconnect and is then gone',
            c.usedHint === false);
    }

    {
        /*
         * Nothing expires a hint on a timer; it is consumed on read, and by the
         * time anything but the save's own reconnect could reach it the program
         * has moved on, which the identity check catches. This is that case: a
         * reconnect so late that the lineup has advanced past what was playing.
         */
        channelCache.clear();
        const ch = fixtureChannel();
        const tA = intoFirstProgram(ch, 5 * MIN);
        startStream(ch, tA, freshStore());
        save(ch);
        const b = startStream(ch, tA + 7 * MIN, freshStore());
        suite.check('a hint is not used once the lineup has moved past it',
            b.usedHint === false, '7 minutes later, into the next item');
    }

    {
        channelCache.clear();
        const ch = fixtureChannel();
        // land on flex, so the recorded item is a commercial rather than a program
        const flexStart = intoFirstProgram(ch, 11 * MIN + 30000);
        const a = startStream(ch, flexStart, freshStore());
        suite.check('the fixture really does put flex at that instant',
            a.prog.program.isOffline === true);
        save(ch);
        const b = startStream(ch, flexStart + 1000, freshStore());
        suite.check('filler gets no hint - the mix may be what the save changed',
            b.usedHint === false);
    }

    // --- a channel with no stream on it is unaffected ------------------------
    {
        channelCache.clear();
        const ch = fixtureChannel();
        save(ch);
        const b = startStream(ch, intoFirstProgram(ch, 5 * MIN), freshStore());
        suite.check('saving a channel nobody is watching produces no hint',
            b.usedHint === false);
    }

    // --- optional: measure against real channels -----------------------------
    const extras = process.argv.slice(2);
    for (const f of extras) {
        const ch = JSON.parse(fs.readFileSync(f, 'utf8'));
        const total = ch.programs.reduce((a, p) => a + p.duration, 0);
        const t0 = Date.now();
        let hinted = 0, exact = 0, skipped = 0, worst = 0, programs = 0, boundary = 0;
        const gap = 1500;
        for (let s = 0; s < 800; s++) {
            const tA = t0 + Math.floor((s / 800) * total);
            channelCache.clear();
            const a = startStream(ch, tA, freshStore());
            if (a.lineupItem.type !== 'program') {
                continue;
            }
            /*
             * A save in the last seconds of a show has nothing to resume: by the
             * time the client is back the next one has started, and beginning it
             * is the right answer rather than a jump.
             */
            const at = helperFuncs.getCurrentProgramAndTimeElapsed(tA + gap, ch);
            if (at.program.isOffline || at.program.key !== a.lineupItem.key) {
                boundary++;
                continue;
            }
            programs++;
            save(ch);
            const b = startStream(ch, tA + gap, freshStore());
            if (b.usedHint) {
                hinted++;
            }
            const drift = b.lineupItem.start - a.lineupItem.start;
            if (drift === 0) {
                exact++;
            } else {
                skipped++;
                if (Math.abs(drift) > Math.abs(worst)) {
                    worst = drift;
                }
            }
        }
        suite.check(`${path.basename(f)}: every mid-program save resumes where it was`,
            exact === programs && programs > 0,
            `${exact}/${programs} exact, ${hinted} hinted, ${skipped} moved by up to ${worst}ms`
            + `, ${boundary} boundary crossings excluded`);
    }

    channelCache.clear();
    suite.log(`SLACK is ${SLACK}ms, which is the window inside which a reconnect`
        + ' replays rather than skips.');

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
