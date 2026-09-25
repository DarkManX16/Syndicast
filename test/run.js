/*
 * Runs every test file in this directory and gives `npm test` one combined
 * pass/fail count. Each file exports an async function returning a
 * test/support.js Suite; add a new file's path here to include it.
 */
const suites = [
    './blocks-acceptance',
    './blocks-unchanged',
    './blocks-persistence',
    './blocks-guide',
];

(async () => {
    let totalCount = 0;
    let totalFailures = 0;
    for (const path of suites) {
        const run = require(path);
        console.log(`\n${path.replace('./', '')}`);
        const suite = await run();
        totalCount += suite.count;
        totalFailures += suite.failures;
    }
    console.log(`\n${totalCount - totalFailures}/${totalCount} passed.`);
    if (totalFailures > 0) {
        console.log(`${totalFailures} FAILURES`);
    }
    process.exitCode = totalFailures === 0 ? 0 : 1;
})();
