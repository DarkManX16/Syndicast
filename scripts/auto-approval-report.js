/*
 * Read-only: every show a breaks folder would have approved automatically (docs/blocks-spec.md,
 * "The Midrolls switch, and approved automatically"), and the totals. Run it on a copy:
 *   node scripts/auto-approval-report.js <copy of the breaks folder> [--points]
 * Shows: at least one episode airs a break automatically. Episodes and breaks: what the rule
 * approves; "airing" counts what airablePoints() would play once a person's choices win
 * (a show he approved or withdrew, points he rejected or decided himself).
 */
const store = require('../src/breaks-store');
const patterns = require('../src/break-patterns');
const { airablePoints } = require('../src/break-airable');

const dir = process.argv[2];
if (! dir) {
    console.error('usage: node scripts/auto-approval-report.js <breaks folder> [--points]');
    process.exit(2);
}
const listPoints = process.argv.includes('--points');
const total = { shows: 0, episodes: 0, breaks: 0, scanned: 0, airingShows: 0, airingEpisodes: 0, airingBreaks: 0 };
const rows = [];
for (const key of store.listShowKeys(dir)) {
    const isMovie = key.startsWith('movie.');
    const show = store.loadShow(dir, key);
    if (! isMovie && (patterns.scanned(show).length > 0)) {
        total.scanned++;
    }
    const auto = patterns.autoApproval(show, { isMovie });
    let eps = 0, brk = 0, airEps = 0, airBrk = 0;
    const picks = [];
    for (const [path, rec] of patterns.scanned(show)) {
        const pts = patterns.autoPoints(auto, rec);
        if (pts.length > 0) {
            eps++;
            brk += pts.length;
            picks.push(`${path.split(/[\/]/).pop()}: ${pts.map( (p) => patterns.clock(p.at) ).join(' ')}`);
        }
        const airing = airablePoints(show, path, { isMovie, auto }).filter( (p) => p.by === 'auto' );
        if (airing.length > 0) {
            airEps++;
            airBrk += airing.length;
        }
    }
    if (eps === 0) {
        continue;
    }
    total.shows++;
    total.episodes += eps;
    total.breaks += brk;
    if (airEps > 0) {
        total.airingShows++;
    }
    total.airingEpisodes += airEps;
    total.airingBreaks += airBrk;
    const groups = auto.groups.filter( (g) => g.approved ).map( (g) => `${g.count} a ep, ${g.holding}/${g.episodes} hold, ${Math.round(g.minMs / 60000)}-${Math.round(g.maxMs / 60000)} min` ).join('; ');
    const note = (show.pattern != null) ? ' [he approved it]' : ( (show.withdrawn != null) ? ' [he withdrew it]' : '' );
    rows.push(`${key}: ${eps} episodes, ${brk} breaks (${groups})${note}`);
    if (listPoints) {
        picks.forEach( (p) => rows.push(`    ${p}`) );
    }
}
rows.forEach( (r) => console.log(r) );
console.log(`\n${total.shows} of ${total.scanned} scanned shows approved automatically: ${total.episodes} episodes, ${total.breaks} breaks.`);
console.log(`Airing automatically once his own choices win: ${total.airingShows} shows, ${total.airingEpisodes} episodes, ${total.airingBreaks} breaks.`);
