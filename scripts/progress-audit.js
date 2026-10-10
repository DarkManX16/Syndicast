/*
 * Checks a whole saved lineup against the rounds the shuffle family
 * promises, position by position:
 *   - no story airs twice in a round, and a round the lineup holds whole airs
 *     every story once;
 *   - no story comes back within half a round of its last airing;
 *   - a Rerun never airs an episode before its show's Play Next has;
 *   - a story's parts air in a row and in order (from the first round the
 *     lineup's own rounds began: a round carried over from before finishes in
 *     its old order).
 * A story is a single episode or the parts of a multi-part one, over the
 * candidates in the lineup itself - the lineup is the pool a regeneration
 * draws from.
 *
 * Usage: node scripts/progress-audit.js --channel <saved channel .json> [--show <regex>]
 *
 * Reads only the file it is given. See NOTES.md, Known issues, "Per-position
 * stored progress, and the shuffles built on it".
 */
const fs = require('fs');
const slotProgress = require('../src/slot-progress');
const rounds = require('../src/shuffle-rounds');
const multiPart = require('../src/multi-part');
const getShowData = require('../web/services/get-show-data')();
const commonProgramTools = require('../web/services/common-program-tools')(getShowData);

function parseArgs(argv) {
    let args = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--channel') args.channel = argv[++i];
        else if (argv[i] === '--show') args.show = new RegExp(argv[++i]);
        else throw new Error('Unknown argument ' + argv[i]);
    }
    if (! args.channel) throw new Error('--channel <saved channel .json> is required');
    return args;
}

const when = (t) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function audit(channel, showFilter) {
    let start = Date.parse(channel.startTime);
    let total = channel.programs.reduce( (a, p) => a + p.duration, 0 );
    let schedule = channel.scheduleBackup || { slots: [] };
    let records = (schedule.progress && schedule.progress.positions) || {};
    let all = slotProgress.airings({ programs: channel.programs, startTime: start, from: start, to: start + total, schedule, getShowData });
    let pool = commonProgramTools.removeDuplicates(channel.programs);

    let byKey = new Map();
    all.forEach( (a) => {
        if (a.key === null) return;
        let mode = JSON.parse(a.key)[1];
        if (slotProgress.ROUND_MODES.indexOf(mode) === -1) return;
        if (! byKey.has(a.key)) byKey.set(a.key, []);
        byKey.get(a.key).push(a);
    } );

    let report = [];
    byKey.forEach( (list, key) => {
        if (showFilter && ! showFilter.test(key)) return;
        let [ showId, , excluded ] = JSON.parse(key);
        let candidates = slotProgress.candidatesFor(pool, showId, { excludeSeasons: excluded }, getShowData);
        let stories = (showId === 'movie.') ? candidates.map( (p) => [ p ] ) : multiPart.stories(candidates);
        let storyOf = new Map();
        stories.forEach( (story) => story.forEach( (p, part) => storyOf.set(rounds.fileKey(p), { key: rounds.storyKey(story), part, size: story.length }) ) );
        let half = Math.floor(stories.length / 2);
        let isRerun = JSON.parse(key)[1] === 'rerun';
        let carried = Array.isArray((records[key] || {}).queue) ? records[key].round : null;
        let violations = [];

        // Story airings in order: a story counts once, at its first part.
        let seq = [];
        list.forEach( (a, i) => {
            let s = storyOf.get(rounds.fileKey(a.program));
            if (typeof(s) === 'undefined') {
                violations.push(`${when(a.start)} ${a.program.title}: not one of the position's episodes`);
                return;
            }
            let round = slotProgress.parseLabel(a.program.slotPosition).round;
            let next = list[i + 1];
            if ( (round !== carried) && (s.part + 1 < s.size) ) {
                let sNext = next && storyOf.get(rounds.fileKey(next.program));
                if (! sNext || (sNext.key !== s.key) || (sNext.part !== s.part + 1) ) {
                    violations.push(`${when(a.start)} ${a.program.title}: part ${s.part + 1} of ${s.size} not followed by part ${s.part + 2}`);
                }
            }
            // A carried round plays the old order episode by episode, so there
            // each episode is its own entry; elsewhere a story is one.
            if ( (s.part === 0) || (round === carried) ) {
                seq.push({ key: s.key, entry: (round === carried) ? rounds.fileKey(a.program) : s.key,
                    round, start: a.start, title: a.program.title });
            }
        } );

        let byRound = new Map();
        seq.forEach( (x) => {
            if (! byRound.has(x.round)) byRound.set(x.round, []);
            byRound.get(x.round).push(x);
        } );
        let roundNumbers = [ ...byRound.keys() ].sort( (a, b) => a - b );
        let whole = 0;
        roundNumbers.forEach( (r, i) => {
            let keys = byRound.get(r).map( (x) => x.entry );
            let distinct = new Set(keys);
            if (distinct.size !== keys.length) {
                violations.push(`round ${r}: ${keys.length - distinct.size} stories aired twice`);
            }
            let inside = (i > 0) && (i < roundNumbers.length - 1);
            if (inside) {
                whole++;
                // A Rerun passes over what its strip hasn't reached, by design.
                if ( (distinct.size !== stories.length) && ! isRerun ) {
                    violations.push(`round ${r}: ${distinct.size} of ${stories.length} stories aired`);
                }
            }
        } );
        let last = new Map();
        let closest = Infinity;
        seq.forEach( (x, i) => {
            // Two parts of one story both aired in a carried round, apart, by design.
            let bothCarried = last.has(x.key) && (x.round === carried) && (seq[last.get(x.key)].round === carried);
            if (last.has(x.key) && ! bothCarried) {
                let gap = i - last.get(x.key) - 1;
                closest = Math.min(closest, gap);
                // A Rerun's round is what it aired, not every story: half of
                // the round the story last aired in.
                let earlier = seq[last.get(x.key)].round;
                let limit = isRerun ? Math.floor(new Set(byRound.get(earlier).map( (y) => y.entry )).size / 2) : half;
                if ( (gap < limit) && ! (isRerun && (x.round === earlier)) ) {
                    violations.push(`${when(x.start)} ${x.title}: back after ${gap} stories, under half a round (${limit})`);
                }
            }
            last.set(x.key, i);
        } );
        let multi = stories.filter( (s) => s.length > 1 ).length;
        // Multi-part stories that aired in the position's own rounds, where their
        // parts must come in a row - the check above covered each one.
        let multiAired = new Set();
        list.forEach( (a) => {
            let s = storyOf.get(rounds.fileKey(a.program));
            let round = slotProgress.parseLabel(a.program.slotPosition).round;
            if ( s && (s.size > 1) && (round !== carried) ) multiAired.add(s.key + '|' + round);
        } );
        let rerun = (JSON.parse(key)[1] === 'rerun') ? rerunCheck(key, list, candidates) : null;
        if (rerun !== null) {
            rerun.ahead.forEach( (v) => violations.push(v) );
        }
        report.push({ key, airings: list.length, stories: stories.length, multi, multiAired: multiAired.size, rounds: roundNumbers.length, whole,
            closest: (closest === Infinity) ? null : closest, carried, rerun, violations });
    } );

    /*
     * A Rerun airing must be an episode its show's Play Next had aired by
     * then: from each Play Next position's place when the lineup was made
     * (its record), plus every Play Next airing of the show since, in time
     * order. While none of the Rerun's range has aired, or the show has no
     * Play Next, it plays as a Shuffle and anything may air.
     */
    function rerunCheck(key, list, candidates) {
        let showId = JSON.parse(key)[0];
        let aired = new Set();
        let any = (schedule.slots || []).some( (s) => (s.showId === showId) && (s.order === 'next') );
        Object.keys(records).forEach( (k) => {
            let [ sid, mode, excluded ] = JSON.parse(k);
            let record = records[k];
            if ( (sid !== showId) || (mode !== 'next') || ! record || (typeof(record.next) !== 'object') ) return;
            any = true;
            let range = slotProgress.candidatesFor(pool, showId, { excludeSeasons: excluded }, getShowData);
            let place = slotProgress.resolveRef(record.next, range, getShowData);
            (record.wrapped === true ? range : range.slice(0, place)).forEach( (p) => aired.add(rounds.fileKey(p)) );
        } );
        let inRange = new Set(candidates.map( (p) => rounds.fileKey(p) ));
        let reruns = new Set(list);
        let ahead = [];
        let fallback = 0;
        let pools = [];
        all.forEach( (a) => {
            if (a.key === null) return;
            let [ sid, mode ] = JSON.parse(a.key);
            if ( (sid === showId) && (mode === 'next') ) {
                aired.add(rounds.fileKey(a.program));
            }
            if (! reruns.has(a) ) return;
            let pool = [ ...aired ].filter( (k) => inRange.has(k) ).length;
            pools.push(pool);
            if ( ! any || (pool === 0) ) {
                fallback++;
            } else if (! aired.has(rounds.fileKey(a.program)) ) {
                ahead.push(`${when(a.start)} ${a.program.title}: rerun before its Play Next aired it`);
            }
        } );
        return { ahead, fallback, firstPool: pools[0], lastPool: pools[pools.length - 1] };
    }
    return report;
}

function main() {
    let args = parseArgs(process.argv.slice(2));
    let channel = JSON.parse(fs.readFileSync(args.channel, 'utf8'));
    let report = audit(channel, args.show);
    let bad = 0;
    report.sort( (a, b) => (a.key < b.key ? -1 : 1) ).forEach( (r) => {
        bad += r.violations.length;
        console.log(`${r.violations.length ? 'FAIL' : 'ok  '} ${r.key}: ${r.airings} airings, ${r.stories} stories (${r.multi} multi-part), `
            + `${r.multiAired} multi-part airings in its own rounds, ${r.rounds} rounds (${r.whole} whole), closest return ${r.closest === null ? '-' : r.closest} stories`
            + (r.carried !== null ? `, carried round ${r.carried}` : '')
            + (r.rerun ? `; Rerun: ${r.rerun.ahead.length} ahead of its Play Next, ${r.rerun.fallback} as a Shuffle, pool ${r.rerun.firstPool} -> ${r.rerun.lastPool} episodes` : ''));
        r.violations.slice(0, 5).forEach( (v) => console.log('       ' + v) );
    } );
    console.log(`${report.length} shuffle-family positions, ${bad} violations`);
    process.exitCode = bad === 0 ? 0 : 1;
}

if (require.main === module) {
    main();
}
module.exports = { audit };
