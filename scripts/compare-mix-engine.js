#!/usr/bin/env node
/*
 * Proves dates on Mix entries (NOTES.md, "Event tools") are additive: runs
 * every real channel's breaks through the old and new createLineup - the
 * filler picker playback calls - with the same seeded random numbers and the
 * same play history, and diffs what each picks. No entry saved before this
 * change carries `dates`, so the two must agree on every pick.
 *
 * Usage: node scripts/compare-mix-engine.js <data-folder> <old-repo-root>
 *            [--weeks 8] [--from YYYY-MM-DDTHH:MM] [--control]
 *
 *   --control   also runs the NEW code with the first list of every mix the
 *               channel has dated to a range that is already over, to prove
 *               the comparison can see a real difference.
 *
 * READ-ONLY. Point it at a COPY of the data folder, not the live one.
 */
const fs = require('fs');
const path = require('path');
const randomJS = require('random-js');

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return (i === -1) ? dflt : argv[i + 1]; };
const [ folder, oldRoot ] = argv.filter( (a, i) => ! a.startsWith('--') && ! (i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--control') );
if (! folder || ! oldRoot) {
    console.error('usage: node scripts/compare-mix-engine.js <data-folder> <old-repo-root> [--weeks 8] [--from 2026-11-09T00:00] [--control]');
    process.exit(2);
}
const weeks = Number(opt('--weeks', 8));
const from = new Date(opt('--from', '2026-11-09T00:00')).getTime();
const control = argv.includes('--control');

const engine = (root) => ({
    helperFuncs: require(path.join(root, 'src', 'helperFuncs')),
    dayParts: require(path.join(root, 'src', 'day-parts')),
});
const oldE = engine(path.resolve(oldRoot));
const newE = engine(path.join(__dirname, '..'));

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const fillerContent = {};
for (const f of fs.readdirSync(path.join(folder, 'filler')).filter( (x) => x.endsWith('.json') )) {
    const j = readJson(path.join(folder, 'filler', f));
    fillerContent[f.slice(0, -5)] = Array.isArray(j.content) ? j.content : [];
}
const store = () => {
    const t = {};
    return { getProgramLastPlayTime: (c, k) => t[c + '|' + k] || 0, update: (c, k, v) => { t[c + '|' + k] = v; } };
};
// As filler-service.getFillersFromCollections loads them.
const fillersFor = (E, channel) => E.dayParts.allFillerCollections(channel).map( (c) => ({
    id: c.id, content: fillerContent[c.id] || [], weight: c.weight, cooldown: c.cooldown,
}) );
const seed = (E, n) => { E.helperFuncs.random.engine = randomJS.MersenneTwister19937.seed(n); };
const pickOf = (lineup) => JSON.stringify(lineup.map( (x) => [ x.type, x.title, x.key, x.start, x.streamDuration ] ));

function datedOver(channel) {
    const c = JSON.parse(JSON.stringify(channel));
    const over = { from: '2000-01-01', to: '2000-01-02' };
    const date = (mix) => { if (Array.isArray(mix) && mix.length > 0) { mix[0].dates = over; } };
    date(c.fillerCollections);
    (c.dayParts || []).forEach( (d) => date(d.fillerCollections) );
    (c.blocks || []).forEach( (b) => date(b.fillerCollections) );
    return c;
}

let total = 0;
let differ = 0;
let controlDiffer = 0;
for (const f of fs.readdirSync(path.join(folder, 'channels')).filter( (x) => x.endsWith('.json') )) {
    const channel = readJson(path.join(folder, 'channels', f));
    if (! Array.isArray(channel.programs) || (channel.programs.length === 0) ) {
        continue;
    }
    const cycle = channel.programs.reduce( (a, p) => a + p.duration, 0 );
    const start = new Date(channel.startTime).getTime();
    const oldFill = fillersFor(oldE, channel);
    const newFill = fillersFor(newE, channel);
    const dated = control ? datedOver(channel) : null;
    const datedFill = control ? fillersFor(newE, dated) : null;
    const stores = [ store(), store(), store() ];
    let n = 0;
    let d = 0;
    let t = from - ( ( (from - start) % cycle ) + cycle ) % cycle;
    let i = 0;
    while (t + channel.programs[i].duration <= from) {
        t += channel.programs[i].duration;
        i = (i + 1) % channel.programs.length;
    }
    const end = from + weeks * 7 * 24 * 3600 * 1000;
    for (; t < end; t += channel.programs[i].duration, i = (i + 1) % channel.programs.length) {
        const p = channel.programs[i];
        if (p.isOffline !== true) {
            continue;
        }
        // Into the break by a quarter of it, and a tune-in at its start.
        for (const [ into, isFirst ] of [ [ Math.floor(p.duration / 4), false ], [ 0, true ] ]) {
            const obj = { program: p, programIndex: i, timeElapsed: into, startsIn: 0 };
            const t0 = t + into;
            const s = n * 7919 + 1;
            seed(oldE, s);
            const a = pickOf(oldE.helperFuncs.createLineup(stores[0], Object.assign({}, obj), channel, oldFill, isFirst, t0));
            seed(newE, s);
            const b = pickOf(newE.helperFuncs.createLineup(stores[1], Object.assign({}, obj), channel, newFill, isFirst, t0));
            n++;
            if (a !== b) {
                d++;
                if (d <= 3) {
                    console.log(`  ch ${channel.number} ${new Date(t).toString().slice(0, 21)}: old ${a} / new ${b}`);
                }
            }
            if (control) {
                seed(newE, s);
                const c = pickOf(newE.helperFuncs.createLineup(stores[2], Object.assign({}, obj), dated, datedFill, isFirst, t0));
                if (c !== b) {
                    controlDiffer++;
                }
            }
        }
    }
    console.log(`channel ${channel.number} (${channel.name}): ${n} picks over ${weeks} weeks, ${d} differ`);
    total += n;
    differ += d;
}
console.log(`\n${total} picks, ${differ} differ between old and new.`);
if (control) {
    console.log(`control (a list dated to a range already over): ${controlDiffer} picks differ.`);
}
process.exitCode = (differ === 0) ? 0 : 1;
