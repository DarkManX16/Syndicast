/*
 * Keeps web/public/bundle.js (the browserified editor UI, gitignored, not
 * source) from ever being older than the code it's built from without anyone
 * noticing - see NOTES.md's "the browserify bundle must never be older than
 * the code it's built from" for the two incidents this replaces.
 *
 * Tracks the bundle's *real* inputs rather than guessing a directory to
 * watch: every build records the exact file list browserify actually
 * resolved (via its 'file' event), which is how a change to src/day-parts.js
 * - outside web/ entirely, but require()'d into the bundle - is caught the
 * same as a change under web/ itself. A brand new .js file under `watchDir`
 * that isn't wired into any require() yet can't appear in that list no
 * matter how many times it's rebuilt, so a separate snapshot of every .js
 * file seen under `watchDir` is kept alongside it purely to notice *that*
 * file showed up - not to prove it's actually bundled.
 */
const fs = require('fs');
const path = require('path');

function statMtimeMs(file) {
    return fs.statSync(file).mtimeMs;
}

function listJsFilesRecursive(dir, excludeDirs) {
    let out = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        return out;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (excludeDirs.some((x) => full === x || full.startsWith(x + path.sep))) {
            continue;
        }
        if (entry.isDirectory()) {
            out = out.concat(listJsFilesRecursive(full, excludeDirs));
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            out.push(full);
        }
    }
    return out;
}

class BundleFreshnessChecker {
    constructor({ entryFile, outFile, manifestFile, watchDir, watchDirExclude }) {
        this.entryFile = entryFile;
        this.outFile = outFile;
        this.manifestFile = manifestFile;
        this.watchDir = watchDir;
        this.watchDirExclude = watchDirExclude || [];
        this.building = null;
        this.lastFailedSignature = null;
        this.lastFailureLogged = false;
    }

    _loadManifest() {
        try {
            const raw = JSON.parse(fs.readFileSync(this.manifestFile, 'utf8'));
            if (!Array.isArray(raw.inputs)) return null;
            return { inputs: raw.inputs, seenFiles: Array.isArray(raw.seenFiles) ? raw.seenFiles : raw.inputs };
        } catch (err) {
            return null;
        }
    }

    _saveManifest(inputs, seenFiles) {
        const tmp = this.manifestFile + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify({ inputs, seenFiles }, null, 2));
        fs.renameSync(tmp, this.manifestFile);
    }

    // Never throws. { stale, signature } - signature identifies *what's*
    // stale, so a repeat with the same signature is a repeat of a build
    // that's already known to fail, not a new reason to try again.
    _computeStaleness() {
        const manifest = this._loadManifest();
        let bundleMtime;
        try {
            bundleMtime = statMtimeMs(this.outFile);
        } catch (err) {
            bundleMtime = -Infinity;
        }
        if (manifest === null) {
            return { stale: true, signature: 'no-manifest', reason: 'no build record yet' };
        }

        let newestInput = -Infinity;
        for (const f of manifest.inputs) {
            try {
                const mtime = statMtimeMs(f);
                if (mtime > newestInput) newestInput = mtime;
            } catch (err) {
                newestInput = Infinity; // a recorded input vanished
                break;
            }
        }

        const seen = new Set(manifest.seenFiles.map((f) => path.resolve(f)));
        const onDisk = listJsFilesRecursive(this.watchDir, this.watchDirExclude);
        const newFiles = onDisk.filter((f) => !seen.has(path.resolve(f))).sort();

        const stale = newestInput > bundleMtime || newFiles.length > 0;
        const signature = `${newestInput}|new:${newFiles.join(',')}`;
        const reason = newFiles.length > 0
            ? `new file(s): ${newFiles.join(', ')}`
            : (stale ? 'an input changed' : null);
        return { stale, signature, reason };
    }

    // Resolves once the bundle is known-fresh-or-best-effort. Never rejects:
    // a build failure is logged and leaves the previous bundle being served.
    async ensureFresh() {
        if (this.building) {
            return this.building;
        }
        const staleness = this._computeStaleness();
        if (!staleness.stale) {
            return;
        }
        if (this.lastFailedSignature !== null && this.lastFailedSignature === staleness.signature) {
            return; // already tried this exact state and it failed; wait for another change
        }
        this.building = this._rebuild(staleness).finally(() => {
            this.building = null;
        });
        return this.building;
    }

    async _rebuild(staleness) {
        const tmpOut = `${this.outFile}.tmp-${process.pid}-${Date.now()}`;
        const inputs = [];
        try {
            const browserify = require('browserify');
            await new Promise((resolve, reject) => {
                const b = browserify(this.entryFile);
                b.on('file', (file) => inputs.push(file));
                const bundleStream = b.bundle();
                bundleStream.on('error', reject);
                const out = fs.createWriteStream(tmpOut);
                out.on('error', reject);
                out.on('finish', resolve);
                bundleStream.pipe(out);
            });
            fs.renameSync(tmpOut, this.outFile);
            const seenFiles = listJsFilesRecursive(this.watchDir, this.watchDirExclude);
            this._saveManifest(inputs, seenFiles);
            this.lastFailedSignature = null;
            this.lastFailureLogged = false;
            console.log(`[web-bundle] rebuilt ${path.basename(this.outFile)} (${inputs.length} files) - ${staleness.reason}`);
        } catch (err) {
            try { fs.unlinkSync(tmpOut); } catch (e) { /* nothing to clean up */ }
            this.lastFailedSignature = staleness.signature;
            if (!this.lastFailureLogged) {
                console.error(`[web-bundle] rebuild failed, still serving the previous ${path.basename(this.outFile)}:`, err.message);
                this.lastFailureLogged = true;
            }
        }
    }

    // Cheap: true only while the last known build attempt failed and nothing
    // has changed since. Used by /api/version so the footer can say the
    // editor may be out of date.
    isStale() {
        return this.lastFailedSignature !== null;
    }
}

module.exports = { BundleFreshnessChecker };
