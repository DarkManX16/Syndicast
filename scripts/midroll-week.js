#!/usr/bin/env node
/*
 * The midroll layout on a copy of the real data (docs/blocks-spec.md, Stage 6, build order
 * 5f's proof): every channel's rows over the coming days, with the Midrolls switch off and on.
 *
 *   A  every real row's start, from the lineup (the switch off: no layout is built at all)
 *   B  the same rows with the switch on, each airing walked through its layout - its parts,
 *      its midrolls and its end break end to end - from where the airing before it ended
 *
 * A and B must be the same to the millisecond. Then every midroll is listed (channel, time,
 * show, episode, the point, who approved it, its length), with the reasons programs have
 * none and what the end break's held-back step time costs.
 *
 * Usage:
 *   node scripts/midroll-week.js --data <copy of .dizquetv-dev> --out <folder>
 *       [--from <ISO>]          the start (default: now)
 *       [--days <n>]            how many days (default 14)
 *       [--list]                print every midroll
 *       [--edits]               then, on the copy's store as the Breaks page would: approve a
 *                               point of a program with none, reject an airing point, withdraw
 *                               a show with midrolls; plan again and print every program whose
 *                               midrolls changed. WRITES the copy's breaks folder.
 *
 * Read-only without --edits. Point it at a copy, never at the live data folder.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const transitions = require('../src/transitions');
const midrolls = require('../src/midroll-plan');
const patterns = require('../src/break-patterns');
const edit = require('../src/break-edit');
const cards = require('../src/card-templates');
const CardTemplateDB = require('../src/dao/card-template-db');
const BreakScanService = require('../src/services/break-scan-service');

const DAY = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
    const args = { data: null, out: null, from: null, days: 14, list: false, edits: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--data') {
            args.data = argv[++i];
        } else if (a === '--out') {
            args.out = argv[++i];
        } else if (a === '--from') {
            args.from = new Date(argv[++i]).getTime();
        } else if (a === '--days') {
            args.days = Number(argv[++i]);
        } else if (a === '--list') {
            args.list = true;
        } else if (a === '--edits') {
            args.edits = true;
        }
    }
    return args;
}

const sha1 = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
const when = (t) => new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.round( (ms % 60000) / 1000 )).padStart(2, '0')}`;
const label = (p) => (p.type === 'episode') ? `${p.showTitle} ${ (p.season != null) ? `S${String(p.season).padStart(2, '0')}E${String(p.episode).padStart(2, '0')}` : '' } ${p.title}`.replace(/\s+/g, ' ') : p.title;

// Every real row starting in [from, to), with the index and lineup start; the one on at `from` too.
function rowsOf(channel, from, to) {
    const programs = channel.programs;
    const n = programs.length;
    const total = programs.reduce( (a, p) => a + p.duration, 0 );
    const lineupStart = new Date(channel.startTime).getTime();
    let offset = (from - lineupStart) % total;
    if (offset < 0) {
        offset += total;
    }
    let index = 0;
    let t = from - offset;
    while (t + programs[index].duration <= from) {
        t += programs[index].duration;
        index++;
    }
    const rows = [];
    for (let guard = 0; (t < to) && (guard < n * 100); guard++) {
        if (programs[index].isOffline !== true) {
            rows.push( { index, start: t } );
        }
        t += programs[index].duration;
        index = (index + 1) % n;
    }
    return rows;
}

// Where the airing at `index` from `start` ends, walked through its layout, or through the
// lineup's Flex run when it has none (a row with no file, a redirect's neighbour).
function endOf(channel, index, start, layout) {
    if (layout !== null) {
        let t = layout.start;
        layout.parts.forEach( (part, k) => {
            if (part.start !== t) {
                throw new Error(`channel ${channel.number} row ${index}: part ${k} starts at ${part.start}, not ${t}`);
            }
            t += part.toMs - part.fromMs;
            const m = layout.midrolls[k];
            if (m != null) {
                if (m.start !== t) {
                    throw new Error(`channel ${channel.number} row ${index}: midroll ${k} starts at ${m.start}, not ${t}`);
                }
                t += m.lengthMs;
            }
        } );
        if (layout.endBreak.start !== t) {
            throw new Error(`channel ${channel.number} row ${index}: the end break starts at ${layout.endBreak.start}, not ${t}`);
        }
        return t + layout.endBreak.lengthMs;
    }
    const programs = channel.programs;
    let t = start + programs[index].duration;
    for (let i = (index + 1) % programs.length, k = 0; (programs[i].isOffline === true) && (k < programs.length); i = (i + 1) % programs.length, k++) {
        t += programs[i].duration;
    }
    return t;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if ( (args.data === null) || (args.out === null) ) {
        console.error('usage: node scripts/midroll-week.js --data <copy> --out <folder> [--from <ISO>] [--days <n>] [--list] [--edits]');
        process.exit(2);
    }
    if (/\.dizquetv-dev[\\/]?$/.test(path.resolve(args.data)) && ! /copy|proof|scratch|tmp|temp/i.test(args.data)) {
        console.error('This looks like the live data folder. Point it at a copy.');
        process.exit(2);
    }
    fs.mkdirSync(args.out, { recursive: true });
    const from = (args.from != null) ? args.from : Date.now();
    const to = from + args.days * DAY;

    const channelDir = path.join(args.data, 'channels');
    const channelFiles = fs.readdirSync(channelDir).filter( (f) => /^\d+\.json$/.test(f) ).map( (f) => path.join(channelDir, f) );
    const before = new Map(channelFiles.map( (f) => [ f, sha1(f) ] ));
    const channels = channelFiles.map( (f) => JSON.parse(fs.readFileSync(f, 'utf8')) )
        .filter( (c) => Array.isArray(c.programs) && (c.programs.length > 0) )
        .sort( (a, b) => a.number - b.number );

    const templates = new CardTemplateDB(args.data);
    await templates.load();
    const service = new BreakScanService( { folder: args.data, channelService: { getAllChannels: async () => channels }, getFfmpegSettings: () => ({}), log: () => {} } );
    await service.load();

    const envFor = (channel, on, withSteps = true) => {
        const lists = {};
        for (const id of transitions.stepListIds(channel)) {
            const p = path.join(args.data, 'filler', `${id}.json`);
            lists[id] = fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')).content || null) : null;
        }
        return {
            on,
            pointsFor: (p) => service.pointsFor(p),
            getList: (id) => (withSteps && Array.isArray(lists[id])) ? lists[id] : null,
            cardMs: (id) => {
                const t = withSteps ? templates.template(id) : null;
                return (t == null) ? null : Math.round(cards.totalSeconds(t) * 1000);
            },
        };
    };

    // ---- plan every channel ---------------------------------------------------------------------
    const plan = () => {
        const out = { a: [], b: [], layoutsOff: 0, midrolls: [], why: {}, programs: 0, withMidrolls: 0, reserveCost: 0, reservePrograms: 0, by: {} };
        for (const channel of channels) {
            const off = envFor(channel, false);
            const on = envFor(channel, true);
            const bare = envFor(channel, true, false);
            const rows = rowsOf(channel, from, to);
            let chained = null;
            for (const row of rows) {
                const program = channel.programs[row.index];
                out.a.push(`${channel.number}\t${row.start}\t${new Date(row.start).toISOString()}\t${label(program)}`);
                if (midrolls.midrollLayout(channel, row.index, row.start, off) !== null) {
                    out.layoutsOff++;
                }
                const start = (chained === null) ? row.start : chained;
                out.b.push(`${channel.number}\t${start}\t${new Date(start).toISOString()}\t${label(program)}`);
                const layout = midrolls.midrollLayout(channel, row.index, start, on);
                chained = endOf(channel, row.index, start, layout);
                if (layout === null) {
                    continue;
                }
                out.programs++;
                if (layout.midrolls.length === 0) {
                    out.why[layout.why] = (out.why[layout.why] || 0) + 1;
                    continue;
                }
                out.withMidrolls++;
                const free = midrolls.midrollLayout(channel, row.index, start, bare);
                if (free.midrolls.length > layout.midrolls.length) {
                    out.reserveCost += free.midrolls.length - layout.midrolls.length;
                    out.reservePrograms++;
                }
                for (const m of layout.midrolls) {
                    out.by[m.by] = (out.by[m.by] || 0) + 1;
                    out.midrolls.push( { channel: channel.number, index: row.index, start: m.start, airing: start, file: program.file, show: transitions.showKey(program),
                        line: `${channel.number}  ${when(m.start)}  ${label(program)}  at ${mmss(m.atMs)} (${m.kind}, ${m.by})  ${mmss(m.lengthMs)}  [end break ${mmss(layout.endBreak.lengthMs)}]` } );
                }
            }
        }
        return out;
    };

    const first = plan();
    fs.writeFileSync(path.join(args.out, 'A-off.tsv'), first.a.join('\n') + '\n');
    fs.writeFileSync(path.join(args.out, 'B-on.tsv'), first.b.join('\n') + '\n');
    const sameAB = fs.readFileSync(path.join(args.out, 'A-off.tsv'), 'utf8') === fs.readFileSync(path.join(args.out, 'B-on.tsv'), 'utf8');
    console.log(`${when(from)} to ${when(to)}, channels ${channels.map( (c) => c.number ).join(', ')}`);
    console.log(`A (switch off): ${first.a.length} rows, ${first.layoutsOff} layouts built; sha1 ${sha1(path.join(args.out, 'A-off.tsv'))}`);
    console.log(`B (switch on):  ${first.b.length} rows walked through their layouts; sha1 ${sha1(path.join(args.out, 'B-on.tsv'))}`);
    console.log(`A and B ${sameAB ? 'IDENTICAL' : 'DIFFER'}`);
    console.log(`${first.programs} airings with a file: ${first.withMidrolls} with midrolls, ${first.midrolls.length} midrolls (${Object.entries(first.by).map( ([k, v]) => `${v} ${k}` ).join(', ')})`);
    console.log(`none: ${Object.entries(first.why).sort( (a, b) => b[1] - a[1] ).map( ([k, v]) => `${v} ${k}` ).join('; ')}`);
    console.log(`the end break's held-back step time cost ${first.reserveCost} midrolls on ${first.reservePrograms} airings`);
    const shows = new Map();
    for (const m of first.midrolls) {
        shows.set(m.show, (shows.get(m.show) || 0) + 1);
    }
    console.log(`${shows.size} shows with midrolls: ${[ ...shows.entries() ].sort( (a, b) => b[1] - a[1] ).map( ([k, v]) => `${k} (${v})` ).join(', ')}`);
    if (args.list) {
        first.midrolls.forEach( (m) => console.log('  ' + m.line) );
    }

    if (args.edits) {
        // as the Breaks page would, through the scan service: one approval, one rejection, one withdrawal
        const index = service.index;
        const airingPaths = new Set(first.midrolls.map( (m) => m.file ));
        const reject = first.midrolls.find( (m) => m.line.includes('auto') );
        const withdrawShow = first.midrolls.map( (m) => index.get(m.file) ).find( (f) => (f != null) && reject && (f.key !== index.get(reject.file).key) );
        let approve = null;
        for (const channel of channels) {
            for (const row of rowsOf(channel, from, to)) {
                const p = channel.programs[row.index];
                const found = (typeof(p.file) === 'string') ? index.get(p.file) : null;
                if ( (approve !== null) || (found == null) || airingPaths.has(p.file) || (withdrawShow && (found.key === withdrawShow.key)) ) {
                    continue;
                }
                const layout = midrolls.midrollLayout(channel, row.index, row.start, envFor(channel, true));
                const rec = found.record;
                const pick = (layout !== null) && (layout.flexMs >= 4 * 60000) && (layout.why === 'no point may air') && Array.isArray(rec.points)
                    ? rec.points.findIndex( (pt) => (pt.kind === 'act') && (pt.status === 'found') && (pt.at * 1000 > p.duration / 3) && (pt.at * 1000 < 2 * p.duration / 3) ) : -1;
                if (pick >= 0) {
                    approve = { key: found.key, file: p.file, index: pick, at: rec.points[pick].at, label: label(p) };
                }
            }
        }
        console.log('\nEdits on the copy, as the Breaks page makes them:');
        if (approve !== null) {
            service.updateShow(approve.key, (show) => edit.editPoint(show.files[approve.file], approve.index, 'approve'));
            console.log(`  approved ${approve.label} at ${mmss(approve.at * 1000)}`);
        }
        let rejected = null;
        if (reject) {
            // the point of that airing's first midroll
            const ch = channels.find( (c) => c.number === reject.channel );
            const lay = midrolls.midrollLayout(ch, reject.index, reject.airing, envFor(ch, true));
            const found = index.get(reject.file);
            const pi = lay.midrolls[0].index;
            rejected = { key: found.key, file: reject.file, index: pi, at: found.record.points[pi].at, label: label(ch.programs[reject.index]) };
            service.updateShow(rejected.key, (show) => edit.editPoint(show.files[rejected.file], rejected.index, 'reject'));
            console.log(`  rejected ${rejected.label} at ${mmss(rejected.at * 1000)}`);
        }
        if (withdrawShow) {
            service.updateShow(withdrawShow.key, (show) => {
                patterns.withdraw(show, Date.now());
            } );
            console.log(`  withdrew ${withdrawShow.key}`);
        }
        const second = plan();
        const sameAB2 = (second.a.join('\n') === first.a.join('\n')) && (second.b.join('\n') === first.a.join('\n'));
        const byAiring = (out) => {
            const m = new Map();
            for (const x of out.midrolls) {
                const k = `${x.channel}|${x.airing}`;
                m.set(k, (m.get(k) || []).concat( [ x.line.split('  ').slice(3).join('  ') ] ));
            }
            return m;
        };
        const a1 = byAiring(first);
        const a2 = byAiring(second);
        const keys = new Set( [ ...a1.keys(), ...a2.keys() ] );
        const changed = [];
        for (const k of keys) {
            if (JSON.stringify(a1.get(k) || []) !== JSON.stringify(a2.get(k) || [])) {
                const [ch, airing] = k.split('|').map(Number);
                const channel = channels.find( (c) => c.number === ch );
                const row = rowsOf(channel, Number(airing), Number(airing) + 1)[0];
                const p = channel.programs[row.index];
                const why = (approve && (p.file === approve.file)) ? 'approved'
                    : (rejected && (p.file === rejected.file)) ? 'rejected'
                        : (withdrawShow && (index.get(p.file) || {}).key === withdrawShow.key) ? 'withdrawn' : 'NOT EDITED';
                changed.push( { why, line: `${ch}  ${when(Number(airing))}  ${label(p)}: ${JSON.stringify(a1.get(k) || [])} -> ${JSON.stringify(a2.get(k) || [])}` } );
            }
        }
        console.log(`\nPlanned again: rows ${sameAB2 ? 'still identical, A and B' : 'DIFFER'}; ${second.midrolls.length} midrolls (was ${first.midrolls.length}); ${changed.length} airings changed:`);
        for (const why of [ 'approved', 'rejected', 'withdrawn', 'NOT EDITED' ]) {
            const these = changed.filter( (c) => c.why === why );
            if (these.length > 0) {
                console.log(`  ${why}: ${these.length}`);
                these.slice(0, (why === 'withdrawn') ? 3 : 20).forEach( (c) => console.log(`    ${c.line}`) );
            }
        }
    }

    const after = channelFiles.filter( (f) => sha1(f) !== before.get(f) );
    console.log(`\nchannel files unchanged: ${after.length === 0 ? 'yes' : 'NO: ' + after.join(', ')}`);
}

main().catch( (err) => {
    console.error(err.stack || err);
    process.exit(1);
} );
