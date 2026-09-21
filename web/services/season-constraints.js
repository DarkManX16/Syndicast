//Season settings a slot puts on its show. The server counterpart lives in
//src/services/show-orderers.js - keyOf below must agree with constraintKey
//there, or the editor will report slots as sharing an episode position when the
//generator gives them separate ones.
module.exports = function () {

    //Returned for a slot that has no settings yet. It is shared and never
    //written to, so asking about a slot cannot bring a constraint into
    //existence - see read().
    const NONE = { excludeSeasons: [] };

    /*
     * Which slots share an episode position: same show, same answer here.
     * startSeason is included because two slots seeking different places are
     * asking for different positions, and a constraint that asks for nothing
     * keys the same as no constraint at all.
     */
    function keyOf(constraint) {
        if ( (typeof(constraint) !== 'object') || (constraint === null) ) {
            return "";
        }
        let excluded = Array.isArray(constraint.excludeSeasons)
            ? constraint.excludeSeasons.slice().sort( (a,b) => a - b )
            : [];
        let start = (typeof(constraint.startSeason) === 'number')
            ? constraint.startSeason
            : null;
        if ( (excluded.length === 0) && (start === null) ) {
            return "";
        }
        return JSON.stringify( [ excluded, start ] );
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
        if (keyOf(slot.seasons) === "") {
            delete slot.seasons;
        }
    }

    function isConstrained(slot) {
        return keyOf(read(slot)) !== "";
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
            if ( (typeof(c) === 'object') && (c !== null) && (keyOf(c) !== "") ) {
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
        sharingPosition: sharingPosition,
        adoptShowConstraints: adoptShowConstraints,
        clearStartSeasons: clearStartSeasons,
    }

}
