#!/usr/bin/env node
/*
 * Counts a channel's breaks over one week by situation, using the same
 * src/transitions.js the playback code will use. This is stage 5 step 1's
 * real-data check: docs/blocks-spec.md quotes channel 1's week of Oct 18, 2026.
 *
 * Usage: node scripts/transitions-week.js <channel.json> [--week YYYY-MM-DD]
 *                                         [--list <situation>]
 *
 *   --week   the Sunday the week starts on, local midnight (default 2026-10-18)
 *   --list   also print every break of that situation (leaving, entering,
 *            betweenEpisodes, betweenShows or boundary)
 *
 * Read-only. Point it at a copy of the channel file, not the live data folder:
 * a channel is tens of megabytes and another session may be writing it.
 */
const fs = require('fs');
const transitions = require('../src/transitions');

function parseArgs(argv) {
    const args = { file: null, week: '2026-10-18', list: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--week' && i + 1 < argv.length) {
            args.week = argv[++i];
        } else if (argv[i] === '--list' && i + 1 < argv.length) {
            args.list = argv[++i];
        } else if (args.file === null) {
            args.file = argv[i];
        }
    }
    return args;
}

function label(entry) {
    const p = entry.program;
    return `${transitions.showKey(p)} - ${p.title}`;
}

const args = parseArgs(process.argv.slice(2));
if (args.file === null) {
    console.error('usage: node scripts/transitions-week.js <channel.json> [--week YYYY-MM-DD] [--list <situation>]');
    process.exit(2);
}
const channel = JSON.parse(fs.readFileSync(args.file, 'utf8'));
const [y, m, d] = args.week.split('-').map(Number);
const from = new Date(y, m - 1, d).getTime();
const to = new Date(y, m - 1, d + 7).getTime();

const breaks = transitions.breaksBetween(channel, from, to);
const counts = { betweenEpisodes: 0, betweenShows: 0, boundary: 0, none: 0 };
const listed = [];
for (const brk of breaks) {
    const plan = transitions.assemble(channel, brk);
    counts[plan.situation]++;
    if (args.list === plan.situation) {
        listed.push(`${new Date(brk.startTime).toString().slice(0, 24)}  ${label(brk.prev)}  ->  ${label(brk.next)}`);
    }
}

console.log(`${channel.name} (channel ${channel.number}), week of ${args.week}`);
console.log(`${breaks.length} breaks: ${counts.betweenEpisodes} between episodes / ${counts.betweenShows} between shows / ${counts.boundary} boundaries`
    + (counts.none > 0 ? ` / ${counts.none} with no neighbour` : ''));
if (listed.length > 0) {
    console.log(`\n${args.list} (${listed.length}):`);
    listed.forEach((line) => console.log('  ' + line));
}
