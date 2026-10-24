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
    './blocks-schedule-view',
    './break-mix-source',
    './transitions',
    './transitions-editor',
    './show-match',
    './names-review',
    './names-movies-seasons',
    './names-seasons-anyof',
    './names-anyof-mixed',
    './names-series',
    './channel-library',
    './nicknames-page',
    './startTime-rotation',
    './save-resume',
    './channel-save',
    './dst-fall-back',
    './lookahead',
    './lineup-cursor',
    './stream-cursor',
    './shared-breaks',
    './backup-verified-copy',
    './backup-retention',
    './backup-restore-check',
    './backup-find-free-port',
    './backup-task-xml',
    './aspect-mark',
    './ffmpeg-encoder-flags',
    './ffmpeg-nvenc-fallback',
    './ffmpeg-qos',
    './bundle-freshness',
    './program-row-heights',
    './drag-vs-repeat-lockup',
    './card-templates',
    './card-moment',
    './card-render',
    './transitions-generated',
    './card-service',
    './card-player',
    './card-api',
    './slot-progress',
    './progress-generators',
    './pins-generator',
    './pins',
    './build-check',
    './multi-part',
    './shuffle-rounds',
    './progress-rerun',
    './progress-repeat',
    './progress-ordered',
    './show-catalog',
    './catalog-reader',
    './channel-catalog',
    './episode-start',
    './episode-start-model',
    './swap-read',
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
