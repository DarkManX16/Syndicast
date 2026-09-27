#!/usr/bin/env node
/*
 * Registers (or updates) the Windows Scheduled Task that runs scripts/
 * backup.js once a day. Uses the full task XML rather than the simple
 * `schtasks /Create /SC DAILY /ST` form, because that form has no switch for
 * "run as soon as possible after a missed start" (Settings/StartWhenAvailable) -
 * only reachable through a full task definition.
 *
 * Usage: node scripts/backup-register-task.js [--time HH:MM] [--dest <backupsRoot>] [--name <taskName>]
 * Also runnable as `npm run backup:schedule`. Windows only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildDailyTaskXml } = require('./lib/task-xml');
const { REPO_ROOT, DEFAULT_DEST_ROOT } = require('./lib/paths');

const DEFAULT_TASK_NAME = 'Syndicast Dev Backup';

function parseArgs(argv) {
    const args = { time: '03:00', dest: null, name: DEFAULT_TASK_NAME };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--time' && i + 1 < argv.length) {
            args.time = argv[++i];
        } else if (argv[i] === '--dest' && i + 1 < argv.length) {
            args.dest = argv[++i];
        } else if (argv[i] === '--name' && i + 1 < argv.length) {
            args.name = argv[++i];
        }
    }
    return args;
}

function todayLocalDate() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function main() {
    if (process.platform !== 'win32') {
        console.error('This registers a Windows Scheduled Task and only runs on Windows.');
        process.exitCode = 1;
        return;
    }

    const { time, dest, name } = parseArgs(process.argv.slice(2));
    if (!/^\d{2}:\d{2}$/.test(time)) {
        console.error(`--time must look like HH:MM, got "${time}"`);
        process.exitCode = 1;
        return;
    }

    const scriptPath = path.join(__dirname, 'backup.js');
    const args = [scriptPath];
    if (dest) {
        args.push('--dest', dest);
    }

    const xml = buildDailyTaskXml({
        description: 'Daily verified backup of the Syndicast dev data folder '
            + `(${dest || DEFAULT_DEST_ROOT}). Registered by scripts/backup-register-task.js.`,
        startTime: time,
        startDate: todayLocalDate(),
        command: process.execPath,
        args,
        workingDirectory: REPO_ROOT,
    });

    const xmlPath = path.join(os.tmpdir(), `syndicast-backup-task-${Date.now()}.xml`);
    // schtasks /XML expects UTF-16LE with a BOM.
    fs.writeFileSync(xmlPath, '﻿' + xml, 'utf16le');
    try {
        execFileSync('schtasks', ['/Create', '/TN', name, '/XML', xmlPath, '/F'], { stdio: 'pipe' });
    } finally {
        fs.rmSync(xmlPath, { force: true });
    }

    console.log(`Registered scheduled task "${name}":`);
    console.log(`  runs daily at ${time} (and as soon as possible after, if the PC was off/asleep)`);
    console.log(`  command: "${process.execPath}" "${scriptPath}"${dest ? ` --dest "${dest}"` : ''}`);
    console.log(`  working directory: ${REPO_ROOT}`);
    console.log(`Inspect it any time with: schtasks /Query /TN "${name}" /V /FO LIST`);
    console.log(`Remove it with: schtasks /Delete /TN "${name}" /F`);
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        if (err.stderr) {
            console.error(err.stderr.toString());
        }
        console.error(err.message || err);
        process.exitCode = 1;
    }
}

module.exports = { main, parseArgs };
