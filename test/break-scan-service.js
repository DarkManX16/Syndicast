/*
 * The background break scanner (src/services/break-scan-service.js): what it
 * scans and in what order, saving each file as it finishes, pausing and
 * resuming in the middle of a file, Gentle's rests and drive rule, the time
 * limit and retries, and a restart picking up where it left off. ffmpeg,
 * ffprobe, the files' sizes and the clock are stand-ins; the store is real,
 * in a temporary folder (docs/blocks-spec.md, Stage 6).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Suite } = require('./support');
const store = require('../src/breaks-store');
const BreakScanService = require('../src/services/break-scan-service');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function program(title, file, minutes, extra = {}) {
    return Object.assign( { type: 'episode', showTitle: title, title: 'Ep', file, duration: minutes * MIN, ratingKey: String(file.length) }, extra );
}
const flex = (minutes) => ({ isOffline: true, duration: minutes * MIN });

function rig(folder, options = {}) {
    const state = { now: Date.UTC(2026, 9, 28, 1, 0, 0), calls: [], live: [], cpu: 0.2, runMs: 2000 };
    const channels = options.channels || [];
    const service = new BreakScanService( Object.assign( {
        folder,
        channelService: { getAllChannels: async () => channels },
        getFfmpegSettings: () => ({ ffmpegPath: 'ffmpeg' }),
        meter: { live: () => state.live },
        cpu: { sample: () => state.cpu },
        now: () => state.now,
        log: () => {},
        stat: async (p) => {
            if (p.includes('missing')) {
                throw Object.assign(new Error(`ENOENT: no such file, stat '${p}'`), { code: 'ENOENT' });
            }
            return { size: 1000, mtimeMs: 5 };
        },
        sleep: async (ms) => {
            state.now += ms;
            await new Promise( (r) => setImmediate(r) );
        },
        force: null,
        runner: async (cmd, args, opts) => {
            const call = { cmd, args, startedAt: state.now };
            state.calls.push(call);
            if (state.during) {
                const r = await state.during(call, opts);
                if (r) {
                    return r;
                }
            }
            state.now += state.runMs;
            call.endedAt = state.now;
            if (cmd === 'ffprobe') {
                return { code: 0, stdout: JSON.stringify( { format: { duration: String(state.durationS || 1500) }, chapters: [] } ), stderr: '' };
            }
            if (state.fail) {
                return { code: 1, stderr: 'Invalid data found when processing input' };
            }
            const ss = args[args.indexOf('-ss') + 1];
            if (args.join(' ').includes('silencedetect') && (ss === '300.000')) {
                return { code: 0, stderr: 'silence_start: 100.0\nsilence_end: 101.0 | silence_duration: 1.0\n' };
            }
            if (args.join(' ').includes('blackdetect')) {
                return { code: 0, stderr: 'black_start:0.9 black_end:2.0 black_duration:1.1\n' };
            }
            return { code: 0, stderr: '' };
        },
    }, options.service || {} ) );
    return { service, state };
}

const silenceStarts = (state) => state.calls.filter( (c) => c.args.join(' ').includes('silencedetect') ).map( (c) => c.args[c.args.indexOf('-ss') + 1] );

module.exports = async () => {
    const suite = new Suite('break scan service');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'break-scan-service-'));

    try {
        // ---- when things air -------------------------------------------------------------
        {
            const now = Date.UTC(2026, 9, 28, 1, 0, 0);
            const channel = { startTime: new Date(now - 40 * MIN).toISOString(), programs: [ program('A', 'G:\\a.mkv', 30), flex(10), program('B', 'G:\\b.mkv', 20) ] };
            const at = BreakScanService.airingsOf(channel, now).map( (a) => (a.nextAt - now) / MIN );
            suite.check('each entry\'s next airing: on now counts from when it started, the rest wrap round the lineup',
                JSON.stringify(at) === JSON.stringify([ 20, 50, 0 ]), JSON.stringify(at));
        }

        // ---- the order --------------------------------------------------------------------
        const folder = path.join(tmp, 'order');
        fs.mkdirSync(folder);
        const breaksDir = path.join(folder, 'breaks');
        store.saveShow(breaksDir, 'movie.The Iron Giant', { theatrical: true, pattern: null, files: {} });
        const ch1 = { number: 1, startTime: new Date(Date.UTC(2026, 9, 28, 0, 0, 0)).toISOString(), programs: [
            program('Happy Days', 'G:\\HD\\s01e01.mkv', 30),             // 0:00, airing now (1:00 is round 2... see below)
            flex(5),
            program('Cheers', 'F:\\Cheers\\s01e01.mkv', 25),
            program('The Iron Giant', 'E:\\Movies\\iron.mkv', 90, { type: 'movie', title: 'The Iron Giant' }),
            program('Happy Days', 'G:\\HD\\s01e01.mkv', 30),             // the same file again
            program('Radio', 'E:\\a.mp3', 3, { type: 'track' }),
            program('Nothing', '', 10),
        ] };
        const ch2 = { number: 2, startTime: new Date(Date.UTC(2026, 9, 28, 0, 30, 0)).toISOString(), programs: [
            program('Long', 'H:\\long.mkv', 8 * 24 * 60),               // on now, for 8 days
            program('Later', 'H:\\later.mkv', 60),                      // after it: next week
            program('Last', 'D:\\last.mkv', 60),
        ] };
        const { service, state } = rig(folder, { channels: [ ch1, ch2 ] });
        await service.init();
        await service.buildOnce();
        const order = service.queue.map( (e) => e.path );
        suite.check('this week\'s files soonest first, then the rest by next airing; each file once',
            JSON.stringify(order) === JSON.stringify([ 'H:\\long.mkv', 'G:\\HD\\s01e01.mkv', 'F:\\Cheers\\s01e01.mkv', 'H:\\later.mkv', 'D:\\last.mkv' ]), JSON.stringify(order));
        suite.check('theatrical movies, music, Flex and entries with no file are never queued',
            ! order.some( (p) => /iron|mp3/.test(p) ) && (service.queue.length === 5));
        suite.check('how much is scanned is counted for the week and the whole library',
            JSON.stringify(service.counts) === JSON.stringify( { week: { files: 3, scanned: 0 }, library: { files: 5, scanned: 0 } } ));

        // ---- one file, saved when it finishes ----------------------------------------------
        const hd = service.queue.find( (e) => e.path === 'G:\\HD\\s01e01.mkv' );
        const outcome = await service.scanOne(hd);
        const saved = store.loadShow(breaksDir, 'tv.Happy Days').files['G:\\HD\\s01e01.mkv'];
        suite.check('a file is probed, scanned in 5-minute pieces, and its record saved under its show',
            (outcome === 'scanned') && (state.calls[0].cmd === 'ffprobe') && (silenceStarts(state).join(',') === '0.000,300.000,600.000,900.000,1200.000') && (saved.size === 1000) && (saved.durationMs === 1500000));
        suite.check('...with the point the made-up silence and black make',
            (saved.points.length === 1) && (Math.abs(saved.points[0].at - 401) < 1.5), JSON.stringify(saved.points));
        const callsBefore = state.calls.length;
        const again = await service.scanOne(hd);
        suite.check('a file with a current record is checked by its size and date, not scanned again',
            (again === 'current') && (state.calls.length === callsBefore));
        suite.check('the counts move as files finish',
            (service.counts.week.scanned === 1) && (service.counts.library.scanned === 1));

        // ---- a restart -------------------------------------------------------------------
        const later = service.queue.find( (e) => e.path === 'H:\\later.mkv' );
        await service.scanOne(later);
        const restarted = rig(folder, { channels: [ ch1, ch2 ] });
        await restarted.service.init();
        await restarted.service.buildOnce();
        const order2 = restarted.service.queue.map( (e) => e.path );
        suite.check('after a restart: files scanned outside the week are not queued again, the rest are where they were',
            JSON.stringify(order2) === JSON.stringify([ 'H:\\long.mkv', 'G:\\HD\\s01e01.mkv', 'F:\\Cheers\\s01e01.mkv', 'D:\\last.mkv' ]), JSON.stringify(order2));
        const recheck = await restarted.service.scanOne(restarted.service.queue[1]);
        suite.check('...and this week\'s already-scanned file is only checked, with no ffmpeg',
            (recheck === 'current') && (restarted.state.calls.length === 0));

        // ---- the drive rule -------------------------------------------------------------
        restarted.state.live = [ { id: 1, channel: 2, title: 'Long', drive: 'H:', pace: 1.0 } ];
        restarted.service.tick();
        suite.check('in Gentle a file on a drive a live stream is reading waits; another drive goes first',
            (restarted.service.governor.mode() === 'gentle') && (restarted.service.pickNext('gentle').path === 'G:\\HD\\s01e01.mkv'));
        restarted.service.queue = restarted.service.queue.filter( (e) => e.drive === 'H:' );
        suite.check('...and when every file left is on that drive, nothing is picked',
            restarted.service.pickNext('gentle') === null);
        suite.check('in Normal there is no drive rule',
            restarted.service.pickNext('normal').path === 'H:\\long.mkv');

        // ---- a pause in the middle of a file --------------------------------------------
        {
            const f = path.join(tmp, 'pause');
            fs.mkdirSync(f);
            const { service: s, state: st } = rig(f, { channels: [ ch1 ] });
            await s.init();
            await s.buildOnce();
            st.durationS = 900;
            let lowFrom = null;
            let abortedAt = null;
            st.during = async (call, opts) => {
                const ss = call.args[call.args.indexOf('-ss') + 1];
                if ( (lowFrom === null) && call.args.join(' ').includes('silencedetect') && (ss === '300.000') ) {
                    st.live = [ { id: 7, channel: 2, title: 'Cheers', drive: 'F:', pace: 0.97 } ];
                    lowFrom = st.now;
                    while (! opts.signal.aborted) {
                        st.now += 2000;
                        s.tick();
                    }
                    abortedAt = st.now;
                    st.live = [ { id: 7, channel: 2, title: 'Cheers', drive: 'F:', pace: 1.0 } ];
                    return { code: null, stderr: '', aborted: true };
                }
                return null;
            };
            const entry = s.queue.find( (e) => e.path === 'G:\\HD\\s01e01.mkv' );
            const result = await s.scanOne(entry);
            const pieces = silenceStarts(st);
            suite.check('a live item below 0.99 stops the scanner\'s ffmpeg once it has been low for 10 s',
                (abortedAt - lowFrom) === 12000, abortedAt - lowFrom);   // first low reading at the first 2 s tick
            suite.check('...the stopped piece runs again from its start after the 10-minute wait, and the file is saved',
                (result === 'scanned') && (pieces.join(',') === '0.000,300.000,300.000,600.000') && (st.calls[3].startedAt - abortedAt >= 10 * MIN), pieces.join(','));
            s.tick();
            suite.check('...with the pause and the resume in the log',
                s.governor.log.some( (e) => /^Paused for 10 min: channel 2's Cheers fell to 0\.970$/.test(e.text) ) && s.governor.log.some( (e) => e.text === 'Resumed Gentle after the pause' ));

            // Gentle's rest: with Cheers still playing, each run is followed by twice its length.
            const gaps = [];
            for (let i = 4; i < st.calls.length; i++) {
                gaps.push(st.calls[i].startedAt - st.calls[i - 1].endedAt);
            }
            suite.check('in Gentle each ffmpeg run is followed by a rest twice as long as it ran',
                gaps.length > 0 && gaps.every( (g) => g >= 2 * st.runMs ), JSON.stringify(gaps));
        }

        // ---- the time limit, and failures ------------------------------------------------
        {
            const f = path.join(tmp, 'limit');
            fs.mkdirSync(f);
            const { service: s, state: st } = rig(f, { channels: [ ch1 ] });
            await s.init();
            await s.buildOnce();
            st.durationS = 3600;
            st.runMs = 6 * MIN;
            const entry = s.queue.find( (e) => e.path === 'G:\\HD\\s01e01.mkv' );
            const result = await s.scanOne(entry);
            const record = store.loadShow(path.join(f, 'breaks'), 'tv.Happy Days').files[entry.path];
            suite.check('a file whose ffmpeg runs reach 15 minutes is stopped, with nothing more run',
                (result === 'failed') && (st.calls.length === 3) && /stopped after 15 minutes/.test(record.error.message), st.calls.length);
            suite.check('...and tried again a day later',
                record.error.retryAt === st.now + DAY);
            suite.check('...which the log says',
                s.governor.log.some( (e) => (e.kind === 'limit') && /trying again tomorrow/.test(e.text) ));
            await s.buildOnce();
            suite.check('before the day is up it is not queued',
                ! s.queue.some( (e) => e.path === entry.path ));
            st.now += DAY + 1;
            await s.buildOnce();
            suite.check('after it, it is',
                s.queue.some( (e) => e.path === entry.path ));
        }
        {
            const f = path.join(tmp, 'hung');
            fs.mkdirSync(f);
            const { service: s, state: st } = rig(f, { channels: [ ch1 ], service: { fileLimitMs: 50 } });
            await s.init();
            await s.buildOnce();
            st.during = (call, opts) => new Promise( (resolve) => {
                opts.signal.addEventListener('abort', () => resolve( { code: null, stderr: '', aborted: true } ));
            } );
            const result = await s.scanOne(s.queue.find( (e) => e.path === 'G:\\HD\\s01e01.mkv' ));
            suite.check('one ffmpeg that hangs is stopped when the time limit runs out',
                (result === 'failed') && (st.calls.length === 1));
        }
        {
            const f = path.join(tmp, 'fail');
            fs.mkdirSync(f);
            const { service: s, state: st } = rig(f, { channels: [ ch1 ] });
            await s.init();
            await s.buildOnce();
            st.fail = true;
            const entry = s.queue.find( (e) => e.path === 'F:\\Cheers\\s01e01.mkv' );
            const result = await s.scanOne(entry);
            const record = store.loadShow(path.join(f, 'breaks'), 'tv.Cheers').files[entry.path];
            suite.check('an ffmpeg that fails is a failed scan, not an empty one, retried a day later',
                (result === 'failed') && /exited with code 1/.test(record.error.message) && (record.error.retryAt === st.now + DAY) && (record.points.length === 0));
            const gone = await s.scanOne( { path: 'G:\\missing.mkv', key: 'tv.Gone', title: 'Gone', drive: 'G:', ratingKey: '1' } );
            suite.check('a file that cannot be found is recorded the same way, with no ffmpeg run',
                (gone === 'failed') && (st.calls.length === 2) && (store.loadShow(path.join(f, 'breaks'), 'tv.Gone').files['G:\\missing.mkv'].error.retryAt === st.now + DAY));
        }

        // ---- a boot that runs out of file handles ----------------------------------------------
        {
            const f = path.join(tmp, 'boot');
            fs.mkdirSync(f);
            fs.writeFileSync(path.join(f, 'break-scanner.json'), JSON.stringify( { paused: true } ));
            let fails = 1;
            const { service: s } = rig(f, { channels: [ ch1 ], service: {
                indexByPath: (dir) => {
                    if (fails-- > 0) {
                        throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
                    }
                    return store.indexByPath(dir);
                },
            } } );
            await s.init();
            suite.check('a store that cannot be read at boot does not stop the scanner starting; it is not ready, and says so',
                (s.ready === false) && /^Starting/.test(s.status().reason));
            await s.buildOnce();
            suite.check('...the first queue build reads it, and the saved Pause by hand still holds',
                (s.ready === true) && (s.governor.mode() === 'off') && (s.queue.length > 0));
        }
        {
            const f = path.join(tmp, 'boot2');
            fs.mkdirSync(f);
            fs.writeFileSync(path.join(f, 'break-scanner.json'), JSON.stringify( { paused: true } ));
            let fails = 1;
            const { service: s } = rig(f, { channels: [ ch1 ], service: {
                indexByPath: (dir) => {
                    if (fails-- > 0) {
                        throw new Error('EMFILE');
                    }
                    return store.indexByPath(dir);
                },
            } } );
            await s.init();
            await s.setPaused(false);
            // what a load that read the file just before the switch would see
            fs.writeFileSync(path.join(f, 'break-scanner.json'), JSON.stringify( { paused: true } ));
            await s.buildOnce();
            suite.check('a Resume by hand before the store is read is not undone by a Pause read from before it',
                (s.ready === true) && (s.governor.mode() !== 'off'));
        }

        // ---- the hand switch ---------------------------------------------------------------
        {
            const f = path.join(tmp, 'switch');
            fs.mkdirSync(f);
            const { service: s } = rig(f, { channels: [ ch1 ] });
            await s.init();
            await s.setPaused(true);
            const again = rig(f, { channels: [ ch1 ] });
            await again.service.init();
            suite.check('Pause by hand is kept across a restart',
                (again.service.governor.mode() === 'off') && (again.service.status().reason === 'Paused by hand'));
            await again.service.setPaused(false);
            suite.check('...and Resume clears it',
                (again.service.governor.mode() !== 'off') && (JSON.parse(fs.readFileSync(path.join(f, 'break-scanner.json'), 'utf8')).paused === false));
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    return suite;
};
