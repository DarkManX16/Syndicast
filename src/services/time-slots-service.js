const constants = require("../constants");


const getShowData = require("./get-show-data")();
const random = require('../helperFuncs').random;
const throttle = require('./throttle');
const orderers = require("./show-orderers");
const slotProgress = require('../slot-progress');
const keptRows = require('../kept-rows');
const specialDays = require('../special-days');
const multiPart = require('../multi-part');

const MINUTE = 60*1000;
const DAY = 24*60*MINUTE;
const LIMIT = 40000;


function getShow(program) {

    let d = getShowData(program);
    if (! d.hasShow) {
        return null;
    } else {
        d.description = d.showDisplayName;
        d.id = d.showId;
        return d;
    }
}

function getProgramId(program) {
    let s = program.serverKey;
    if (typeof(s) === 'undefined') {
        s = 'unknown';
    }
    let p = program.key;
    if (typeof(p) === 'undefined') {
        p = 'unknown';
    }
    return s + "|" + p;
}

/*
 * The instant the local clock falls back, somewhere in (from, to] - the first
 * moment already on the later offset. Only asked when the offsets at the two
 * ends are known to differ, and a slot interval never spans two changes.
 */
function fallBackInstant(from, to) {
    let offsetAfter = (new Date(to)).getTimezoneOffset();
    let lo = from;
    let hi = to;
    while (hi - lo > 1) {
        let mid = Math.floor( (lo + hi) / 2 );
        if ( (new Date(mid)).getTimezoneOffset() === offsetAfter ) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    return hi;
}

function addProgramToShow(show, program) {
    if ( (show.id == 'flex.') || show.id.startsWith("redirect.")  ) {
        //nothing to do
        return;
    }
    let id = getProgramId(program)
    if(show.programs[id] !== true) {
        show.programs.push(program);
        show.programs[id] = true
    }
}

/*
 * `history`, optional, is what the lineup on air aired before now -
 * [{ start, program }] - for a Repeat slot whose source aired before this
 * lineup begins.
 *
 * `pins`, optional, are swaps and inserts fixed to a date and time -
 * [{ at, then, program }], `program` carrying its `pin` mark - placed by the
 * four rules in NOTES.md ("Swaps, inserts and Flex that keeps time").
 * Entries marked `kept: true` are kept rows instead (src/kept-rows.js
 * keptAhead; NOTES.md, "What you see is what airs"): `at` is the row's
 * instant in the list. A row kept as it is airs as it is; one with a `key`,
 * kept in time, airs that position's next episode. A kept row never waits for
 * the slot before it: that slot gets only what fits whole before it.
 *
 * `carry`, optional, is the program on air as the lineup is made - or the
 * one whose break is on air - { start, program }: it stays where it is, and
 * the lineup is made from its end, as after a run-late pin (src/pins.js
 * carryAt; the planner counts it as aired).
 *
 * `fillerPools`, optional, is every filler list a special day's "Fill long
 * breaks with" might name, read ahead of time - { [listId]: [item, ...] } -
 * since this is a pure function and cannot read one itself. See
 * special-days.js's `fillBreaksWith` and this file's `fillItemsFor`.
 *
 * `holidayItems`, optional, is what a special day's holiday rows play first -
 * { [dayId]: { [showId]: [program, ...] } }, the show's episodes set aside for
 * the day's holiday (special-days.js's holidayItems). They are in no pool:
 * the catalog's never-air list holds them out of every regular position.
 */
module.exports = async( programs, schedule, history, pinsIn, carryIn, fillerPools, holidayItems ) => {
    if (! Array.isArray(programs) ) {
        return { userError: 'Expected a programs array' };
    }
    if (typeof(schedule) === 'undefined') {
        return { userError: 'Expected a schedule' };
    }
    // timeZoneOffset is no longer read. The offset is resolved per slot
    // occurrence instead of being captured once, so a schedule that still
    // carries the field is accepted and the field ignored.
    //verify that the schedule is in the correct format
    if (! Array.isArray(schedule.slots) ) {
        return { userError: 'Expected a "slots" array in schedule' };
    }
    if (typeof(schedule).period === 'undefined') {
        schedule.period = DAY;
    }
    for (let i = 0; i < schedule.slots.length; i++) {
        if (typeof(schedule.slots[i].time) === 'undefined') {
            return { userError: "Each slot should have a time" };
        }
        if (typeof(schedule.slots[i].showId) === 'undefined') {
            return { userError: "Each slot should have a showId" };
        }
        if (
            (schedule.slots[i].time < 0)
            || (schedule.slots[i].time >= schedule.period)
            || (Math.floor(schedule.slots[i].time) != schedule.slots[i].time)
        ) {
            return { userError: "Slot times should be a integer number of milliseconds between 0 and period-1, inclusive" };
        }
        // Slot times stay in local wall-clock terms. They used to be flattened
        // to UTC here using a single offset captured at generation time, which
        // made every occurrence after a daylight savings change land an hour
        // away from the time the user asked for. The offset is now resolved per
        // occurrence, inside the loop, so nothing is pre-flattened.
        schedule.slots[i].time = ( schedule.slots[i].time + 10*schedule.period ) % schedule.period;
    }
    schedule.slots.sort( (a,b) => {
        return (a.time - b.time);
    } );
    for (let i = 1; i < schedule.slots.length; i++) {
        if (schedule.slots[i].time == schedule.slots[i-1].time) {
            return { userError: "Slot times should be unique."};
        }
    }
    if (typeof(schedule.pad) === 'undefined') {
        return { userError: "Expected schedule.pad" };
    }

    if (typeof(schedule.lateness) == 'undefined') {
        return { userError: "schedule.lateness must be defined." };
    }
    if (typeof(schedule.maxDays) == 'undefined') {
        return { userError: "schedule.maxDays must be defined." };
    }
    if (typeof(schedule.flexPreference) === 'undefined') {
        schedule.flexPreference = "distribute";
    }
    if (schedule.flexPreference !== "distribute" && schedule.flexPreference !== "end") {
        return { userError: `Invalid schedule.flexPreference value: "${schedule.flexPreference}"` };
    }
    let flexBetween = ( schedule.flexPreference !== "end" );

    // throttle so that the stream is not affected negatively
    let steps = 0;

    let showsById = {};
    let shows = [];

    /*
     * Each slot plays from its position - show, mode and seasons - which starts
     * from its record in schedule.progress, or the founder rule without one.
     * Season settings belong to the slot (slotProgress.constraintOf, which
     * still reads a schedule's old per-show showConstraints). Created once the
     * programs are loaded, since the founder rule needs each show's founder.
     */
    let positions = null;

    /*
     * Repeat a slot: re-airs whatever a chosen earlier slot aired - the
     * episodes of its show that started inside the source slot's latest
     * occurrence before this one, the same day or up to a period back - from
     * this lineup, or from `history` when that occurrence was before it.
     * Labelled 'repeat', so a repeat never moves its source's position. A
     * source that aired nothing - Flex, or before the lineup on air existed -
     * plays a Rerun of the same show (Ron, Oct 9). One occurrence at a time:
     * `occurrenceStart` is set by the loop below before each slot it fills.
     */
    let aired = [];
    let occurrenceStart = null;
    let repeatState = new Map();

    function sourceAirings(slot, start) {
        let source = s.find( (x) => (x.time === slot.repeatOf) && (x.order !== 'repeat') );
        if (typeof(source) === 'undefined') {
            return [];
        }
        let index = s.indexOf(source);
        let length = ( (index === s.length - 1) ? s[0].time + schedule.period : s[index + 1].time ) - source.time;
        let back = ( (localMsIntoPeriod(start) - source.time) % schedule.period + schedule.period ) % schedule.period;
        if (back === 0) {
            back = schedule.period;
        }
        // In real time, a daylight-saving change in between moves it an hour.
        let from = start - back;
        for (let shift of [ 0, -60 * MINUTE, 60 * MINUTE ]) {
            if (localMsIntoPeriod(start - back + shift) === source.time) {
                from = start - back + shift;
                break;
            }
        }
        // A special day's airing isn't the source slot's: the day replaced it, so
        // the repeat finds nothing and airs a Rerun, as for a source that aired nothing.
        let inWindow = (a) => (a.start >= from) && (a.start < from + length)
            && ! a.program.isOffline && ! a.program.specialDay && (getShowData(a.program).showId === source.showId);
        let before = (Array.isArray(history) ? history : []).filter( (a) => (a.start < ts) && inWindow(a) );
        let after = aired.filter( (a) => (a.start >= ts) && inWindow(a) );
        return before.concat(after).sort( (a, b) => a.start - b.start ).map( (a) => a.program );
    }

    function repeatFor(slot) {
        let state = repeatState.get(slot.time);
        if ( (typeof(state) === 'undefined') || (state.start !== occurrenceStart) ) {
            state = { start: occurrenceStart, list: sourceAirings(slot, occurrenceStart), index: 0 };
            repeatState.set(slot.time, state);
        }
        if (state.list.length === 0) {
            let fallback = positions.forSlot({ time: slot.time, showId: slot.showId, order: 'rerun' });
            return { current: () => fallback.current(), next: () => fallback.next() };
        }
        return {
            current: () => {
                if (state.index >= state.list.length) {
                    return null;
                }
                let copy = Object.assign( {}, state.list[state.index] );
                delete copy.shuffleOrder;
                // A repeat of a pinned or kept airing is not itself pinned or kept.
                delete copy.pin;
                delete copy.kept;
                copy.slotPosition = slotProgress.label('repeat');
                return copy;
            },
            next: () => { state.index++; },
        };
    }

    /*
     * A special day's row (src/special-days.js): a picked item, once per
     * occurrence of its row, or its show's position - the regular one on an
     * Advance day, the day's own on a Keep-apart day (`apart`). Every airing it
     * gives carries the day and the row, `specialRow`, so a re-make during a
     * Back to back day knows which row comes next. A show not in the pool has
     * nothing to give.
     *
     * A holiday row (`slot.holiday`, built with the day) first plays the
     * episodes set aside for the day's holiday - from a position of its own,
     * tagged "holiday:" + the day, whatever the day's mode, so no regular
     * position moves - each once; when they have all aired that day it plays
     * as any row of its show does. `holidayTaken` counts them by position, from
     * what the lineup on air already aired of them (the planner) and this run.
     */
    let itemState = new Map();
    let holidayTaken = new Map();
    let holidayDone = (hs) => (holidayTaken.get(hs.key) || 0) >= hs.total;
    let specialCopy = (program, slot) => {
        let copy = Object.assign( {}, program );
        copy.specialDay = slot.special;
        copy.specialRow = slot.specialRow;
        return copy;
    };
    function specialItem(slot) {
        if ( (typeof(slot.item) === 'object') && (slot.item !== null) ) {
            if ( (typeof(slot.item.program) !== 'object') || (slot.item.program === null) || (itemState.get(slot) === occurrenceStart) ) {
                return null;
            }
            let copy = specialCopy(slot.item.program, slot);
            delete copy.slotPosition;
            delete copy.shuffleOrder;
            delete copy.kept;
            delete copy.pin;
            return copy;
        }
        if ( (typeof(slot.holiday) === 'object') && ! holidayDone(slot.holiday) ) {
            let current = positions.forSlot(slot.holiday).current();
            if ( (current !== null) && (typeof(current) !== 'undefined') ) {
                return specialCopy(current, slot);
            }
        }
        if ( (typeof(showsById[slot.showId]) === 'undefined') || ! positions.plays(slot.order) ) {
            return null;
        }
        let next = positions.forSlot(slot).current();
        return ( (next === null) || (typeof(next) === 'undefined') ) ? null : specialCopy(next, slot);
    }
    function advanceSpecial(slot) {
        if ( (typeof(slot.item) === 'object') && (slot.item !== null) ) {
            itemState.set(slot, occurrenceStart);
        } else if ( (typeof(slot.holiday) === 'object') && ! holidayDone(slot.holiday) ) {
            positions.forSlot(slot.holiday).next();
            holidayTaken.set(slot.holiday.key, (holidayTaken.get(slot.holiday.key) || 0) + 1);
        } else if ( (typeof(showsById[slot.showId]) !== 'undefined') && positions.plays(slot.order) ) {
            positions.forSlot(slot).next();
        }
    }

    function getNextForSlot(slot, remaining) {
        //remaining doesn't restrict what next show is picked. It is only used
        //for shows with flexible length (flex and redirects)
        if (typeof(slot.special) === 'string') {
            return specialItem(slot);
        }
        if (slot.showId === "flex.") {
            return {
                isOffline: true,
                duration: remaining,
            }
        }
        let show = shows[ showsById[slot.showId] ];

        if (slot.showId.startsWith("redirect.")) {
            return {
                isOffline: true,
                type: "redirect",
                duration: remaining,
                channel: show.channel,
            }
        } else if (slot.order === 'repeat') {
            return repeatFor(slot).current();
        } else if (positions.plays(slot.order)) {
            return positions.forSlot(slot).current();
        }
    }
    
    function advanceSlot(slot) {
        if (typeof(slot.special) === 'string') {
            return advanceSpecial(slot);
        }
        if ( (slot.showId === "flex.") || (slot.showId.startsWith("redirect.") ) ) {
            return;
        }
        if (slot.order === 'repeat') {
            return repeatFor(slot).next();
        }
        if (positions.plays(slot.order)) {
            return positions.forSlot(slot).next();
        }
    }

    /*
     * Split episodes (multi-part.js): a slot that starts an "a" half plays the
     * rest of that episode in the same slot. `unitOf` is the item and the
     * halves after it in its show's order - from its show's pool, or a holiday
     * row's - so a slot can tell whether the whole episode fits before it places
     * the first half. A picked item is only itself. `takeRest` then places the
     * halves as the slot's position gives them, stopping at anything else, and
     * says how long they run.
     */
    let sortedPools = new Map();
    let sortedPool = (id, programs) => {
        if (! sortedPools.has(id)) {
            sortedPools.set(id, programs.slice().sort( (a, b) => getShowData(a).order - getShowData(b).order ));
        }
        return sortedPools.get(id);
    };
    function unitOf(slot, item) {
        let unit = { rest: [], duration: (item && item.duration) || 0 };
        if ( (item === null) || (typeof(item) !== 'object') || item.isOffline || (multiPart.halfOf(item) === null)
             || ( (typeof(slot.item) === 'object') && (slot.item !== null) ) ) {
            return unit;
        }
        let pool = [];
        let id = getShowData(item).showId;
        if ( (typeof(slot.holiday) === 'object') && Array.isArray(slot.holiday.pool) ) {
            pool = sortedPool(slot.holiday.key, slot.holiday.pool);
        }
        let i = pool.findIndex( (p) => getProgramId(p) === getProgramId(item) );
        if ( (i === -1) && (typeof(showsById[id]) !== 'undefined') ) {
            pool = sortedPool(id, shows[ showsById[id] ].programs);
            i = pool.findIndex( (p) => getProgramId(p) === getProgramId(item) );
        }
        for (let j = i + 1; (i !== -1) && (j < pool.length) && multiPart.joinsHalf(pool[j - 1], pool[j]); j++) {
            unit.rest.push(pool[j]);
            unit.duration += pool[j].duration;
        }
        return unit;
    }
    function takeRest(slot, unit, place) {
        let taken = 0;
        for (let k = 0; k < unit.rest.length; k++) {
            let next = getNextForSlot(slot, 0);
            if ( (next === null) || (typeof(next) !== 'object') || next.isOffline || (getProgramId(next) !== getProgramId(unit.rest[k])) ) {
                break;
            }
            place(next);
            advanceSlot(slot);
            taken += next.duration;
        }
        return taken;
    }
    // A slot holding a split episode whose halves fit only without their pads lays them without:
    // Ron's 2:35 slot airs 11a and 11b back to back, ending 2:57:22, rather than 11a alone.
    // `openEnd`: the last item's pad isn't laid (before a pin), so it doesn't count.
    function squeeze(pads, room, split, openEnd) {
        let padded = pads.reduce( (sum, x) => sum + x.totalDuration, 0 );
        let plain = pads.reduce( (sum, x) => sum + x.item.duration, 0 );
        let laid = (openEnd === true) ? padded - pads[pads.length - 1].pad : padded;
        if (split && (laid > room) && (plain <= room)) {
            pads.forEach( (x) => { x.pad = 0; x.totalDuration = x.item.duration; } );
            return plain;
        }
        return padded;
    }

    function makePadded(item) {
        let x = item.duration;
        let m = x % schedule.pad;
        let f = 0;
        if ( (m > constants.SLACK) && (schedule.pad - m > constants.SLACK) ) {
            f = schedule.pad - m;
        }
        return {
            item: item,
            pad: f,
            totalDuration: item.duration + f,
        }

    }

    // load the programs
    for (let i = 0; i < programs.length; i++) {
        let p = programs[i];
        // An episode enters the pool as itself: a special day's own airing in the
        // lineup this pool came from (specialCopy) would otherwise be what every
        // regular slot plays of it from here on, marked as a row of that day.
        if ( (typeof(p.specialDay) !== 'undefined') || (typeof(p.specialRow) !== 'undefined') ) {
            p = Object.assign( {}, p );
            delete p.specialDay;
            delete p.specialRow;
        }
        let show = getShow(p);
        if (show != null) {
            if (typeof(showsById[show.id] ) === 'undefined') {
                showsById[show.id] = shows.length;
                shows.push( show );
                show.founder = p;
                show.programs = [];
            } else {
                show = shows[ showsById[show.id] ];
            }
            addProgramToShow( show, p );
        }
    }
    positions = orderers.createPositions({ shows: shows, schedule: schedule });

    /*
     * How far an instant sits into its local period, resolving the timezone
     * offset for that instant rather than for whenever the schedule was made.
     * This is what keeps a slot on the wall-clock time it was set to across a
     * daylight savings change.
     *
     * Consequences, which follow local time honestly rather than being
     * special-cased: on the spring-forward day the skipped local hour never
     * occurs, so a slot inside it does not air that day. On the autumn day the
     * repeated hour occurs twice, so a slot inside it airs twice.
     */
    function localMsIntoPeriod(instant) {
        let offsetMs = (new Date(instant)).getTimezoneOffset() * MINUTE;
        let local = instant - offsetMs;
        return ( (local % schedule.period) + schedule.period ) % schedule.period;
    }

    let s = schedule.slots;

    /*
     * The slot covering a local time of day, how far into it that is, and how
     * long until the next one starts. The loop below asks this once per step,
     * and the fall-back handling asks it which slot the repeated time belongs
     * to, so the two can never disagree about who owns a moment.
     */
    function findSlot(dayTime) {
        for (let i = 0; i < s.length; i++) {
            let endTime;
            if (i == s.length - 1) {
                endTime = s[0].time + schedule.period;
            } else {
                endTime = s[i+1].time;
            }

            if ((s[i].time <= dayTime) && (dayTime < endTime)) {
                return {
                    slot: s[i],
                    dayTime: dayTime,
                    remaining: endTime - dayTime,
                    late: dayTime - s[i].time,
                };
            }
            if ((s[i].time <= dayTime + schedule.period) && (dayTime + schedule.period < endTime)) {
                let wrapped = dayTime + schedule.period;
                return {
                    slot: s[i],
                    dayTime: wrapped,
                    remaining: endTime - wrapped,
                    late: wrapped + schedule.period - s[i].time,
                };
            }
        }
        return null;
    }

    let ts = (new Date() ).getTime();
    let curr = ts - localMsIntoPeriod(ts);
    let t0 = curr + s[0].time;
    /*
     * The carry, if it is one: a program with a length that started by now, and is
     * on air or whose slot - the one it began in - is still going. Otherwise what is
     * on air is some other slot's Flex, nobody's break, and the lineup is made from
     * now as it always was: its end would put episodes in the past.
     */
    let carryChecked = null;
    if ( (typeof(carryIn) === 'object') && (carryIn !== null) && (typeof(carryIn.start) === 'number') && (carryIn.start <= ts)
        && (typeof(carryIn.program) === 'object') && (carryIn.program !== null) && ! carryIn.program.isOffline
        && Number.isFinite(carryIn.program.duration) && (carryIn.program.duration > 0) ) {
        let ownSlot = findSlot(localMsIntoPeriod(carryIn.start));
        if ( (carryIn.start + carryIn.program.duration > ts) || ( (ownSlot !== null) && (carryIn.start + ownSlot.remaining > ts) ) ) {
            carryChecked = carryIn;
        }
    }
    // A program still on air from before the period's start is kept: the
    // lineup starts with it, still a whole number of periods long.
    if ( (carryChecked !== null) && (carryChecked.start < t0) && (carryChecked.start > t0 - schedule.period) ) {
        t0 = carryChecked.start;
    }

    /*
     * Pins. Rule 1: a pin airs at its time, or the moment a program still on
     * then ends - it never cuts into one. Rule 2: from its time to the end of
     * its slot the slot is the pin's; the slot's own show airs after it only
     * what fits whole. Rule 3: a slot that begins while the pin is on and ends
     * before it is taken over; the one it ends in is taken over too ('take')
     * or runs late ('late'): programs one after another from the pin's end,
     * unpadded and unrounded, until one starts on time. Take covers only the
     * slots the pin reaches from its own time: one pushed later by a program
     * still on runs late into any slot beyond those. Rule 4 needs nothing
     * here: a position advances only when its episode is placed, so what a pin
     * pushes out airs at its show's next slot.
     */
    const SLACK = constants.SLACK;
    let keptKindOf = keptRows.keptKind;
    let pins = (Array.isArray(pinsIn) ? pinsIn : [])
        .filter( (x) => (x !== null) && (typeof(x) === 'object') && (typeof(x.at) === 'number')
            && (typeof(x.program) === 'object') && (x.program !== null) && (x.at + x.program.duration > ts) )
        .sort( (a, b) => a.at - b.at );
    // A pinned Flex on air ("Remove this airing only") with nothing to carry keeps
    // its own time, as the program on air does: restarted now, it would run on
    // into the next slot and take it over.
    let flexOnAir = (carryChecked !== null) ? undefined : pins.find( (x) => x.program.isOffline && (x.at <= ts) );
    if ( (typeof(flexOnAir) !== 'undefined') && (flexOnAir.at < t0) && (flexOnAir.at > t0 - schedule.period) ) {
        t0 = flexOnAir.at;
    }
    if ( (typeof(flexOnAir) !== 'undefined') && (flexOnAir.at < t0) ) {
        flexOnAir = undefined;
    }
    let p = [];
    let t = t0;
    let hardLimit = t0 + schedule.maxDays * DAY;

    let pushFlex = (d) => {
        if (d > 0) {
            t += d;
            if ( (p.length > 0) && p[p.length-1].isOffline && (p[p.length-1].type != 'redirect') && ! p[p.length-1].pin ) {
                p[p.length-1].duration += d;
            } else {
                p.push( {
                    duration: d,
                    isOffline : true,
                } );
            }
        }
    }

    // The last airing a special day placed, for the run-late after its end.
    let lastSpecial = null;
    let pushProgram = (item) => {
        if ( item.isOffline && (item.type !== 'redirect') ) {
            pushFlex(item.duration);
        } else {
            if (! item.isOffline) {
                aired.push({ start: t, program: item });
            }
            if (typeof(item.specialDay) === 'string') {
                lastSpecial = { start: t, end: t + item.duration, day: item.specialDay };
            }
            p.push(item);
            t += item.duration;
        }
    };

    /*
     * A slot's programs with their pads, and what is left of it shared out as
     * Flex - between them, or after the last ("end") - then laid down.
     */
    let layPads = (pads, rem) => {
        if (flexBetween) {
            let div = Math.floor(rem / schedule.pad );
            let mod = rem % schedule.pad;
            // add mod to the latest item
            pads[ pads.length - 1].pad += mod;
            pads[ pads.length - 1].totalDuration += mod;

            let sortedPads = pads.map( (p, $index) => {
                return {
                    pad: p.pad,
                    index : $index,
                }
            });
            sortedPads.sort( (a,b) => { return a.pad - b.pad; } );
            for (let i = 0; i < pads.length; i++) {
                let q = Math.floor( div / pads.length );
                if (i < div % pads.length) {
                    q++;
                }
                let j = sortedPads[i].index;
                pads[j].pad += q * schedule.pad;
            }
        } else {
            //also add div to the latest item
            pads[ pads.length - 1].pad += rem;
            pads[ pads.length - 1].totalDuration += rem;
        }
        // now unroll them all
        for (let i = 0; i < pads.length; i++) {
            pushProgram( pads[i].item );
            pushFlex( pads[i].pad );
        }
    };

    /*
     * Special days (src/special-days.js; NOTES.md, "Special days"): each one not
     * yet ended, and with nothing that stops it, replaces the regular slots for
     * its hours. A regular slot stops where a day begins. Set times rows are
     * slots at their instants, filled as any slot is; Back to back rows go in
     * order, each from the next :00 or :30 after the one before ends (backStep).
     * An airing still on at the day's end runs the regular schedule late from
     * its end, as after a run-late pin, until a program starts on time.
     */
    let stopped = {};
    specialDays.problems(schedule, undefined).forEach( (x) => {
        if (x.field !== 'block') {
            stopped[x.dayId] = true;
        }
    } );
    let laidDays = specialDays.ahead(schedule, ts).filter( (day) => ! stopped[day.id] ).map( (day) => {
        let w = specialDays.windowOf(day);
        let rows = day.slots.filter( (row) => (row !== null) && (typeof(row) === 'object') );
        // Where a day under way is, from the planner (slot-progress specialDaysPlan):
        // the next Back to back row, the picked items already aired, and how many
        // of each holiday position's episodes have.
        let at = ( (typeof(schedule.progress) === 'object') && (schedule.progress !== null)
                   && (typeof(schedule.progress.specialDays) === 'object') && (schedule.progress.specialDays !== null) )
            ? schedule.progress.specialDays[day.id] : undefined;
        let dayHolidays = ( (specialDays.holidayNames(day.holiday).length > 0) && (typeof(holidayItems) === 'object') && (holidayItems !== null)
                            && (typeof(holidayItems[day.id]) === 'object') && (holidayItems[day.id] !== null) )
            ? holidayItems[day.id] : {};
        let slotOf = rows.map( (row, k) => {
            let slot = Object.assign( {}, row, {
                time: -1, special: day.id, specialRow: k, apart: (day.positions === 'apart') ? day.id : undefined,
                untilAt: specialDays.untilAt(day, row) } );
            let pool = ( (row.holidayOnly === true) && (typeof(row.showId) === 'string') && Array.isArray(dayHolidays[row.showId]) ) ? dayHolidays[row.showId] : null;
            if ( (pool !== null) && ! ((typeof(row.item) === 'object') && (row.item !== null)) ) {
                let hs = { showId: row.showId, order: specialDays.holidayOrder(row.order), seasons: row.seasons, apart: 'holiday:' + day.id, pool: pool };
                hs.key = specialDays.taggedKey(slotProgress.positionKey(hs.showId, hs.order, slotProgress.constraintOf(hs, schedule)), hs.apart);
                hs.total = slotProgress.applySeasonExclusions(pool, slotProgress.constraintOf(hs, schedule)).length;
                if ( (typeof(at) === 'object') && (at !== null) && (typeof(at.holidayAired) === 'object') && (at.holidayAired !== null)
                     && Number.isInteger(at.holidayAired[hs.key]) ) {
                    holidayTaken.set(hs.key, at.holidayAired[hs.key]);
                }
                slot.holiday = hs;
            }
            return slot;
        } );
        let timed = null;
        if (day.layout === 'times') {
            timed = specialDays.rowTimes(day).filter( (x) => ! x.gap && (x.at >= w.from) && (x.at < w.to) )
                .map( (x) => ({ at: x.at, slot: slotOf[rows.indexOf(x.row)] }) );
        }
        let k = ( (typeof(at) === 'object') && (at !== null) && Number.isInteger(at.nextRow) ) ? at.nextRow : 0;
        let itemsAired = new Set( ( (typeof(at) === 'object') && (at !== null) && Array.isArray(at.airedItems) ) ? at.airedItems : [] );
        return { day: day, from: w.from, to: w.to, slotOf: slotOf, timed: timed, k: k, itemsAired: itemsAired,
            step: specialDays.stepOf(day), jumped: (w.from <= ts) };
    } );
    let dayAt = (x) => laidDays.find( (d) => (d.from <= x) && (x < d.to) ) || null;
    let nextDayFrom = (x) => laidDays.reduce( (m, d) => ( (d.from > x) && (d.from < m) ) ? d.from : m, Infinity );
    const FLEX_SLOT = { time: -1, showId: 'flex.' };

    // A Set times day's row covering t, as findSlot answers for a regular slot.
    let timedFound = (d) => {
        let cur = -1;
        for (let k = 0; k < d.timed.length; k++) {
            if (d.timed[k].at <= t + SLACK) {
                cur = k;
            }
        }
        if (cur === -1) {
            let first = (d.timed.length > 0) ? d.timed[0].at : d.to;
            return { slot: FLEX_SLOT, dayTime: null, remaining: first - t, late: 0, special: true };
        }
        let end = (cur + 1 < d.timed.length) ? d.timed[cur + 1].at : d.to;
        return { slot: d.timed[cur].slot, dayTime: null, remaining: end - t, late: Math.max(0, t - d.timed[cur].at), special: true };
    };

    let isItem = (row) => (typeof(row.item) === 'object') && (row.item !== null);

    /*
     * An Advance day's row with a start (decision 3): its position jumps there as
     * the day begins, and carries on from wherever the day leaves it. A day already
     * begun when the lineup is made jumped then; its places say where it is now.
     * Play Next only: a Shuffle's place is a round, not an episode to jump to.
     */
    let jump = (d) => {
        d.jumped = true;
        if (d.day.positions === 'apart') {
            return;
        }
        let seen = new Set();
        d.slotOf.forEach( (row) => {
            if ( isItem(row) || (row.order !== 'next') || (typeof(row.start) !== 'object') || (row.start === null)
                 || (typeof(showsById[row.showId]) === 'undefined') ) {
                return;
            }
            let key = slotProgress.positionKey(row.showId, row.order, slotProgress.constraintOf(row, schedule));
            if (! seen.has(key)) {
                seen.add(key);
                positions.forSlot(row).seek(row.start);
            }
        } );
    };

    /*
     * "Fill long breaks with" (special-days.js's `day.fillBreaksWith`): when a
     * Back to back row ends with more than FILL_THRESHOLD left before the next
     * row's own mark, that gap plays as many items of this source as fit
     * first, a normal (shorter) Flex still closing it out exactly on the mark.
     * Off (null/undefined) leaves every gap as it always was, one Flex.
     *
     * A show or custom show (its showId, exactly as a row names one) reuses
     * getNextForSlot/advanceSlot, but never the show's own regular position -
     * filling a break must never move where its regular slot picks up next
     * (Ron, Nov 5). Tagged "fill:<dayId>" (specialDays.taggedKey, the same
     * mechanism a Keep-apart row's own position already uses to stay off the
     * regular one), it gets its own position, round robin, remembered between
     * runs the normal way, just never shared with anything else. "filler:<listId>"
     * reads `fillerPools[listId]` - plain items this function cannot read itself -
     * round robin too, but only within this one run: filler is disposable,
     * nothing to remember.
     */
    const FILL_THRESHOLD = 10 * MINUTE;
    let fillCounters = new Map();
    let fillItemsFor = (d, roomLeft) => {
        let source = d.day.fillBreaksWith;
        if ( (typeof(source) !== 'string') || (source === '') ) {
            return [];
        }
        let out = [];
        let room = roomLeft;
        let tag = { special: d.day.id, specialRow: 'fill' };
        if (source.startsWith('filler:')) {
            let listId = source.slice('filler:'.length);
            let pool = ( (typeof(fillerPools) === 'object') && (fillerPools !== null) && Array.isArray(fillerPools[listId]) )
                ? fillerPools[listId] : [];
            if (pool.length === 0) {
                return out;
            }
            let i = fillCounters.get(listId) || 0;
            for (let tries = 0; (tries < pool.length) && (room >= constants.SLACK); tries++) {
                let clip = pool[i % pool.length];
                i++;
                if ( (clip.duration > 0) && (clip.duration <= room) ) {
                    out.push(specialCopy(clip, tag));
                    room -= clip.duration;
                }
            }
            fillCounters.set(listId, i);
            return out;
        }
        if (typeof(showsById[source]) === 'undefined') {
            return out;
        }
        let slot = { time: -1, showId: source, order: 'next', apart: 'fill:' + d.day.id };
        for (let tries = 0; (tries < 1000) && (room >= constants.SLACK); tries++) {
            let next = getNextForSlot(slot, room);
            let unit = unitOf(slot, next);
            if ( (next === null) || (typeof(next) === 'undefined') || next.isOffline || ! (next.duration > 0) || (unit.duration > room) ) {
                break;
            }
            out.push(specialCopy(next, tag));
            advanceSlot(slot);
            room -= next.duration + takeRest(slot, unit, (x) => out.push(specialCopy(x, tag)));
        }
        return out;
    };

    /*
     * One step of a Back to back day: Flex to the next row's start, or the next
     * row with something to air - its first item, then any more of its own that
     * finish by the next :00 or :30, padded and sharing the Flex as a regular
     * slot does. A kept row ahead never waits: a row that wouldn't finish before
     * it waits for after it instead.
     */
    let backStep = (d) => {
        // The row after a run that ended at its until time starts right there,
        // even when that time is not one of the day's marks.
        let atUntil = (typeof(d.untilEnd) === 'number') && (Math.abs(t - d.untilEnd) <= SLACK);
        d.untilEnd = null;
        let start = ( (t <= d.from + SLACK) || atUntil ) ? t : specialDays.nextMark(t, d.step);
        let pinAt = (nextPin < pins.length) ? pins[nextPin].at : Infinity;
        if (start >= d.to - SLACK) {
            pushFlex(Math.min(d.to, pinAt) - t);
            return;
        }
        if (pinAt < start) {
            pushFlex(pinAt - t);
            return;
        }
        if (start > t) {
            // Waiting for the next row's mark after something already laid (the
            // program on air, carried by a re-make): a long wait fills as any long
            // break of the day does.
            let gap = start - t;
            let fill = (gap > FILL_THRESHOLD) ? fillItemsFor(d, gap) : [];
            fill.forEach( (item) => {
                pushProgram(item);
                gap -= item.duration;
            } );
            pushFlex(gap);
            return;
        }
        occurrenceStart = t;
        let n = d.slotOf.length;
        let row = null;
        let first = null;
        for (let tries = 0; (tries < n) && (first === null); tries++) {
            row = d.slotOf[d.k % n];
            // A picked item airs once a day, though the list starts again.
            first = ( isItem(row) && d.itemsAired.has(row.specialRow) ) ? null : specialItem(row);
            if (first === null) {
                d.k++;
            }
        }
        if (first === null) {
            pushFlex(Math.min(d.to, pinAt) - t);
            return;
        }
        let unit = unitOf(row, first);
        // A row that runs until a time (row.untilAt) is the row written out again
        // and again: each go on its mark, while one finishes by that time. Then the
        // time left is a break and the next row starts at the until time. Once the
        // time has passed - the list started again from the top - it is one go.
        let until = ( (typeof(row.untilAt) === 'number') && (t < row.untilAt - SLACK) ) ? row.untilAt : null;
        if ( (until !== null) && (t + unit.duration > until + SLACK) ) {
            d.k++;
            d.untilEnd = until;
            let gap = Math.min(until, pinAt, d.to) - t;
            let fill = (gap > FILL_THRESHOLD) ? fillItemsFor(d, gap) : [];
            fill.forEach( (x) => {
                pushProgram(x);
                gap -= x.duration;
            } );
            pushFlex(gap);
            return;
        }
        if (t + unit.duration > pinAt + SLACK) {
            pushFlex(pinAt - t);
            return;
        }
        if (until === null) {
            d.k++;
        }
        advanceSpecial(row);
        if (isItem(row)) {
            d.itemsAired.add(row.specialRow);
        }
        if (t + unit.duration > d.to + SLACK) {
            pushProgram(first);
            takeRest(row, unit, pushProgram);
            return;
        }
        let end = Math.min(specialDays.nextMark(t + unit.duration, d.step), d.to, pinAt, (until !== null) ? until : Infinity);
        if ( (until !== null) && (end >= until - SLACK) ) {
            d.k++;
            d.untilEnd = until;
        }
        let remaining = end - t;
        let pads = [ makePadded(first) ];
        let split = takeRest(row, unit, (x) => pads.push(makePadded(x))) > 0;
        let total = squeeze(pads, remaining, split);
        while ( (typeof(row.item) !== 'object') || (row.item === null) ) {
            let more = specialItem(row);
            let moreUnit = unitOf(row, more);
            if ( (more === null) || (total + moreUnit.duration > remaining) ) {
                break;
            }
            pads.push(makePadded(more));
            advanceSpecial(row);
            split = (takeRest(row, moreUnit, (x) => pads.push(makePadded(x))) > 0) || split;
            total = squeeze(pads, remaining, split);
        }
        let leftover = Math.max(0, remaining - total);
        // "Long" is the break as it airs - everything after the row's own items, their
        // pads included - not what is left once the pads round them up: 76:28 padded
        // to 80:00 leaves 10:00, but 13:32 airs.
        let onAir = remaining - pads.reduce( (sum, p) => sum + p.item.duration, 0 );
        let fill = (onAir > FILL_THRESHOLD) ? fillItemsFor(d, leftover) : [];
        if (fill.length === 0) {
            layPads(pads, leftover);
            return;
        }
        // Filled: the row's own item(s) with only their usual small pad
        // (schedule.flexPreference never spreads the long part of this break
        // across them), then fill items back to back, then one plain break for
        // whatever is still left - the next row still starts right on its mark.
        layPads(pads, 0);
        fill.forEach( (item) => {
            pushProgram(item);
            leftover -= item.duration;
        } );
        pushFlex(Math.max(0, leftover));
    };

    // A take pin, pushed later than its own time, ending in a slot that began after it
    // would have ended: that slot was never given to it, so it runs late (rule 3).
    let pushedPast = (pin, at) => {
        if ( (pin.then !== 'take') || (typeof(pin.ownEnd) !== 'number') ) {
            return false;
        }
        let found = findSlot(localMsIntoPeriod(at));
        let occStart = (found === null) ? at : at - found.late;
        return (occStart > pin.start + SLACK) && (occStart >= pin.ownEnd - SLACK);
    };
    let nextPin = 0;
    let lastPin = null;
    let runningLate = false;
    // A row kept in time is a one-off slot of its position, at its instant - and
    // the rest of a split episode it starts follows it straight away.
    let keptSlot = null;
    let keptEpisode = (pin) => {
        let [ showId, order, excluded ] = JSON.parse(pin.key);
        if ( (typeof(showsById[showId]) === 'undefined') || ! positions.plays(order) ) {
            return null;
        }
        keptSlot = { time: -1, showId: showId, order: order, seasons: { excludeSeasons: excluded } };
        let position = positions.forSlot(keptSlot);
        let next = position.current();
        if ( (next === null) || (typeof(next) === 'undefined') || next.isOffline ) {
            return null;
        }
        position.next();
        return Object.assign( {}, next, { kept: JSON.parse(JSON.stringify(pin.program.kept)) } );
    };
    let placePin = () => {
        let pin = pins[nextPin++];
        let program = Object.assign( {}, pin.program );
        keptSlot = null;
        let fromPosition = false;
        if (pin.kept) {
            let episode = (typeof(pin.key) === 'string') ? keptEpisode(pin) : null;
            fromPosition = (episode !== null);
            program = fromPosition ? episode : program;
        } else {
            delete program.slotPosition;
            delete program.shuffleOrder;
        }
        let start = t;
        if (program.isOffline) {
            // its own entry, never merged, so the next run finds it again
            p.push(program);
            t += program.duration;
        } else {
            pushProgram(program);
            if (fromPosition) {
                takeRest(keptSlot, unitOf(keptSlot, program), pushProgram);
            }
        }
        // `ownEnd`: where it would end from its own time - take covers no slot past it (pushedPast).
        lastPin = { start: start, end: t, then: ( ! pin.kept && (pin.then === 'late') ) ? 'late' : 'take',
            kind: program.pin ? program.pin.kind : (keptKindOf(program) || undefined), ownEnd: pin.at + (t - start) };
        runningLate = false;
    };

    /*
     * The program on air, a split episode's half from its slot's position: the rest of
     * the episode stays in its slot. After its usual pad when it still fits by the slot's
     * end (as the slot would have laid it); otherwise straight after it, as a slot short
     * of room lays its halves. A Back to back row moves on once its program is on air, so
     * the rest is laid here either way.
     */
    function carryRest(c) {
        let program = c.program;
        let parsed = slotProgress.parseLabel(program.slotPosition);
        if ( (parsed === null) || (parsed.mode === 'repeat') || slotProgress.keptAsItIs(program) || program.pin ) {
            return;
        }
        let slot = null;
        let end = null;
        let back = false;
        if (typeof(program.specialDay) === 'string') {
            let d = laidDays.find( (x) => x.day.id === program.specialDay );
            slot = ( (typeof(d) !== 'undefined') && (typeof(program.specialRow) === 'number') ) ? (d.slotOf[program.specialRow] || null) : null;
            if (slot !== null) {
                back = (d.timed === null);
                let later = back ? [] : d.timed.filter( (x) => x.at > c.start + SLACK );
                end = back ? Math.min(specialDays.nextMark(c.start + unitOf(slot, program).duration, d.step), d.to)
                           : ( (later.length > 0) ? later[0].at : d.to );
            }
        } else {
            let found = findSlot(localMsIntoPeriod(c.start));
            if ( (found !== null) && (found.slot.showId === getShowData(program).showId) && positions.plays(found.slot.order) ) {
                slot = found.slot;
                end = c.start + found.remaining;
            }
        }
        if (slot === null) {
            return;
        }
        let unit = unitOf(slot, program);
        let pad = makePadded(program).pad;
        if ( (unit.rest.length === 0) || ( ! back && (t + pad + unit.duration - program.duration <= end) ) ) {
            return;
        }
        if (t + pad + unit.duration - program.duration <= end) {
            pushFlex(pad);
        }
        takeRest(slot, unit, pushProgram);
    }

    let carry = ( (carryChecked !== null) && (carryChecked.start >= t0) ) ? carryChecked : null;
    if (carry !== null) {
        // The program on air keeps its place: everything from its end is made anew.
        if (carry.start > t0) {
            pushFlex( carry.start - t0 );
        }
        pushProgram( Object.assign( {}, carry.program ) );
        carryRest(carry);
        // Its own slot gets only what fits whole after it (rule 2); slots it ran into
        // are filled as the generator always has, so what follows is what it was -
        // unless it is a pin, which keeps its own choice for them (rule 3).
        let carriedPin = carry.program.pin;
        let carriedKind = keptKindOf(carry.program);
        lastPin = ( (typeof(carriedPin) === 'object') && (carriedPin !== null) && (typeof(carriedPin.at) === 'number') )
            ? { start: carry.start, end: t, then: (carriedPin.then === 'late') ? 'late' : 'take', kind: carriedPin.kind,
                ownEnd: carriedPin.at + carry.program.duration }
            : ( (carriedKind !== null) && (carriedKind !== 'shifted') )
                ? { start: carry.start, end: t, then: 'take', kind: carriedKind, ownEnd: t }
                : { start: carry.start, end: t, then: 'carry' };
        // A pin the program on air is itself was carried, not placed again; nor a kept row.
        pins = pins.filter( (x) => ! ( x.program.pin && carry.program.pin && (x.program.pin.at === carry.program.pin.at) )
            && ! ( x.kept && ! x.program.isOffline && (Math.abs(x.at - carry.start) <= SLACK) ) );
    } else if (ts > t0) {
        pushFlex( ( (typeof(flexOnAir) !== 'undefined') ? flexOnAir.at : ts ) - t0 );
    }
    // A Back to back day on air carries on with the row after the program on air's -
    // or with that same row, when it runs until a time still to come (row.untilAt).
    if ( (carry !== null) && (typeof(carry.program.specialDay) === 'string') && (typeof(carry.program.specialRow) === 'number') ) {
        let d = laidDays.find( (x) => x.day.id === carry.program.specialDay );
        if (typeof(d) !== 'undefined') {
            let onAirRow = d.slotOf[carry.program.specialRow] || {};
            let goesOn = (typeof(onAirRow.untilAt) === 'number') && (t < onAirRow.untilAt - SLACK);
            d.k = carry.program.specialRow + (goesOn ? 0 : 1);
            if ( isItem(d.slotOf[carry.program.specialRow] || {}) ) {
                d.itemsAired.add(carry.program.specialRow);
            }
        }
    }
    while ( (t < hardLimit) && (p.length < LIMIT) ) {
        await throttle();
        // An airing of a special day still on past its end: the regular schedule
        // starts at the day's own next mark after it - the half hour or the quarter
        // hour, whichever the day rounds to - never right where the overrun ends, so
        // the break between holds the day's own leaving and entering steps (its
        // sign-off, then the regular context's sign-on). From there it runs late and
        // catches up, as after a run-late pin (rule 3) - unless the mark happens to
        // land on a regular slot boundary, where nothing needs to catch up and the
        // slot the overrun ran into is simply skipped, like any slot with no time left.
        if ( (lastSpecial !== null) && (t === lastSpecial.end) && ! lastSpecial.handled ) {
            lastSpecial.handled = true;
            let d = laidDays.find( (x) => x.day.id === lastSpecial.day );
            if ( (typeof(d) !== 'undefined') && (t > d.to + SLACK) ) {
                let mark = specialDays.nextMark(t, d.step);
                pushFlex(mark - t);
                lastPin = { start: lastSpecial.start, end: mark, then: 'late', kind: undefined, ownEnd: mark };
                runningLate = false;
            }
            continue;
        }
        //ensure t is padded - except while running late after a pin (rule 3)
        let m = t % schedule.pad;
        let afterLatePin = (lastPin !== null) && (t === lastPin.end) && ( (lastPin.then === 'late') || pushedPast(lastPin, t) );
        if ( ! runningLate && ! afterLatePin && (t % schedule.pad > constants.SLACK) && (schedule.pad - m > constants.SLACK) )  {
            let d = schedule.pad - m;
            if ( (nextPin < pins.length) && (pins[nextPin].at - t < d) ) {
                d = Math.max(0, pins[nextPin].at - t);
            }
            // nor past a special day's start
            d = Math.min(d, Math.max(0, nextDayFrom(t) - t));
            if (d > 0) {
                pushFlex( d );
                continue;
            }
        }
        // rule 1: a pin that is due
        if ( (nextPin < pins.length) && (pins[nextPin].at <= t + SLACK) ) {
            placePin();
            continue;
        }

        let inDay = dayAt(t);
        if ( (inDay !== null) && ! inDay.jumped ) {
            jump(inDay);
        }
        if ( (inDay !== null) && (inDay.timed === null) ) {
            backStep(inDay);
            continue;
        }
        let found = (inDay !== null) ? timedFound(inDay) : findSlot(localMsIntoPeriod(t));
        if (found == null) {
            throw Error("Unexpected. Unable to find slot for time of day " + t + " " + localMsIntoPeriod(t));
        }
        let slot = found.slot;
        let dayTime = found.dayTime;
        let remaining = found.remaining;
        let late = found.late;
        occurrenceStart = t - late;

        /*
         * remaining is the wall-clock distance to the next slot boundary, but t
         * advances in real time. Across a daylight savings change those differ
         * by an hour, and since a quiet slot is filled with one flex block of
         * exactly this length, an uncorrected value overshoots the next
         * boundary and skips that slot for the day.
         */
        if ( (remaining !== null) && ! found.special ) {
            let boundaryLocal = (dayTime + remaining) % schedule.period;
            let drift = localMsIntoPeriod(t + remaining) - boundaryLocal;
            if (drift > schedule.period / 2) {
                drift -= schedule.period;
            } else if (drift < -schedule.period / 2) {
                drift += schedule.period;
            }
            if (drift < 0) {
                /*
                 * The clock falls back before the boundary, so the wall-clock
                 * time just after the jump comes round a second time. When that
                 * time belongs to an earlier slot, stop at the jump and let the
                 * loop air that slot again - on the autumn day the 1:00 and 1:30
                 * slots each air twice, and every later slot keeps its clock
                 * time. When it lands back inside this same slot there is
                 * nothing to air again, so the slot runs on through the repeat
                 * as one block rather than being cut at the jump and re-entered
                 * an hour "late", which lateness would turn into flex.
                 */
                let jump = fallBackInstant(t, t + remaining);
                let repeated = findSlot(localMsIntoPeriod(jump));
                if ( (repeated != null) && (repeated.slot !== slot) ) {
                    remaining = jump - t;
                } else {
                    remaining = remaining - drift;
                }
            } else {
                let corrected = remaining - drift;
                // The loop only advances when it is handed a positive duration, so a
                // correction that cancels the interval entirely would stall it.
                remaining = (corrected > constants.SLACK) ? corrected : remaining;
            }
        }

        // A regular slot stops where a special day begins.
        if ( ! found.special && (t + remaining > nextDayFrom(t)) ) {
            remaining = nextDayFrom(t) - t;
        }

        let occStart = t - late;
        let occEnd = t + remaining;
        let pinInside = (nextPin < pins.length) && (pins[nextPin].at < occEnd);
        let ownSlot = (lastPin !== null) && (occStart <= lastPin.start + SLACK) && (lastPin.start < occEnd);
        // rule 3: a slot that began while the last pin was on
        if ( (lastPin !== null) && (lastPin.then !== 'carry') && (occStart > lastPin.start + SLACK) && (occStart < lastPin.end - SLACK) ) {
            if ( (occEnd <= lastPin.end + SLACK) || ( (lastPin.then === 'take') && (occStart < lastPin.ownEnd - SLACK) ) ) {
                pushFlex( pinInside ? Math.max(0, pins[nextPin].at - t) : remaining );
                continue;
            }
            runningLate = true;
        }
        if (runningLate && (late <= SLACK)) {
            runningLate = false;
        }
        if (pinInside) {
            remaining = Math.max(0, pins[nextPin].at - t);
        }
        if (runningLate && ! pinInside && ! ownSlot) {
            // rule 3, running late: one after another from where we are
            let next = getNextForSlot(slot, remaining);
            if ( (next === null) || next.isOffline || (late >= schedule.lateness + SLACK) ) {
                pushFlex(remaining);
                continue;
            }
            let first = true;
            while ( (next !== null) && ! next.isOffline && (first || (t + unitOf(slot, next).duration <= occEnd)) ) {
                let unit = unitOf(slot, next);
                let fits = (t + unit.duration <= occEnd);
                pushProgram(next);
                advanceSlot(slot);
                takeRest(slot, unit, pushProgram);
                first = false;
                if (! fits) {
                    break;
                }
                next = getNextForSlot(slot, occEnd - t);
            }
            if (t < occEnd) {
                pushFlex(occEnd - t);
            }
            continue;
        }

        let item = getNextForSlot(slot, remaining);
        if (item === null) {
            // A repeat whose source occurrence is used up: Flex for the rest.
            item = { isOffline: true, duration: remaining };
        }

        if (late >= schedule.lateness + constants.SLACK ) {
            //it's late.
            item = {
                isOffline : true,
                duration: remaining,
            }
        }

        if (item.isOffline) {
            //flex or redirect. We can just use the whole duration
            item.duration = remaining;
            pushProgram(item);
            continue;
        }
        let unit = unitOf(slot, item);
        if (ownSlot && ( (lastPin.kind === 'remove') || (unit.duration > remaining) )) {
            // rule 2: after a pin, only what fits whole - and after a removal nothing: its
            // slot stays Flex to the end, so the removed episode (and what follows it in
            // the slot) airs at its show's next slot, not straight after the Flex
            pushFlex(remaining);
            continue;
        }
        if (pinInside) {
            // rule 1: programs that start before the pin; the pin waits for the last to end -
            // but a kept row never waits: only what fits whole before it
            let pads = [];
            let total = 0;
            let split = false;
            let fits = (x) => ! pins[nextPin].kept || (total + x.duration <= remaining + SLACK);
            while ( (item !== null) && ! item.isOffline && (total < remaining - SLACK) && fits(unit) ) {
                pads.push(makePadded(item));
                advanceSlot(slot);
                split = (takeRest(slot, unit, (x) => pads.push(makePadded(x))) > 0) || split;
                total = squeeze(pads, remaining, split, true);
                item = getNextForSlot(slot, remaining);
                unit = unitOf(slot, item);
            }
            for (let k = 0; k < pads.length; k++) {
                pushProgram(pads[k].item);
                if (k < pads.length - 1) {
                    pushFlex(pads[k].pad);
                }
            }
            if (t < pins[nextPin].at) {
                pushFlex(pins[nextPin].at - t);
            }
            continue;
        }
        if (unit.duration > remaining) {
            // Slide - a split episode whole
            pushProgram(item);
            advanceSlot(slot);
            takeRest(slot, unit, pushProgram);
            continue;
        }

        let pads = [ makePadded(item) ];
        advanceSlot(slot);
        let split = takeRest(slot, unit, (x) => pads.push(makePadded(x))) > 0;
        let total = squeeze(pads, remaining, split);

        while(true) {
            let item2 = getNextForSlot(slot, remaining);
            let unit2 = unitOf(slot, item2);
            if ( (item2 === null) || (total + unit2.duration > remaining) ) {
                break;
            }
            pads.push(makePadded(item2));
            advanceSlot(slot);
            split = (takeRest(slot, unit2, (x) => pads.push(makePadded(x))) > 0) || split;
            total = squeeze(pads, remaining, split);
        }
        layPads(pads, Math.max(0, remaining - total));
    }
    while ( (t > hardLimit) || (p.length >= LIMIT) ) {
        t -= p.pop().duration;
    }
    let m = (t - t0) % schedule.period;
    if (m > 0) {
        //ensure the schedule is a multiple of period
        pushFlex( schedule.period - m);
    }


    return {
        programs: p,
        startTime: (new Date(t0)).toISOString(),
    }

}




