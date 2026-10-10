/*
 * A snapshot of every show's full catalog on a copy of the data folder, read
 * the way the editor reads it - src/catalog-reader.js with the library's own
 * Plex code (web/services/plex.js) - for scripts/progress-check.js --catalog
 * and the proofs in NOTES.md ("Full catalogs, and a never-air list").
 *
 * Usage:
 *   node scripts/catalog-snapshot.js --data <copy> --plex <plex-servers.json> --out <file> [--channels 1,2,3]
 *
 * Plex is only read (GET). The snapshot's program objects carry icon URLs with
 * the Plex token, exactly as channel files do: keep it beside the copies and
 * never commit it.
 */
const fs = require('fs');
const path = require('path');
const { readCatalogs } = require('../src/catalog-reader');
const getShowData = require('../web/services/get-show-data')();
const commonProgramTools = require('../web/services/common-program-tools')(getShowData);
const plex = require('../web/services/plex')(null, null, null);

function parseArgs(argv) {
    let args = { channels: [1, 2, 3] };
    for (let i = 0; i < argv.length; i++) {
        let a = argv[i];
        let next = () => argv[++i];
        if (a === '--data') args.data = next();
        else if (a === '--plex') args.plex = next();
        else if (a === '--out') args.out = next();
        else if (a === '--channels') args.channels = next().split(',').map(Number);
        else throw new Error('Unknown argument ' + a);
    }
    if (! args.data || ! args.plex || ! args.out) throw new Error('--data, --plex and --out are required');
    return args;
}

async function main() {
    let args = parseArgs(process.argv.slice(2));
    let servers = JSON.parse(fs.readFileSync(args.plex, 'utf8'));
    let getShow = async (id) => {
        let f = path.join(args.data, 'custom-shows', id + '.json');
        return fs.existsSync(f) ? Object.assign({ id }, JSON.parse(fs.readFileSync(f, 'utf8'))) : null;
    };
    let out = {};
    for (let n of args.channels) {
        let channel = JSON.parse(fs.readFileSync(path.join(args.data, 'channels', n + '.json'), 'utf8'));
        let groups = new Map();
        commonProgramTools.removeDuplicates(channel.programs).forEach( (p) => {
            let d = getShowData(p);
            if (! d.hasShow || (d.showId === 'movie.') || p.isOffline) return;
            if (! groups.has(d.showId)) groups.set(d.showId, []);
            groups.get(d.showId).push(p);
        } );
        let shows = [ ...groups.entries() ].map( ([showId, items]) => ({ showId, title: items[0].showTitle, lineupItems: items }) );
        let t0 = Date.now();
        out[n] = await readCatalogs({ shows, servers, getNested: plex.getNested, getShowKey: plex.getShowKey, getShow });
        let errors = Object.entries(out[n]).filter( ([, c]) => c.error );
        console.log(`channel ${n}: ${shows.length} shows read in ${((Date.now() - t0) / 1000).toFixed(1)} s, `
            + `${Object.values(out[n]).reduce( (a, c) => a + (c.items ? c.items.length : 0), 0 )} items, ${errors.length} errors`
            + (errors.length ? ': ' + errors.map( ([id, c]) => id + ' (' + c.error + ')' ).join(', ') : ''));
    }
    fs.writeFileSync(args.out, JSON.stringify(out));
    console.log('saved ' + args.out);
}

main().catch( (err) => { console.error('failed: ' + err.message); process.exitCode = 1; } );
