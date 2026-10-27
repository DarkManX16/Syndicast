/*
 * Running ffmpeg to find a file's break points (src/break-scan.js). ffmpeg is
 * a stand-in here: the fake runner answers each call the way real
 * silencedetect/blackdetect would and records every command, so the tests
 * check both the parsed result and that scanning stayed idle-priority,
 * read-only and one process at a time.
 */
const { Suite } = require('./support');
const scan = require('../src/break-scan');

function fakeRunner(state, { silenceByStart = {}, blackByStart = {} } = {}) {
    return async (ffmpegPath, args) => {
        state.calls.push( { ffmpegPath, args } );
        const joined = args.join(' ');
        const ss = args[args.indexOf('-ss') + 1];
        if (joined.includes('silencedetect')) {
            return { code: 0, stderr: silenceByStart[ss] || '' };
        }
        if (joined.includes('blackdetect')) {
            return { code: 0, stderr: blackByStart[ss] || '' };
        }
        return { code: 0, stderr: '' };
    };
}

module.exports = async () => {
    const suite = new Suite('break scan');

    // ---- scanSilence: chunked, offsets by each chunk's start -----------------------------
    await (async () => {
        const state = { calls: [] };
        const run = fakeRunner(state, {
            silenceByStart: {
                '0.000': 'silence_start: 74.0\nsilence_end: 75.2 | silence_duration: 1.2\n',
                '300.000': 'silence_start: 5.6\nsilence_end: 7.1 | silence_duration: 1.5\n', // 305.6-307.1 absolute
            },
        });
        const silence = await scan.scanSilence('/x.mkv', 620, { run });
        suite.check('5-minute chunks, each run from its own start',
            JSON.stringify(state.calls.map( (c) => c.args[c.args.indexOf('-ss') + 1] )) === JSON.stringify(['0.000', '300.000', '600.000']));
        suite.check('every chunk is one thread, audio only, no re-encode of the picture',
            state.calls.every( (c) => c.args.includes('-threads') && c.args.includes('1') && c.args.includes('-vn') ));
        suite.check('relative times are offset back to absolute, by each chunk\'s start',
            JSON.stringify(silence) === JSON.stringify([[74.0, 75.2], [305.6, 307.1]]));
    })();

    // ---- scanBlackWindows: one run per window, scaled down first -------------------------
    await (async () => {
        const state = { calls: [] };
        const run = fakeRunner(state, {
            blackByStart: { '29.000': 'black_start:1.73 black_end:2.46\n', '649.000': '' },
        });
        const black = await scan.scanBlackWindows('/x.mkv', [[29, 31], [649, 651]], { run });
        suite.check('one ffmpeg per window',
            state.calls.length === 2);
        suite.check('the picture is scaled down before blackdetect runs',
            state.calls.every( (c) => c.args.join(' ').includes('scale=w=192:h=-2') ));
        suite.check('audio is skipped entirely for the black pass',
            state.calls.every( (c) => c.args.includes('-an') ));
        suite.check('offsets back to absolute, and an empty window finds nothing',
            JSON.stringify(black) === JSON.stringify([[30.73, 31.46]]));
    })();

    // ---- idle priority, actually asked for ------------------------------------------------
    await (async () => {
        let askedPriority = null;
        const os = require('os');
        const realSetPriority = os.setPriority;
        os.setPriority = (pid, value) => { askedPriority = value; };
        try {
            await scan.defaultRunner(process.execPath, ['-e', '0']);
        } finally {
            os.setPriority = realSetPriority;
        }
        suite.check('every real run asks the OS for idle (PRIORITY_LOW) priority',
            askedPriority === require('os').constants.priority.PRIORITY_LOW);
    })();

    // ---- scanFile: wires silence into windows into points, and times each phase ----------
    await (async () => {
        const state = { calls: [] };
        const run = fakeRunner(state, {
            silenceByStart: { '0.000': 'silence_start: 74.0\nsilence_end: 75.2 | silence_duration: 1.2\n' },
            blackByStart: { '73.000': 'black_start:1.2 black_end:2.0\n' }, // window starts at 73: relative 1.2-2.0 = absolute 74.2-75.0
        });
        const file = { path: '/show/ep1.mkv', durationS: 600, title: 'Pilot', chapters: [] };
        const result = await scan.scanFile(file, { run });
        suite.check('one point, from a chunk\'s silence carried into a window\'s black',
            (result.points.length === 1) && (result.points[0].kind === 'opening'));
        suite.check('timings are reported for both phases, and the window count matches what was asked',
            (typeof result.timings.silenceMs === 'number') && (result.timings.nWindows === 1) && (result.timings.nSilenceGroups === 1));
    })();

    // beforeChunk runs once per chunk and per window, letting a caller pause between them
    await (async () => {
        let hooks = 0;
        const run = fakeRunner( { calls: [] } );
        await scan.scanSilence('/x.mkv', 620, { run, beforeChunk: async () => { hooks++; } });
        suite.check('scanSilence calls beforeChunk once per 5-minute chunk',
            hooks === 3);
        hooks = 0;
        await scan.scanBlackWindows('/x.mkv', [[0, 2], [10, 12], [20, 22]], { run, beforeChunk: async () => { hooks++; } });
        suite.check('scanBlackWindows calls beforeChunk once per window',
            hooks === 3);
    })();

    return suite;
};
