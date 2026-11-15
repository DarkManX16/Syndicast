/*
 * The frame grabber (src/break-frames.js) for step 5c (docs/blocks-spec.md, Stage 6): at most
 * two cuts at once, a request the page cancelled dropped from the queue or its ffmpeg stopped,
 * and a drive a viewer is playing from not read for a frame not already cut ("drive busy").
 * The scan service is a stand-in; ffmpeg is a runner the test holds and lets go of.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Suite } = require('./support');
const { FrameGrabber, FrameError } = require('../src/break-frames');

function rig(tmp) {
    const state = { running: 0, max: 0, runs: [], busy: new Set(), release: [] };
    const index = new Map();
    for (const f of [ 'G:\\A\\e1.mkv', 'G:\\A\\e2.mkv', 'G:\\A\\e3.mkv', 'G:\\A\\e4.mkv', 'G:\\A\\e5.mkv', 'F:\\B\\e1.mkv' ]) {
        index.set(f, { key: 'tv.A', record: { size: 1, mtimeMs: 1 } });
    }
    const service = {
        options: { folder: tmp, getFfmpegSettings: () => ({ ffmpegPath: 'ffmpeg' }) },
        index,
        isSkipped: () => false,
        governor: { isPaused: () => false, busyDrives: () => state.busy },
        disk: { lower: async () => {} },
        // ffmpeg: holds until the test lets it go, or until it is stopped
        baseRunner: (cmd, args, opts) => new Promise( (resolve) => {
            const run = { args, signal: opts.signal, stopped: false };
            state.runs.push(run);
            state.running++;
            state.max = Math.max(state.max, state.running);
            const finish = (r) => {
                state.running--;
                resolve(r);
            };
            opts.signal.addEventListener('abort', () => {
                run.stopped = true;
                finish( { code: null, stderr: '', aborted: true } );
            }, { once: true } );
            state.release.push( () => {
                if (! run.stopped) {
                    fs.writeFileSync(args[args.length - 1], 'jpeg');
                    finish( { code: 0, stderr: '' } );
                }
            } );
        } ),
    };
    return { grabber: new FrameGrabber(service, { dir: path.join(tmp, 'frames') }), state };
}

const sleep = (ms) => new Promise( (r) => setTimeout(r, ms) );
const settle = (p) => p.then( (v) => ({ ok: true, v }), (e) => ({ ok: false, e }) );
// Waits (up to two seconds) for what the grabber does on its own time: it makes its folder before a cut.
async function until(cond) {
    for (let i = 0; i < 100 && ! cond(); i++) {
        await sleep(20);
    }
    return cond();
}

module.exports = async () => {
    const suite = new Suite('frame grabber');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'break-frames-'));
    try {
        {
            const { grabber, state } = rig(path.join(tmp, 'two'));
            const asks = [ 1, 2, 3, 4, 5 ].map( (i) => settle(grabber.grab(`G:\\A\\e${i}.mkv`, 10)) );
            await until( () => state.running >= 2 );
            await sleep(150);
            suite.check('five frames asked for at once: two cuts run, the rest wait', (state.running === 2) && (state.max === 2), `${state.running} running`);
            for (let i = 0; i < 5; i++) {
                if (! await until( () => state.release.length > 0 )) {
                    break;
                }
                state.release.shift()();
                await sleep(30);
            }
            const done = await Promise.race( [ Promise.all(asks), sleep(3000).then( () => [] ) ] );
            suite.check('...and all five are cut, never more than two at once', done.every( (d) => d.ok ) && (state.runs.length === 5) && (state.max === 2), `max ${state.max}, ${done.filter( (d) => d.ok ).length} cut`);
        }
        {
            const { grabber, state } = rig(path.join(tmp, 'cancel'));
            const a = new AbortController();
            const b = new AbortController();
            const c = new AbortController();
            const first = settle(grabber.grab('G:\\A\\e1.mkv', 10, { signal: a.signal }));
            const second = settle(grabber.grab('G:\\A\\e2.mkv', 10, { signal: b.signal }));
            const third = settle(grabber.grab('G:\\A\\e3.mkv', 10, { signal: c.signal }));
            await until( () => state.running >= 1 );
            await sleep(100);
            c.abort();
            const dropped = await Promise.race( [ third, sleep(2000).then( () => ({ ok: true, v: 'still waiting' }) ) ] );
            await sleep(50);
            suite.check('a request cancelled while it waits is dropped: no ffmpeg for it',
                ! dropped.ok && (dropped.e instanceof FrameError) && (dropped.e.reason === 'cancelled') && (state.runs.length === 2), `${dropped.e && dropped.e.reason}, ${state.runs.length} runs`);
            a.abort();
            const stopped = await Promise.race( [ first, sleep(2000).then( () => ({ ok: true, v: 'still running' }) ) ] );
            suite.check('a request cancelled while its ffmpeg runs stops that ffmpeg',
                ! stopped.ok && (stopped.e.reason === 'cancelled') && state.runs[0].stopped && ! fs.readdirSync(grabber.dir).some( (f) => f.endsWith('.part.jpg') ), `${stopped.e && stopped.e.reason}`);
            // let everything still held go, the serial chain's turns included
            let kept = null;
            for (let i = 0; i < 4 && kept === null; i++) {
                await until( () => state.release.length > 0 );
                state.release.splice(0).forEach( (r) => r() );
                kept = await Promise.race( [ second, sleep(300).then( () => null ) ] );
            }
            suite.check('...the other one is cut as before', (kept !== null) && kept.ok && fs.existsSync(kept.v));
        }
        {
            const { grabber, state } = rig(path.join(tmp, 'busy'));
            const cut = settle(grabber.grab('G:\\A\\e1.mkv', 10));
            await until( () => state.release.length > 0 );
            state.release.splice(0).forEach( (r) => r() );
            const before = await cut;
            state.busy = new Set( [ 'G:' ] );
            const busyAsk = settle(grabber.grab('G:\\A\\e2.mkv', 10));
            const busy = await Promise.race( [ busyAsk, sleep(1000).then( () => ({ ok: true, v: 'still waiting' }) ) ] );
            state.release.splice(0).forEach( (r) => r() );
            suite.check('a frame not cut yet, on a drive a viewer is playing from, is not read: "drive busy" at once',
                ! busy.ok && (busy.e.reason === 'busy') && /drive busy/.test(busy.e.message) && (state.runs.length === 1), `${busy.e && busy.e.reason}: ${busy.e && busy.e.message}, ${state.runs.length} runs`);
            const again = await settle(grabber.grab('G:\\A\\e1.mkv', 10));
            suite.check('...a frame cut before still shows', again.ok && (again.v === before.v));
            const other = settle(grabber.grab('F:\\B\\e1.mkv', 10));
            await until( () => state.release.length > 0 );
            state.release.splice(0).forEach( (r) => r() );
            const otherDone = await Promise.race( [ other, sleep(2000).then( () => ({ ok: false }) ) ] );
            suite.check('...and another drive is read as before', otherDone.ok);
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    return suite;
};
