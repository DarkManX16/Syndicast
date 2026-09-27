/*
 * src/web-bundle.js: the check that keeps web/public/bundle.js from being
 * older than the code it's built from without anyone noticing (see NOTES.md).
 * Drives the real module against a scratch fixture tree with a real
 * browserify build - not a transcription of its staleness logic - so an
 * entry file, a file under the watched "web" directory, and a file outside
 * it (standing in for src/day-parts.js, which the real bundle also pulls in)
 * are all real files on disk that really get bundled.
 *
 * "Stale" is proved by rolling the *bundle's* mtime back a few seconds
 * rather than pushing an edited file's mtime forward: an edited file's mtime
 * is whatever real wall-clock time the edit happens to land on, and a
 * rebuild's mtime is real wall-clock time strictly later than that (the
 * rebuild runs after the edit, in the same synchronous test step) - forcing
 * the edited file artificially ahead of "now" would only have to race the
 * next real rebuild to ever catch back up to it. Aging the bundle backward
 * has no such race: every subsequent natural mtime is already later than it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Suite } = require('./support');
const { BundleFreshnessChecker } = require('../src/web-bundle');

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
function readIfExists(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (err) {
        return null;
    }
}

module.exports = async function run() {
    const suite = new Suite('bundle freshness');
    const root = tempDir('syndicast-bundle-');
    try {
        const webRoot = path.join(root, 'webroot');
        const publicDir = path.join(webRoot, 'public');
        const outsideDir = path.join(root, 'outside'); // stands in for src/
        const outDir = path.join(root, 'out');
        fs.mkdirSync(path.join(webRoot, 'dir'), { recursive: true });
        fs.mkdirSync(publicDir, { recursive: true });
        fs.mkdirSync(outsideDir, { recursive: true });
        fs.mkdirSync(outDir, { recursive: true });

        const entryFile = path.join(webRoot, 'app.js');
        const moduleA = path.join(webRoot, 'dir', 'module-a.js');
        const shared = path.join(outsideDir, 'shared.js'); // day-parts.js analog
        const outFile = path.join(outDir, 'bundle.js');
        const manifestFile = path.join(root, 'bundle.manifest.json');

        fs.writeFileSync(entryFile,
            "module.exports = require('./dir/module-a') + '|' + require('../outside/shared');\n");
        fs.writeFileSync(moduleA, "module.exports = 'MODULE_A_V1';\n");
        fs.writeFileSync(shared, "module.exports = 'SHARED_V1';\n");

        const checker = new BundleFreshnessChecker({
            entryFile, outFile, manifestFile,
            watchDir: webRoot,
            watchDirExclude: [publicDir],
        });

        // Rolls the bundle's own mtime back so the next check unambiguously
        // sees it as older than any file with a real, current mtime -
        // deterministic, no race against how long a rebuild actually takes.
        function ageBundle(secondsBack) {
            const t = (Date.now() - secondsBack * 1000) / 1000;
            fs.utimesSync(outFile, t, t);
        }

        // ---- first build: no manifest yet, must build ------------------------
        await checker.ensureFresh();
        let built = readIfExists(outFile);
        suite.check('first call builds the bundle', built !== null);
        suite.check('first build includes the web-tree module', built && built.includes('MODULE_A_V1'));
        suite.check('first build includes the file outside the watched tree', built && built.includes('SHARED_V1'));
        suite.check('a manifest is recorded', fs.existsSync(manifestFile));
        suite.check('checker is not stale after a clean build', checker.isStale() === false);

        // ---- a changed web file triggers a rebuild ----------------------------
        ageBundle(10);
        fs.writeFileSync(moduleA, "module.exports = 'MODULE_A_V2';\n");
        await checker.ensureFresh();
        built = readIfExists(outFile);
        suite.check('editing a file under the watched web tree triggers a rebuild',
            built && built.includes('MODULE_A_V2'));

        // ---- a changed file outside web/ (the day-parts.js case) triggers one --
        ageBundle(10);
        fs.writeFileSync(shared, "module.exports = 'SHARED_V2';\n");
        await checker.ensureFresh();
        built = readIfExists(outFile);
        suite.check('editing a required file outside the watched tree triggers a rebuild',
            built && built.includes('SHARED_V2'));

        // ---- a brand new, unreferenced .js file under web/ also triggers one --
        const manifestBeforeNewFile = fs.statSync(manifestFile).mtimeMs;
        const moduleC = path.join(webRoot, 'dir', 'module-c.js');
        fs.writeFileSync(moduleC, "// not required anywhere\n");
        await checker.ensureFresh();
        const manifestAfterNewFile = fs.statSync(manifestFile).mtimeMs;
        suite.check('an unreferenced new file under the watched tree also triggers a rebuild attempt',
            manifestAfterNewFile !== manifestBeforeNewFile);

        await checker.ensureFresh();
        suite.check("once a new file has been seen, it doesn't force a rebuild every time",
            fs.statSync(manifestFile).mtimeMs === manifestAfterNewFile);

        // ---- a failing build serves the old bundle and sets the stale flag ---
        const goodBundle = readIfExists(outFile);
        ageBundle(10);
        fs.writeFileSync(moduleA, "this is not } valid javascript (((\n");
        let threw = false;
        try {
            await checker.ensureFresh();
        } catch (err) {
            threw = true;
        }
        suite.check('ensureFresh never throws, even when the build fails', threw === false);
        suite.check('a failed build leaves the previous bundle being served',
            readIfExists(outFile) === goodBundle);
        suite.check('a failed build sets the stale flag', checker.isStale() === true);

        const manifestAfterFailure = fs.statSync(manifestFile).mtimeMs;
        await checker.ensureFresh();
        suite.check("a repeat failure for the same broken state isn't retried",
            fs.statSync(manifestFile).mtimeMs === manifestAfterFailure);

        // ---- fixing the input rebuilds and clears the stale flag -------------
        fs.writeFileSync(moduleA, "module.exports = 'MODULE_A_FIXED';\n");
        await checker.ensureFresh();
        built = readIfExists(outFile);
        suite.check('fixing the input rebuilds successfully', built && built.includes('MODULE_A_FIXED'));
        suite.check('a successful rebuild clears the stale flag', checker.isStale() === false);

        // ---- concurrent requests share one in-flight rebuild ------------------
        ageBundle(10);
        fs.writeFileSync(shared, "module.exports = 'SHARED_V3';\n");
        checker.ensureFresh(); // fire, don't await - starts the rebuild synchronously
        const building1 = checker.building;
        checker.ensureFresh(); // a "concurrent" second request while the first is in flight
        const building2 = checker.building;
        suite.check('a second concurrent call reuses the same in-flight rebuild',
            building1 !== null && building1 === building2);
        await building1;
        built = readIfExists(outFile);
        suite.check('the shared in-flight rebuild still produces the fresh bundle',
            built && built.includes('SHARED_V3'));
    } finally {
        removeDir(root);
    }
    return suite;
};
