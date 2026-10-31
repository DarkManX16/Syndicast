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
 *   node scripts/special-days-check.js --data <dataDir> --file <channel.json> --breaks --from <ISO> --to <ISO>
 *       every break from `from` to `to` in that saved lineup: its situation, the contexts either
 *       side, the mix that fills it, and the clips its steps play (src/transitions.js buildPlan,
 *       the real filler lists from <dataDir>/filler, every clip equally idle)
 *   node scripts/special-days-check.js --data <dataDir> --file <channel.json> --guide --from <ISO> --to <ISO>
 *       [--plain]      the guide (TVGuideService#getChannelPrograms, which the XMLTV file, the web
 *                      guide and the API guide all read) against the lineup; --plain also builds it
 *                      with the special days taken off the channel and counts what differs
 *       [--context-from <ISO> --context-to <ISO>]  resolveContext every minute, with and without the
 *                      special days, outside their windows
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
        else if (a === '--file') args.file = next();
        else if (a === '--breaks') args.breaks = true;
        else if (a === '--guide') args.guide = true;
        else if (a === '--plain') args.plain = true;
        else if (a === '--context-from') args.contextFrom = Date.parse(next());
        else if (a === '--context-to') args.contextTo = Date.parse(next());
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

const clock = (t) => new Date(t).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const ctxName = (c) => (c == null) ? '(channel Flex)' : c.name;
const without = (channel) => Object.assign( {}, channel, { scheduleBackup: Object.assign( {}, channel.scheduleBackup, { specialDays: [] } ) } );

function breaksReport(args) {
    const transitions = require('../src/transitions');
    const dayParts = require('../src/day-parts');
    let channel = JSON.parse(fs.readFileSync(args.file, 'utf8'));
    let lists = {};
    let getList = (id) => {
        if (! (id in lists)) {
            let p = path.join(args.data, 'filler', `${id}.json`);
            // the list's clips, with the id each was picked from
            lists[id] = fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')).content || null) : null;
        }
        return lists[id];
    };
    let env = { getList, lastPlayed: () => 0, featuresShows: () => false, card: () => null, log: () => {} };
    let from = Date.parse(args.from);
    let to = Date.parse(args.to);
    let byContext = {};
    let found = transitions.breaksBetween(channel, from, to);
    console.log(`BREAKS from ${clock(from)} to ${clock(to)}: ${found.length}`);
    for (const brk of found) {
        let plan = transitions.buildPlan(channel, brk, env);
        let mix = dayParts.resolveBreakContext(channel, brk.startTime, (brk.next != null) ? brk.next.startTime : null);
        let key = `${plan.situation} ${ctxName(plan.from)} -> ${ctxName(plan.to)}`;
        byContext[key] = (byContext[key] || 0) + 1;
        let steps = (side) => plan[side].map( (x) => (x.clip && x.clip.title) || x.title || '?' ).join(' | ');
        let p = (brk.prev != null) ? (brk.prev.program.showTitle || brk.prev.program.title) : '-';
        let n = (brk.next != null) ? (brk.next.program.showTitle || brk.next.program.title) : '-';
        console.log(`  ${clock(brk.startTime)}  ${p} -> ${n}`);
        console.log(`      ${plan.situation}: ${ctxName(plan.from)} -> ${ctxName(plan.to)}; mix ${ctxName(mix)}`
            + `${plan.out.length ? '; out: ' + steps('out') : ''}${plan.in.length ? '; in: ' + steps('in') : ''}`);
    }
    console.log('  by situation and context:');
    Object.keys(byContext).forEach( (k) => console.log(`    ${byContext[k]}  ${k}`) );
}

async function guideReport(args) {
    const TVGuideService = require('../src/services/tv-guide-service');
    const dayParts = require('../src/day-parts');
    let channel = JSON.parse(fs.readFileSync(args.file, 'utf8'));
    let from = Date.parse(args.from);
    let to = Date.parse(args.to);
    // Prepared as the service prepares a channel, as test/blocks-guide.js does it.
    let guideFor = async (ch) => {
        let g = new TVGuideService(null, null, null, null, null);
        g._throttle = async () => {};
        g.channelsByNumber = { [ch.number]: ch };
        g.accumulateTable = { [ch.number]: await g.makeAccumulated(ch) };
        return await g.getChannelPrograms(from, to, ch);
    };
    // Guide entries ({ start, stop, title }): a program's is its show's title (a movie's its
    // own), a long Flex's the context's guide name.
    let guide = (await guideFor(channel)).programs.map( (x) => ({ start: Date.parse(x.start), title: x.title }) );
    let lineup = airingsOf(channel, from - 6 * HOUR, to).filter( (a) => ! a.program.isOffline && (a.start + a.program.duration > from) );
    let titleOf = (p) => p.showTitle || p.title;
    let missing = lineup.filter( (a) => ! guide.some( (x) => (Math.abs(x.start - Math.max(a.start, from)) <= 2000) && (x.title === titleOf(a.program)) ) );
    let flex = guide.filter( (x) => ! lineup.some( (a) => (Math.abs(x.start - Math.max(a.start, from)) <= 2000) && (x.title === titleOf(a.program)) ) );
    console.log(`GUIDE from ${clock(from)} to ${clock(to)}: ${guide.length} entries for ${lineup.length} airings; `
        + `${missing.length === 0 ? 'every airing at its lineup time, under its title' : missing.length + ' airings not in the guide, e.g. ' + clock(missing[0].start) + ' ' + titleOf(missing[0].program)}`);
    console.log(`  entries of a long Flex: ${flex.length}${flex.length ? ' - ' + flex.map( (x) => clock(x.start) + ' "' + x.title + '"' ).join('; ') : ''}`);
    if (args.plain) {
        let plainGuide = (await guideFor(without(channel))).programs.map( (x) => `${x.start}|${x.title}` );
        let differ = guide.map( (x) => `${new Date(x.start).toISOString()}|${x.title}` ).filter( (k, i) => k !== plainGuide[i] );
        console.log(`  with the special days taken off the channel: ${differ.length} entries differ${differ.length ? ': ' + differ.slice(0, 6).join(' / ') : ''}`);
    }
    if (! isNaN(args.contextFrom)) {
        let plain = without(channel);
        let windows = (channel.scheduleBackup.specialDays || []).map( (d) => sd.windowOf(d) ).filter( (w) => w !== null );
        let outside = 0;
        let differ = 0;
        let insideNames = {};
        for (let t = args.contextFrom; t < args.contextTo; t += MIN) {
            let a = dayParts.resolveContext(channel, t);
            if (windows.some( (w) => (t >= w.from) && (t < w.to) )) {
                insideNames[ctxName(a)] = (insideNames[ctxName(a)] || 0) + 1;
                continue;
            }
            outside++;
            let b = dayParts.resolveContext(plain, t);
            if ( ((a && a.id) || null) !== ((b && b.id) || null) ) {
                differ++;
            }
        }
        console.log(`CONTEXT every minute from ${clock(args.contextFrom)} to ${clock(args.contextTo)}: ${outside} minutes outside the days, ${differ} resolve differently; inside: ${JSON.stringify(insideNames)}`);
    }
}

let args = parseArgs(process.argv.slice(2));
if (args.breaks) {
    breaksReport(args);
} else if (args.guide) {
    guideReport(args).catch( (e) => { console.error(e); process.exitCode = 1; } );
} else if (args.slotAt) {
    slotAtReport(args);
} else {
    if (! args.channel || (! args.day && ! args.block)) {
        throw new Error('--channel, and --day or --fill-from-block, are required');
    }
    dayReport(args);
}
