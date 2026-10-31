/*
 * Special days (src/special-days.js) on a copy of a channel: a day's window,
 * its rows, what stops it, and the airings of the saved lineup it would
 * displace. Or, with --slot-at, slotProgress.slotAt over every airing of each
 * channel compared against another checkout's slot-progress (a schedule with
 * no special day must answer the same).
 *
 * Usage:
 *   node scripts/special-days-check.js --data <dataDir> --channel <n>
 *       (--day <day.json> | --fill-from-block "<block name>" --from <YYYY-MM-DDTHH:MM> --to <YYYY-MM-DDTHH:MM>)
 *       [--layout back|times]                  default back; times fills the day with fillTimes
 *   node scripts/special-days-check.js --data <dataDir> --slot-at <other checkout> [--days 300]
 *
 * Reads only the files it is given; writes nothing.
 *
 * See NOTES.md, Known issues, "Special days".
 */
const fs = require('fs');
const path = require('path');
const sd = require('../src/special-days');
const slotProgress = require('../src/slot-progress');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function parseArgs(argv) {
    let args = { layout: 'back', days: 300 };
    for (let i = 0; i < argv.length; i++) {
        let a = argv[i];
        let next = () => argv[++i];
        if (a === '--data') args.data = next();
        else if (a === '--channel') args.channel = next();
        else if (a === '--day') args.day = next();
        else if (a === '--fill-from-block') args.block = next();
        else if (a === '--from') args.from = next();
        else if (a === '--to') args.to = next();
        else if (a === '--layout') args.layout = next();
        else if (a === '--slot-at') args.slotAt = next();
        else if (a === '--days') args.days = Number(next());
        else throw new Error('unknown argument ' + a);
    }
    if (! args.data) {
        throw new Error('--data is required');
    }
    return args;
}

const fmt = (t) => new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const nameOf = (p) => p.isOffline ? 'Flex' : (p.showTitle || p.customShowName || p.title);
const episodeOf = (p) => (typeof(p.season) === 'number') ? ` S${p.season}E${p.episode}` : '';

function readChannel(data, n) {
    return JSON.parse(fs.readFileSync(path.join(data, 'channels', `${n}.json`), 'utf8'));
}

function customNames(data) {
    let names = {};
    let dir = path.join(data, 'custom-shows');
    if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
            try {
                names[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).name;
            } catch (e) {
                // a custom show that won't read is shown by its id
            }
        }
    }
    return names;
}

function localSpec(spec) {
    let m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(spec || '');
    if (m === null) {
        throw new Error(`expected YYYY-MM-DDTHH:MM, got ${spec}`);
    }
    return { date: m[1], time: Number(m[2]) * HOUR + Number(m[3]) * MIN };
}

function airingsOf(channel, from, to) {
    let out = [];
    let t = new Date(channel.startTime).getTime();
    for (const p of channel.programs) {
        if ( (t >= from) && (t < to) ) {
            out.push({ start: t, program: p });
        }
        t += p.duration;
        if (t >= to) {
            break;
        }
    }
    return out;
}

function dayReport(args) {
    let channel = readChannel(args.data, args.channel);
    let schedule = channel.scheduleBackup;
    let custom = customNames(args.data);
    let label = (id) => id.startsWith('custom.') ? `[custom] ${custom[id.slice(7)] || id}` : id.replace(/^tv\./, '');
    let day;
    if (args.day) {
        day = JSON.parse(fs.readFileSync(args.day, 'utf8'));
    } else {
        let block = (channel.blocks || []).find( (b) => b.name === args.block );
        if (! block) {
            throw new Error(`channel ${args.channel} has no block named ${args.block}`);
        }
        let from = localSpec(args.from);
        let to = localSpec(args.to);
        let rows = sd.fillFromBlock({ block: block, schedule: schedule });
        day = { id: 'sd_check', name: `${block.name} (check)`, from: from, to: to, blockId: block.id,
            positions: 'advance', layout: args.layout, slots: rows.map( (r) => { let c = Object.assign( {}, r ); delete c.length; return c; } ) };
        if (args.layout === 'times') {
            day.slots = sd.fillTimes(day, rows);
        }
    }
    let w = sd.windowOf(day);
    console.log(`Channel ${channel.number} ${channel.name}: ${day.name}`);
    if (w === null) {
        console.log('  no window');
    } else {
        console.log(`  window   ${fmt(w.from)} to ${fmt(w.to)}   (${new Date(w.from).toISOString()} to ${new Date(w.to).toISOString()})`);
    }
    console.log(`  layout ${day.layout}, positions ${day.positions}, block ${ (channel.blocks || []).find( (b) => b.id === day.blockId ) ? (channel.blocks.find( (b) => b.id === day.blockId ).name) : day.blockId }`);
    console.log(`  rows (${day.slots.length}):`);
    day.slots.forEach( (r, k) => {
        let when = (typeof(r.at) === 'number') ? fmt(sd.localInstant(day.from.date, r.at).at) + '  ' : '';
        console.log(`    ${String(k + 1).padStart(2)}. ${when}${label(r.showId)}  ${r.order || ''}${r.seasons ? ' ' + JSON.stringify(r.seasons) : ''}`);
    } );
    let problems = sd.problems(Object.assign( {}, schedule, { specialDays: [ day ] } ), channel.blocks);
    console.log(`  problems: ${ (problems.length === 0) ? 'none' : problems.map( (p) => p.text ).join(' / ') }`);
    if (w !== null) {
        let shown = airingsOf(channel, w.from, w.to).filter( (a) => ! a.program.isOffline );
        let shows = {};
        shown.forEach( (a) => { let n = nameOf(a.program); shows[n] = (shows[n] || 0) + 1; } );
        console.log(`  the saved lineup's airings it displaces: ${shown.length}, of ${Object.keys(shows).length} shows`);
        if (shown.length > 0) {
            let first = shown[0];
            let last = shown[shown.length - 1];
            console.log(`    first ${fmt(first.start)} ${nameOf(first.program)}${episodeOf(first.program)}`);
            console.log(`    last  ${fmt(last.start)} ${nameOf(last.program)}${episodeOf(last.program)}`);
        }
        let after = airingsOf(channel, w.to, w.to + HOUR).filter( (a) => ! a.program.isOffline )[0];
        if (after) {
            console.log(`    then  ${fmt(after.start)} ${nameOf(after.program)}${episodeOf(after.program)}`);
        }
        let inside = shown.filter( (a) => sd.dayAt(Object.assign( {}, schedule, { specialDays: [ day ] } ), a.start) !== null ).length;
        console.log(`  dayAt finds the day for ${inside} of them`);
    }
}

function slotAtReport(args) {
    let other = require(path.resolve(args.slotAt, 'src', 'slot-progress.js'));
    for (const f of fs.readdirSync(path.join(args.data, 'channels')).filter( (x) => /^\d+\.json$/.test(x) ).sort()) {
        let channel = readChannel(args.data, f.replace('.json', ''));
        let schedule = channel.scheduleBackup;
        if ( (schedule == null) || ! Array.isArray(schedule.slots) ) {
            console.log(`Channel ${channel.number}: no Time Slots schedule`);
            continue;
        }
        let start = new Date(channel.startTime).getTime();
        let mine = slotProgress.slotFinder(schedule);
        let theirs = other.slotFinder(schedule);
        let checked = 0;
        let differ = 0;
        for (const a of airingsOf(channel, start, start + args.days * DAY)) {
            checked++;
            if (JSON.stringify(mine(a.start)) !== JSON.stringify(theirs(a.start))) {
                differ++;
            }
        }
        console.log(`Channel ${channel.number}: slotAt over ${checked} entries (${args.days} days): ${differ} differ`);
    }
}

let args = parseArgs(process.argv.slice(2));
if (args.slotAt) {
    slotAtReport(args);
} else {
    if (! args.channel || (! args.day && ! args.block)) {
        throw new Error('--channel, and --day or --fill-from-block, are required');
    }
    dayReport(args);
}
