const SLACK = require('./constants').SLACK;

let cache = {};

/*
 * Where a stream was when a save flushed the playback cache out from under it.
 *
 * Saving a channel stops whatever is playing it (the channel-update listener in
 * video.js) and flushes `cache` below, so the client's reconnect cannot take
 * getCurrentLineupItem's "let's not lose seconds for no reason" branch and has
 * to work its position out from the wall clock instead. That recompute is right
 * about *what* to play - it is the whole point of flushing - but it does not
 * know a stream was already in flight, so it re-applies createLineup's 30
 * second tune-in rewind against a later instant and skips the reconnect gap the
 * intact cache would have replayed. Measured on the dev channels: every save
 * jumped forward by exactly the reconnect gap, and ~31 seconds when the stream
 * had been sitting inside that rewind.
 *
 * So the flush keeps throwing away the item and its channel contexts, and this
 * keeps only the position, for the recompute to anchor to when it lands on the
 * same program anyway. Read once and dropped - see takeResumeHint.
 */
let resumeHints = {};

let configCache = {};
let numbers = null;

async function getChannelConfig(channelDB, channelId) {
    //with lazy-loading
     
    if ( typeof(configCache[channelId]) === 'undefined') {
        let channel = await channelDB.getChannel(channelId)
        if (channel == null) {
            configCache[channelId]  = [];
        } else {
            configCache[channelId] = [channel];
        }
    }
    return configCache[channelId];
}

async function getAllNumbers(channelDB) {
    if (numbers === null) {
        let n = await channelDB.getAllChannelNumbers();
        numbers = n;
    }
    return numbers;
}

async function getAllChannels(channelDB) {
    let channelNumbers = await getAllNumbers(channelDB);
    return (await Promise.all( channelNumbers.map( async (x) => {
        return (await getChannelConfig(channelDB, x))[0];
    }) )).filter( (channel) => {
        if (channel == null) {
            console.error("Found a null channel " + JSON.stringify(channelNumbers) );
            return false;
        }
        if ( typeof(channel) === "undefined") {
            console.error("Found a undefined channel " + JSON.stringify(channelNumbers) );
            return false;
        }
        if ( typeof(channel.number) === "undefined") {
            console.error("Found a channel without number " + JSON.stringify(channelNumbers) );
            return false;
        }

        return true;
    } );
}


function saveChannelConfig(number, channel ) {
    configCache[number] = [channel];
    
    // flush the item played cache for the channel and any channel in its
    // redirect chain, keeping each one's position as a resume hint
    if (typeof(cache[number]) !== 'undefined') {
        let lineupItem = cache[number].lineupItem;
        for (let i = 0; i < lineupItem.redirectChannels.length; i++) {
            let n = lineupItem.redirectChannels[i].number;
            keepResumeHint(n, cache[n]);
            delete cache[n];
        }
        keepResumeHint(number, cache[number]);
        delete cache[number];

    }
    numbers = null;
}

/*
 * Only a real program is worth a hint. Filler is deliberately re-picked on every
 * recompute - the mix is exactly the kind of thing the save may have changed -
 * and an offline or error item has no position to preserve.
 */
function keepResumeHint(channelId, recorded) {
    if ( (typeof(recorded) === 'undefined') || (recorded == null) ) {
        return;
    }
    if (recorded.lineupItem.type !== 'program') {
        delete resumeHints[channelId];
        return;
    }
    resumeHints[channelId] = {
        t0: recorded.t0,
        start: recorded.lineupItem.start,
        duration: recorded.lineupItem.duration,
        streamDuration: recorded.lineupItem.streamDuration,
        identity: getProgramKey(recorded.lineupItem),
    };
}

/*
 * Where a reconnect at t1 should resume this channel, or null if there was no
 * in-flight stream or `program` is not what it was playing.
 *
 * The answer is the one getCurrentLineupItem would have given had the save not
 * flushed the cache, down to its "let's not lose seconds for no reason" branch -
 * the guarantee being that a save costs the viewer no more than an ordinary
 * quick reconnect does. The branch replays the gap rather than skipping it, and
 * the same reasoning applies here: the item did not change, so there is nothing
 * to be gained by dropping the seconds the stopped stream did not finish
 * sending.
 *
 * Consumed on read, so a hint answers at most the one reconnect the save caused.
 * That plus the identity check plus the ended-by-now check below are what keep a
 * hint nobody collected from meaning anything later: a hint only exists if a
 * stream was recorded playing, and by the time anything else could pick it up
 * the program has either changed (identity) or run out (rem).
 */
function takeResumeHint(channelId, t1, program) {
    let hint = resumeHints[channelId];
    if (typeof(hint) === 'undefined') {
        return null;
    }
    delete resumeHints[channelId];
    // an item getProgramKey cannot tell apart must never match one
    if (hint.identity === UNKNOWN_PROGRAM_KEY) {
        return null;
    }
    if ( (program == null) || (hint.identity !== getProgramKey(program)) ) {
        return null;
    }
    let diff = t1 - hint.t0;
    if (diff < 0) {
        return null;
    }
    // the item would have ended on its own by now, so there is nothing to resume
    let rem = hint.duration - hint.start;
    if (typeof(hint.streamDuration) !== 'undefined') {
        rem = Math.min(rem, hint.streamDuration);
    }
    if (diff + SLACK >= rem) {
        return null;
    }
    if (diff <= SLACK) {
        return hint.start;
    }
    return hint.start + diff;
}

function getCurrentLineupItem(channelId, t1) {
    if (typeof(cache[channelId]) === 'undefined') {
        return null;
    }
    let recorded = cache[channelId];
    let lineupItem =  JSON.parse( JSON.stringify(recorded.lineupItem) );
    let diff = t1 - recorded.t0;
    let rem = lineupItem.duration - lineupItem.start;
    if (typeof(lineupItem.streamDuration) !== 'undefined') {
        rem = Math.min(rem, lineupItem.streamDuration);
    }
    if ( (diff <= SLACK) && (diff + SLACK < rem) ) {
        //closed the stream and opened it again let's not lose seconds for
        //no reason
        let originalT0 = recorded.lineupItem.originalT0;
        if (typeof(originalT0) === 'undefined') {
            originalT0 = recorded.t0;
        }
        if (t1 - originalT0 <= SLACK) {
            lineupItem.originalT0 = originalT0;
            return lineupItem;
        }
    }
   
    lineupItem.start += diff;
    if (typeof(lineupItem.streamDuration)!=='undefined') {
        lineupItem.streamDuration -= diff;
        if (lineupItem.streamDuration < SLACK) { //let's not waste time playing some loose seconds
            return null;
        }
    }
    if(lineupItem.start + SLACK > lineupItem.duration) {
        return null;
    }
    return lineupItem;
}

// What getProgramKey returns for an item carrying neither a serverKey nor a key.
const UNKNOWN_PROGRAM_KEY = "!unknown!|!unknownProgram!";

function getProgramKey(program) {
    let serverKey = "!unknown!";
    if (typeof(program.serverKey) !== 'undefined') {
        if (typeof(program.serverKey) !== 'undefined') {
            serverKey = "plex|" + program.serverKey;
        }
    }
    let programKey = "!unknownProgram!";
    if (typeof(program.key) !== 'undefined') {
        programKey = program.key;
    }
    return serverKey + "|" + programKey;
}


/*
 * Per-list last-play times are kept in the same store as per-clip ones, under a
 * key that cannot collide with a real program: getProgramKey always opens with
 * "!unknown!" or "plex", never this.
 *
 * They used to live in a plain object in this module, so a list cooldown was
 * forgotten on every restart - CN Groovies' 3000 second cooldown never survived
 * one. Day-parts lean on list cooldowns, so that had to stop being true. Reusing
 * the program store gets the on-disk layout and the load-at-boot for free, and
 * leaves one source of truth rather than two.
 */
function getFillerPlayTimeKey(fillerId) {
    return "!fillerList!|" + fillerId;
}



function recordProgramPlayTime(programPlayTime, channelId, lineupItem, t0) {
    let remaining;
    if ( typeof(lineupItem.streamDuration) !== 'undefined') {
        remaining = lineupItem.streamDuration;
    } else {
        remaining = lineupItem.duration - lineupItem.start;
    }
    setProgramLastPlayTime(programPlayTime, channelId, lineupItem, t0 + remaining);
    if (typeof(lineupItem.fillerId) !== 'undefined') {
        programPlayTime.update(
            channelId,
            getFillerPlayTimeKey(lineupItem.fillerId),
            t0 + remaining
        );
    }
}

function setProgramLastPlayTime(programPlayTime, channelId, lineupItem, t) {
    let programKey = getProgramKey(lineupItem);
    programPlayTime.update(channelId, programKey, t);
}

function getProgramLastPlayTime(programPlayTime, channelId, program) {
    let programKey = getProgramKey(program);
    return programPlayTime.getProgramLastPlayTime(channelId, programKey);
}

function getFillerLastPlayTime(programPlayTime, channelId, fillerId) {
    return programPlayTime.getProgramLastPlayTime(
        channelId,
        getFillerPlayTimeKey(fillerId)
    );
}

function recordPlayback(programPlayTime, channelId, t0, lineupItem) {
    recordProgramPlayTime(programPlayTime, channelId, lineupItem, t0);
    
    cache[channelId] = {
        t0: t0,
        lineupItem: lineupItem,
    }
}

function clearPlayback(channelId) {
    delete cache[channelId];
}

function clear() {
    //it's not necessary to clear the playback cache and it may be undesirable
    configCache = {};
    cache = {};
    resumeHints = {};
    numbers = null;
}

module.exports = {
    getCurrentLineupItem: getCurrentLineupItem,
    takeResumeHint: takeResumeHint,
    recordPlayback: recordPlayback,
    clear: clear,
    getProgramLastPlayTime: getProgramLastPlayTime,
    getAllChannels: getAllChannels,
    getAllNumbers: getAllNumbers,
    getChannelConfig: getChannelConfig,
    saveChannelConfig: saveChannelConfig,
    getFillerLastPlayTime: getFillerLastPlayTime,
    clearPlayback: clearPlayback,
}
