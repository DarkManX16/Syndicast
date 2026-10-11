//Season settings a slot puts on its show. Which slots share an episode
//position comes from src/slot-progress.js, the same module the generators key
//positions with, so the editor and the generator cannot disagree about it.
const slotProgress = require('../../src/slot-progress');

module.exports = function () {

    //Returned for a slot that has no settings yet. It is shared and never
    //written to, so asking about a slot cannot bring a constraint into
    //existence - see read().
    const NONE = { excludeSeasons: [] };

    /*
     * Which slots share an episode position: same show, same answer here. Only
     * the excluded seasons count - startSeason is a one-time move of the
     * position's place, not a different position - and a constraint that
     * excludes nothing keys the same as no constraint at all.
     */
    function keyOf(constraint) {
        let excluded = slotProgress.excludedOf(constraint);
        return (excluded.length === 0) ? "" : JSON.stringify(excluded);
    }

    //Whether a slot's settings ask for anything at all - seasons left out, or
    //a season to start from. Distinct from keyOf: a slot that only seeks shares
    //its position, but its seek still has to be kept.
    function asksNothing(constraint) {
        if ( (typeof(constraint) !== 'object') || (constraint === null) ) {
            return true;
        }
        return (slotProgress.excludedOf(constraint).length === 0)
            && (typeof(constraint.startSeason) !== 'number');
    }

    /*
     * Read a slot's settings without creating them. The template asks this on
     * every digest, so it must not write: a read that created the entry it was
     * asked about is what filled schedules with an empty constraint for every
     * show that merely had a button drawn next to it.
     */
    function read(slot) {
        if ( (typeof(slot.seasons) === 'object') && (slot.seasons !== null)
             && Array.isArray(slot.seasons.excludeSeasons) ) {
            return slot.seasons;
        }
        return NONE;
    }

    //The writable counterpart, called only from a click handler.
    function edit(slot) {
        if ( (typeof(slot.seasons) !== 'object') || (slot.seasons === null) ) {
            slot.seasons = { excludeSeasons: [] };
        }
        if (! Array.isArray(slot.seasons.excludeSeasons) ) {
            slot.seasons.excludeSeasons = [];
        }
        return slot.seasons;
    }

    //A slot that asks for nothing carries no settings at all, so an untouched
    //schedule stays as small as it was.
    function tidy(slot) {
        if (asksNothing(slot.seasons)) {
            delete slot.seasons;
        }
    }

    function isConstrained(slot) {
        return ! asksNothing(read(slot));
    }

    function sameRange(a, b) {
        return keyOf( read(a) ) === keyOf( read(b) );
    }

    //Give a slot the same seasons as another one. Copied rather than shared:
    //they are separate slots and editing one later must not move the other.
    function copyRange(fromSlot, toSlot) {
        if (fromSlot === toSlot) {
            return;
        }
        if (! isConstrained(fromSlot) ) {
            delete toSlot.seasons;
            return;
        }
        toSlot.seasons = JSON.parse( JSON.stringify( read(fromSlot) ) );
    }

    //How many slots in this schedule share the slot's episode position.
    function sharingPosition(slots, slot) {
        let key = keyOf( read(slot) );
        let n = 0;
        for (let i = 0; i < slots.length; i++) {
            if ( (slots[i].showId === slot.showId)
                 && (slots[i].order === slot.order)
                 && (keyOf( read(slots[i]) ) === key) ) {
                n++;
            }
        }
        return n;
    }

    /*
     * Settings used to be stored once per show, in schedule.showConstraints,
     * where every slot naming that show shared them. Fold those onto the slots
     * as the schedule is opened so the editor shows what the generator will
     * actually do. Entries that constrain nothing are dropped rather than
     * copied onto 40-odd slots.
     *
     * The map is left in place: the services still read it for a slot with no
     * settings of its own, so a channel whose lineup predates this keeps
     * generating the same way until it is saved again.
     */
    function adoptShowConstraints(schedule) {
        let old = schedule.showConstraints;
        if ( (typeof(old) !== 'object') || (old === null) ) {
            return;
        }
        for (let i = 0; i < schedule.slots.length; i++) {
            let slot = schedule.slots[i];
            if (typeof(slot.seasons) !== 'undefined') {
                continue;
            }
            let c = old[ slot.showId ];
            if (! asksNothing(c)) {
                slot.seasons = JSON.parse( JSON.stringify(c) );
            }
        }
        delete schedule.showConstraints;
    }

    /*
     * startSeason is a one-off seek. The lineup it produced is now the resume
     * point, so clearing it after a generation keeps earlier seasons reachable
     * instead of pinning every future run to the same season.
     */
    function clearStartSeasons(schedule) {
        if (! Array.isArray(schedule.slots) ) {
            return;
        }
        for (let i = 0; i < schedule.slots.length; i++) {
            let slot = schedule.slots[i];
            if ( (typeof(slot.seasons) === 'object') && (slot.seasons !== null) ) {
                delete slot.seasons.startSeason;
                tidy(slot);
            }
        }
    }

    return {
        keyOf: keyOf,
        read: read,
        edit: edit,
        tidy: tidy,
        isConstrained: isConstrained,
        sameRange: sameRange,
        copyRange: copyRange,
        sharingPosition: sharingPosition,
        adoptShowConstraints: adoptShowConstraints,
        clearStartSeasons: clearStartSeasons,
    }

}
