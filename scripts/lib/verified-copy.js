/*
 * Copies a file (or a whole tree) the way scripts/backup.js needs to: never
 * leaving a half-written file under its real name. NOTES.md's own
 * investigation ("A read during a write must not report the channel as
 * missing" in test/channel-save.js) found fs.writeFile truncates the target
 * before writing, so a copy landing mid-write can read a torn file - the
 * usual fix (write a temp file, rename over the target) also doesn't help
 * here on its own, because the *source* can still be torn regardless of how
 * the copy itself is written.
 *
 * The approach: copy to a temp name, then check the source didn't change
 * size or mtime between just before and just after the copy, that the copy's
 * size matches, and - for .json files, where a torn read is easiest to
 * detect - that it actually parses. Only then is the temp file renamed into
 * place; a copy that doesn't look stable is discarded and retried. The
 * rename itself is same-directory and nothing else has this temp name open,
 * so it doesn't hit the EPERM-while-a-reader-holds-it problem that ruled out
 * temp-then-rename for the app's own live writes.
 */
const fs = require('fs');
const path = require('path');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pure decision: does this copy look like a complete, stable snapshot of the
// source? Takes plain stat/content values so it's testable without touching
// disk.
function isStableCopy({ srcSizeBefore, srcSizeAfter, srcMtimeBefore, srcMtimeAfter, destSize, isJson, destText }) {
    if (srcSizeBefore !== srcSizeAfter) {
        return false;
    }
    if (srcMtimeBefore !== srcMtimeAfter) {
        return false;
    }
    if (destSize !== srcSizeBefore) {
        return false;
    }
    if (isJson) {
        try {
            JSON.parse(destText);
        } catch (err) {
            return false;
        }
    }
    return true;
}

async function copyFileVerified(srcPath, destPath, { maxAttempts = 20, delayMs = 50 } = {}) {
    const tmpPath = destPath + '.tmp';
    const isJson = destPath.toLowerCase().endsWith('.json');

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let srcStatBefore;
        try {
            srcStatBefore = fs.statSync(srcPath);
        } catch (err) {
            return { ok: false, attempts: attempt, reason: `source unreadable: ${err.code || err.message}` };
        }

        try {
            fs.copyFileSync(srcPath, tmpPath);
        } catch (err) {
            await sleep(delayMs);
            continue;
        }

        let stable = false;
        try {
            const destStat = fs.statSync(tmpPath);
            const destText = isJson ? fs.readFileSync(tmpPath, 'utf8') : null;
            const srcStatAfter = fs.statSync(srcPath);
            stable = isStableCopy({
                srcSizeBefore: srcStatBefore.size,
                srcSizeAfter: srcStatAfter.size,
                srcMtimeBefore: srcStatBefore.mtimeMs,
                srcMtimeAfter: srcStatAfter.mtimeMs,
                destSize: destStat.size,
                isJson,
                destText,
            });
        } catch (err) {
            stable = false;
        }

        if (stable) {
            fs.renameSync(tmpPath, destPath);
            return { ok: true, attempts: attempt };
        }

        try {
            fs.rmSync(tmpPath, { force: true });
        } catch (err) {
            // ignore - next attempt overwrites it, and cleanup below covers giving up
        }
        await sleep(delayMs);
    }

    try {
        fs.rmSync(tmpPath, { force: true });
    } catch (err) {
        // nothing to clean up
    }
    return { ok: false, attempts: maxAttempts, reason: 'never stabilized' };
}

function listEntries(dir) {
    return fs.readdirSync(dir, { withFileTypes: true });
}

// Walks srcDir into destDir, mirroring structure, verifying each file with
// copyFileVerified. A single file that fails is recorded in `failures` and
// does not stop the rest of the tree from copying.
async function copyTreeVerified(srcDir, destDir, options = {}) {
    fs.mkdirSync(destDir, { recursive: true });
    let totalFiles = 0;
    const failures = [];

    for (const entry of listEntries(srcDir)) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);

        if (entry.isDirectory()) {
            const sub = await copyTreeVerified(srcPath, destPath, options);
            totalFiles += sub.totalFiles;
            failures.push(...sub.failures);
            continue;
        }
        if (!entry.isFile()) {
            // symlinks, devices, etc. - not expected under .dizquetv-dev, skip rather than guess
            continue;
        }

        totalFiles++;
        const result = await copyFileVerified(srcPath, destPath, options);
        if (!result.ok) {
            failures.push({ path: srcPath, reason: result.reason, attempts: result.attempts });
        }
    }

    return { totalFiles, failures };
}

module.exports = { isStableCopy, copyFileVerified, copyTreeVerified };
