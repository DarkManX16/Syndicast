/*
 * Pure logic for scripts/lib/retention.js: which dated backup-run folders to
 * keep. No filesystem access here - planRetention takes plain folder names in
 * and returns plain names out, so this suite is instant and never flaky.
 */
const { Suite } = require('./support');
const { parseRunFolderName, formatRunFolderName, planRetention } = require('../scripts/lib/retention');

module.exports = async function run() {
    const suite = new Suite('backup retention');

    // ---- naming: format and parse agree, including the failure marker -----
    const d = new Date(2026, 8, 27, 3, 0, 0); // months are 0-based: September
    const name = formatRunFolderName(d);
    suite.check('formats a run folder name with no colons (Windows-safe)',
        !name.includes(':'), name);

    const parsedOk = parseRunFolderName(name);
    suite.check('parses its own formatted name back to the same instant',
        parsedOk && parsedOk.date.getTime() === d.getTime(), JSON.stringify(parsedOk));
    suite.check('a plain run folder parses as complete',
        parsedOk && parsedOk.complete === true);

    const parsedIncomplete = parseRunFolderName(name + '-INCOMPLETE');
    suite.check('an -INCOMPLETE suffix parses as not complete',
        parsedIncomplete && parsedIncomplete.complete === false);
    suite.check('the -INCOMPLETE name still parses the same instant',
        parsedIncomplete && parsedIncomplete.date.getTime() === d.getTime());

    suite.check('a name that is not a run folder parses to null',
        parseRunFolderName('.lock') === null);
    suite.check('a name with a bad date-shaped string also parses to null',
        parseRunFolderName('2026-13-40T99-99-99') === null);

    // ---- retention: age cutoff, complete-only floor, incomplete handling --
    const now = new Date(2026, 9, 1, 0, 0, 0).getTime(); // Oct 1, 2026
    const DAY = 24 * 60 * 60 * 1000;
    const nameAt = (daysAgo, complete = true) =>
        formatRunFolderName(new Date(now - daysAgo * DAY)) + (complete ? '' : '-INCOMPLETE');

    // Only two backups, both recent: both kept, nothing pruned.
    {
        const names = [nameAt(0), nameAt(1)];
        const { keep, remove } = planRetention(names, { now });
        suite.check('two recent complete backups: both kept',
            keep.length === 2 && remove.length === 0, JSON.stringify({ keep, remove }));
    }

    // Eight complete backups all older than 14 days: only the 5 newest survive.
    {
        const names = [20, 25, 30, 35, 40, 45, 50, 55].map((d) => nameAt(d));
        const { keep, remove } = planRetention(names, { now });
        suite.check('keeps exactly the 5 newest complete backups when all are past 14 days',
            keep.length === 5 && remove.length === 3,
            `kept ${keep.length}, removed ${remove.length}`);
        const keptDaysAgo = keep.map((n) => Math.round((now - parseRunFolderName(n).date.getTime()) / DAY)).sort((a, b) => a - b);
        suite.check('keeps the 5 with the smallest age (the newest ones)',
            JSON.stringify(keptDaysAgo) === JSON.stringify([20, 25, 30, 35, 40]),
            JSON.stringify(keptDaysAgo));
    }

    // A backup exactly at the boundary: 14 days old is still within the window,
    // 15 is not.
    {
        const names = [nameAt(14), nameAt(15)];
        const { keep, remove } = planRetention(names, { now, keepNewestComplete: 0 });
        suite.check('a backup exactly 14 days old is kept',
            keep.includes(nameAt(14)), JSON.stringify({ keep, remove }));
        suite.check('a backup 15 days old is pruned',
            remove.includes(nameAt(15)), JSON.stringify({ keep, remove }));
    }

    // Only prune after a successful run: the caller decides whether to call
    // planRetention at all for an incomplete current run, so this suite only
    // has to prove the -INCOMPLETE entries themselves are handled sanely once
    // asked - they never count toward the "5 newest complete" floor, but a
    // recent one is still kept by the ordinary age cutoff, and an old one is
    // pruned like anything else past 14 days.
    {
        const names = [nameAt(0), nameAt(1), nameAt(2), nameAt(3), nameAt(4), nameAt(5, false), nameAt(20, false)];
        const { keep, remove } = planRetention(names, { now, keepNewestComplete: 5 });
        suite.check('a recent -INCOMPLETE run does not steal one of the 5 complete slots',
            keep.length === 6 && keep.includes(nameAt(5, false)),
            JSON.stringify({ keep, remove }));
        suite.check('an old -INCOMPLETE run is pruned by age like a complete one would be',
            remove.includes(nameAt(20, false)), JSON.stringify({ keep, remove }));
    }

    // Entries that are not run folders at all (e.g. a stray ".lock" left over,
    // or an unrelated file) are ignored rather than ever proposed for removal -
    // planRetention only ever acts on names it can parse as its own.
    {
        const { keep, remove } = planRetention(['.lock', 'readme.txt', nameAt(0)], { now });
        suite.check('unrecognised entries are never proposed for removal',
            !remove.includes('.lock') && !remove.includes('readme.txt'),
            JSON.stringify({ keep, remove }));
    }

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
