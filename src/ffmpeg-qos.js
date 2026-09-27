/*
 * Marks every ffmpeg Syndicast starts as High QoS on Windows, so Windows
 * can't throttle it onto the efficiency cores.
 *
 * Windows gives a process the QoS of the app it descends from: while that
 * app's window is minimized or covered, its descendants - this server's
 * ffmpegs included - drop to Low QoS and, on this machine, run on the
 * E-cores only, at 0.13-0.45x realtime. Priority doesn't override that
 * (os.setPriority measured 0.78-0.97x while throttled), and a child doesn't
 * inherit its parent's mark, so each ffmpeg is marked on its own. See "Heavy
 * buffering during playback" in NOTES.md.
 *
 * Node has no call for SetProcessInformation, so one PowerShell helper,
 * started with the first ffmpeg and kept for the life of the server, is sent
 * each ffmpeg's pid on stdin and marks it. The script is passed as plain
 * -Command text: .ps1 files can be blocked by execution policy, and an
 * encoded command is what security tools look for. It reads until stdin
 * closes, so it exits with the server, crash included.
 *
 * Does nothing off Windows. If the helper can't start, dies, or Windows
 * refuses a mark, it logs one line, stops trying, and ffmpeg runs exactly as
 * it did before this existed.
 */
const childProcess = require('child_process');

const HELPER_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace Syndicast -Name Qos -MemberDefinition '",
    "  [StructLayout(LayoutKind.Sequential)] public struct State { public uint Version; public uint ControlMask; public uint StateMask; }",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool SetProcessInformation(IntPtr process, int infoClass, ref State info, int size);",
    "  [DllImport(\"kernel32.dll\")] static extern bool CloseHandle(IntPtr handle);",
    // ProcessPowerThrottling (4), EXECUTION_SPEED (1) in the control mask and
    // not in the state mask: throttling explicitly off, which is High QoS.
    "  public static int MarkHigh(int pid) {",
    "    IntPtr h = OpenProcess(0x0200, false, pid);",   // PROCESS_SET_INFORMATION
    "    if (h == IntPtr.Zero) return Marshal.GetLastWin32Error();",
    "    State s = new State(); s.Version = 1; s.ControlMask = 1; s.StateMask = 0;",
    "    bool ok = SetProcessInformation(h, 4, ref s, Marshal.SizeOf(s));",
    "    int err = ok ? 0 : Marshal.GetLastWin32Error();",
    "    CloseHandle(h);",
    "    return err;",
    "  }",
    "'",
    "while ($null -ne ($line = [Console]::In.ReadLine())) {",
    "  [Console]::Out.WriteLine($line.Trim() + ' ' + [Syndicast.Qos]::MarkHigh([int]$line))",
    "}",
].join('\n');

// OpenProcess's answer for a pid that has already exited - a -version check
// or a very short clip finishing first. Nothing to mark, nothing wrong.
const ERROR_INVALID_PARAMETER = 87;

function createMarker({ platform = process.platform, spawn = childProcess.spawn, log = console.log } = {}) {
    let helper = null;
    let givenUp = false;

    function giveUp(why) {
        if (givenUp) {
            return;
        }
        givenUp = true;
        log(`Could not mark ffmpeg High QoS (${why}); Windows may slow ffmpeg down while Syndicast runs in the background.`);
        const h = helper;
        helper = null;
        if (h) {
            try { h.stdin.end(); } catch (e) { /* already gone */ }
        }
    }

    function startHelper() {
        const h = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', HELPER_SCRIPT], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stderr = '';
        let out = '';
        h.on('error', (e) => giveUp(`helper failed to start: ${e.message}`));
        h.on('exit', (code) => {
            if (helper === h) {
                giveUp(`helper exited with code ${code}${stderr ? ': ' + stderr.trim().split(/\r?\n/)[0] : ''}`);
            }
        });
        h.stdin.on('error', (e) => giveUp(`helper stopped reading: ${e.message}`));
        h.stderr.on('data', (d) => { if (stderr.length < 2000) stderr += d; });
        h.stdout.on('data', (d) => {
            out += d;
            let i;
            while ((i = out.indexOf('\n')) >= 0) {
                const [pid, code] = out.slice(0, i).trim().split(' ');
                out = out.slice(i + 1);
                const err = parseInt(code, 10);
                if (err !== 0 && err !== ERROR_INVALID_PARAMETER) {
                    giveUp(`Windows refused to mark pid ${pid}: error ${code}`);
                }
            }
        });
        // The server never waits on the helper, and the helper must not keep
        // a node process alive that would otherwise exit.
        h.unref();
        for (const s of [h.stdin, h.stdout, h.stderr]) {
            if (s && typeof s.unref === 'function') s.unref();
        }
        return h;
    }

    function markHighQos(child) {
        if (platform !== 'win32' || givenUp || !child || typeof child.pid !== 'number') {
            return;
        }
        try {
            if (!helper) {
                helper = startHelper();
            }
            helper.stdin.write(`${child.pid}\n`);
        } catch (e) {
            giveUp(e.message);
        }
    }

    // For tests: ends the helper's stdin, the way a server exiting does.
    markHighQos.close = () => {
        const h = helper;
        helper = null;
        if (h) h.stdin.end();
        return h;
    };

    return markHighQos;
}

module.exports = {
    markHighQos: createMarker(),
    createMarker,
    HELPER_SCRIPT,
};
