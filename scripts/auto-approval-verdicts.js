/*
 * Read-only: what automatic approval picks on the frame-checked proof shows, against the
 * verdicts from the frames (docs/break-frame-verdicts.json). Run it on a copy:
 *   node scripts/auto-approval-verdicts.js <copy of the breaks folder>
 * A pick with no verdict of its own was never looked at in the frames, except that
 * Hannah Montana's and Gargoyles' were checked per show ("perShow", its tally there).
 */
const store = require('../src/breaks-store');
const patterns = require('../src/break-patterns');
const verdicts = require('../docs/break-frame-verdicts.json');

const dir = process.argv[2];
const SHOWS = { 'tv.Hannah Montana': 'Hannah Montana', 'tv.Family Guy': 'Family Guy', 'tv.Gargoyles': 'Gargoyles',
    'custom.799696bd-830c-46d9-99be-b2c59d236397': 'Batman', 'tv.Cheers': 'Cheers', 'tv.Full House': 'Full House' };
const base = (p) => p.split(/[\/]/).pop();
const epOf = (p) => ( (/S\d+\s?E\d+|\d+x\d+/i.exec(base(p)) || [ base(p).slice(0, 20) ])[0] ).replace(/\s/g, '');
const total = { clear: 0, unclear: 0, doubtful: 0, perShow: 0, unchecked: 0 };
for (const [key, name] of Object.entries(SHOWS)) {
    const show = store.loadShow(dir, key);
    const auto = patterns.autoApproval(show);
    const groups = auto.groups.filter( (g) => g.count !== null ).map( (g) => `${g.count} a ep, ${g.holding}/${g.episodes} hold${g.approved ? ', APPROVED' : ''}` );
    const tally = { clear: 0, unclear: 0, doubtful: 0, perShow: 0, unchecked: 0 };
    const notes = [];
    for (const [file, rec] of patterns.scanned(show)) {
        for (const p of patterns.autoPoints(auto, rec)) {
            const label = `${epOf(file)} ${patterns.clock(p.at)}`;
            const v = ( (verdicts.picks[key] || {})[label] ) || (verdicts.perShow[key] ? 'perShow' : 'unchecked');
            tally[v]++;
            total[v]++;
            if ( (v === 'unclear') || (v === 'doubtful') ) {
                notes.push(`${label} ${v}`);
            }
        }
    }
    console.log(`${name}: ${groups.join('; ') || 'no "N breaks an episode" line'} -> ${JSON.stringify(tally)}${notes.length ? '  ' + notes.join(', ') : ''}`);
}
console.log(`\nAll picks: ${JSON.stringify(total)}`);
