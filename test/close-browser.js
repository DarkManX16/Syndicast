/*
 * scripts/lib/close-browser.js: the workflow checklist (scripts/editor-workflows.js)
 * hung in browser.close() after its last workflow, twice on Nov 8, 2026. Closing
 * now gives up after a limit and kills the browser's process instead.
 */
const { Suite } = require('./support');
const closeBrowser = require('../scripts/lib/close-browser');

function fakeBrowser(closes) {
    const proc = { killed: false, exitCode: null, kill() { this.killed = true; } };
    return {
        proc,
        close: () => closes ? Promise.resolve().then(() => { proc.exitCode = 0; }) : new Promise( () => {} ),
        process: () => proc,
    };
}

module.exports = async function run() {
    const suite = new Suite('close-browser');
    const hung = fakeBrowser(false);
    const t0 = Date.now();
    const said = await closeBrowser(hung, 50);
    suite.check('a close that never finishes gives up after the limit', Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
    suite.check('...and kills the browser process', hung.proc.killed === true && said === 'killed', said);
    const fine = fakeBrowser(true);
    const saidFine = await closeBrowser(fine, 50);
    suite.check('a close that finishes kills nothing', fine.proc.killed === false && saidFine === 'closed', saidFine);
    const gone = { close: () => new Promise( () => {} ), process: () => null };
    suite.check('a hung close with no process to kill still returns', await closeBrowser(gone, 50) === 'gave up');
    return suite;
};
