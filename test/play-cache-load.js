/*
 * Loading the play cache never opens more files at once than the process can
 * hold, so every file is loaded.
 *
 * Nov 5, 2026: src/dao/program-play-time-db.js load() opened every file under
 * play-cache/<channel>/ at the same moment (Promise.all over all of them). On
 * a copy of .dizquetv-dev (14,666 files) 12,970 failed with "EMFILE: too many
 * open files" and were never loaded, so after each restart the Flex picker saw
 * most clips as never played: cooldowns and longest-idle reset.
 *
 * The machine's own limit differs (and a test that needs thousands of files is
 * slow), so the limit is stood in for: fs.promises.readFile is wrapped to hold
 * a count of reads in flight and to fail with EMFILE past LIMIT, as the real
 * thing does. A folder with far more files than LIMIT must still load whole.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Suite } = require('./support');
const ProgramPlayTimeDB = require('../src/dao/program-play-time-db');

const LIMIT = 64;
const CHANNELS = 3;
const PER_CHANNEL = 400; // 1,200 files, nearly 19 times LIMIT

function key64(n) {
    return Buffer.from(`clip-${n}`, 'utf-8').toString('base64');
}

module.exports = async function () {
    const suite = new Suite('play-cache-load');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-cache-load-'));
    const realReadFile = fs.promises.readFile;
    try {
        for (let c = 1; c <= CHANNELS; c++) {
            fs.mkdirSync(path.join(dir, `${c}`));
            for (let n = 0; n < PER_CHANNEL; n++) {
                fs.writeFileSync(
                    path.join(dir, `${c}`, `${key64(n)}.json`),
                    JSON.stringify({ t: c * 1000000 + n }),
                );
            }
        }
        // A file that isn't ours is skipped quietly, as before.
        fs.writeFileSync(path.join(dir, '1', 'notes.txt'), 'not a play time');

        let inFlight = 0;
        let peak = 0;
        let emfile = 0;
        fs.promises.readFile = async function (...args) {
            inFlight++;
            peak = Math.max(peak, inFlight);
            try {
                if (inFlight > LIMIT) {
                    emfile++;
                    const err = new Error('EMFILE: too many open files, open ' + args[0]);
                    err.code = 'EMFILE';
                    throw err;
                }
                const text = await realReadFile.apply(fs.promises, args);
                // Hold the "descriptor" across a tick, as a real open does.
                await new Promise(resolve => setImmediate(resolve));
                return text;
            } finally {
                inFlight--;
            }
        };

        const logged = [];
        const realLog = console.log;
        console.log = (...a) => logged.push(a.join(' '));
        const db = new ProgramPlayTimeDB(dir);
        try {
            await db.load();
        } finally {
            console.log = realLog;
        }

        const total = CHANNELS * PER_CHANNEL;
        const loaded = Object.keys(db.programPlayTimeCache).length;
        suite.check(`every one of ${total} files loads (limit ${LIMIT} at once)`,
            loaded === total, `loaded ${loaded}, ${emfile} refused with EMFILE`);
        suite.check('no read was refused', emfile === 0, `${emfile} refused`);
        suite.check('never more than the limit open at once', peak <= LIMIT,
            `peak ${peak}`);
        suite.check('a loaded time is the file\'s own',
            db.getProgramLastPlayTime('2', 'clip-7') === 2000007
            && db.getProgramLastPlayTime('3', `clip-${PER_CHANNEL - 1}`) === 3000000 + PER_CHANNEL - 1);
        suite.check('a clip with no file reads as never played',
            db.getProgramLastPlayTime('2', 'not-there') === 0);
        suite.check('a non-json file is skipped without a word',
            logged.length === 0, logged.slice(0, 1).join(''));
    } finally {
        fs.promises.readFile = realReadFile;
        fs.rmSync(dir, { recursive: true, force: true });
    }
    return suite;
};

if (require.main === module) {
    module.exports().then(s => { process.exitCode = s.failures ? 1 : 0; });
}
