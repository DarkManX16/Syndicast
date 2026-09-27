/*
 * scripts/lib/task-xml.js builds the Windows Task Scheduler XML for the
 * daily backup task. Pure string building - no schtasks call here - so the
 * shape of what gets registered is provable without ever touching the real
 * Task Scheduler in a test run.
 */
const { Suite } = require('./support');
const { buildDailyTaskXml } = require('../scripts/lib/task-xml');

module.exports = async function run() {
    const suite = new Suite('backup task xml');

    const xml = buildDailyTaskXml({
        description: 'Daily verified backup of the Syndicast dev data folder.',
        startTime: '03:00',
        startDate: '2026-09-27',
        command: 'C:\\Program Files\\nodejs\\node.exe',
        args: ['C:\\Projects\\dizquetv\\scripts\\backup.js', '--dest', 'C:\\Projects\\dizquetv-backups'],
        workingDirectory: 'C:\\Projects\\dizquetv',
    });

    suite.check('sets StartWhenAvailable so a missed 3am run fires once the PC is back',
        xml.includes('<StartWhenAvailable>true</StartWhenAvailable>'));
    suite.check('schedules a daily trigger, one day apart',
        xml.includes('<DaysInterval>1</DaysInterval>'));
    suite.check('anchors the trigger at the requested local time',
        xml.includes('<StartBoundary>2026-09-27T03:00:00</StartBoundary>'));
    suite.check('refuses to pile up a second run if one is still going',
        xml.includes('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'));
    suite.check('points the action at the full node.exe path, not just "node"',
        xml.includes('<Command>C:\\Program Files\\nodejs\\node.exe</Command>'));
    suite.check('quotes each argument so a space in a path is not split apart',
        xml.includes('"C:\\Projects\\dizquetv\\scripts\\backup.js" "--dest" "C:\\Projects\\dizquetv-backups"'));
    suite.check('sets the working directory to the repo root',
        xml.includes('<WorkingDirectory>C:\\Projects\\dizquetv</WorkingDirectory>'));
    suite.check('carries the description through',
        xml.includes('Daily verified backup of the Syndicast dev data folder.'));
    suite.check('declares itself well-formed XML with a version/encoding header',
        xml.trim().startsWith('<?xml'));

    const withSpecials = buildDailyTaskXml({
        description: 'Backs up & restores <the> "dev" folder',
        startTime: '03:00',
        startDate: '2026-09-27',
        command: 'C:\\node.exe',
        args: [],
        workingDirectory: 'C:\\Projects\\dizquetv',
    });
    suite.check('XML-escapes special characters in free text so the file stays well-formed',
        withSpecials.includes('Backs up &amp; restores &lt;the&gt; &quot;dev&quot; folder'),
        withSpecials.match(/<Description>.*<\/Description>/)?.[0]);

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
