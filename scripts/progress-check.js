/*
 * What a regeneration does to each slot position, on a copy of a channel:
 * the editor's Create Lineup path driven directly - rotate the lineup at a
 * moment, removeDuplicates, the real Time Slots generator with the clock
 * frozen at that moment - then, per position, the saved lineup's next
 * episodes against the regenerated one's.
 *
 * Usage:
 *   node scripts/progress-check.js --data <dataDir> --channel <n> --at <ISO>
 *       [--from <channel.json>]   read this channel file instead of <dataDir>/channels/<n>.json
 *       [--edit <module.js>]      a module exporting (schedule) => void, applied before generating
 *       [--save <out.json>]       write the regenerated channel, ready for a second run with --from
 *       [--show <regex>]          list matching positions even when they continue
 *       [--airings <regex> --days <n>]  list matching shows' airings in both lineups
 *       [--all]                   list every position, not only the ones that jump
 *       [--today]                 skip the planner: no records, so Play Next falls back to the founder
 *                                 rule as blocks did; Shuffle starts rounds of its own, so blocks'
 *                                 Shuffle losses need blocks' code
 *       [--add-custom <id>]       add a custom show's items to the programs first, as the library's
 *                                 "add custom show" does (the lineup alone holds only what it aired)
 *       [--catalog <snapshot.json>] full catalogs, from scripts/catalog-snapshot.js: the pool is built
 *                                 as the editor builds it (src/show-catalog.js poolFor), with the
 *                                 channel's own catalog state, and --save keeps that state
 *       [--review <regex|all>]    with --catalog: review the matching shows first, everything ticked
 *       [--never-air <keys.json>] with --catalog: an array of file keys put on the never-air list
 *       [--pin "<local time>|<showId>|<S0E7 | #12 | exact title>|<take|late>[|insert]"]  a swap or insert
 *                                 pinned at that time, repeatable; the item from --catalog's snapshot, else
 *                                 the pool. Pins already in the lineup (--from) are always kept.
 *       [--around "<local time>"]  the three hours either side, saved and regenerated, Flex after each
 *       [--changed <days>]        airings whose start or episode differ over that many days, by show
 *       [--start <show|mode|seasons=episode>]  Episode start, repeatable: the position of <show> in <mode>
 *                                 (next, shuffle, rerun) leaving out <seasons> (comma-separated, may be
 *                                 empty) plays <episode> next - S01E34, or #12 for the 12th item of a
 *                                 custom show. e.g. --start "Johnny Bravo|next|2=S01E34"
 *
 * Reads only the files it is given and writes only --save. Never point it at
 * the live data folder's files with --save.
 *
 * See NOTES.md, Known issues, "Per-position stored progress, and the shuffles
 * built on it".
 */
const fs = require('fs');
const path = require('path');
const timeSlotsService = require('../src/services/time-slots-service');
const slotProgress = require('../src/slot-progress');
const getShowData = require('../web/services/get-show-data')();
const commonProgramTools = require('../web/services/common-program-tools')(getShowData);
const seasonConstraints = require('../web/services/season-constraints')();
const showCatalog = require('../src/show-catalog');
const rounds = require('../src/shuffle-rounds');
const pinTools = require('../src/pins');

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const DAYS = [ 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed' ];

function parseArgs(argv) {
    let args = { days: 7 };
    for (let i = 0; i < argv.length; i++) {
        let a = argv[i];
        let next = () => argv[++i];
        if (a === '--data') args.data = next();
        else if (a === '--channel') args.channel = next();
        else if (a === '--at') args.at = Date.parse(next());
        else if (a === '--from') args.from = next();
        else if (a === '--edit') args.edit = next();
        else if (a === '--save') args.save = next();
        else if (a === '--show') args.show = new RegExp(next());
        else if (a === '--airings') args.airings = new RegExp(next());
        else if (a === '--days') args.days = Number(next());
        else if (a === '--all') args.all = true;
        else if (a === '--today') args.today = true;
        else if (a === '--add-custom') args.addCustom = next();
        else if (a === '--catalog') args.catalog = next();
        else if (a === '--review') args.review = next();
        else if (a === '--never-air') args.neverAir = next();
        else if (a === '--start') (args.starts = args.starts || []).push(next());
        else if (a === '--pin') (args.pins = args.pins || []).push(next());
        else if (a === '--around') args.around = Date.parse(next());
        else if (a === '--changed') args.changed = Number(next());
        else throw new Error('Unknown argument ' + a);
    }
    if (isNaN(args.at)) throw new Error('--at <ISO instant> is required');
    if (! args.from && ! (args.data && args.channel)) throw new Error('--data and --channel, or --from, are required');
    return args;
}

const when = (t) => new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const slotLabel = (time) => {
    let m = (time % DAY) / MIN;
    return DAYS[Math.floor(time / DAY)] + ' ' + String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
};
function episodeOf(p) {
    if (typeof(p.customShowId) !== 'undefined') return 'X' + String(p.customOrder + 1).padStart(2, '0');
    if (p.type === 'movie') return p.title;
    return 'S' + String(p.season).padStart(2, '0') + 'E' + String(p.episode).padStart(2, '0');
}
function describe(key) {
    let [ showId, mode, excluded ] = JSON.parse(key);
    let range = (excluded.length === 0) ? 'all seasons' : 'no S' + excluded.join(',');
    return `${showId} | ${mode}${mode === 'next' ? ' | ' + range : (excluded.length ? ' | ' + range : '')}`;
}

// The channel editor's adjustStartTimeToCurrentProgram, at `at`.
function rotate(programs, startTime, at) {
    let total = programs.reduce( (a, p) => a + p.duration, 0 );
    let m = ( ( (at - startTime) % total ) + total ) % total;
    let x = 0, running = 0, offset = 0;
    for (let i = 0; i < programs.length; i++) {
        if (x + programs[i].duration > m) { running = i; offset = m - x; break; }
        x += programs[i].duration;
    }
    return { programs: programs.slice(running).concat(programs.slice(0, running)), startTime: at - offset };
}

// test/dst-fall-back.js's generate: the real generator with `new Date()` frozen.
async function generate(programs, schedule, at, history, pins) {
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(at); else super(...a); }
        static now() { return at; }
    }
    global.Date = FrozenDate;
    try {
        return await timeSlotsService(programs, JSON.parse(JSON.stringify(schedule)), history, pins);
    } finally {
        global.Date = RealDate;
    }
}

function byPosition(list) {
    let m = new Map();
    for (let a of list) {
        if (a.key === null) continue;
        if (! m.has(a.key)) m.set(a.key, []);
        m.get(a.key).push(a);
    }
    return m;
}

async function main() {
    let args = parseArgs(process.argv.slice(2));
    let file = args.from || path.join(args.data, 'channels', args.channel + '.json');
    let channel = JSON.parse(fs.readFileSync(file, 'utf8'));
    let at = args.at;
    let horizon = 21 * DAY;
    let savedStart = Date.parse(channel.startTime);

    // Before: the saved lineup as the editor has it loaded.
    let before = slotProgress.airings({
        programs: channel.programs, startTime: savedStart, from: at, to: at + horizon,
        schedule: channel.scheduleBackup, getShowData,
    });
    let repeats = before.filter( (a) => a.program.slotPosition === 'repeat' ).length;
    let unmatched = before.filter( (a) => (a.key === null) && (a.program.slotPosition !== 'repeat') );

    // The editor's path: rotate, removeDuplicates, edit, generate.
    // The library's "add custom show": its items in list order, appended to the programs.
    if (args.addCustom) {
        let show = JSON.parse(fs.readFileSync(path.join(args.data || path.dirname(path.dirname(file)), 'custom-shows', args.addCustom + '.json'), 'utf8'));
        show.content.forEach( (item, i) => {
            channel.programs.push(Object.assign({}, item, { customShowId: args.addCustom, customShowName: show.name, customOrder: i }));
        } );
        console.log('added ' + show.content.length + ' items of ' + show.name);
    }
    let rotated = rotate(channel.programs, savedStart, at);
    // A pinned airing never joins the pool.
    let pool = commonProgramTools.slotPool(rotated.programs);
    let schedule = JSON.parse(JSON.stringify(channel.scheduleBackup));
    if (args.edit) {
        require(path.resolve(args.edit))(schedule);
    }
    // Full catalogs, as the editor reads them at the dialog and builds the pool at Create Lineup.
    let lineupPool = pool;
    let state = showCatalog.stateOf(channel);
    let catalogOps = [];
    if (args.catalog) {
        let catalogs = JSON.parse(fs.readFileSync(args.catalog, 'utf8'))[String(channel.number)] || {};
        let ops = [];
        if (args.review) {
            let re = (args.review === 'all') ? /./ : new RegExp(args.review);
            let byShow = new Map();
            pool.forEach( (p) => { let d = getShowData(p); if (d.hasShow) { if (! byShow.has(d.showId)) byShow.set(d.showId, []); byShow.get(d.showId).push(p); } } );
            Object.keys(catalogs).filter( (id) => re.test(id) && catalogs[id].items && ! state.shows[id] ).forEach( (id) => {
                ops.push({ review: { showId: id, source: catalogs[id].source, by: 'review',
                    specials: id.startsWith('custom.') || showCatalog.specialsAllowed(byShow.get(id) || []),
                    known: catalogs[id].items.map(rounds.fileKey), neverAir: [] } });
            } );
        }
        if (args.neverAir) {
            let all = new Map();
            Object.values(catalogs).forEach( (c) => (c.items || []).forEach( (p) => all.set(rounds.fileKey(p), p) ) );
            pool.forEach( (p) => { if (! p.isOffline) all.set(rounds.fileKey(p), p); } );
            let entries = JSON.parse(fs.readFileSync(args.neverAir, 'utf8')).filter( (k) => all.has(k) )
                .map( (k) => showCatalog.neverAirEntry(all.get(k), getShowData, 'deleted', 'never', undefined, at) );
            ops.push({ neverAir: entries });
        }
        state = showCatalog.applyOps(state, ops, at);
        let slotted = [ ...new Set( schedule.slots.map( (sl) => sl.showId ).filter( (id) => typeof(id) === 'string' && id !== 'flex.' && ! id.startsWith('redirect.') ) ) ];
        let run = showCatalog.poolFor({ lineupPool: pool, slotted, catalogs, state, getShowData });
        pool = run.pool;
        catalogOps = [ { known: run.known } ].concat( run.complete.map( (id) => ({ review: { showId: id, by: 'complete', source: catalogs[id].source,
            specials: id.startsWith('custom.') || showCatalog.specialsAllowed(lineupPool.filter( (p) => getShowData(p).showId === id )),
            known: run.known[id], neverAir: [] } }) ) );
        console.log(`catalog: ${Object.keys(state.shows).length} shows reviewed, ${run.complete.length} complete, ${Object.keys(state.neverAir).length} never air; `
            + `pool ${lineupPool.length} -> ${pool.length}; new since the last run: ${Object.values(run.fresh).reduce( (a, l) => a + l.length, 0 )}; `
            + `fell back: ${run.fellBack.map( (f) => f.showId + ' (' + f.reason + ')' ).join(', ') || 'none'}`);
    }
    // Episode start: the picks, each found in the pool the planner draws on.
    let starts = {};
    (args.starts || []).forEach( (spec) => {
        let m = spec.match(/^(.+?)\|(\w+)\|([\d,]*)=(.+)$/);
        if (m === null) throw new Error('--start wants show|mode|seasons=episode, got ' + spec);
        let showId = /^(tv|custom)\./.test(m[1]) ? m[1] : 'tv.' + m[1];
        let excluded = m[3] === '' ? [] : m[3].split(',').map(Number);
        let key = slotProgress.positionKey(showId, m[2], { excludeSeasons: excluded });
        let wanted = m[4].trim();
        let found = pool.find( (p) => {
            if (p.isOffline || getShowData(p).showId !== showId) return false;
            return (wanted.startsWith('#')) ? (p.customOrder + 1 === Number(wanted.slice(1))) : (episodeOf(p) === wanted);
        } );
        if (! found) throw new Error('--start: ' + wanted + ' is not in the pool for ' + showId);
        starts[key] = slotProgress.ref(found, getShowData);
        console.log('start: ' + describe(key) + ' -> ' + wanted + ' ' + found.title);
    } );
    // The editor's doIt: every position's place, read from the lineup on air at this moment.
    if (! args.today) {
        schedule.progress = slotProgress.planProgress({
            programs: channel.programs, startTime: savedStart, now: at,
            openedSchedule: channel.scheduleBackup, schedule: schedule, pool: lineupPool, catalog: pool,
            starts: Object.keys(starts).length ? starts : undefined, getShowData,
        });
    }
    // and, as the editor does, what aired in the last period, for Repeat slots:
    // from the lineup on air and what the last run kept, kept again for the next.
    let h = slotProgress.repeatHistory({
        programs: channel.programs, startTime: savedStart, now: at,
        spanMs: (schedule.period || DAY) + 60 * MIN,
        opened: channel.scheduleBackup, schedule, getShowData,
    });
    let history = args.catalog ? h.history.filter( (a) => ! showCatalog.isNeverAir(state, a.program) ) : h.history;
    if (schedule.progress) {
        schedule.progress.history = h.keep;
    }
    // Pins: the lineup's own still to air, and any asked for.
    let pins = [];
    let total0 = channel.programs.reduce( (a, p) => a + p.duration, 0 );
    channel.programs.forEach( (p) => {
        if (p.pin && (p.pin.at + p.duration > at)) pins.push({ at: p.pin.at, then: p.pin.then, program: p });
    } );
    let catalogItems = args.catalog ? (JSON.parse(fs.readFileSync(args.catalog, 'utf8'))[String(channel.number)] || {}) : {};
    (args.pins || []).forEach( (spec) => {
        let [ when0, showId, which, then, kind ] = spec.split('|');
        let t = Date.parse(when0);
        let items = (catalogItems[showId] && catalogItems[showId].items) || pool.filter( (p) => getShowData(p).showId === showId );
        let found = items.find( (p, i) => {
            let m = which.match(/^S(\d+)E(\d+)$/);
            if (m) return (p.season === Number(m[1])) && (p.episode === Number(m[2]));
            if (which.startsWith('#')) return ( (typeof(p.customOrder) === 'number') ? p.customOrder : i ) + 1 === Number(which.slice(1));
            return p.title === which;
        } );
        if (! found || isNaN(t)) throw new Error('--pin: nothing found for ' + spec);
        let slot = slotProgress.slotAt(schedule, t);
        let program = pinTools.makePin({ program: found, at: t, kind: kind || 'swap', then: then || 'take',
            slotShow: slot ? slot.showId : undefined, now: at });
        pins.push({ at: t, then: program.pin.then, program });
        console.log(`pin: ${when(t)} ${program.title} (${Math.round(program.duration / 1000)}s), ${program.pin.then}`);
    } );
    if (total0 <= 0) pins = [];
    let res = await generate(pool, schedule, at, history, pins.length ? pins : undefined);
    if (typeof(res.userError) !== 'undefined') throw new Error(res.userError);
    seasonConstraints.clearStartSeasons(schedule);

    // The editor's readSlotsResult: startTime moved back whole cycles, then rotated to now.
    let total = res.programs.reduce( (a, p) => a + p.duration, 0 );
    let newStart = Date.parse(res.startTime);
    while (newStart > at) newStart -= total;
    let after = slotProgress.airings({
        programs: res.programs, startTime: newStart, from: at, to: at + horizon,
        schedule: schedule, getShowData,
    });

    let b = byPosition(before), a = byPosition(after);
    let keys = [ ...new Set([ ...b.keys(), ...a.keys() ]) ].sort();
    let same = 0;
    let lines = [];
    for (let key of keys) {
        let bs = (b.get(key) || []).slice(0, 4), as = (a.get(key) || []).slice(0, 4);
        let ok = (bs.length > 0) && (as.length > 0) && (bs[0].program.title === as[0].program.title)
            && (episodeOf(bs[0].program) === episodeOf(as[0].program));
        if (ok) same++;
        if (ok && ! args.all && ! (args.show && args.show.test(key))) continue;
        let first = bs.length ? `${when(bs[0].start)} (${slotLabel(slotProgress.slotAt(channel.scheduleBackup, bs[0].start).time)})` : '-';
        lines.push(`  ${ok ? 'same' : 'JUMP'} ${describe(key)}${starts[key] ? '   [start]' : ''}   first ${first}`);
        lines.push(`        saved lineup next: ${bs.map( (x) => episodeOf(x.program) ).join(', ') || '-'}`);
        lines.push(`        regenerated next:  ${as.map( (x) => episodeOf(x.program) ).join(', ') || '-'}`);
    }
    console.log(`${channel.number} ${channel.name} | at ${when(at)} | from ${file}`);
    console.log(`saved lineup, next three weeks: ${before.length} airings, ${before.length - unmatched.length - repeats} matched to a position` + (repeats ? `, ${repeats} repeats` : '')
        + (unmatched.length ? ` (unmatched: ${unmatched.slice(0, 5).map( (x) => when(x.start) + ' ' + (x.program.showTitle || x.program.title) + ' ' + episodeOf(x.program) ).join('; ')})` : ''));
    console.log(`continue exactly: ${same} of ${keys.length}`);
    lines.forEach( (l) => console.log(l) );

    if (args.airings) {
        for (let [ name, list ] of [ [ 'SAVED LINEUP', before ], [ 'REGENERATED', after ] ]) {
            console.log(name);
            let seen = {};
            for (let x of list) {
                if (x.start >= at + args.days * DAY) break;
                let d = getShowData(x.program);
                if (! args.airings.test(d.showId)) continue;
                let e = d.showId + ' ' + episodeOf(x.program);
                seen[e] = (seen[e] || 0) + 1;
                console.log('   ' + when(x.start).padEnd(26) + (x.key ? describe(x.key) : '(no position)').padEnd(48)
                    + episodeOf(x.program) + (seen[e] > 1 ? '   <- airs again' : ''));
            }
        }
    }

    // Every entry on air in [from, to), with its start and, for a program, the Flex after it.
    let walk = (programs, startTime, from, to) => {
        let out = [];
        let total = programs.reduce( (a, p) => a + p.duration, 0 );
        let t = startTime + Math.floor( (from - startTime) / total ) * total;
        let i = 0;
        while (t + programs[i].duration <= from) { t += programs[i].duration; i = (i + 1) % programs.length; }
        while (t < to) {
            let p = programs[i];
            let flex = 0;
            for (let j = (i + 1) % programs.length; programs[j].isOffline && (programs[j].type !== 'redirect') && ! programs[j].pin; j = (j + 1) % programs.length) {
                flex += programs[j].duration;
            }
            if (! p.isOffline || p.pin) out.push({ start: t, program: p, flex: flex });
            t += p.duration;
            i = (i + 1) % programs.length;
        }
        return out;
    };
    let mmss = (ms) => { let s = Math.round(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    let clockOf = (t) => new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
    let lineOf = (x) => x ? `${clockOf(x.start)} ${x.program.pin ? '[PIN] ' : ''}${x.program.isOffline ? 'Flex' : (x.program.showTitle || '') + ' ' + episodeOf(x.program) + ' ' + x.program.title} ${mmss(x.program.duration)} +${mmss(x.flex)}` : '';
    if (args.around) {
        let from = args.around - 3 * 60 * MIN, to = args.around + 3 * 60 * MIN;
        let b = walk(channel.programs, savedStart, from, to), a = walk(res.programs, newStart, from, to);
        console.log(`AROUND ${clockOf(args.around)}`);
        console.log('  SAVED');
        b.forEach( (x) => console.log('    ' + lineOf(x)) );
        console.log('  REGENERATED');
        a.forEach( (x) => console.log('    ' + lineOf(x)) );
    }
    if (args.changed) {
        let to = at + args.changed * DAY;
        let b = walk(channel.programs, savedStart, at, to).filter( (x) => ! x.program.isOffline );
        let a = walk(res.programs, newStart, at, to).filter( (x) => ! x.program.isOffline );
        let fileOf = (p) => (p.serverKey || '') + '|' + (p.key || '') + '|' + p.title;
        let j = 0, same = 0, byShow = {};
        for (let x of b) {
            while ( (j < a.length) && (a[j].start < x.start - 2000) ) j++;
            if ( (j < a.length) && (Math.abs(a[j].start - x.start) <= 2000) && (fileOf(a[j].program) === fileOf(x.program)) ) {
                same++;
            } else {
                let s = x.program.showTitle || x.program.title;
                byShow[s] = (byShow[s] || 0) + 1;
            }
        }
        console.log(`CHANGED over ${args.changed} days: ${b.length} saved airings, ${a.length} regenerated; ${b.length - same} saved airings moved or changed:`
            + ` ${JSON.stringify(byShow)}`);
    }

    if (args.save) {
        let saved = rotate(res.programs, newStart, at);
        let out = Object.assign({}, channel, {
            programs: saved.programs,
            startTime: new Date(saved.startTime).toISOString(),
            scheduleBackup: schedule,
        });
        if (args.catalog) {
            out.catalog = showCatalog.applyOps(state, catalogOps, at);
        }
        fs.writeFileSync(args.save, JSON.stringify(out));
        console.log('saved ' + args.save);
    }
}

main().catch( (err) => { console.error(err); process.exitCode = 1; } );
