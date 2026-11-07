/*
 * Very Low disk priority for the break scanner (src/io-priority.js): the
 * helper's answers, what happens when it is slow, fails or goes away (the run
 * keeps Normal disk priority and the scanner carries on), and, on Windows, the
 * real helper lowering a real process, read back from Windows.
 */
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const childProcess = require('child_process');
const { Suite } = require('./support');
const { DiskPriority } = require('../src/io-priority');

// A stand-in PowerShell: says "ready", then answers each pid with `answers(pid)`.
function fakeHelper(options = {}) {
    const made = [];
    const spawn = (cmd, args) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.args = args;
        child.kill = () => child.emit('exit', 1);
        made.push(child);
        child.stdin.on('data', (d) => {
            for (const line of String(d).split('\n').filter( (l) => l !== '' )) {
                const value = options.answers ? options.answers(Number(line)) : 0;
                if (value !== null) {
                    child.stdout.write(`${line} ${value}\r\n`);
                }
            }
        } );
        if (options.silent !== true) {
            setImmediate( () => child.stdout.write('ready\r\n') );
        }
        return child;
    };
    return { spawn, made };
}

module.exports = async () => {
    const suite = new Suite('io priority');
    const quiet = () => {};

    {
        const h = fakeHelper( { answers: (pid) => (pid === 7 ? 2 : 0) } );
        const d = new DiskPriority( { platform: 'win32', spawn: h.spawn, log: quiet } );
        const a = await d.lower(1234);
        const b = await d.lower(4321);
        suite.check('a pid the helper reads back as 0 is at Very Low',
            (a === true) && (b === true) && (d.status().level === 'very low') && (d.status().lowered === 2));
        suite.check('...and one helper serves every run',
            h.made.length === 1);
        suite.check('...started with its script encoded, so nothing in it is quoted by the command line',
            h.made[0].args.includes('-EncodedCommand') && h.made[0].args.includes('-NoProfile'));
        const c = await d.lower(7);
        suite.check('a pid that comes back at another level is not counted as lowered',
            (c === false) && (d.status().level === 'normal') && (d.status().failed === 1));
        d.stop();
    }
    {
        const h = fakeHelper( { answers: () => null } );
        const d = new DiskPriority( { platform: 'win32', spawn: h.spawn, log: quiet, answerTimeoutMs: 20 } );
        suite.check('no answer in time: false, and the run carries on',
            (await d.lower(55)) === false);
        d.stop();
    }
    {
        let now = 0;
        const lines = [];
        const h = fakeHelper();
        const d = new DiskPriority( { platform: 'win32', spawn: h.spawn, now: () => now, log: (l) => lines.push(l) } );
        await d.lower(1);
        h.made[0].emit('exit', 1);
        suite.check('a helper that stops is reported once in the log',
            (lines.length === 1) && /scanning at normal disk priority/.test(lines[0]), lines.join(' | '));
        const during = await d.lower(2);
        suite.check('...and for the next minute runs go at Normal without trying to start it again',
            (during === false) && (h.made.length === 1));
        now += 61000;
        const after = await d.lower(3);
        suite.check('...after which it is started again',
            (after === true) && (h.made.length === 2) && (d.status().problem === null));
        d.stop();
    }
    {
        const h = fakeHelper( { silent: true } );
        const d = new DiskPriority( { platform: 'win32', spawn: h.spawn, log: quiet, startTimeoutMs: 20 } );
        suite.check('a helper that never starts: false, with the reason in the status',
            ( (await d.lower(9)) === false ) && /did not start/.test(d.status().problem));
    }
    {
        const d = new DiskPriority( { platform: 'win32', spawn: () => { throw new Error('spawn powershell ENOENT'); }, log: quiet } );
        suite.check('no PowerShell at all: false, with the reason',
            ( (await d.lower(9)) === false ) && /ENOENT/.test(d.status().problem));
    }
    {
        let spawned = 0;
        const d = new DiskPriority( { platform: 'linux', spawn: () => { spawned++; }, log: quiet } );
        suite.check('elsewhere than Windows nothing is started and runs keep Normal',
            ( (await d.lower(9)) === false ) && (spawned === 0) && (d.status().problem === 'only on Windows'));
    }

    {
        const breakScan = require('../src/break-scan');
        let seen = null;
        const r = await breakScan.defaultRunner(process.execPath, [ '-e', 'process.stdout.write(String(process.pid))' ], { onSpawn: (pid) => { seen = pid; } });
        suite.check('the scanner\'s runner hands each new process\'s pid to onSpawn',
            (r.code === 0) && (seen !== null) && (String(seen) === r.stdout), `${seen} ${r.stdout}`);
        const r2 = await breakScan.defaultRunner(process.execPath, [ '-e', '' ], { onSpawn: () => { throw new Error('boom'); } });
        suite.check('...and an onSpawn that throws does not stop the run',
            r2.code === 0);
    }

    if (process.platform === 'win32') {
        const d = new DiskPriority( { log: quiet } );
        const target = childProcess.spawn(process.execPath, [ '-e', 'setTimeout(() => {}, 20000)' ], { stdio: 'ignore', windowsHide: true });
        try {
            const ok = await d.lower(target.pid);
            suite.check('on Windows the real helper puts a real process at Very Low, as Windows reads it back',
                ok === true, JSON.stringify(d.status()));
        } finally {
            target.kill();
            d.stop();
        }
    }

    return suite;
};
