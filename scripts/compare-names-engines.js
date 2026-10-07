#!/usr/bin/env node
/*
 * Proves a change to how clips are named is additive: runs the name-reading code of
 * two source trees side by side over a data folder and reports every difference.
 * The real-data check for "nothing saved today reads differently" (docs/blocks-spec.md,
 * Stage 5; NOTES.md, the names entries).
 *
 * Usage: node scripts/compare-names-engines.js <data-folder> <old-repo-root>
 *            [--channel 1] [--from YYYY-MM-DD] [--weeks 8] [--control]
 *
 *   <old-repo-root>  a checkout (or worktree) of the code to compare against; the code
 *                    being compared is the one this script sits in.
 *   --control        also run the new code over a copy of the lists whose saved show
 *                    names have all been narrowed to one season. This must differ: a
 *                    comparison that cannot see a change proves nothing.
 *
 * Two comparisons:
 *   1. What the matcher proposes for every clip of every filler list, with the nicknames
 *      saved in the data folder (names, how each was found, anything flagged).
 *   2. The plan of every break of the channel over the weeks asked for, with one
 *      `show` step keyed on the next show, one `pair` step and one `any` step keyed on
 *      the show that just ended, from every list, on every situation of every day-part
 *      and block. Plans are compared as JSON.
 *
 * READ-ONLY. Point it at a COPY of the data folder: a channel runs to tens of megabytes.
 */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const args = { folder: null, old: null, channel: '1', from: '2026-10-18', weeks: 8, control: false };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--channel' && i + 1 < argv.length) {
            args.channel = argv[++i];
        } else if (argv[i] === '--from' && i + 1 < argv.length) {
            args.from = argv[++i];
        } else if (argv[i] === '--weeks' && i + 1 < argv.length) {
            args.weeks = parseInt(argv[++i], 10);
        } else if (argv[i] === '--control') {
            args.control = true;
        } else {
            rest.push(argv[i]);
        }
    }
    args.folder = rest[0] || null;
    args.old = rest[1] || null;
    return args;
}
const args = parseArgs(process.argv.slice(2));
if ( (args.folder === null) || (args.old === null) ) {
    console.error('usage: node scripts/compare-names-engines.js <data-folder> <old-repo-root> [--channel 1] [--from YYYY-MM-DD] [--weeks 8] [--control]');
    process.exit(2);
}

const engine = (root) => ({
    showMatch: require(path.join(root, 'src', 'show-match')),
    transitions: require(path.join(root, 'src', 'transitions')),
});
const oldE = engine(path.resolve(args.old));
const newE = engine(path.join(__dirname, '..'));

const readJsonFiles = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter( (f) => f.endsWith('.json') )
    .map( (f) => ({ id: f.slice(0, -5), json: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }) ) : [];
const channels = readJsonFiles(path.join(args.folder, 'channels')).map( (c) => c.json );
const customShowNames = {};
for (const show of readJsonFiles(path.join(args.folder, 'custom-shows')) ) {
    customShowNames[show.id] = show.json.name;
}
const fillers = readJsonFiles(path.join(args.folder, 'filler'));
const aliasFile = path.join(args.folder, 'show-aliases.json');
const aliases = fs.existsSync(aliasFile) ? (JSON.parse(fs.readFileSync(aliasFile, 'utf8')).aliases || {}) : {};

// ---- 1. proposals ------------------------------------------------------------------
{
    const oldVocab = oldE.showMatch.buildVocabulary(channels, customShowNames);
    const newVocab = newE.showMatch.buildVocabulary(channels, customShowNames);
    let clips = 0;
    const differ = [];
    for (const f of fillers) {
        for (const clip of (f.json.content || []) ) {
            clips++;
            const a = JSON.stringify(oldE.showMatch.propose(clip.title, oldVocab, aliases));
            const b = JSON.stringify(newE.showMatch.propose(clip.title, newVocab, aliases));
            if (a !== b) {
                differ.push(`${f.json.name} | ${clip.title}\n      old ${a}\n      new ${b}`);
            }
        }
    }
    console.log(`proposals: ${clips} clips in ${fillers.length} lists, ${Object.keys(aliases).length} nicknames saved: ${differ.length} differ`);
    differ.slice(0, 20).forEach( (d) => console.log('    ' + d) );
}

// ---- 2. plans ----------------------------------------------------------------------
{
    const channel = channels.find( (c) => String(c.number) === String(args.channel) );
    if (typeof(channel) === 'undefined') {
        console.error(`no channel ${args.channel}`);
        process.exit(2);
    }
    const lists = {};
    for (const f of fillers) {
        lists[f.id] = f.json.content || [];
    }
    const withNames = Object.keys(lists).filter( (id) => lists[id].some( (c) => Array.isArray(c.names) && c.names.length > 0 ) );
    const steps = [];
    withNames.forEach( (id, i) => {
        const base = { kind: 'list', listId: id, fallbackListId: null, onlyIfNoMatch: null, days: null, chance: null };
        steps.push(Object.assign({ id: `n${i}`, match: 'show', keyedOn: 'next' }, base));
        steps.push(Object.assign({ id: `p${i}`, match: 'pair', keyedOn: 'next' }, base));
        steps.push(Object.assign({ id: `a${i}`, match: 'any', keyedOn: 'now' }, base));
    } );
    const side = { out: steps, in: steps };
    const everywhere = (context) => Object.assign({}, context, { transitions: { leaving: side, entering: side, betweenEpisodes: side, betweenShows: side } });
    const copy = Object.assign({}, channel, { dayParts: (channel.dayParts || []).map(everywhere), blocks: (channel.blocks || []).map(everywhere) });
    const [y, m, d] = args.from.split('-').map(Number);
    const from = new Date(y, m - 1, d).getTime();
    const to = new Date(y, m - 1, d + 7 * args.weeks).getTime();
    const env = { getList: (id) => lists[id] || null, lastPlayed: () => 0, featuresShows: () => false };

    const run = (e, ch, environment) => e.transitions.breaksBetween(ch, from, to).map( (brk) => {
        const plan = e.transitions.buildPlan(ch, brk, environment);
        return JSON.stringify([plan.situation, plan.out.map( (s) => [s.clip.title, s.listId, s.via, s.specific] ), plan.in.map( (s) => [s.clip.title, s.listId, s.via, s.specific] )]);
    } );
    const a = run(oldE, copy, env);
    const b = run(newE, copy, env);
    let different = 0;
    let withClips = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            different++;
        }
        if (JSON.parse(a[i])[1].length + JSON.parse(a[i])[2].length > 0) {
            withClips++;
        }
    }
    console.log(`plans: channel ${channel.number}, ${args.weeks} weeks from ${args.from}, ${withNames.length} lists with saved names: ${a.length} breaks, ${withClips} with clips, ${different} differ`
        + (a.length !== b.length ? ` (!! ${a.length} vs ${b.length} breaks)` : ''));

    if (args.control) {
        const narrowed = {};
        for (const id of Object.keys(lists)) {
            narrowed[id] = lists[id].map( (c) => Array.isArray(c.names) ? Object.assign({}, c, {
                names: c.names.map( (n) => (typeof(n) === 'string') && /^tv\./.test(n) ? { show: n, season: 1 } : n ) }) : c );
        }
        const c = run(newE, copy, { getList: (id) => narrowed[id] || null, lastPlayed: () => 0, featuresShows: () => false });
        let controlDiffer = 0;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== c[i]) {
                controlDiffer++;
            }
        }
        console.log(`control (every saved show name narrowed to one season): ${controlDiffer} of ${a.length} differ`);
    }
}
