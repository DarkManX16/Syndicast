/*
 * scripts/lib/verified-copy.js: the copy step backup.js uses to move
 * .dizquetv-dev into a backup folder without ever keeping a half-written
 * file. NOTES.md's own investigation ("A read during a write" in Known
 * issues / channel-save.js) found fs.writeFile truncates the target before
 * writing, so a copy landing mid-write can read a partial file - the same
 * risk this guards against, one level up (copying, not serving).
 *
 * isStableCopy is the pure decision ("does this copy look complete?") and is
 * tested exhaustively with plain objects. copyFileVerified/copyTreeVerified
 * are the real-fs loop built on top of it, proved against real files the way
 * test/channel-save.js proves the app's own torn-read handling - real writes,
 * real timing, generous margins so the suite doesn't get flaky.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Suite } = require('./support');
const { isStableCopy, copyFileVerified, copyTreeVerified } = require('../scripts/lib/verified-copy');

function tempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function removeDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
        console.log(`  (could not remove ${dir}: ${err.code})`);
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = async function run() {
    const suite = new Suite('backup verified copy');

    // ---- isStableCopy: pure, exhaustive ------------------------------------
    const base = { srcSizeBefore: 100, srcSizeAfter: 100, srcMtimeBefore: 1, srcMtimeAfter: 1, destSize: 100, isJson: false, destText: null };
    suite.check('a matching non-json copy is stable',
        isStableCopy(base) === true);
    suite.check('a source size change during the copy is unstable',
        isStableCopy({ ...base, srcSizeAfter: 101 }) === false);
    suite.check('a source mtime change during the copy is unstable',
        isStableCopy({ ...base, srcMtimeAfter: 2 }) === false);
    suite.check('a destination size that does not match the source is unstable',
        isStableCopy({ ...base, destSize: 99 }) === false);
    suite.check('a valid json copy that matches is stable',
        isStableCopy({ ...base, isJson: true, destText: '{"a":1}' }) === true);
    suite.check('a json copy that fails to parse is unstable even if sizes match',
        isStableCopy({ ...base, isJson: true, destText: '{"a":1' }) === false);

    // ---- copyFileVerified: real files --------------------------------------
    {
        const dir = tempDir('syndicast-copy-stable-');
        try {
            const src = path.join(dir, 'source.json');
            const dest = path.join(dir, 'dest.json');
            fs.writeFileSync(src, JSON.stringify({ hello: 'world' }));

            const result = await copyFileVerified(src, dest);
            suite.check('a stable file copies successfully on the first attempt',
                result.ok === true && result.attempts === 1, JSON.stringify(result));
            suite.check('the copied json is byte-identical and parses',
                fs.readFileSync(dest, 'utf8') === fs.readFileSync(src, 'utf8'));
            suite.check('no leftover .tmp file remains next to a successful copy',
                !fs.existsSync(dest + '.tmp'));
        } finally {
            removeDir(dir);
        }
    }

    {
        // Races a real concurrent write against a real copy, the same way
        // test/channel-save.js proves the app's own torn-read handling: a
        // large async fs.writeFile takes real, non-instantaneous time on
        // disk, so a synchronous copy attempt landing during it can observe
        // a genuinely partial file at the OS level - something a tiny
        // synchronous write could never demonstrate, since nothing else can
        // run while a synchronous call has the main thread. Whether this
        // particular run actually catches the write in progress is a timing
        // question (informational, logged either way); what must always
        // hold is the guarantee below: never a torn file under the real
        // name, never a leftover temp file.
        const dir = tempDir('syndicast-copy-race-');
        try {
            const src = path.join(dir, 'source', 'channel.json');
            const destDir = path.join(dir, 'backup');
            const dest = path.join(destDir, 'channel.json');
            fs.mkdirSync(path.dirname(src), { recursive: true });
            fs.mkdirSync(destDir, { recursive: true });

            function bigContent(tag) {
                const items = [];
                for (let i = 0; i < 20000; i++) {
                    items.push({ i, tag, pad: 'x'.repeat(40) });
                }
                return JSON.stringify({ tag, items });
            }

            fs.writeFileSync(src, bigContent('v0'));
            // On Windows a concurrent open for read (copyFileSync, below) and
            // this write can occasionally collide as EBUSY on whichever side
            // loses the race to open the file - a real platform quirk, but
            // not what this test is about (copyFileVerified's own retry
            // around a *copy* failure is exercised directly by the
            // deterministic exhaustion test below). Here the write racing
            // for real is what matters; if it loses that race, retry it
            // rather than let it fail the suite.
            const writeDone = (async () => {
                for (let attempt = 0; attempt < 20; attempt++) {
                    try {
                        await new Promise((resolve, reject) => {
                            fs.writeFile(src, bigContent('final'), (err) => (err ? reject(err) : resolve()));
                        });
                        return;
                    } catch (err) {
                        if (err.code !== 'EBUSY' || attempt === 19) {
                            throw err;
                        }
                        await sleep(5);
                    }
                }
            })();

            const result = await copyFileVerified(src, dest, { maxAttempts: 40, delayMs: 20 });
            await writeDone;

            suite.check('no leftover .tmp file remains either way',
                !fs.existsSync(dest + '.tmp'));
            suite.check('a failed race never leaves a file under the real destination name',
                result.ok || !fs.existsSync(dest));
            if (result.ok) {
                let parsedTag = null;
                let parseError = null;
                try {
                    parsedTag = JSON.parse(fs.readFileSync(dest, 'utf8')).tag;
                } catch (err) {
                    parseError = err.message;
                }
                suite.check('a copy reported successful is always valid, parseable json - never torn',
                    parseError === null, parseError || '');
                suite.log(`landed on tag "${parsedTag}" after ${result.attempts} attempt(s)`);
            } else {
                suite.log(`gave up after ${result.attempts} attempts racing the real write`
                    + ' (informational - a timing outcome on this machine, not a failure of the checks above)');
            }
        } finally {
            removeDir(dir);
        }
    }

    {
        // Deterministic version of "never stabilizes": rather than hoping to
        // win a real race, force every attempt to look unstable and prove
        // the loop gives up cleanly - reports failure, and never leaves a
        // partial file under the real name or a stray .tmp behind.
        const dir = tempDir('syndicast-copy-exhaust-');
        try {
            const src = path.join(dir, 'flapping.json');
            const dest = path.join(dir, 'backup-flapping.json');
            fs.writeFileSync(src, JSON.stringify({ n: 0 }));

            const realStatSync = fs.statSync;
            let call = 0;
            fs.statSync = (p, ...rest) => {
                const real = realStatSync(p, ...rest);
                // Only perturb reads of the source file, and only the second
                // read within each attempt (the "after" stat) - simulates the
                // source having changed size during every single attempt.
                if (String(p) === src) {
                    call++;
                    if (call % 2 === 0) {
                        return { ...real, size: real.size + 1, mtimeMs: real.mtimeMs + 1 };
                    }
                }
                return real;
            };

            let result;
            try {
                result = await copyFileVerified(src, dest, { maxAttempts: 4, delayMs: 5 });
            } finally {
                fs.statSync = realStatSync;
            }

            suite.check('a source that always looks unstable is reported as failed, not copied',
                result.ok === false && result.attempts === 4, JSON.stringify(result));
            suite.check('nothing is left under the real destination name',
                !fs.existsSync(dest));
            suite.check('no leftover .tmp file remains after giving up',
                !fs.existsSync(dest + '.tmp'));
        } finally {
            removeDir(dir);
        }
    }

    // ---- copyTreeVerified: walks a real directory tree ---------------------
    {
        const dir = tempDir('syndicast-copy-tree-');
        try {
            const srcRoot = path.join(dir, 'src');
            const destRoot = path.join(dir, 'dest');
            fs.mkdirSync(path.join(srcRoot, 'channels'), { recursive: true });
            fs.mkdirSync(path.join(srcRoot, 'images', 'uploads'), { recursive: true });
            fs.writeFileSync(path.join(srcRoot, 'channels', '1.json'), JSON.stringify({ number: 1 }));
            fs.writeFileSync(path.join(srcRoot, 'channels', '2.json'), JSON.stringify({ number: 2 }));
            fs.writeFileSync(path.join(srcRoot, 'images', 'uploads', 'logo.png'), 'not-really-a-png-but-stable');
            fs.writeFileSync(path.join(srcRoot, 'settings.json'), JSON.stringify({ ok: true }));

            const result = await copyTreeVerified(srcRoot, destRoot);
            suite.check('a nested tree of stable files copies with no failures',
                result.failures.length === 0, JSON.stringify(result));
            suite.check('every source file is present at its mirrored path',
                fs.existsSync(path.join(destRoot, 'channels', '1.json'))
                && fs.existsSync(path.join(destRoot, 'channels', '2.json'))
                && fs.existsSync(path.join(destRoot, 'images', 'uploads', 'logo.png'))
                && fs.existsSync(path.join(destRoot, 'settings.json')));
            suite.check('copyTreeVerified reports how many files it copied',
                result.totalFiles === 4, `totalFiles ${result.totalFiles}`);
        } finally {
            removeDir(dir);
        }
    }

    {
        // One file that can never be read (deleted out from under the walk)
        // must not stop the rest of the tree from copying - a single flaky
        // file is reported, not fatal to the whole run.
        const dir = tempDir('syndicast-copy-tree-partial-');
        try {
            const srcRoot = path.join(dir, 'src');
            const destRoot = path.join(dir, 'dest');
            fs.mkdirSync(srcRoot, { recursive: true });
            fs.writeFileSync(path.join(srcRoot, 'good.json'), JSON.stringify({ ok: true }));
            fs.writeFileSync(path.join(srcRoot, 'vanishes.json'), JSON.stringify({ ok: true }));

            const realStat = fs.statSync;
            const statSpy = (p, ...rest) => {
                if (String(p).endsWith('vanishes.json')) {
                    const err = new Error('ENOENT (simulated)');
                    err.code = 'ENOENT';
                    throw err;
                }
                return realStat(p, ...rest);
            };
            fs.statSync = statSpy;
            let result;
            try {
                result = await copyTreeVerified(srcRoot, destRoot, { maxAttempts: 2, delayMs: 5 });
            } finally {
                fs.statSync = realStat;
            }

            suite.check('the unreadable file is reported as a failure',
                result.failures.length === 1 && result.failures[0].path.endsWith('vanishes.json'),
                JSON.stringify(result));
            suite.check('the rest of the tree still copies despite the one failure',
                fs.existsSync(path.join(destRoot, 'good.json')));
        } finally {
            removeDir(dir);
        }
    }

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
