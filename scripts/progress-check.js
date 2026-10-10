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
async function generate(programs, schedule, at) {
    const RealDate = Date;
    class FrozenDate extends RealDate {
        constructor(...a) { if (a.length === 0) super(at); else super(...a); }
        static now() { return at; }
    }
    global.Date = FrozenDate;
    try {
        return await timeSlotsService(programs, JSON.parse(JSON.stringify(schedule)));
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
    let unmatched = before.filter( (a) => a.key === null );

    // The editor's path: rotate, removeDuplicates, edit, generate.
    let rotated = rotate(channel.programs, savedStart, at);
    let pool = commonProgramTools.removeDuplicates(rotated.programs);
    let schedule = JSON.parse(JSON.stringify(channel.scheduleBackup));
    if (args.edit) {
        require(path.resolve(args.edit))(schedule);
    }
    let res = await generate(pool, schedule, at);
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
        lines.push(`  ${ok ? 'same' : 'JUMP'} ${describe(key)}   first ${first}`);
        lines.push(`        saved lineup next: ${bs.map( (x) => episodeOf(x.program) ).join(', ') || '-'}`);
        lines.push(`        regenerated next:  ${as.map( (x) => episodeOf(x.program) ).join(', ') || '-'}`);
    }
    console.log(`${channel.number} ${channel.name} | at ${when(at)} | from ${file}`);
    console.log(`saved lineup, next three weeks: ${before.length} airings, ${before.length - unmatched.length} matched to a position`
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

    if (args.save) {
        let saved = rotate(res.programs, newStart, at);
        let out = Object.assign({}, channel, {
            programs: saved.programs,
            startTime: new Date(saved.startTime).toISOString(),
            scheduleBackup: schedule,
        });
        fs.writeFileSync(args.save, JSON.stringify(out));
        console.log('saved ' + args.save);
    }
}

main().catch( (err) => { console.error(err); process.exitCode = 1; } );
