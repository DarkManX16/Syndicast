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
        g.setWorking(true, 'F:');
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

        g.setWorking(true, 'F:');
        feed(14000, [ stream(0.97) ], 0.3);
        suite.check('a second pause within the hour waits twice as long',
            g.lastWaitMs === 20 * MIN);
        g.setWorking(false);
        feed(20 * MIN, [], 0.3);
        g.setWorking(true, 'F:');
        feed(14000, [ stream(0.97) ], 0.3);
        g.setWorking(false);
        feed(40 * MIN, [], 0.3);
        g.setWorking(true, 'F:');
        feed(14000, [ stream(0.97) ], 0.3);
        g.setWorking(false);
        feed(80 * MIN, [], 0.3);
        g.setWorking(true, 'F:');
        feed(14000, [ stream(0.97) ], 0.3);
        suite.check('...doubling each time, up to 2 hours',
            g.lastWaitMs === 2 * 60 * MIN);
        g.setWorking(false);
        feed(2 * 60 * MIN + 61 * MIN, [], 0.3);
        g.setWorking(true, 'F:');
        feed(14000, [ stream(0.97) ], 0.3);
        suite.check('a pause over an hour after the last one is back to 10 minutes',
            g.lastWaitMs === 10 * MIN);
    }

    {
        const { g, feed } = rig();
        const at = feed(30000, [ stream(0.95) ], 0.3);
        suite.check('a slow stream while the scanner is not working never pauses it',
            (at === null) && (g.mode() === 'gentle'));
        g.setWorking(true, 'F:');
        const now = feed(30000, [ stream(0.95) ], 0.3);
        // Before Nov 12 this paused at once, counting the slowness from before the scanner
        // started; now only time spent reading the viewer's drive counts.
        suite.check('...and the scanner starting on that stream\'s drive while it is slow pauses after 10 s of reading it',
            now === 12000, now);
    }

    {
        // A break of short bumpers on a starved channel: each item gives no
        // reading for its first few seconds, then a few low ones, then ends.
        const { g, feed } = rig();
        g.setWorking(true, 'F:');
        const bumper = (id) => [
            [ 4000, [ stream(null, { id, title: `CN City Bumper (${id})` }) ] ],
            [ 4000, [ stream(0.60, { id, title: `CN City Bumper (${id})` }) ] ],
        ];
        let at = null;
        let elapsed = 0;
        for (const [ms, live] of [ ...bumper(11), ...bumper(12), ...bumper(13) ]) {
            const p = feed(ms, live, 0.3);
            if ( (p !== null) && (at === null) ) {
                at = elapsed + p;
            }
            elapsed += ms;
        }
        suite.check('a run of short items, none slow for 10 s on its own, pauses once the channel has been slow for 10 s',
            (at === 16000) && /channel 2's CN City Bumper \(12\) fell to 0\.600/.test(g.reason()), at);
    }

    {
        const { g, feed } = rig();
        g.setWorking(true, 'F:');
        const at = feed(30000, [ stream(0.97, { id: 1, title: 'Viewer A' }), stream(1.0, { id: 2, title: 'Viewer B' }) ], 0.3);
        suite.check('two viewers of one channel, one slow: the slow one still pauses the scanner',
            (at === 12000) && /Viewer A fell to 0\.970/.test(g.reason()), at);
    }

    {
        const { g, feed } = rig();
        g.setWorking(true, 'F:');
        feed(6000, [ stream(0.97) ], 0.3);
        const at = feed(30000, [], 0.3);
        feed(6000, [ stream(0.97, { id: 9 }) ], 0.3);
        suite.check('a channel no one is watching any more ends its count',
            (at === null) && (g.mode() !== 'paused'));
    }

    {
        const { g, feed } = rig();
        g.setWorking(true, 'F:');
        const at = feed(30000, [ stream(0.0, { held: true, title: 'ATHF promo [Party]' }) ], 0.3);
        suite.check('an item held back by its reader (a slow viewer, or none left) never pauses the scanner, even at 0.000',
            (at === null) && (g.mode() === 'gentle') && (g.paceReport().length === 0));
    }

    {
        const { g, feed } = rig();
        g.setWorking(true, 'F:');
        feed(8000, [ stream(0.98) ], 0.3);
        feed(2000, [ stream(1.0) ], 0.3);
        const at = feed(8000, [ stream(0.98) ], 0.3);
        suite.check('the 10 s must be unbroken: a reading back at 1.00 starts the count again',
            at === null);
    }

    {
        const { g, feed } = rig();
        g.setWorking(true, 'F:');
        const at = feed(40000, [], 0.9);
        suite.check('the PC above 85% for 30 s while working: paused, after 30 s and not before',
            (at !== null) && (at >= constants.CPU_PAUSE_FOR_MS) && (at <= constants.CPU_PAUSE_FOR_MS + 2000), at);
        suite.check('...saying so',
            /CPU stayed above 85% for 30 s/.test(g.reason()));
    }

    {
        const { g, feed } = rig();
        g.setWorking(true, 'F:');
        feed(20000, [], 0.9);
        const at = feed(20000, [], 0.8);
        suite.check('a dip under 85% inside the 30 s means no pause',
            at === null);
    }

    {
        const { g, feed } = rig();
        g.setManualPaused(true);
        g.setWorking(true, 'F:');
        const at = feed(20000, [ stream(0.9) ], 0.95);
        suite.check('paused by hand: Off, and the automatic pause never fires',
            (g.mode() === 'off') && (at === null) && (g.reason() === 'Paused by hand'));
        g.setManualPaused(false);
        suite.check('resumed by hand: back to the mode the feed calls for, both logged',
            (g.mode() === 'gentle') && (g.log.filter( (e) => (e.kind === 'off') || (e.kind === 'on') ).length === 2));
    }

    {
        const { g, feed } = rig();
        g.setWorking(true, 'F:');
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
        g.setWorking(true, 'F:');
        feed(14000, [ stream(0.97) ], 0.2);
        suite.check('...and still pauses for a slow stream',
            g.mode() === 'paused');
        g.setWorking(false);
        feed(10 * MIN, [ stream(1.0) ], 0.2);
        suite.check('...coming back Gentle, as any pause does, until it finishes a file',
            (g.mode() === 'gentle') && g.log.some( (e) => e.text === 'Resumed Gentle after the pause' ));
        g.fileDone();
        suite.check('...and Normal again after that',
            g.mode() === 'normal');
    }

    // ---- only a slowdown on the drive being read pauses (Ron, Nov 12) -----------------
    // The first day on 18000: 14 pauses, none with the scanner on the slow viewer's drive.
    {
        const { g, feed } = rig();
        g.setWorking(true, 'D:');
        const paused = feed(60000, [ stream(0.95, { drive: 'G:' }) ], 0.2);
        suite.check('a viewer slow on another drive than the one being read never pauses the scanner',
            (paused === null) && (g.mode() !== 'paused'), paused);
    }
    {
        const { g, feed } = rig();
        g.setWorking(true, 'G:');
        const paused = feed(30000, [ stream(0.95, { drive: 'G:' }) ], 0.2);
        suite.check('...one slow on the drive being read pauses it after 10 s, as before',
            paused === 12000, paused);
        const entry = g.log.find( (e) => e.kind === 'pause' );
        suite.check('...its log entry names both drives',
            (entry.drive === 'G:') && (entry.scanningDrive === 'G:'), JSON.stringify(entry));
    }
    {
        const { g, feed } = rig();
        g.setWorking(true, 'D:');
        feed(8000, [ stream(0.95, { drive: 'G:' }) ], 0.2);
        g.fileDone();
        g.setWorking(true, 'G:');
        const paused = feed(30000, [ stream(0.95, { drive: 'G:' }) ], 0.2);
        suite.check('a slow stretch counts only from when the scanner starts reading that viewer\'s drive',
            paused === 12000, paused);
    }
    {
        const { g, feed } = rig();
        g.setWorking(true, 'G:');
        feed(4000, [ stream(0.95, { drive: 'G:' }) ], 0.2);
        g.setWorking(false);   // Gentle's rest between two runs on the same file
        feed(4000, [ stream(0.95, { drive: 'G:' }) ], 0.2);
        g.setWorking(true, 'G:');
        const paused = feed(10000, [ stream(0.95, { drive: 'G:' }) ], 0.2);
        suite.check('...and goes on counting through the rests between runs of the same file',
            paused === 4000, paused);
    }
    {
        const { g, feed } = rig();
        g.setWorking(true, 'D:');
        const paused = feed(40000, [ stream(1.0, { drive: 'G:' }) ], 0.9);
        suite.check('the PC\'s CPU above 85% for 30 s still pauses it, whatever drive it reads',
            (paused !== null) && /CPU stayed above 85%/.test(g.pauseReason), `${paused} ${g.pauseReason}`);
    }

    return suite;
};
