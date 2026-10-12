/*
 * Swaps and inserts: an airing fixed to its date and time by a mark,
 * `program.pin`, on the airing itself in channel.programs - so there is no
 * separate list to keep in step with the lineup. The Time Slots generator
 * places pins (src/services/time-slots-service.js); this module is what the
 * editor needs around them. Pure, tested in Node, and bundled into the editor
 * as src/episode-start.js is. See NOTES.md, Known issues, "Swaps, inserts and
 * Flex that keeps time".
 */

function pad2(n) {
    return String(n).padStart(2, '0');
}

// "Hey Arnold! S03E23 Best Man / Cool Party"; a custom-show item by its place
// in the show; a movie or anything else by its title.
function label(program) {
    if (typeof(program.customShowId) !== 'undefined') {
        return `${program.customShowName} #${program.customOrder + 1} ${program.title}`;
    }
    if ( (program.type === 'episode') && (typeof(program.showTitle) === 'string') ) {
        return `${program.showTitle} S${pad2(program.season)}E${pad2(program.episode)} ${program.title}`;
    }
    return program.title;
}

// A pinned copy of `program`, carrying nothing of where it came from.
function makePin({ program, at, kind, then, was, slotShow, now }) {
    let copy = JSON.parse(JSON.stringify(program));
    delete copy.slotPosition;
    delete copy.shuffleOrder;
    delete copy.start;
    delete copy.stop;
    delete copy.$index;
    delete copy.pin;
    copy.pin = { at: at, kind: kind, then: then };
    if (typeof(was) === 'string') {
        copy.pin.was = was;
    }
    copy.pin.slotShow = slotShow;
    copy.pin.made = new Date(now).toISOString();
    return copy;
}

// "Remove this airing only": Flex the airing's length, kept by Create Lineup.
function removalPin({ airing, at, slotShow, now }) {
    return {
        isOffline: true,
        duration: airing.duration,
        pin: { at: at, kind: 'remove', then: 'take', was: label(airing), slotShow: slotShow, made: new Date(now).toISOString() },
    };
}

// The pins in a lineup still to air, as the generator takes them. Each airing
// is in the lineup once a cycle and its pin names its instant, so no walk is
// needed: `startTime` is accepted for symmetry with the other readers.
function pinsAhead({ programs, startTime, now }) {
    void startTime;
    return programs
        .filter( (p) => (typeof(p.pin) === 'object') && (p.pin !== null) && (typeof(p.pin.at) === 'number') && (p.pin.at + p.duration > now) )
        .map( (p) => ({ at: p.pin.at, then: (p.pin.then === 'late') ? 'late' : 'take', program: p }) )
        .sort( (a, b) => a.at - b.at );
}

module.exports = {
    label: label,
    makePin: makePin,
    removalPin: removalPin,
    pinsAhead: pinsAhead,
};
