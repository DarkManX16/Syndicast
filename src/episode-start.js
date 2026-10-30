/*
 * Episode start, for the Time Slots editor: choosing exactly which episode a
 * position plays next, once. Pure - no I/O - so the editor reaches it through
 * browserify and its answers are tested in Node; the directive only draws them.
 *
 * What the planner does with a pick is slot-progress.js's startRecord. This
 * module answers the editor's questions: when does a position first air, what
 * is every row's next episode (asked of the generators' own orderers, so a
 * Rerun that passes a story over shows the one it will really play), what may
 * the picker offer and why can't it offer the rest, and when should it warn.
 *
 * See NOTES.md, Known issues, "Episode start".
 */

const slotProgress = require('./slot-progress');
const rounds = require('./shuffle-rounds');
const constants = require('./constants');
const pinTools = require('./pins');
const orderers = require('./services/show-orderers');
const orderersShowData = require('./services/get-show-data')();

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const isRecord = (value) => (typeof(value) === 'object') && (value !== null);

const DAY_NAMES = [ 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat' ];
const MONTH_NAMES = [ 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec' ];

/*
 * When a position first airs in a lineup made at `now`: right away when one
 * of its slots is under way and the schedule's lateness lets a program start
 * late (the generator puts the first program in at once), else the next start
 * of any of its slots. A slot follows the wall clock, so across a change of
 * the clocks the instant moves with it. Null for a position with no slots.
 *
 * `pins` ({ at, then, program }, the generator's own clock-time pins): an
 * occurrence a pin takes - it
 * starts as the pin does, or inside it - does not air the position's show, so
 * the next one counts; except that a run-late pin ending inside the occurrence
 * lets the show start the moment the pin ends. (A slot of two half-length
 * episodes may still air one after the pin in the same slot: not worked out.)
 */
function firstAiring({ slots, schedule, now, pins }) {
    let timed = slots.filter( (s) => typeof(s.time) === 'number' );
    if (timed.length === 0) {
        return null;
    }
    let period = (typeof(schedule.period) === 'number') ? schedule.period : DAY;
    let lateness = (typeof(schedule.lateness) === 'number') ? schedule.lateness : 0;
    let offsetNow = (new Date(now)).getTimezoneOffset();
    let into = ( ( (now - offsetNow * MINUTE) % period ) + period ) % period;

    let owner = slotProgress.slotAt(schedule, now);
    if ( (owner !== null) && timed.some( (s) => s.time === owner.time ) ) {
        let late = ( (into - owner.time) % period + period ) % period;
        if (late < lateness + constants.SLACK) {
            return { at: now, now: true };
        }
    }
    // The next start of any of the slots at or after `from`.
    let nextStart = (from) => {
        let offsetFrom = (new Date(from)).getTimezoneOffset();
        let intoFrom = ( ( (from - offsetFrom * MINUTE) % period ) + period ) % period;
        let wait = Infinity;
        timed.forEach( (s) => {
            wait = Math.min(wait, ( (s.time - intoFrom) % period + period ) % period);
        } );
        let at = from + wait;
        let offsetThen = (new Date(at)).getTimezoneOffset();
        if (offsetThen !== offsetFrom) {
            at += (offsetThen - offsetFrom) * MINUTE;
        }
        return at;
    };
    let ahead = (Array.isArray(pins) ? pins : []).filter( (x) => x && (typeof(x.at) === 'number') && x.program && (x.program.duration > 0) );
    let from = now;
    let at = nextStart(from);
    for (let n = 0; (n < 400) && (ahead.length > 0); n++) {
        // Is this occurrence taken by a pin?
        let verdict = null;
        for (let i = 0; i < ahead.length; i++) {
            let pin = ahead[i];
            let end = pin.at + pin.program.duration;
            if ( (at >= pin.at - constants.SLACK) && (at < end - constants.SLACK) ) {
                let around = pinTools.slotAround({ schedule: schedule, at: at });
                let ownSlot = Math.abs(at - pin.at) <= constants.SLACK;
                if ( ! ownSlot && (pin.then === 'late') && (around !== null) && (end < around.end - constants.SLACK) ) {
                    verdict = { at: end };
                } else {
                    verdict = { skip: true };
                }
                break;
            }
        }
        if (verdict === null) {
            break;
        }
        if (typeof(verdict.at) === 'number') {
            return { at: verdict.at, now: false };
        }
        from = at + 1000;
        at = nextStart(from);
    }
    return { at: at, now: false };
}

function keyOfSlot(slot, schedule) {
    return slotProgress.positionKey(slot.showId, slot.order, slotProgress.constraintOf(slot, schedule));
}

// A slot that plays a position (Play Next, Shuffle, Rerun, Ordered shuffle).
function playsPosition(slot) {
    return (typeof(slot.showId) === 'string') && (slot.showId !== 'flex.') && ! slot.showId.startsWith('redirect.')
        && [ 'next', 'shuffle', 'rerun', 'ordered' ].indexOf(slot.order) !== -1;
}

/*
 * Every position's next episode and when it first airs, as the generator would
 * play it from `progress` (the planner's answer, with any picks in it): the
 * generators' own orderers are asked, over the same pool. Keyed by position
 * key, so every row of a position gets the same answer.
 *   key -> { key, mode, showId, slots, program (or null), at, now }
 */
function describe({ schedule, progress, pool, now, pins }) {
    let shows = [];
    let byId = new Map();
    pool.forEach( (p) => {
        let data = orderersShowData(p);
        if (! data.hasShow) {
            return;
        }
        let show = byId.get(data.showId);
        if (typeof(show) === 'undefined') {
            show = Object.assign( {}, data, { id: data.showId, description: data.showDisplayName, founder: p, programs: [], seen: new Set() } );
            byId.set(data.showId, show);
            shows.push(show);
        }
        let id = rounds.fileKey(p);
        if (! show.seen.has(id) ) {
            show.seen.add(id);
            show.programs.push(p);
        }
    } );

    let slots = Array.isArray(schedule.slots) ? schedule.slots : [];
    let positions = orderers.createPositions({ shows: shows, schedule: Object.assign( {}, schedule, { progress: progress } ) });
    let out = new Map();
    slots.filter(playsPosition).forEach( (slot) => {
        let key = keyOfSlot(slot, schedule);
        if (! out.has(key) ) {
            out.set(key, { key: key, mode: slot.order, showId: slot.showId, slots: [], program: null, at: null, now: false });
        }
        out.get(key).slots.push(slot);
    } );
    out.forEach( (entry) => {
        let first = firstAiring({ slots: entry.slots, schedule: schedule, now: now, pins: pins });
        if (first !== null) {
            entry.at = first.at;
            entry.now = first.now;
        }
        if (! byId.has(entry.showId) ) {
            return;
        }
        let constraint = slotProgress.constraintOf(entry.slots[0], schedule);
        if (slotProgress.candidatesFor(pool, entry.showId, constraint, orderersShowData).length === 0) {
            return;
        }
        let program = positions.forSlot(entry.slots[0]).current();
        entry.program = (program === null) ? null : program;
    } );
    return out;
}

/*
 * What the picker offers for a position, in the show's order, each with a
 * state and, where it can't be picked, why:
 *   current  - the episode that is next
 *   ok       - can be picked
 *   aired    - Shuffle and Rerun: already aired this round
 *   held     - Shuffle and Rerun: held to the end of this round, because it
 *              aired late in the last, so nothing comes back within half a round
 *   notAired - Rerun: the show's Play Next hasn't aired it yet
 * `record` is the position's place without its own pick; `aired` is
 * slotProgress.playNextAired for a Rerun. Null for a mode with no picker.
 */
function options({ key, mode, record, pool, aired, getShowData }) {
    if ( [ 'next', 'shuffle', 'rerun' ].indexOf(mode) === -1 ) {
        return null;
    }
    let [ showId, , excluded ] = JSON.parse(key);
    let constraint = { excludeSeasons: excluded };
    let candidates = slotProgress.candidatesFor(pool, showId, constraint, getShowData);
    let entry = (program, state, why) => ({ program: program, ref: slotProgress.ref(program, getShowData), state: state, why: why || null });
    if (candidates.length === 0) {
        return { episodes: [], current: null };
    }
    if (mode === 'next') {
        let place = (isRecord(record) && isRecord(record.next)) ? slotProgress.resolveRef(record.next, candidates, getShowData) : 0;
        return {
            episodes: candidates.map( (p, i) => entry(p, (i === place) ? 'current' : 'ok') ),
            current: slotProgress.ref(candidates[place], getShowData),
        };
    }

    let base = isRecord(record) ? record : { round: 0, deferred: [] };
    let rest = slotProgress.restOfRoundOf(pool, getShowData, key, base);
    if (rest === null) {
        return { episodes: candidates.map( (p) => entry(p, 'ok') ), current: null };
    }
    let inRest = new Set( rest.refs.map( (r) => r.key ) );
    let firstKey = (rest.refs.length > 0) ? rest.refs[0].key : null;
    let held = Array.isArray(base.queue) ? new Set() : new Set(base.deferred || []);
    let stories = slotProgress.storiesOf(pool, showId, constraint, mode, getShowData);
    let storyOf = new Map();
    stories.forEach( (story) => story.forEach( (p) => storyOf.set(rounds.fileKey(p), story) ) );

    let airedKeys = (isRecord(aired) && (aired.aired instanceof Set)) ? aired.aired : new Set();
    let eligible = (story) => story.every( (p) => airedKeys.has(rounds.fileKey(p)) );
    // With nothing of its range aired, a Rerun plays as a Shuffle: all open.
    let gated = (mode === 'rerun') && isRecord(aired) && (aired.any === true) && stories.some(eligible);

    let episodes = candidates.map( (p) => {
        let story = storyOf.get(rounds.fileKey(p)) || [ p ];
        if (! story.some( (q) => inRest.has(rounds.fileKey(q)) ) ) {
            return entry(p, 'aired', "Already aired this round.");
        }
        if (gated && ! eligible(story) ) {
            return entry(p, 'notAired', "This show's Play Next hasn't aired it yet.");
        }
        if (story.some( (q) => rounds.fileKey(q) === firstKey )) {
            return entry(p, 'current');
        }
        if (story.some( (q) => held.has(rounds.fileKey(q)) )) {
            return entry(p, 'held', "Held to the end of this round: it aired late in the last one.");
        }
        return entry(p, 'ok');
    } );
    return { episodes: episodes, current: (rest.refs.length > 0) ? rest.refs[0] : null };
}

function episodeCode(program) {
    if (typeof(program.customShowId) !== 'undefined') {
        return '#' + (program.customOrder + 1);
    }
    if ( (typeof(program.season) === 'number') && (typeof(program.episode) === 'number') ) {
        return 'S' + String(program.season).padStart(2, '0') + 'E' + String(program.episode).padStart(2, '0');
    }
    return program.title;
}

function episodeLabel(program) {
    let code = episodeCode(program);
    return (code === program.title) ? code : code + ' ' + program.title;
}

function rangeLabel(excluded) {
    if (excluded.length === 0) {
        return 'all seasons';
    }
    return 'no Season' + ( (excluded.length > 1) ? 's ' : ' ' ) + excluded.join(', ');
}

function whenLabel(entry) {
    if (entry.now) {
        return 'right away (this slot is under way)';
    }
    let d = new Date(entry.at);
    let h = d.getHours();
    let clock = ((h % 12) || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + (h < 12 ? 'am' : 'pm');
    return DAY_NAMES[d.getDay()] + ' ' + MONTH_NAMES[d.getMonth()] + ' ' + d.getDate() + ', ' + clock;
}

/*
 * Two ranges of one show whose Play Next sits at the same episode air the same
 * episodes days apart. Each says so, naming the other: key -> text. Shuffles
 * are not compared - they are meant to look random.
 */
function doubling({ rows, schedule, nameOf }) {
    let byEpisode = new Map();
    rows.forEach( (entry, key) => {
        if ( (entry.mode !== 'next') || (entry.program === null) ) {
            return;
        }
        let id = entry.showId + '|' + rounds.fileKey(entry.program);
        if (! byEpisode.has(id) ) {
            byEpisode.set(id, []);
        }
        byEpisode.get(id).push(key);
    } );
    let out = new Map();
    byEpisode.forEach( (keys) => {
        if (keys.length < 2) {
            return;
        }
        keys.forEach( (key) => {
            let others = keys.filter( (k) => k !== key ).map( (k) => {
                let [ showId, , excluded ] = JSON.parse(k);
                return nameOf(showId) + ', ' + rangeLabel(excluded);
            } );
            out.set(key, "Same place as " + others.join('; ') + ": they'll air the same episodes days apart.");
        } );
    } );
    return out;
}

/*
 * What a Play Next jump forward skips, when the show also has a Rerun slot:
 * a Rerun treats everything before a strip's place as aired, so it may replay
 * what the jump leaves behind. Null when there is nothing to say.
 */
function skipNote({ key, current, pick, schedule, pool, getShowData }) {
    let [ showId, , excluded ] = JSON.parse(key);
    let reruns = (Array.isArray(schedule.slots) ? schedule.slots : []).filter( (s) => (s.showId === showId) && (s.order === 'rerun') );
    if ( (reruns.length === 0) || ! isRecord(current) || ! isRecord(pick) ) {
        return null;
    }
    let candidates = slotProgress.candidatesFor(pool, showId, { excludeSeasons: excluded }, getShowData);
    let currentAt = candidates.findIndex( (p) => rounds.fileKey(p) === rounds.fileKey(current) );
    let pickAt = candidates.findIndex( (p) => rounds.fileKey(p) === rounds.fileKey(pick) );
    if ( (currentAt === -1) || (pickAt === -1) || (pickAt <= currentAt) ) {
        return null;
    }
    let skipped = candidates.slice(currentAt, pickAt);
    let span = (skipped.length === 1) ? episodeCode(skipped[0]) : episodeCode(skipped[0]) + ' to ' + episodeCode(skipped[skipped.length - 1]);
    return "This jump skips " + skipped.length + (skipped.length === 1 ? " episode" : " episodes") + " (" + span + "). "
        + (reruns.length === 1 ? "This show's Rerun" : "This show's Rerun slots") + " may replay episodes this jump skips.";
}

/*
 * The picks the editor holds ({ positionKey: { ref, ... } }) that a slot of the
 * schedule still plays - `pending`, as the planner takes them ({ key: ref }) -
 * and the keys of those that no slot plays any more, `dropped`: a row that
 * changed its show, order or seasons left its position, and with the last row
 * gone there is nothing for a pick to start.
 */
function liveStarts(schedule, starts) {
    let live = new Set( (Array.isArray(schedule.slots) ? schedule.slots : []).filter(playsPositionForStart).map( (s) => keyOfSlot(s, schedule) ) );
    let pending = {};
    let dropped = [];
    Object.keys(starts).forEach( (key) => {
        if (live.has(key) && isRecord(starts[key]) && isRecord(starts[key].ref) ) {
            pending[key] = starts[key].ref;
        } else {
            dropped.push(key);
        }
    } );
    return { pending: pending, dropped: dropped };
}

// A start needs a position with a picker: Ordered shuffle has none.
function playsPositionForStart(slot) {
    return playsPosition(slot) && (slot.order !== 'ordered');
}

/*
 * The editor's whole picture at one moment, in one call:
 *   base     - every position's place with no picks (what the picker is drawn from)
 *   progress - the same with the picks in (what Create Lineup would start from)
 *   rows     - describe() over `progress`
 *   pending  - the picks that apply, as the planner takes them
 *   dropped  - keys of picks no slot plays any more
 *   ignored  - keys of picks that can't apply as they stand (a Shuffle pick that
 *              has aired this round, or no longer a candidate)
 * `planArgs` is what slotProgress.planProgress takes, less `now` and `starts`.
 */
function plan({ planArgs, starts, now, pins }) {
    let schedule = planArgs.schedule;
    let { pending, dropped } = liveStarts(schedule, starts);
    let base = slotProgress.planProgress(Object.assign( {}, planArgs, { now: now, starts: undefined } ));
    let progress = (Object.keys(pending).length === 0)
        ? base
        : slotProgress.planProgress(Object.assign( {}, planArgs, { now: now, starts: pending } ));
    let pool = Array.isArray(planArgs.catalog) ? planArgs.catalog : planArgs.pool;
    let rows = describe({ schedule: schedule, progress: progress, pool: pool, now: now, pins: pins });
    let ignored = Object.keys(pending).filter( (key) => {
        let [ , mode ] = JSON.parse(key);
        return slotProgress.startRecord({ key: key, mode: mode, record: base.positions[key], pick: pending[key],
            pool: pool, getShowData: planArgs.getShowData }) === null;
    } );
    return { base: base, progress: progress, rows: rows, pending: pending, dropped: dropped, ignored: ignored };
}

module.exports = {
    liveStarts: liveStarts,
    plan: plan,
    firstAiring: firstAiring,
    keyOfSlot: keyOfSlot,
    playsPosition: playsPosition,
    describe: describe,
    options: options,
    doubling: doubling,
    skipNote: skipNote,
    episodeCode: episodeCode,
    episodeLabel: episodeLabel,
    rangeLabel: rangeLabel,
    whenLabel: whenLabel,
};
