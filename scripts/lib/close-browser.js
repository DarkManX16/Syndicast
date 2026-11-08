/*
 * Closes a puppeteer browser, or, when close() hasn't finished within `ms`,
 * kills its process. The workflow checklist hung in browser.close() after its
 * last workflow (Nov 8, 2026), so a run never exited on its own. Answers what
 * it did: 'closed', 'killed', or 'gave up' (no process to kill).
 */
module.exports = async function closeBrowser(browser, ms) {
    let timer = null;
    const done = await Promise.race([
        browser.close().then( () => true, () => true ),
        new Promise( (resolve) => { timer = setTimeout( () => resolve(false), ms ); } ),
    ]);
    clearTimeout(timer);
    if (done) {
        return 'closed';
    }
    const proc = (typeof(browser.process) === 'function') ? browser.process() : null;
    if ( (proc === null) || (typeof(proc) === 'undefined') ) {
        return 'gave up';
    }
    try {
        proc.kill('SIGKILL');
    } catch (e) {
        return 'gave up';
    }
    return 'killed';
};
