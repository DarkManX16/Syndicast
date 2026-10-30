/*
 * Hand edits kept in the list (src/kept-rows.js), on a copy of a channel: the
 * first open's keep and let-go lines, and edits applied in the order given,
 * with the night printed before and after each and a count of every other
 * entry whose start or item changed.
 *
 * Usage:
 *   node scripts/kept-check.js --data <dataDir> --channel <n> --at <ISO>
 *       [--first-open]                         show the first open's lines; with any edit, apply it first
 *       [--swap "<local time>|<S2E20 | #12 | exact title>[|late|take]"]  the airing there, for an episode
 *                                              of its own show from the list (S2E20, or a title)
 *       [--insert "<local time>|<S2E20 | exact title>"]   in the break after the airing there
 *       [--remove "<local time>"]              Remove this airing only
 *       [--move "<from local time>|<to local time>"]      drag the row at from in front of the row at to
 *       [--put-back "<local time>"]           Put back on the row there
 *       [--around "<local time>"]             the night printed: three hours before, six after (default: the first edit's)
 *
 * A swap or a removal also says how the episode it pushed out moved along:
 * its position's later airings, each with the one before's episode; every
 * other change, counted; and each position's record as Create Lineup would
 * read it from the list (slot-progress planProgress), before and after. A
 * Put back says which earlier list it gives back, JSON for JSON.
 *
 * Reads only the channel file it is given; writes nothing.
 *
 * See NOTES.md, Known issues, "What you see is what airs: hand edits kept in the list".
 */
const fs = require('fs');
const path = require('path');
const kept = require('../src/kept-rows');
const pins = require('../src/pins');
const slotProgress = require('../src/slot-progress');
const rounds = require('../src/shuffle-rounds');
const getShowData = require('../web/services/get-show-data')();

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const SAME = 2000;

function parseArgs(argv) {
    let args = { edits: [] };
    for (let i = 0; i < argv.length; i++) {
        let a = argv[i];
        let next = () => argv[++i];
        if (a === '--data') args.data = next();
        else if (a === '--channel') args.channel = next();
        else if (a === '--at') args.at = Date.parse(next());
        else if (a === '--first-open') args.firstOpen = true;
        else if (a === '--around') args.around = Date.parse(next());
        else if ( [ '--swap', '--insert', '--remove', '--move', '--put-back' ].indexOf(a) !== -1 ) args.edits.push({ what: a.slice(2), spec: next() });
        else throw new Error('unknown argument ' + a);
    }
    if (! args.data || ! args.channel || isNaN(args.at)) {
        throw new Error('--data, --channel and --at are required');
    }
    return args;
}

const fmt = (t) => new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const mmss = (ms) => pins.length(ms);

function starts(lineup) {
    let out = [];
    lineup.programs.reduce( (t, p) => { out.push(t); return t + p.duration; }, lineup.startTime );
    return out;
}

// The row starting at a local time (within 2 s), round the loop to its next
// airing: a program, or a removal's kept Flex.
function rowAt(lineup, local) {
    let t = Date.parse(local);
    let total = lineup.programs.reduce( (a, p) => a + p.duration, 0 );
    let s = starts(lineup);
    let isRow = (p) => ! p.isOffline || p.kept;
    let i = s.findIndex( (x, k) => isRow(lineup.programs[k]) && Math.abs( (((t - x) % total) + total) % total ) <= SAME
        || isRow(lineup.programs[k]) && Math.abs( (((x - t) % total) + total) % total ) <= SAME );
    if (i === -1) {
        throw new Error('no airing starts at ' + local);
    }
    return i;
}

function itemFor(lineup, near, spec) {
    let own = getShowData(lineup.programs[near]);
    let m = /^S(\d+)E(\d+)$/i.exec(spec);
    let found = lineup.programs.find( (p) => ! p.isOffline && (getShowData(p).showId === own.showId)
        && (m ? (p.season === +m[1] && p.episode === +m[2]) : (p.title === spec)) );
    if (! found) {
        throw new Error(`no ${spec} of ${own.showId} in the list`);
    }
    return found;
}

function night(lineup, from, to) {
    let s = starts(lineup);
    let total = lineup.programs.reduce( (a, p) => a + p.duration, 0 );
    let base = Math.floor( (from - lineup.startTime) / total ) * total;
    let out = [];
    lineup.programs.forEach( (p, i) => {
        let t = s[i] + base;
        if (t < from) {
            t += total;
        }
        if ( (t >= from) && (t < to) ) {
            let flexAfter = 0;
            for (let j = i + 1; (j < lineup.programs.length) && lineup.programs[j].isOffline && ! lineup.programs[j].kept && (lineup.programs[j].type !== 'redirect'); j++) {
                flexAfter += lineup.programs[j].duration;
            }
            if (! p.isOffline || p.kept) {
                let mark = kept.keptKind(p) ? `[${kept.keptKind(p)}] ` : (p.pin ? '[pin] ' : '');
                out.push({ t, line: `    ${fmt(t)}  ${mark}${p.isOffline ? 'Flex' : pins.label(p)}  ${mmss(p.duration)} +${mmss(flexAfter)}` });
            }
        }
    } );
    return out.sort( (a, b) => a.t - b.t ).map( (x) => x.line );
}

// Entries whose start or item differ between two lists, by identity of what
// is there: compared position by position over the longer list.
function changed(before, after) {
    let a = starts(before), b = starts(after);
    let key = (p) => p.isOffline ? `flex|${p.duration}` : `${p.serverKey}|${p.key}|${p.title}|${p.duration}`;
    let seen = new Map();
    before.programs.forEach( (p, i) => seen.set(key(p) + '@' + a[i], true) );
    let moved = [];
    after.programs.forEach( (p, i) => {
        if (! seen.has(key(p) + '@' + b[i])) {
            moved.push({ start: b[i], program: p });
        }
    } );
    return moved;
}

/*
 * The pushed-out episode's position, read before and after: its airings after
 * the edited row, kept-as-it-is rows left out. After the edit each should be
 * at the same start with the episode the one before it had, the first with
 * the episode pushed out, and the last episode gone past the list's end.
 */
function along(before, after, index, was, now) {
    let key = kept.positionOf(was);
    if (key === null) {
        return [ `  moved along: nothing - ${pins.label(was)} has no position (placed by hand, or a Repeat)` ];
    }
    let from = starts(before)[index];
    // Past the end of the lineup the generator made: what aired, rotated there.
    let horizon = pins.loopEnd(before, now);
    let seq = (l, past) => {
        let s = starts(l);
        let out = [];
        l.programs.forEach( (p, i) => {
            if ( (s[i] > from) && ( (s[i] < horizon) !== past ) && ! p.isOffline && ! p.pin && ! kept.keepsItem(p) && (kept.positionOf(p) === key) ) {
                out.push({ t: s[i], f: rounds.fileKey(p), p: p });
            }
        } );
        return out;
    };
    let b = seq(before, false);
    let a = seq(after, false);
    let rb = seq(before, true);
    let ra = seq(after, true);
    let rotatedSame = (rb.length === ra.length) && rb.every( (x, k) => (x.f === ra[k].f) && (x.t === ra[k].t) );
    let expect = [ rounds.fileKey(was) ].concat( b.map( (x) => x.f ) );
    let wrong = a.filter( (x, k) => x.f !== expect[k] ).length;
    let moved = a.filter( (x, k) => (k < b.length) && (x.t !== b[k].t) );
    let lines = [ `  moved along: ${pins.showName(was)}, ${a.length} later airings (${b.length} before), ${a.length - wrong} with the episode of the one before`
        + (a.length > 0 ? `; ${title(was)} at ${fmt(a[0].t)}` : '') + (b.length > 0 ? `; past the end: ${pins.label(b[b.length - 1].p)} (last at ${fmt(b[b.length - 1].t)})` : '') ];
    lines.push(`    lineup made to ${fmt(horizon)}; aired airings rotated after it: ${rb.length}, ${rotatedSame ? 'all as they were' : 'CHANGED'}`);
    lines.push(`    starts moved: ${moved.length}` + moved.slice(0, 3).map( (x) => ` ${fmt(x.t)} ${pins.label(x.p)}` ).join(';'));
    a.slice(0, 3).forEach( (x, k) => lines.push(`    ${fmt(x.t)}  ${pins.label(x.p)}   (was ${b[k] ? pins.label(b[k].p) : '-'})`) );
    return lines;
}
const title = (p) => p.isOffline ? 'Flex' : p.title;

// Each position's record as Create Lineup reads it from the list.
function progressOf(lineup, now, schedule, pool) {
    return slotProgress.planProgress({ programs: lineup.programs, startTime: lineup.startTime, now, openedSchedule: schedule, schedule, pool, getShowData }).positions;
}

function main() {
    let args = parseArgs(process.argv.slice(2));
    let file = path.join(args.data, 'channels', args.channel + '.json');
    let channel = JSON.parse(fs.readFileSync(file, 'utf8'));
    let schedule = channel.scheduleBackup;
    let lineup = { programs: channel.programs, startTime: Date.parse(channel.startTime) };
    console.log(`${channel.number} ${channel.name} | at ${fmt(args.at)} | from ${file} (${fs.statSync(file).mtime.toISOString()})`);

    if (args.firstOpen) {
        let found = kept.firstOpen({ programs: lineup.programs, startTime: lineup.startTime, now: args.at, schedule, getShowData });
        let count = (list, why) => list.filter( (x) => x.why === why ).length;
        console.log(`FIRST OPEN: keep ${found.keep.length} (pins ${count(found.keep, 'pin')}, of them away from their pinned time ${found.keep.filter( (x) => typeof(x.pinnedAt) === 'number' ).length}; shifted ${count(found.keep, 'shifted')}), let go ${found.letGo.length} (aired pins ${count(found.letGo, 'aired')}, placed by hand ${count(found.letGo, 'placed')})`);
        found.lines.forEach( (l) => console.log('  | ' + l) );
        found.keep.filter( (x) => x.why === 'shifted' ).forEach( (x) => console.log(`    shifted ${fmt(x.start)} ${pins.label(x.program)}${x.by ? '  (by ' + x.by.title + ')' : ''}`) );
        if (args.edits.length > 0) {
            let out = kept.applyFirstOpen({ programs: lineup.programs, startTime: lineup.startTime, now: args.at, schedule, getShowData });
            let moved = changed(lineup, { programs: out, startTime: lineup.startTime });
            console.log(`  applied: ${out.filter( (p) => p.kept ).length} rows kept, ${out.filter( (p) => p.pin ).length} pins left, ${moved.length} entries moved`);
            lineup = { programs: out, startTime: lineup.startTime };
        }
    }

    let now = args.at;
    let pool = channel.programs;
    let earlier = [];
    args.edits.forEach( (e, n) => {
        earlier.push(JSON.stringify(lineup.programs));
        let parts = e.spec.split('|');
        let index = rowAt(lineup, parts[0]);
        let around = isNaN(args.around) ? Date.parse(parts[0]) : args.around;
        let from = around - 3 * HOUR, to = around + 6 * HOUR;
        console.log(`\nEDIT ${n + 1}: ${e.what} ${e.spec}`);
        console.log('  before');
        night(lineup, from, to).forEach( (l) => console.log(l) );
        let r;
        now += 1;
        if (e.what === 'swap') {
            r = kept.swap({ lineup, index, item: itemFor(lineup, index, parts[1]), choice: parts[2], now, schedule });
        } else if (e.what === 'insert') {
            r = kept.insertAfter({ lineup, index, item: itemFor(lineup, index, parts[1]), now });
        } else if (e.what === 'remove') {
            r = kept.removeOnly({ lineup, index, now, schedule });
        } else if (e.what === 'move') {
            r = kept.move({ lineup, from: index, to: rowAt(lineup, parts[1]), now, sure: true });
        } else {
            r = kept.putBack({ lineup, index, now, schedule, catalog: pool });
        }
        if (! r.programs) {
            console.log('  NOT APPLIED: ' + (r.refused || r.ask || JSON.stringify(r)));
            return;
        }
        let after = { programs: r.programs, startTime: lineup.startTime };
        console.log(`  says: ${r.text}`);
        console.log('  after');
        night(after, from, to).forEach( (l) => console.log(l) );
        let moved = changed(lineup, after);
        let outside = moved.filter( (x) => (x.start < from) || (x.start >= to) );
        console.log(`  entries new or moved: ${moved.length}, of them outside the night printed: ${outside.length}`);
        if ( (e.what === 'swap') || (e.what === 'remove') ) {
            let was = lineup.programs[index];
            along(lineup, after, index, was, args.at).forEach( (l) => console.log(l) );
            let key = kept.positionOf(was);
            let ofIt = moved.filter( (x) => ! x.program.isOffline && (kept.positionOf(x.program) === key) && ! kept.keepsItem(x.program) );
            let repeats = moved.filter( (x) => x.program.slotPosition === 'repeat' );
            let flexes = moved.filter( (x) => x.program.isOffline );
            let others = moved.filter( (x) => (ofIt.indexOf(x) === -1) && (repeats.indexOf(x) === -1) && (flexes.indexOf(x) === -1) );
            console.log(`  changed entries: ${ofIt.length} of the position, ${repeats.length} Repeats, ${flexes.length} Flex, ${others.length} other`);
            repeats.slice(0, 3).forEach( (x) => console.log(`    Repeat ${fmt(x.start)}  ${pins.label(x.program)}`) );
            others.slice(0, 6).forEach( (x) => console.log(`    other ${fmt(x.start)}  ${x.program.isOffline ? 'Flex' : pins.label(x.program)}${kept.keptKind(x.program) ? ' [' + kept.keptKind(x.program) + ']' : ''}`) );
            let p0 = progressOf(lineup, args.at, schedule, pool);
            let p1 = progressOf(after, args.at, schedule, pool);
            let keys = Object.keys(Object.assign({}, p0, p1));
            let same = keys.filter( (k) => JSON.stringify(p0[k]) === JSON.stringify(p1[k]) );
            console.log(`  stored progress read from the list: ${same.length} of ${keys.length} positions continue exactly as before`);
            keys.filter( (k) => same.indexOf(k) === -1 ).slice(0, 4).forEach( (k) => console.log(`    differs ${k}: ${JSON.stringify(p0[k])} -> ${JSON.stringify(p1[k])}`) );
        }
        if (e.what === 'put-back') {
            let json = JSON.stringify(after.programs);
            let k = earlier.findIndex( (x) => x === json );
            console.log( (k === -1) ? '  gives back: no earlier list exactly' : `  gives back: the list before edit ${k + 1}, JSON for JSON (${after.programs.length} entries)` );
        }
        lineup = after;
    } );
}

main();
