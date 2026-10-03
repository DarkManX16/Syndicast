#!/usr/bin/env node
/*
 * What the matcher proposes for a data folder's filler lists, and what it leaves
 * unnamed. Stage 5 step 2's real-data check (docs/blocks-spec.md).
 *
 * Usage: node scripts/match-lists.js <data-folder> [--list <text>]...
 *            [--unnamed <n|all>] [--fix "<clip text>=<show key>"]...
 *            [--shows "<title>|<title>|..."]
 *
 *   --list     only lists whose name contains <text> (repeatable, any case);
 *              without it every list gets its one-line summary and the
 *              Adult Swim, Toonami and AcTN lists are shown in full
 *   --unnamed  how many unnamed clips to print per shown list (default 25)
 *   --shows    add stand-in shows to the vocabulary, as Plex would title them,
 *              for a show no channel in this folder carries yet (a Nick at Nite
 *              lineup that is not in the dev data, say). Output is labelled.
 *   --fix      simulate one review-screen fix in memory: the first clip whose
 *              title contains <clip text> is mapped to <show key>, the aliases
 *              that would be learned are applied, and the lists are matched
 *              again. Nothing is saved.
 *
 * READ-ONLY. This only reads files - the channels, the filler lists, the custom
 * show names and show-aliases.json if there is one - and never writes, not even
 * with --fix. Point it at a COPY of the data folder anyway: channels run to tens
 * of megabytes and another session may be writing them.
 */
const fs = require('fs');
const path = require('path');
const showMatch = require('../src/show-match');

function parseArgs(argv) {
    const args = { folder: null, lists: [], unnamed: 25, fixes: [], shows: [] };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--list' && i + 1 < argv.length) {
            args.lists.push(argv[++i].toLowerCase());
        } else if (argv[i] === '--unnamed' && i + 1 < argv.length) {
            const v = argv[++i];
            args.unnamed = (v === 'all') ? Infinity : parseInt(v, 10);
        } else if (argv[i] === '--shows' && i + 1 < argv.length) {
            args.shows = argv[++i].split('|').map( (t) => t.trim() ).filter( (t) => t !== '' );
        } else if (argv[i] === '--fix' && i + 1 < argv.length) {
            args.fixes.push(argv[++i]);
        } else if (args.folder === null) {
            args.folder = argv[i];
        }
    }
    return args;
}

function readJsonFiles(dir) {
    if (! fs.existsSync(dir) ) {
        return [];
    }
    return fs.readdirSync(dir)
        .filter( (f) => f.endsWith('.json') )
        .map( (f) => ({ id: f.slice(0, -5), json: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }) );
}

function readAliases(folder) {
    const file = path.join(folder, 'show-aliases.json');
    if (! fs.existsSync(file) ) {
        return {};
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (parsed && parsed.aliases) || {};
}

const args = parseArgs(process.argv.slice(2));
if (args.folder === null) {
    console.error('usage: node scripts/match-lists.js <data-folder> [--list <text>]... [--unnamed <n|all>] [--fix "<clip text>=<show key>"]...');
    process.exit(2);
}

const channels = readJsonFiles(path.join(args.folder, 'channels')).map( (c) => c.json );
const customShowNames = {};
for (const show of readJsonFiles(path.join(args.folder, 'custom-shows')) ) {
    customShowNames[show.id] = show.json.name;
}
const lists = readJsonFiles(path.join(args.folder, 'filler'))
    .map( (f) => ({ id: f.id, name: f.json.name, content: f.json.content || [] }) )
    .sort( (a, b) => a.name.localeCompare(b.name) );
if (args.shows.length > 0) {
    // Stand-ins ride in as a channel of one-off episodes, the way a real one
    // would carry them, so they go through exactly the same vocabulary rules.
    channels.push( { number: 'stand-in', programs: args.shows.map( (title) => ({
        title: title + ' 1', type: 'episode', showTitle: title, duration: 22 * 60 * 1000 }) ) } );
}
const vocabulary = showMatch.buildVocabulary(channels, customShowNames);
let aliases = readAliases(args.folder);

const shown = (list) => (args.lists.length > 0)
    ? args.lists.some( (t) => list.name.toLowerCase().includes(t) )
    : /adult swim|toonami|actn/i.test(list.name);

function matchAll() {
    return lists.map( (list) => ({
        list: list,
        rows: list.content.map( (clip) => ({ clip: clip, proposal: showMatch.propose(clip.title, vocabulary, aliases) }) ),
    }) );
}

if (args.shows.length > 0) {
    console.log(`STAND-IN shows added to the vocabulary: ${args.shows.join(' | ')}`);
}
console.log(`${channels.length} channels, ${Object.keys(vocabulary.names).length} shows in the vocabulary, ${Object.keys(aliases).length} aliases, ${lists.length} filler lists`);
const ambiguous = Object.keys(vocabulary.ambiguous);
if (ambiguous.length > 0) {
    console.log(`titles owned by more than one show key: ${ambiguous.map( (f) => `"${f}" (${vocabulary.ambiguous[f].join(' / ')})` ).join('; ')}`);
}

function summarise(results, label) {
    console.log(`\n${label}`);
    let total = 0, named = 0;
    for (const { list, rows } of results) {
        const hits = rows.filter( (r) => r.proposal.names.length > 0 );
        const pairs = hits.filter( (r) => r.proposal.names.length === 2 ).length;
        const byAlias = hits.filter( (r) => r.proposal.found.some( (f) => f.via === 'alias' ) ).length;
        total += rows.length;
        named += hits.length;
        console.log(`  ${list.name.padEnd(32)} ${String(rows.length).padStart(4)} clips   ${String(hits.length).padStart(4)} named`
            + ` (${pairs} pairs, ${byAlias} using an alias)   ${String(rows.length - hits.length).padStart(4)} unnamed`);
    }
    console.log(`  ${'all lists'.padEnd(32)} ${String(total).padStart(4)} clips   ${String(named).padStart(4)} named   ${String(total - named).padStart(4)} unnamed`);
}

function detail(results) {
    for (const { list, rows } of results) {
        if (! shown(list) ) {
            continue;
        }
        const hits = rows.filter( (r) => r.proposal.names.length > 0 );
        console.log(`\n=== ${list.name} (${rows.length} clips: ${hits.length} named, ${rows.length - hits.length} unnamed)`);
        const byShow = new Map();
        for (const r of hits) {
            const label = r.proposal.names.map( (k) => vocabulary.names[k] || k ).join('  ->  ');
            if (! byShow.has(label) ) {
                byShow.set(label, []);
            }
            byShow.get(label).push(r);
        }
        for (const [label, group] of Array.from(byShow).sort( (a, b) => b[1].length - a[1].length )) {
            console.log(`  ${label}  (${group.length})`);
            for (const r of group.slice(0, 3) ) {
                const via = r.proposal.found.map( (f) => f.via === 'alias' ? `alias "${f.text}"` : (f.standalone ? 'title, bracketed word alone' : 'title') ).join(', ');
                console.log(`      ${r.clip.title}   [${via}]`);
            }
            if (group.length > 3) {
                console.log(`      ... and ${group.length - 3} more`);
            }
        }
        const extra = hits.filter( (r) => r.proposal.extra > 0 );
        if (extra.length > 0) {
            console.log(`  ${extra.length} clip(s) name more than two shows; only the first two are proposed`);
        }
        const unnamed = rows.filter( (r) => r.proposal.names.length === 0 );
        const sample = unnamed.slice(0, args.unnamed);
        console.log(`  unnamed (${unnamed.length}${sample.length < unnamed.length ? `, first ${sample.length}` : ''}):`);
        for (const r of sample) {
            console.log(`      ${r.clip.title}`);
        }
    }
}

let results = matchAll();
summarise(results, 'Proposals from titles' + (Object.keys(aliases).length > 0 ? ' and the aliases on file' : ' alone'));
detail(results);

for (const fix of args.fixes) {
    const at = fix.lastIndexOf('=');
    const text = fix.slice(0, at).toLowerCase();
    const key = fix.slice(at + 1);
    let clip = null;
    for (const { rows } of results) {
        const hit = rows.find( (r) => r.clip.title.toLowerCase().includes(text) );
        if (hit) { clip = hit.clip; break; }
    }
    if (clip === null) {
        console.log(`\n--fix "${fix}": no clip title contains "${text}"`);
        continue;
    }
    const corpus = [];
    for (const { rows } of results) {
        for (const r of rows) {
            corpus.push( { title: r.clip.title, names: r.proposal.names } );
        }
    }
    const learned = showMatch.learnAliases(clip.title, key, vocabulary, aliases, corpus);
    const before = results.reduce( (n, { rows }) => n + rows.filter( (r) => r.proposal.names.length > 0 ).length, 0 );
    aliases = Object.assign({}, aliases, learned.added);
    results = matchAll();
    const after = results.reduce( (n, { rows }) => n + rows.filter( (r) => r.proposal.names.length > 0 ).length, 0 );
    console.log(`\n--fix "${clip.title}" -> ${vocabulary.names[key] || key}   (simulated, nothing saved)`);
    console.log(`  learns: ${Object.keys(learned.added).map( (w) => `"${w}"` ).join(', ') || 'nothing'}`);
    console.log(`  skips:  ${learned.skipped.map( (s) => `"${s.word}" (${s.reason})` ).join(', ') || 'nothing'}`);
    console.log(`  named clips across all lists: ${before} -> ${after}`);
    for (const { list, rows } of results) {
        const gained = rows.filter( (r) => r.proposal.found.some( (f) => f.via === 'alias' && Object.prototype.hasOwnProperty.call(learned.added, f.text) ) );
        if (gained.length > 0) {
            console.log(`  ${list.name}: ${gained.length} clip(s) now named, e.g. ${gained.slice(0, 4).map( (r) => `"${r.clip.title}"` ).join(', ')}`);
        }
    }
}
