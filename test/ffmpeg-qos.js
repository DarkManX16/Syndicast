/*
 * src/ffmpeg-qos.js: every ffmpeg marked High QoS on Windows, nothing done
 * anywhere else, one log line when it can't be done, and a helper that goes
 * away with the server. See "Heavy buffering during playback" in NOTES.md.
 *
 * Most checks drive createMarker with a fake platform and a fake spawn, so
 * the failure paths run without Windows actually failing. The last one, on
 * Windows only, starts the real helper: it proves the PowerShell and C# in
 * HELPER_SCRIPT compile and mark a real process, and that the helper exits
 * when its stdin closes, which is what a server exiting or crashing does.
 */
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const childProcess = require('child_process');
const { createMarker } = require('../src/ffmpeg-qos');
const { Suite } = require('./support');

function fakeHelper() {
    const h = new EventEmitter();
    h.stdin = new PassThrough();
    h.stdout = new PassThrough();
    h.stderr = new PassThrough();
    h.written = '';
    h.stdin.on('data', (d) => { h.written += d; });
    h.unref = () => {};
    return h;
}

function harness(platform) {
    const t = { spawns: [], logs: [] };
    t.mark = createMarker({
        platform,
        spawn: (cmd, args, opts) => { const h = fakeHelper(); t.spawns.push({ cmd, args, opts, h }); return h; },
        log: (line) => t.logs.push(line),
    });
    return t;
}

const tick = () => new Promise((r) => setImmediate(r));
const until = async (pred, ms) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    return pred();
};

module.exports = async function () {
    const s = new Suite('ffmpeg-qos');

    {
        const t = harness('linux');
        t.mark({ pid: 123 });
        s.check('off Windows: no helper is started', t.spawns.length === 0 && t.logs.length === 0);
    }
    {
        const t = harness('win32');
        t.mark({ pid: 123 });
        t.mark({ pid: 456 });
        await tick();
        const sp = t.spawns[0];
        s.check('Windows: one helper for every ffmpeg', t.spawns.length === 1, `${t.spawns.length} spawned`);
        s.check('Windows: the helper is PowerShell with the script as plain -Command text, hidden',
            sp && sp.cmd === 'powershell' && sp.args.includes('-Command') && !sp.args.includes('-EncodedCommand') && sp.opts.windowsHide === true);
        s.check('Windows: each pid is sent to the helper', sp && sp.h.written === '123\n456\n', sp && JSON.stringify(sp.h.written));
    }
    {
        const t = harness('win32');
        t.mark({});                 // a child whose spawn failed has no pid
        t.mark(undefined);
        s.check('a child without a pid is skipped', t.spawns.length === 0);
    }
    {
        const t = harness('win32');
        t.mark({ pid: 123 });
        t.spawns[0].h.stdout.write('123 0\n77 87\n');   // 87: the process had already exited
        await tick();
        s.check('a mark that worked, or a process already gone, logs nothing', t.logs.length === 0, t.logs.join(' | '));
    }
    {
        const t = harness('win32');
        t.mark({ pid: 123 });
        t.spawns[0].h.stdout.write('123 5\n');   // access denied
        await tick();
        t.spawns[0].h.stdout.write('456 5\n');
        await tick();
        t.mark({ pid: 789 });
        s.check('Windows refusing a mark logs once', t.logs.length === 1 && /pid 123: error 5/.test(t.logs[0]), t.logs.join(' | '));
        s.check('after giving up, no new helper and nothing more sent', t.spawns.length === 1 && t.spawns[0].h.written === '123\n');
    }
    {
        const t = harness('win32');
        t.mark({ pid: 1 });
        t.spawns[0].h.emit('error', new Error('spawn powershell ENOENT'));
        t.spawns[0].h.emit('exit', -4058);
        t.mark({ pid: 2 });
        s.check('a helper that fails to start logs once and is not retried', t.logs.length === 1 && t.spawns.length === 1, t.logs.join(' | '));
    }
    {
        const t = harness('win32');
        t.mark({ pid: 1 });
        t.spawns[0].h.stderr.write('Add-Type : Cannot add type.\r\nmore\r\n');
        await tick();
        t.spawns[0].h.emit('exit', 1);
        s.check('a helper that dies logs once, with its first error line', t.logs.length === 1 && /helper exited with code 1: Add-Type : Cannot add type\.\)/.test(t.logs[0]), t.logs.join(' | '));
    }
    {
        const t = harness('win32');
        t.mark({ pid: 1 });
        const h = t.mark.close();
        h.emit('exit', 0);
        s.check('closing the helper on purpose logs nothing', t.logs.length === 0);
    }

    if (process.platform === 'win32') {
        const replies = [];
        const logs = [];
        let helper = null;
        const mark = createMarker({
            spawn: (cmd, args, opts) => {
                helper = childProcess.spawn(cmd, args, opts);
                helper.stdout.on('data', (d) => replies.push(...String(d).trim().split(/\r?\n/)));
                return helper;
            },
            log: (line) => logs.push(line),
        });
        const child = childProcess.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
        mark(child);
        const got = await until(() => replies.length > 0 || logs.length > 0, 20000);
        s.check('real helper: marks a real process High QoS', got && replies[0] === `${child.pid} 0`, JSON.stringify({ replies, logs }));
        let exited = false;
        helper.on('exit', () => { exited = true; });
        mark.close();
        s.check('real helper: exits when its stdin closes', await until(() => exited, 10000));
        child.kill();
    } else {
        s.log('(real-helper check skipped: not Windows)');
    }

    return s;
};

if (require.main === module) {
    module.exports().then((suite) => {
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
