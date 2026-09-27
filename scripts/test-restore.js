#!/usr/bin/env node
/*
 * Proves a backup actually loads: copies a dated backup folder into a
 * scratch folder under the OS temp directory, starts a real `node index.js`
 * against *that* copy on a spare port (never ./.dizquetv-dev - a second
 * server on the live data folder is its own hazard, see NOTES.md's "Two
 * servers on one data folder" entry), waits for it to come up, and checks
 * both that it serves and that it reports the same channels the backup's
 * files have.
 *
 * Usage: node scripts/test-restore.js [--dest <backupsRoot>] [--from <runFolderName>] [--port <port>]
 * Also runnable as `npm run backup:test-restore`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ChannelDB = require('../src/dao/channel-db');
const { findFreePort } = require('./lib/find-free-port');
const { parseRunFolderName } = require('./lib/retention');
const { compareChannelNumbers } = require('./lib/compare-channels');
const { REPO_ROOT, DEFAULT_DEST_ROOT } = require('./lib/paths');

const CANDIDATE_PORTS = Array.from({ length: 50 }, (_, i) => 19323 + i);
const READY_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 300;

function parseArgs(argv) {
    const args = { dest: DEFAULT_DEST_ROOT, from: null, port: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--dest' && i + 1 < argv.length) {
            args.dest = argv[++i];
        } else if (argv[i] === '--from' && i + 1 < argv.length) {
            args.from = argv[++i];
        } else if (argv[i] === '--port' && i + 1 < argv.length) {
            args.port = Number(argv[++i]);
        }
    }
    return args;
}

function pickBackup(destRoot, explicitName) {
    if (explicitName) {
        return explicitName;
    }
    const names = fs.readdirSync(destRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    const candidates = names
        .map(parseRunFolderName)
        .filter((e) => e && e.complete)
        .sort((a, b) => b.date.getTime() - a.date.getTime());
    if (candidates.length === 0) {
        return null;
    }
    return candidates[0].name;
}

// Never trust whatever autoDiscovery the backup happened to capture - force
// it off on the scratch copy so the throwaway restore never announces
// itself on the network as an HDHomeRun tuner.
function disableHdhrAutoDiscovery(dataDir) {
    const file = path.join(dataDir, 'hdhr-settings.json');
    if (!fs.existsSync(file)) {
        return;
    }
    const records = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const record of records) {
        record.autoDiscovery = false;
    }
    fs.writeFileSync(file, JSON.stringify(records));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForVersion(port, deadline) {
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://localhost:${port}/api/version`);
            if (res.ok) {
                return true;
            }
        } catch (err) {
            // not up yet
        }
        await sleep(POLL_INTERVAL_MS);
    }
    return false;
}

function stopChild(child) {
    return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            } catch (err) {
                // already gone
            }
        }, 5000);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
        child.kill('SIGTERM');
    });
}

async function main() {
    const { dest: destRoot, from, port: explicitPort } = parseArgs(process.argv.slice(2));

    const backupName = pickBackup(destRoot, from);
    if (!backupName) {
        console.error(from
            ? `No backup named "${from}" found under ${destRoot}`
            : `No complete backup found under ${destRoot}. Run "npm run backup" first.`);
        process.exitCode = 1;
        return;
    }
    const backupDir = path.join(destRoot, backupName);
    const channelsDir = path.join(backupDir, 'channels');
    if (!fs.existsSync(channelsDir)) {
        console.error(`${backupDir} does not look like a data folder (no channels/ subfolder).`);
        process.exitCode = 1;
        return;
    }

    console.log(`Testing restore of ${backupName}`);
    const expectedNumbers = await new ChannelDB(channelsDir).getAllChannelNumbers();

    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syndicast-restore-test-'));
    let child = null;
    let ok = false;
    try {
        console.log(`Copying into scratch folder ${scratchDir}`);
        fs.cpSync(backupDir, scratchDir, { recursive: true });
        disableHdhrAutoDiscovery(scratchDir);

        const port = explicitPort || await findFreePort(CANDIDATE_PORTS);
        console.log(`Starting a throwaway server on port ${port} against the scratch copy`);

        child = spawn(process.execPath, [path.join(REPO_ROOT, 'index.js'), '-p', String(port), '-d', scratchDir], {
            cwd: REPO_ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (d) => { output += d; });
        child.stderr.on('data', (d) => { output += d; });
        let exitedEarly = false;
        child.once('exit', () => { exitedEarly = true; });

        const up = await waitForVersion(port, Date.now() + READY_TIMEOUT_MS);
        if (!up) {
            console.error(`Server did not respond on /api/version within ${READY_TIMEOUT_MS / 1000}s`
                + (exitedEarly ? ' (it exited early)' : '') + '.');
            if (output) {
                console.error(`--- server output ---\n${output}`);
            }
            process.exitCode = 1;
            return;
        }
        console.log('Server is up.');

        const channelsRes = await fetch(`http://localhost:${port}/api/channels`);
        const actualNumbers = await channelsRes.json();
        const comparison = compareChannelNumbers(expectedNumbers, actualNumbers);

        if (comparison.ok) {
            console.log(`PASS: ${comparison.actualCount} channel(s) match the backup's channel files.`);
            ok = true;
        } else {
            console.error(`FAIL: channel mismatch. Backup has ${comparison.expectedCount},`
                + ` live server reported ${comparison.actualCount}.`);
            if (comparison.missing.length) {
                console.error(`Missing from the live server: ${comparison.missing.join(', ')}`);
            }
            if (comparison.extra.length) {
                console.error(`Reported live but not in the backup: ${comparison.extra.join(', ')}`);
            }
        }
    } finally {
        if (child) {
            await stopChild(child);
        }
        fs.rmSync(scratchDir, { recursive: true, force: true });
    }

    process.exitCode = ok ? 0 : 1;
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exitCode = 1;
    });
}

module.exports = { main, parseArgs, pickBackup };
