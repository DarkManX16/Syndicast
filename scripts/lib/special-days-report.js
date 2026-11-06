// What special days did to a regenerated lineup, for scripts/progress-check.js
// --special: each day's timetable, and, outside the days, every airing against
// the same regeneration without them - its slot, its show, its start and its
// episode. See NOTES.md, Known issues, "Special days".
const sd = require('../../src/special-days');
const slotProgress = require('../../src/slot-progress');

const MIN = 60 * 1000;
const SAME = 2000;

const clock = (t) => new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const time = (t) => new Date(t).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const mmss = (ms) => {
    let s = Math.round(ms / 1000);
    let h = Math.floor(s / 3600);
    let m = Math.floor( (s % 3600) / 60 );
    return (h > 0 ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s % 60).padStart(2, '0');
};
const episode = (p) => (typeof(p.season) === 'number' && p.type === 'episode') ? `S${p.season}E${p.episode}` : '';

// Every entry from `from` to `to`, once round the loop, each with its start and the Flex after it.
function walk(programs, startTime, from, to) {
    let out = [];
    let total = programs.reduce( (a, p) => a + p.duration, 0 );
    let t = startTime + Math.floor( (from - startTime) / total ) * total;
    let i = 0;
    while (t + programs[i].duration <= from) {
        t += programs[i].duration;
        i = (i + 1) % programs.length;
    }
    while (t < to) {
        let p = programs[i];
        let flex = 0;
        for (let j = (i + 1) % programs.length; programs[j].isOffline && (programs[j].type !== 'redirect') && ! programs[j].kept; j = (j + 1) % programs.length) {
            flex += programs[j].duration;
        }
        if (! p.isOffline || p.kept) {
            out.push({ start: t, program: p, flex: flex });
        }
        t += p.duration;
        i = (i + 1) % programs.length;
    }
    return out;
}

// How late an airing starts into its regular slot, and that slot occurrence's start.
function occurrence(schedule, start) {
    let period = schedule.period;
    let local = start - (new Date(start)).getTimezoneOffset() * MIN;
    let into = ( (local % period) + period ) % period;
    let slot = slotProgress.slotAt(schedule, start);
    if (slot === null) {
        return { slot: null, start: start, late: 0 };
    }
    let late = ( (into - slot.time) % period + period ) % period;
    return { slot: slot, start: start - late, late: late };
}

/*
 * One day's timetable: every airing from half an hour before it to two hours
 * after, each with its start, end and the Flex after it, the day's own marked
 * with its row; the rows that never aired; where the list started again; and
 * after the end, how late the regular schedule ran and when it was back on time.
 */
function timetable({ day, programs, startTime, regular, nameOf, print }) {
    let w = sd.windowOf(day);
    let list = walk(programs, startTime, w.from - 30 * MIN, w.to + 120 * MIN);
    print(`TIMETABLE ${day.name}: ${clock(w.from)} to ${clock(w.to)}, ${day.layout === 'times' ? 'set times' : 'back to back'}, ${day.positions === 'apart' ? 'kept apart' : 'advancing'}`);
    let seen = new Set();
    let lastRow = -1;
    let longestFlex = 0;
    let offGrid = 0;
    let backOnTime = null;
    let latest = null;
    list.forEach( (x) => {
        let ours = (x.program.specialDay === day.id);
        if (ours) {
            if ( (typeof(x.program.specialRow) === 'number') && (x.program.specialRow < lastRow) ) {
                print('    -- the list starts again from the top --');
            }
            lastRow = (typeof(x.program.specialRow) === 'number') ? x.program.specialRow : lastRow;
            seen.add(x.program.specialRow);
            if (x.start + x.program.duration <= w.to) {
                longestFlex = Math.max(longestFlex, x.flex);
            }
            let d = new Date(x.start);
            let stepMin = sd.stepOf(day) / MIN;
            if ( (day.layout !== 'times') && ( (d.getMinutes() % stepMin !== 0) || (d.getSeconds() > 10) ) && (x.start !== w.from) ) {
                let prev = list[list.indexOf(x) - 1];
                if (! (prev && prev.program.specialDay === day.id && prev.program.specialRow === x.program.specialRow)) {
                    offGrid++;
                }
            }
        }
        let other = (typeof(x.program.specialDay) === 'string') && ! ours;
        let late = '';
        let prevOcc = (k) => (k > 0) ? occurrence(regular, list[k - 1].start).start : null;
        if (! ours && ! other && (x.start >= w.to) && (occurrence(regular, x.start).start !== prevOcc(list.indexOf(x))) ) {
            let o = occurrence(regular, x.start);
            late = (o.late > SAME) ? `   (${mmss(o.late)} late)` : '';
            if ( (o.late <= SAME) && (backOnTime === null) ) {
                backOnTime = x.start;
            }
            if (o.late > SAME) {
                latest = latest || x;
            }
        }
        let mark = ours ? `[row ${String(x.program.specialRow + 1).padStart(2)}] ` : (other ? '[next day]' : (x.start < w.from ? '[before]  ' : '[after]   '));
        print(`    ${mark}${time(x.start).padStart(11)}-${time(x.start + x.program.duration).padStart(11)}  ${nameOf(x.program)} ${episode(x.program)}  ${mmss(x.program.duration)}  +${mmss(x.flex)} Flex${late}`);
    } );
    let rows = Array.isArray(day.slots) ? day.slots.length : 0;
    let never = [];
    for (let k = 0; k < rows; k++) {
        if (! seen.has(k)) {
            never.push(k + 1);
        }
    }
    print(`  rows aired: ${rows - never.length} of ${rows}${never.length ? `; rows that won't air: ${never.join(', ')}` : ''}`);
    print(`  longest Flex inside the day: ${mmss(longestFlex)}; rows starting off the ${sd.stepOf(day) === 15 * MIN ? 'quarter hour' : ':00 or :30'}: ${offGrid}`);
    if ( (latest === null) && (backOnTime === null) && list.some( (x) => (x.start >= w.to) && (typeof(x.program.specialDay) === 'string') && (x.program.specialDay !== day.id) ) ) {
        print('  another special day follows straight on');
    } else if (latest !== null) {
        print(`  after the day the regular schedule runs late from ${time(latest.start)}, back on time at ${backOnTime ? time(backOnTime) : '(not within two hours)'}`);
    } else {
        print(`  after the day the regular schedule is on time: ${backOnTime ? time(backOnTime) : '-'}`);
    }
}

/*
 * Outside every day, the regeneration with them against the one without, over
 * [from, to): the same slot occurrence and show for every airing, then which
 * starts and episodes differ, by show - split into the shows the days
 * displaced, the shows the days themselves air, and every other show.
 */
function outside({ days, base, withDays, regular, from, to, showOf, follow, print }) {
    let windows = days.map( (d) => sd.windowOf(d) );
    let inAny = (x) => windows.some( (w) => (x.start >= w.from) && (x.start < w.to) );
    let b = walk(base.programs, base.startTime, from, to).filter( (x) => ! x.program.isOffline );
    let a = walk(withDays.programs, withDays.startTime, from, to).filter( (x) => ! x.program.isOffline );
    let displaced = new Set(b.filter(inAny).map( (x) => showOf(x.program) ));
    let marathon = new Set(a.filter(inAny).map( (x) => showOf(x.program) ));
    // Each slot occurrence outside the days, with its airings in order.
    let byOcc = (list) => {
        let m = new Map();
        list.filter( (x) => ! inAny(x) ).forEach( (x) => {
            let o = occurrence(regular, x.start).start;
            if (! m.has(o)) m.set(o, []);
            m.get(o).push(x);
        } );
        return m;
    };
    let bo = byOcc(b);
    let ao = byOcc(a);
    let occs = [ ...new Set([ ...bo.keys(), ...ao.keys() ]) ].sort( (x, y) => x - y );
    let days0 = Math.round( (to - from) / (24 * 60 * MIN) );
    print(`OUTSIDE THE DAYS, ${days0} days from ${clock(from)}: ${occs.length} slot occurrences; ${b.filter( (x) => ! inAny(x) ).length} airings without the days, ${a.filter( (x) => ! inAny(x) ).length} with`);
    let kind = (s) => displaced.has(s) ? 'displaced' : (marathon.has(s) ? 'marathon' : 'other');
    let showDiff = [];
    let count = { displaced: {}, marathon: {}, other: {} };
    let moved = { displaced: {}, marathon: {}, other: {} };
    let fewer = { displaced: {}, marathon: {}, other: {} };
    let add = (o, s) => { o[s] = (o[s] || 0) + 1; };
    occs.forEach( (o) => {
        let x = bo.get(o) || [];
        let y = ao.get(o) || [];
        let sx = [ ...new Set(x.map( (q) => showOf(q.program) )) ].join('+');
        let sy = [ ...new Set(y.map( (q) => showOf(q.program) )) ].join('+');
        if (sx !== sy) {
            showDiff.push(`${clock(o)} ${sx || '-'} vs ${sy || '-'}`);
            return;
        }
        let s = sx;
        if ( (x.length > 0) && (y.length > 0) && (Math.abs(x[0].start - y[0].start) > SAME) ) add(moved[kind(s)], s);
        if (x.length !== y.length) add(fewer[kind(s)], s);
        let ex = x.map( (q) => q.program.key + '|' + q.program.title ).join(',');
        let ey = y.map( (q) => q.program.key + '|' + q.program.title ).join(',');
        if (ex !== ey) add(count[kind(s)], s);
    } );
    let sum = (o) => Object.values(o).reduce( (p, q) => p + q, 0 );
    let say = (o) => sum(o) ? ` ${JSON.stringify(o)}` : '';
    if (showDiff.length === 0) {
        print('  every slot occurrence keeps its show');
    } else {
        print(`  SLOT OCCURRENCES WITH ANOTHER SHOW: ${showDiff.length}, e.g. ${showDiff.slice(0, 5).join(' / ')}`);
    }
    print(`  shows the days displaced (${displaced.size}): episodes moved along in ${sum(count.displaced)} slot occurrences, ${Object.keys(count.displaced).length} shows;`
        + ` a different number of airings (a next episode of another length) in ${sum(fewer.displaced)}; first start moved in ${sum(moved.displaced)}${say(moved.displaced)}`);
    print(`  shows the days air themselves and didn't displace: episodes moved along in ${sum(count.marathon)}${say(count.marathon)}; first start moved in ${sum(moved.marathon)}${say(moved.marathon)}`);
    print(`  every other show: episodes changed in ${sum(count.other)}${say(count.other)}; number of airings changed in ${sum(fewer.other)}${say(fewer.other)}; first start moved in ${sum(moved.other)}${say(moved.other)}`);
    if (follow) {
        let lastEnd = Math.max.apply(null, windows.map( (w) => w.to ));
        let firstStart = Math.min.apply(null, windows.map( (w) => w.from ));
        let shows = [ ...new Set(b.concat(a).map( (x) => showOf(x.program) )) ].filter( (s) => follow.test(s) ).sort();
        print('  where shows stand (without the days -> with them):');
        shows.forEach( (s) => {
            let lastBefore = b.filter( (x) => (showOf(x.program) === s) && (x.start < firstStart) ).pop();
            let inB = b.filter( (x) => (showOf(x.program) === s) && inAny(x) ).map( (x) => episode(x.program) || x.program.title );
            let inA = a.filter( (x) => (showOf(x.program) === s) && inAny(x) ).map( (x) => episode(x.program) || x.program.title );
            let nb = b.find( (x) => (showOf(x.program) === s) && (x.start >= lastEnd) );
            let na = a.find( (x) => (showOf(x.program) === s) && (x.start >= lastEnd) );
            let short = (l) => (l.length > 6) ? l.slice(0, 3).join(',') + ' ... ' + l.slice(-2).join(',') + ` (${l.length})` : (l.join(',') || '-');
            print(`    ${s}: last before ${lastBefore ? episode(lastBefore.program) || lastBefore.program.title : '-'}; in the days ${short(inB)} -> ${short(inA)}; next after `
                + `${nb ? clock(nb.start) + ' ' + (episode(nb.program) || nb.program.title) : '-'} -> ${na ? clock(na.start) + ' ' + (episode(na.program) || na.program.title) : '-'}`);
        } );
    }
}

module.exports = { timetable, outside, walk };
