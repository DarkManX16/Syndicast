/*
 * Proof for step 5c's saved frames, on a COPY of the data folder (never the live one): what the
 * list to check wants, and the backfill run for real on drives you name, which no viewer may be
 * using - every other drive is skipped. Run it with the copy's own server stopped or its scanner
 * paused; this script is its own scanner, at idle CPU and Very Low disk priority.
 *
 *   node scripts/saved-frames-proof.js <copy of .dizquetv-dev> [--drives D:,H:] [--limit 200]
 *
 * Without --drives it only counts. Prints the frames wanted and already saved, then (with
 * --drives) how many it cut, how long each took and their size.
 */
const fs = require('fs');
const path = require('path');
const store = require('../src/breaks-store');
const { SavedFrames } = require('../src/break-saved-frames');
const BreakScanService = require('../src/services/break-scan-service');

const folder = process.argv[2];
const arg = (name) => { const i = process.argv.indexOf(name); return (i > 0) ? process.argv[i + 1] : null; };
if (! folder || /[\\/]\.dizquetv-dev[\\/]?$/.test(folder)) {
    console.error('usage: node scripts/saved-frames-proof.js <a COPY of .dizquetv-dev> [--drives D:,H:] [--limit 200]');
    process.exit(2);
}
const drives = (arg('--drives') || '').split(',').map( (d) => d.trim().toUpperCase() ).filter( (d) => /^[A-Z]:$/.test(d) );
const limit = Number(arg('--limit') || 200);

(async () => {
    const breaksDir = path.join(folder, 'breaks');
    const saved = new SavedFrames(folder);
    let wanted = 0;
    let have = 0;
    const byDrive = {};
    const t0 = Date.now();
    for (const key of store.listShowKeys(breaksDir)) {
        const show = store.loadShow(breaksDir, key);
        for (const w of saved.wanted(key, show)) {
            wanted++;
            const d = w.file.slice(0, 2).toUpperCase();
            byDrive[d] = (byDrive[d] || 0) + 1;
            if (fs.existsSync(w.out)) {
                have++;
            }
        }
    }
    console.log(`wanted: ${wanted} frames (${JSON.stringify(byDrive)}), saved already ${have}; worked out in ${Date.now() - t0} ms`);
    if (drives.length === 0) {
        return;
    }
    const all = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map( (c) => c + ':' );
    const service = new BreakScanService( {
        folder,
        channelService: { getAllChannels: async () => JSON.parse('[]') },
        getFfmpegSettings: () => JSON.parse(fs.readFileSync(path.join(folder, 'ffmpeg-settings.json'), 'utf8'))[0],
        log: () => {},
        force: 'normal',
    } );
    await service.init();
    service.midrolls = true;
    service.governor.midrollsOff = false;
    service.governor.manualPaused = false;
    service.skipDrives = all.filter( (d) => ! drives.includes(d) );
    service.disk.start();
    const times = [];
    let cut = 0;
    for (let i = 0; i < limit; i++) {
        const s = Date.now();
        const ok = await service.backfillFrames();
        if (! ok && (service.backfillJobs.length === 0)) {
            break;
        }
        if (ok) {
            cut++;
            times.push(Date.now() - s);
        }
    }
    service.disk.stop();
    const sizes = [];
    const walk = (d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).forEach( (e) => e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.jpg') && sizes.push(fs.statSync(path.join(d, e.name)).size)) ) : null;
    walk(saved.dir);
    const med = (a) => { const x = a.slice().sort( (p, q) => p - q ); return x.length ? x[Math.floor(x.length / 2)] : null; };
    const sum = sizes.reduce( (a, b) => a + b, 0 );
    console.log(`cut ${cut} on ${drives.join(', ')}: median ${med(times)} ms, longest ${times.length ? Math.max(...times) : null} ms`);
    console.log(`saved frames now: ${sizes.length}, ${(sum / 1048576).toFixed(1)} MB, median ${med(sizes)} bytes`);
    process.exit(0);
})();
