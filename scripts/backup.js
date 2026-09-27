#!/usr/bin/env node
/*
 * Backs up the dev data folder (./.dizquetv-dev by default) into a dated
 * folder outside the repo, safe to run whether or not the dev server is up.
 *
 * Usage: node scripts/backup.js [--source <dir>] [--dest <backupsRoot>]
 * Also runnable as `npm run backup`. Registered as a daily Windows Scheduled
 * Task by scripts/backup-register-task.js.
 *
 * Every file is copied through copyTreeVerified (see scripts/lib/
 * verified-copy.js), which never accepts a half-written copy - a file that
 * never stabilizes is retried, then reported rather than silently kept
 * broken. If *any* file failed, the run folder is renamed with an
 * -INCOMPLETE suffix and a FAILURES.log is written inside it, and retention
 * is skipped for this run entirely - an incomplete backup is not proof
 * anything is safe to prune by.
 */
const fs = require('fs');
const path = require('path');
const { copyTreeVerified } = require('./lib/verified-copy');
const { formatRunFolderName, planRetention } = require('./lib/retention');
const { DEFAULT_SOURCE, DEFAULT_DEST_ROOT } = require('./lib/paths');

function parseArgs(argv) {
    const args = { source: DEFAULT_SOURCE, dest: DEFAULT_DEST_ROOT };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--source' && i + 1 < argv.length) {
            args.source = argv[++i];
        } else if (argv[i] === '--dest' && i + 1 < argv.length) {
            args.dest = argv[++i];
        }
    }
    return args;
}

async function main() {
    const { source, dest: destRoot } = parseArgs(process.argv.slice(2));

    if (!fs.existsSync(source)) {
        console.error(`Backup source does not exist: ${source}`);
        process.exitCode = 1;
        return;
    }

    fs.mkdirSync(destRoot, { recursive: true });

    const lockDir = path.join(destRoot, '.backup.lock');
    try {
        fs.mkdirSync(lockDir);
    } catch (err) {
        if (err.code === 'EEXIST') {
            console.error(`Another backup run appears to be in progress (lock at ${lockDir}).`
                + ' If you are sure nothing is running, delete that folder and try again.');
            process.exitCode = 1;
            return;
        }
        throw err;
    }

    try {
        const runName = formatRunFolderName(new Date());
        const runDir = path.join(destRoot, runName);
        console.log(`Backing up ${source} -> ${runDir}`);

        const started = Date.now();
        const { totalFiles, failures } = await copyTreeVerified(source, runDir);
        const seconds = ((Date.now() - started) / 1000).toFixed(1);

        let finalDir = runDir;
        if (failures.length > 0) {
            finalDir = `${runDir}-INCOMPLETE`;
            fs.renameSync(runDir, finalDir);
            const log = failures.map((f) => `${f.path}\n  ${f.reason} (after ${f.attempts} attempt(s))`).join('\n\n');
            fs.writeFileSync(path.join(finalDir, 'FAILURES.log'),
                `${failures.length} of ${totalFiles} file(s) never copied cleanly:\n\n${log}\n`);
            console.error(`INCOMPLETE: ${failures.length} of ${totalFiles} file(s) failed in ${seconds}s.`
                + ` See ${path.join(finalDir, 'FAILURES.log')}`);
            console.error('Retention skipped this run - only a successful run prunes old backups.');
            process.exitCode = 1;
        } else {
            console.log(`OK: ${totalFiles} file(s) copied in ${seconds}s.`);

            const names = fs.readdirSync(destRoot).filter((n) => n !== path.basename(lockDir));
            const { remove } = planRetention(names);
            for (const name of remove) {
                fs.rmSync(path.join(destRoot, name), { recursive: true, force: true });
            }
            if (remove.length > 0) {
                console.log(`Pruned ${remove.length} old backup(s): ${remove.join(', ')}`);
            }
        }
    } finally {
        fs.rmSync(lockDir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exitCode = 1;
    });
}

module.exports = { main, parseArgs };
