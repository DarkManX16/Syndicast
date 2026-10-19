#!/usr/bin/env node
/*
 * Proves the "only at these times" option (times) is additive: runs every real
 * channel's OWN SAVED transitions through the old and new buildPlan, over
 * several weeks, and diffs the plans. Since no step saved before this change
 * carries `times`, the two must agree on every break - this is the real-data
 * check for "saved channels and plans don't change" (the pattern
 * scripts/compare-cascade-engine.js already uses for the cascade option).
 *
 * Usage: node scripts/compare-times-engine.js <data-folder> <old-repo-root>
 *            [--weeks 8] [--from YYYY-MM-DD] [--control]
 *
 *   <old-repo-root>  a checkout (or worktree) of the code to compare against;
 *                    the code being compared is the one this script sits in.
 *   --control        also runs the NEW code with one step on every channel's
 *                    first day-part changed to a narrow time window, to prove
 *                    the comparison can see a real difference when there is one.
 *
 * READ-ONLY. Point it at a COPY of the data folder, not the live one.
 */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const args = { folder: null, old: null, weeks: 8, from: '2026-10-18', control: false };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--weeks' && i + 1 < argv.length) {
            args.weeks = parseInt(argv[++i], 10);
        } else if (argv[i] === '--from' && i + 1 < argv.length) {
            args.from = argv[++i];
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
if ((args.folder === null) || (args.old === null)) {
    console.error('usage: node scripts/compare-times-engine.js <data-folder> <old-repo-root> [--weeks 8] [--from YYYY-MM-DD] [--control]');
    process.exit(2);
}

const engine = (root) => ({ transitions: require(path.join(root, 'src', 'transitions')) });
const oldE = engine(path.resolve(args.old));
const newE = engine(path.join(__dirname, '..'));

const readJsonFiles = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter( (f) => f.endsWith('.json') )
    .map( (f) => ({ id: f.slice(0, -5), file: f, json: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }) ) : [];
const channels = readJsonFiles(path.join(args.folder, 'channels'));
if (channels.length === 0) {
    console.error(`no channel files found under ${path.join(args.folder, 'channels')}`);
    process.exit(2);
}
const fillers = readJsonFiles(path.join(args.folder, 'filler'));
const lists = {};
for (const f of fillers) {
    lists[f.id] = f.json.content || [];
}

const [y, m, d] = args.from.split('-').map(Number);
const from = new Date(y, m - 1, d).getTime();

const env = { getList: (id) => lists[id] || null, lastPlayed: () => 0, featuresShows: () => false };
const run = (e, channel, weeks, environment) => {
    const to = from + 7 * weeks * 24 * 60 * 60 * 1000;
    return e.transitions.breaksBetween(channel, from, to).map( (brk) => {
        const plan = e.transitions.buildPlan(channel, brk, environment);
        return JSON.stringify([plan.situation,
            plan.out.map( (s) => [s.clip.title, s.listId, s.via, s.specific] ),
            plan.in.map( (s) => [s.clip.title, s.listId, s.via, s.specific] ),
            plan.skipped.map( (s) => [s.stepId, s.side, s.reason, s.problem] )]);
    } );
};

let totalBreaks = 0;
let totalDiffer = 0;
let totalWithSteps = 0;
for (const { file, json: channel } of channels) {
    if (! newE.transitions.hasSteps(channel)) {
        console.log(`channel ${channel.number} [${file}]: no transitions configured, skipped`);
        continue;
    }
    const a = run(oldE, channel, args.weeks, env);
    const b = run(newE, channel, args.weeks, env);
    let different = 0;
    let withSteps = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            different++;
        }
        const parsed = JSON.parse(a[i]);
        if (parsed[1].length + parsed[2].length > 0) {
            withSteps++;
        }
    }
    console.log(`channel ${channel.number} [${file}]: ${args.weeks} weeks from ${args.from}: ${a.length} breaks, `
        + `${withSteps} with clips, ${different} differ`
        + (a.length !== b.length ? ` (!! ${a.length} vs ${b.length} breaks)` : ''));
    totalBreaks += a.length;
    totalDiffer += different;
    totalWithSteps += withSteps;
}
console.log(`\nTOTAL: ${totalBreaks} breaks across ${channels.length} channel(s), ${totalWithSteps} with clips, ${totalDiffer} differ.`);

if (args.control) {
    console.log('\n-- control: a narrow time window on one channel\'s first day-part proves the comparison can see a real change --');
    const target = channels.find( ({ json }) => newE.transitions.hasSteps(json) ) || channels[0];
    const channel = JSON.parse(JSON.stringify(target.json));
    const context = (channel.dayParts || [])[0] || (channel.blocks || [])[0];
    if (context == null) {
        console.log('no day-part or block to mark; skipping the control.');
    } else {
        context.transitions = context.transitions || {};
        context.transitions.betweenShows = context.transitions.betweenShows || { out: [], in: [] };
        context.transitions.betweenShows.out = context.transitions.betweenShows.out || [];
        // A one-millisecond window a break's start can only hit by astronomical
        // coincidence, so this step should always be left out - but it still
        // changes the plan, because it displaces whatever a step with no times
        // would otherwise find there.
        context.transitions.betweenShows.out.push({ id: 'control-times', kind: 'list', listId: Object.keys(lists)[0] || 'none',
            match: 'any', times: { start: 0, end: 1 } });
        const a = run(oldE, target.json, args.weeks, env);
        const c = run(newE, channel, args.weeks, env);
        let controlDiffer = 0;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== c[i]) {
                controlDiffer++;
            }
        }
        console.log(`channel ${channel.number}, with a narrow-times step added to betweenShows.out: ${controlDiffer} of ${a.length} breaks differ `
            + '(must be > 0, or the comparison proves nothing).');
    }
}
