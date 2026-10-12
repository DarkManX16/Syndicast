/*
 * What the editor makes of /api/version: is the server running the code the
 * page was built from? `codeRunning` is the server's fingerprint from its
 * start, `codeOnDisk` one taken now (src/code-fingerprint.js). Different -
 * or neither reported, which is how a server older than this check answers -
 * means it still runs older code, and Create Lineup, Swap, Insert and undo
 * refuse until it is restarted: a new editor against an old generator once
 * ran an evening late. Pure, tested in Node, bundled into the editor.
 */
const MESSAGE = 'Your server is still running older code than this page. Restart your server first, then reload this page and try again.';

// The server could not be asked: nothing proves it stale, and the call the
// editor was about to make will say what is wrong.
const UNKNOWN = { unknown: true };

function verdict(version) {
    if (version === UNKNOWN) {
        return { ok: true, message: '' };
    }
    if ( (typeof(version) === 'object') && (version !== null)
        && (typeof(version.codeRunning) === 'string') && (version.codeRunning !== '')
        && (version.codeRunning === version.codeOnDisk) ) {
        return { ok: true, message: '' };
    }
    return { ok: false, message: MESSAGE };
}

/*
 * Runs `run` only for a server on the current code. `fetchVersion` asks
 * /api/version; when it can't be asked the verdict is UNKNOWN and `run`
 * goes ahead - its own error will say what is wrong. A refusal carries
 * `serverStale`, so the editor shows the message as it is.
 */
async function guard({ fetchVersion, run }) {
    let version;
    try {
        version = await fetchVersion();
    } catch (err) {
        version = UNKNOWN;
    }
    let said = verdict(version);
    if (! said.ok) {
        let refusal = new Error(said.message);
        refusal.serverStale = true;
        throw refusal;
    }
    return await run();
}

module.exports = { verdict, guard, UNKNOWN, MESSAGE };
