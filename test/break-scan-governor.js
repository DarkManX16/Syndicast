/*
 * The scanner's modes (src/break-scan-governor.js), driven with a made-up
 * pace and CPU feed on a hand-moved clock (docs/blocks-spec.md, Stage 6, "The
 * scanner, and live streams").
 */
const { Suite } = require('./support');
const { ScanGovernor, constants } = require('../src/break-scan-governor');

const MIN = 60 * 1000;

function rig(options = {}) {
    const state = { now: Date.UTC(2026, 9, 28, 1, 0, 0) };
    const g = new ScanGovernor( Object.assign( { now: () => state.now }, options ) );
    // every 2 s for `ms`, the same live items and CPU each time
    const feed = (ms, live, cpu) => {
        let paused = null;
        for (let t = 0; t < ms; t += 2000) {
            state.now += 2000;
            const r = g.observe( { live, cpu } );
            if (r.pauseNow && (paused === null)) {
                paused = t + 2000;
            }
        }
        return paused;
    };
    return { g, state, feed };
}

const stream = (pace, extra = {}) => Object.assign( { id: 1, channel: 2, title: 'The Jeffersons', drive: 'F:', pace }, extra );

module.exports = async () => {
    const suite = new Suite('break scan governor');

    {
        const { g, feed } = rig();
        feed(10000, [], 0.2);
        suite.check('nothing playing, CPU 20%: Normal',
            (g.mode() === 'normal') && (g.reason() === 'Normal: nothing playing, CPU 20%'), g.reason());
        suite.check('...with no rest between runs',
            g.restMs(4000) === 0);
        feed(10000, [ stream(1.0) ], 0.2);
        suite.check('a stream playing: Gentle, saying how many',
            (g.mode() === 'gentle') && (g.reason() === 'Gentle: 1 stream playing'), g.reason());
        suite.check('...resting twice as long as each run took',
            g.restMs(4000) === 8000);
        suite.check('...and the drive the stream reads is busy',
            g.busyDrives().has('F:') && (g.busyDrives().size === 1));
        feed(12000, [], 0.75);
        suite.check('nothing playing but the PC at 75%: Gentle',
            (g.mode() === 'gentle') && /CPU 75%/.test(g.reason()), g.reason());
        const modes = g.log.filter( (e) => e.kind === 'mode' ).map( (e) => e.text );
        suite.check('the log records each change of mode',
            (modes[0] === 'Normal: nothing playing, CPU 20%') && (modes[1] === 'Gentle: 1 stream playing') && /^Gentle: the PC's CPU \d+%$/.test(modes[modes.length - 1]), modes.join(' / '));
    }

    {
        const { g, state, feed } = rig();
        g.setWorking(true);
        const at = feed(30000, [ stream(0.985) ], 0.3);
        suite.check('a live item below 0.99 for 10 s while the scanner works: paused at the 10 s mark',
            at === 12000, at);  // first low reading at 2 s, so 10 s below by the 12 s tick
        suite.check('...for 10 minutes, saying why and until when',
            (g.mode() === 'paused') && (g.pausedUntil - (state.now - 18000) === 10 * MIN)
            && /^Paused until \d+:\d\d[ap]m: channel 2's The Jeffersons fell to 0\.985$/.test(g.reason()), g.reason());
        g.setWorking(false);
        feed(10 * MIN, [ stream(1.0) ], 0.3);
        suite.check('after the wait it resumes Gentle, and logs it',
            (g.mode() === 'gentle') && g.log.some( (e) => e.text === 'Resumed Gentle after the pause' ));
        feed(4000, [], 0.1);
        suite.check('...staying Gentle with nothing playing until it finishes a file',
            (g.mode() === 'gentle') && (g.reason() === 'Gentle: back from a pause'));
        g.fileDone();
        suite.check('...then Normal',
            g.mode() === 'normal');

        g.setWorking(true);
        feed(14000, [ stream(0.97) ], 0.3);
        suite.check('a second pause within the hour waits twice as long',
            g.lastWaitMs === 20 * MIN);
        g.setWorking(false);
        feed(20 * MIN, [], 0.3);
        g.setWorking(true);
        feed(14000, [ stream(0.97) ], 0.3);
        g.setWorking(false);
        feed(40 * MIN, [], 0.3);
        g.setWorking(true);
        feed(14000, [ stream(0.97) ], 0.3);
        g.setWorking(false);
        feed(80 * MIN, [], 0.3);
        g.setWorking(true);
        feed(14000, [ stream(0.97) ], 0.3);
        suite.check('...doubling each time, up to 2 hours',
            g.lastWaitMs === 2 * 60 * MIN);
        g.setWorking(false);
        feed(2 * 60 * MIN + 61 * MIN, [], 0.3);
        g.setWorking(true);
        feed(14000, [ stream(0.97) ], 0.3);
        suite.check('a pause over an hour after the last one is back to 10 minutes',
            g.lastWaitMs === 10 * MIN);
    }

    {
        const { g, feed } = rig();
        const at = feed(30000, [ stream(0.95) ], 0.3);
        suite.check('a slow stream while the scanner is not working never pauses it',
            (at === null) && (g.mode() === 'gentle'));
        g.setWorking(true);
        const now = feed(4000, [ stream(0.95) ], 0.3);
        suite.check('...but the scanner starting while a stream is already slow pauses at once',
            now === 2000);
    }

    {
        const { g, feed } = rig();
        g.setWorking(true);
        feed(8000, [ stream(0.98) ], 0.3);
        feed(2000, [ stream(1.0) ], 0.3);
        const at = feed(8000, [ stream(0.98) ], 0.3);
        suite.check('the 10 s must be unbroken: a reading back at 1.00 starts the count again',
            at === null);
    }

    {
        const { g, feed } = rig();
        g.setWorking(true);
        const at = feed(40000, [], 0.9);
        suite.check('the PC above 85% for 30 s while working: paused, after 30 s and not before',
            (at !== null) && (at >= constants.CPU_PAUSE_FOR_MS) && (at <= constants.CPU_PAUSE_FOR_MS + 2000), at);
        suite.check('...saying so',
            /CPU stayed above 85% for 30 s/.test(g.reason()));
    }

    {
        const { g, feed } = rig();
        g.setWorking(true);
        feed(20000, [], 0.9);
        const at = feed(20000, [], 0.8);
        suite.check('a dip under 85% inside the 30 s means no pause',
            at === null);
    }

    {
        const { g, feed } = rig();
        g.setManualPaused(true);
        g.setWorking(true);
        const at = feed(20000, [ stream(0.9) ], 0.95);
        suite.check('paused by hand: Off, and the automatic pause never fires',
            (g.mode() === 'off') && (at === null) && (g.reason() === 'Paused by hand'));
        g.setManualPaused(false);
        suite.check('resumed by hand: back to the mode the feed calls for, both logged',
            (g.mode() === 'gentle') && (g.log.filter( (e) => (e.kind === 'off') || (e.kind === 'on') ).length === 2));
    }

    {
        const { g, feed } = rig();
        g.setWorking(true);
        feed(6000, [ stream(1.0) ], 0.2);
        g.setWorking(false);
        feed(8000, [ stream(0.999) ], 0.2);
        const report = g.paceReport()[0];
        suite.check('each item\'s pace is kept while scanning and while not, apart',
            (report.scanning.samples === 3) && (report.idle.samples === 4) && (report.idle.lowest === 0.999));
    }

    {
        const { g, feed } = rig( { force: 'normal' } );
        feed(6000, [ stream(1.0) ], 0.2);
        suite.check('a forced Normal (for a proof) runs Normal with streams playing, and says it is forced',
            (g.mode() === 'normal') && (g.reason() === 'Normal (forced): 1 stream playing'), g.reason());
        g.setWorking(true);
        feed(14000, [ stream(0.97) ], 0.2);
        suite.check('...and still pauses for a slow stream',
            g.mode() === 'paused');
    }

    return suite;
};
