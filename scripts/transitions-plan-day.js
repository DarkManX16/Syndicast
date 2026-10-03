#!/usr/bin/env node
/*
 * The plans one day of a channel would get, break by break, with a test sequence
 * on some of its day-parts and blocks. Stage 5 step 3's real-data check
 * (docs/blocks-spec.md): the same src/transitions.js the playback code will use,
 * run over the real lineup and the real filler lists.
 *
 * Usage: node scripts/transitions-plan-day.js <data-folder> [--channel 1]
 *            [--day YYYY-MM-DD] [--seq "<context text>=<list text>"]...
 *            [--breaks <n>]
 *
 *   --channel  the channel number to walk (default 1)
 *   --day      the day to walk, local midnight to midnight (default 2026-10-21)
 *   --seq      give every day-part or block whose name contains <context text>
 *              the test sequence, drawing from the filler list whose name
 *              contains <list text>. Repeatable; the first rule that matches a
 *              context wins. The default is the Adult Swim pair:
 *                "Adult Swim (Sun=Adult Swim [Sunday]"
 *                "Adult Swim=Adult Swim [Weekday]"
 *   --breaks   how many breaks to print in full (default: every one)
 *
 * The test sequence is the one the spec gives the NEXT promos: between shows,
 * on both sides of the Flex, one `show` step keyed on the next show from the
 * list, skip if none. Nothing is saved, nothing is changed: the sequence is put
 * on an in-memory copy of the channel.
 *
 * The saved filler lists carry no `names` yet (nothing writes them until the
 * review screen, step 6), so each unnamed clip is given step 2's proposal from
 * its title in memory, and the output says so. Last-played times are all zero,
 * so every clip is equally idle and the first that fits is chosen; in a live
 * stream playback is recorded and the choice rotates.
 *
 * READ-ONLY. Point it at a COPY of the data folder: a channel runs to tens of
 * megabytes and another session may be writing it.
 */
const fs = require('fs');
const path = require('path');
const showMatch = require('../src/show-match');
const transitions = require('../src/transitions');

function parseArgs(argv) {
    const args = { folder: null, channel: '1', day: '2026-10-21', seqs: [], breaks: Infinity };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--channel' && i + 1 < argv.length) {
            args.channel = argv[++i];
        } else if (argv[i] === '--day' && i + 1 < argv.length) {
            args.day = argv[++i];
        } else if (argv[i] === '--seq' && i + 1 < argv.length) {
            args.seqs.push(argv[++i]);
        } else if (argv[i] === '--breaks' && i + 1 < argv.length) {
            args.breaks = parseInt(argv[++i], 10);
        } else if (args.folder === null) {
            args.folder = argv[i];
        }
    }
    if (args.seqs.length === 0) {
        args.seqs = ['Adult Swim (Sun=Adult Swim [Sunday]', 'Adult Swim=Adult Swim [Weekday]'];
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

const args = parseArgs(process.argv.slice(2));
if (args.folder === null) {
    console.error('usage: node scripts/transitions-plan-day.js <data-folder> [--channel 1] [--day YYYY-MM-DD] [--seq "<context text>=<list text>"]... [--breaks <n>]');
    process.exit(2);
}

const channels = readJsonFiles(path.join(args.folder, 'channels')).map( (c) => c.json );
const channel = channels.find( (c) => String(c.number) === String(args.channel) );
if (typeof(channel) === 'undefined') {
    console.error(`no channel ${args.channel} in ${path.join(args.folder, 'channels')}`);
    process.exit(2);
}
const customShowNames = {};
for (const show of readJsonFiles(path.join(args.folder, 'custom-shows')) ) {
    customShowNames[show.id] = show.json.name;
}
const aliasFile = path.join(args.folder, 'show-aliases.json');
const aliases = fs.existsSync(aliasFile) ? ((JSON.parse(fs.readFileSync(aliasFile, 'utf8')) || {}).aliases || {}) : {};
const vocabulary = showMatch.buildVocabulary(channels, customShowNames);
const shownAs = (key) => (key == null) ? 'none' : (vocabulary.names[key] || key);

// The lists, named in memory from their titles where they carry no names.
const lists = {};
const listNames = {};
let proposed = 0;
let alreadyNamed = 0;
for (const f of readJsonFiles(path.join(args.folder, 'filler')) ) {
    listNames[f.id] = f.json.name;
    lists[f.id] = (f.json.content || []).map( (clip) => {
        if (showMatch.namesOf(clip).length > 0) {
            alreadyNamed++;
            return clip;
        }
        const names = showMatch.propose(clip.title, vocabulary, aliases).names;
        if (names.length === 0) {
            return clip;
        }
        proposed++;
        return Object.assign({}, clip, { names: names });
    });
}
const listIdFor = (text) => Object.keys(listNames).find( (id) => listNames[id].toLowerCase().includes(text.toLowerCase()) );

// The test sequence goes on an in-memory copy; the channel as read is not touched.
const rules = args.seqs.map( (s) => {
    const at = s.lastIndexOf('=');
    return { context: s.slice(0, at).toLowerCase(), list: s.slice(at + 1) };
});
const sequenced = [];
const withSequence = (context) => {
    const rule = rules.find( (r) => (context.name || '').toLowerCase().includes(r.context) );
    if (typeof(rule) === 'undefined') {
        return context;
    }
    const listId = listIdFor(rule.list);
    if (typeof(listId) === 'undefined') {
        console.error(`no filler list whose name contains "${rule.list}"`);
        process.exit(2);
    }
    sequenced.push(`${context.name} <- ${listNames[listId]}`);
    const step = (id) => ({ id: id, kind: 'list', listId: listId, match: 'show', keyedOn: 'next', fallbackListId: null });
    return Object.assign({}, context, { transitions: { betweenShows: { out: [step('next-out')], in: [step('next-in')] } } });
};
const copy = Object.assign({}, channel, {
    dayParts: (channel.dayParts || []).map(withSequence),
    blocks: (channel.blocks || []).map(withSequence),
});

const env = { getList: (id) => lists[id] || null, lastPlayed: () => 0 };
const [y, m, d] = args.day.split('-').map(Number);
const from = new Date(y, m - 1, d).getTime();
const to = new Date(y, m - 1, d + 1).getTime();
const breaks = transitions.breaksBetween(copy, from, to);

const clock = (t) => new Date(t).toTimeString().slice(0, 5);
const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`;
const label = (entry) => shownAs(transitions.showKey(entry.program));

console.log(`${channel.name} (channel ${channel.number}), ${args.day}`);
console.log(`test sequence (between shows, show step keyed on next, skip if none, both sides):`);
sequenced.forEach( (line) => console.log(`  ${line}`) );
console.log(`filler clips named in memory from their titles: ${proposed} (${alreadyNamed} already carried names)\n`);

const counts = { betweenEpisodes: 0, betweenShows: 0, boundary: 0, none: 0 };
const playing = {};
let withSteps = 0;
let overrun = 0;
let printed = 0;
const sequencedBreaks = [];
for (const brk of breaks) {
    const plan = transitions.buildPlan(copy, brk, env);
    counts[plan.situation]++;
    const hasSteps = (plan.out.length > 0) || (plan.in.length > 0);
    const configured = plan.skipped.length > 0 || hasSteps;
    if (hasSteps) {
        withSteps++;
        for (const s of plan.out.concat(plan.in)) {
            playing[listNames[s.listId]] = (playing[listNames[s.listId]] || 0) + 1;
        }
    }
    const length = brk.endTime - brk.startTime;
    const stepsMs = plan.outMs + plan.inMs;
    if (stepsMs > length) {
        overrun++;
    }
    if (configured) {
        sequencedBreaks.push(plan);
    }
    if (printed < args.breaks) {
        printed++;
        const line = plan.out.map( (s) => `${s.clip.title} [${(s.durationMs / 1000).toFixed(0)}s]` ).concat(['Flex ' + mmss(Math.max(0, length - stepsMs))],
            plan.in.map( (s) => `${s.clip.title} [${(s.durationMs / 1000).toFixed(0)}s]` ) ).join('  ->  ');
        const tag = configured ? (hasSteps ? '*' : '-') : ' ';
        console.log(`${tag} ${clock(brk.startTime)}  ${label(brk.prev)}  ->  ${label(brk.next)}   (${plan.situation}, break ${mmss(length)})`);
        if (configured) {
            console.log(`        ${hasSteps ? line : 'no clip names the next show: Flex only'}`);
        }
        for (const note of plan.notes) {
            console.log(`        note: ${note}`);
        }
    }
}

console.log(`\n${breaks.length} breaks: ${counts.betweenEpisodes} between episodes / ${counts.betweenShows} between shows / ${counts.boundary} boundaries`
    + (counts.none > 0 ? ` / ${counts.none} with no neighbour` : ''));
console.log(`* = a plan with steps, - = a break the sequence applies to but nothing names the show, blank = no sequence on its context`);
console.log(`${withSteps} breaks have steps; ${sequencedBreaks.length - withSteps} more fall under the sequence and found no clip`);
for (const name of Object.keys(playing).sort() ) {
    console.log(`  ${playing[name]} steps from ${name}`);
}
console.log(`steps longer than their whole break: ${overrun}`);
