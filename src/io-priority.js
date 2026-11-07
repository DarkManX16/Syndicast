/*
 * Very Low disk priority for the break scanner's ffmpeg and ffprobe runs
 * (docs/blocks-spec.md, Stage 6, "The scanner, and live streams").
 *
 * Idle CPU priority leaves a process's disk priority at Normal (measured Nov
 * 7, 2026), so on a busy USB drive the scanner's reads queued level with a
 * live stream's. Windows sets disk priority per process, and only through
 * NtSetInformationProcess, which Node cannot call; so one PowerShell helper is
 * started the first time it is needed and kept running, and each new run's
 * pid is written to it. It sets Very Low, reads the value back and answers
 * "<pid> <value>" (0 is Very Low). Setting it takes a few milliseconds, while
 * an ffmpeg takes far longer than that to open its file.
 *
 * Anything that goes wrong leaves that run at Normal disk priority, as before,
 * and the scanner carries on: lower() never throws, it answers true or false.
 * Elsewhere than Windows it answers false at once.
 */
const childProcess = require('child_process');

const START_TIMEOUT_MS = 20000;
const ANSWER_TIMEOUT_MS = 3000;
const RETRY_AFTER_MS = 60000;

const SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -TypeDefinition @"',
    'using System; using System.Runtime.InteropServices;',
    'public static class SyndicastDiskPriority {',
    '  [DllImport("ntdll.dll")] static extern int NtSetInformationProcess(IntPtr h, int cls, ref int info, int len);',
    '  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref int info, int len, IntPtr ret);',
    '  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);',
    '  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);',
    '  public static int VeryLow(int pid) {',
    '    IntPtr h = OpenProcess(0x0200 | 0x1000, false, pid);',
    '    if (h == IntPtr.Zero) return -1;',
    '    try {',
    '      int v = 0;',
    '      if (NtSetInformationProcess(h, 33, ref v, 4) != 0) return -2;',
    '      int got = -1;',
    '      if (NtQueryInformationProcess(h, 33, ref got, 4, IntPtr.Zero) != 0) return -3;',
    '      return got;',
    '    } finally { CloseHandle(h); }',
    '  }',
    '}',
    '"@',
    "[Console]::Out.WriteLine('ready')",
    'while ($true) {',
    '  $line = [Console]::In.ReadLine()',
    '  if ($line -eq $null) { break }',
    '  $n = 0',
    '  if ([int]::TryParse($line, [ref]$n)) { [Console]::Out.WriteLine("$n " + [SyndicastDiskPriority]::VeryLow($n)) }',
    '}',
].join('\n');

class DiskPriority {
    /*
     * options: { platform?, spawn?, now?, log?, startTimeoutMs?, answerTimeoutMs? }
     * - spawn, now and the timeouts are for tests.
     */
    constructor(options = {}) {
        this.platform = options.platform || process.platform;
        this.spawn = options.spawn || childProcess.spawn;
        this.now = options.now || ( () => Date.now() );
        this.log = options.log || ( (line) => console.log(line) );
        this.startTimeoutMs = options.startTimeoutMs || START_TIMEOUT_MS;
        this.answerTimeoutMs = options.answerTimeoutMs || ANSWER_TIMEOUT_MS;
        this.child = null;
        this.ready = null;
        this.pending = new Map();
        this.downUntil = 0;
        this.lowered = 0;
        this.failed = 0;
        this.last = null;
        this.problem = (this.platform === 'win32') ? null : 'only on Windows';
    }

    start() {
        if (this.ready !== null) {
            return this.ready;
        }
        this.ready = new Promise( (resolve) => {
            let child;
            try {
                child = this.spawn('powershell', [
                    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                    '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64'),
                ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] } );
            } catch (err) {
                this.down(`could not start: ${err.message}`);
                resolve(false);
                return;
            }
            this.child = child;
            let buffered = '';
            let started = false;
            let stderr = '';
            const timer = setTimeout( () => {
                if (! started) {
                    this.down(`did not start within ${Math.round(this.startTimeoutMs / 1000)} s`);
                    try { child.kill(); } catch (err) { /* already gone */ }
                    resolve(false);
                }
            }, this.startTimeoutMs );
            child.stdout.on('data', (d) => {
                buffered += d;
                let i;
                while ( (i = buffered.indexOf('\n')) >= 0 ) {
                    const line = buffered.slice(0, i).trim();
                    buffered = buffered.slice(i + 1);
                    if ( (line === 'ready') && ! started ) {
                        started = true;
                        clearTimeout(timer);
                        this.problem = null;
                        resolve(true);
                        continue;
                    }
                    const m = /^(\d+) (-?\d+)$/.exec(line);
                    if (m) {
                        this.answer(Number(m[1]), Number(m[2]));
                    }
                }
            } );
            child.stderr.on('data', (d) => { stderr += d; });
            child.stdin.on('error', () => { /* the exit handler below reports it */ });
            const gone = (why) => {
                if (this.child !== child) {
                    return;
                }
                clearTimeout(timer);
                this.down(why || (stderr.trim().split('\n')[0] || 'stopped'));
                resolve(false);
            };
            child.on('error', (err) => gone(err.message));
            child.on('exit', (code) => gone( (code === 0) ? null : `stopped (exit ${code})` ));
        } );
        return this.ready;
    }

    down(why) {
        if (this.problem !== why) {
            this.log(`Breaks: disk priority helper ${why}; scanning at normal disk priority for now`);
        }
        this.problem = why;
        this.child = null;
        this.ready = null;
        this.downUntil = this.now() + RETRY_AFTER_MS;
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.resolve(false);
        }
        this.pending.clear();
    }

    answer(pid, value) {
        const p = this.pending.get(pid);
        if (p == null) {
            return;
        }
        this.pending.delete(pid);
        clearTimeout(p.timer);
        this.record(value === 0);
        p.resolve(value === 0);
    }

    record(ok) {
        if (ok) {
            this.lowered++;
        } else {
            this.failed++;
        }
        this.last = ok;
    }

    // Resolves true once `pid` is at Very Low disk priority, false otherwise.
    async lower(pid) {
        if ( (this.platform !== 'win32') || ! (pid > 0) ) {
            return false;
        }
        if ( (this.ready === null) && (this.now() < this.downUntil) ) {
            this.record(false);
            return false;
        }
        if (! await this.start()) {
            this.record(false);
            return false;
        }
        const child = this.child;
        return new Promise( (resolve) => {
            const timer = setTimeout( () => {
                this.pending.delete(pid);
                this.record(false);
                resolve(false);
            }, this.answerTimeoutMs );
            this.pending.set(pid, { resolve, timer });
            try {
                child.stdin.write(`${pid}\n`);
            } catch (err) {
                this.pending.delete(pid);
                clearTimeout(timer);
                this.record(false);
                resolve(false);
            }
        } );
    }

    status() {
        return {
            level: (this.last === true) ? 'very low' : 'normal',
            lowered: this.lowered,
            failed: this.failed,
            problem: this.problem,
        };
    }

    stop() {
        const child = this.child;
        this.child = null;
        this.ready = null;
        if (child) {
            try { child.stdin.end(); } catch (err) { /* already gone */ }
        }
    }
}

module.exports = { DiskPriority, SCRIPT };
