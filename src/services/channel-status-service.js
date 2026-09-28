/*
 * Read-only status for the channel detail page: what's airing on a channel
 * right now, and which filler lists it can draw from. Computed on the
 * server, from the server's own clock, so it can never disagree with
 * playback over what time it is.
 *
 * Deliberately never calls OnDemandService#activateChannelIfNeeded (the path
 * video.js and ProgrammingService use) - that function resumes a paused
 * on-demand channel and *saves* it, which this display-only page must never
 * trigger just by being viewed. A paused on-demand channel is reported as
 * paused, exactly as it sits on disk; helperFuncs.getCurrentProgramAndTimeElapsed
 * is otherwise the same pure function video.js calls to decide what to
 * actually stream, so "now playing" here is not a second, possibly-drifting
 * guess at it.
 *
 * During a break the specific filler clip is chosen live, per viewer, by
 * video.js/createLineup - it is never stored on the channel, so there is
 * nothing here to report it as. What *is* knowable ahead of a request is
 * which filler mix would supply that clip (the day-part or block in effect,
 * resolved the same way resolveCollections does for real) and how long until
 * the next real program, from the fixed, already-generated lineup.
 */
const helperFuncs = require('../helperFuncs');
const dayParts = require('../day-parts');

function isPausedOnDemand(channel) {
    return (typeof(channel.onDemand) !== 'undefined')
        && (channel.onDemand.isOnDemand === true)
        && (channel.onDemand.paused === true);
}

function describeProgram(program) {
    return {
        type: program.type,
        title: program.title,
        showTitle: program.showTitle,
        season: program.season,
        episode: program.episode,
        year: program.year,
        duration: program.duration,
        icon: program.icon,
        episodeIcon: program.episodeIcon,
    };
}

async function resolveMix(entries, fillerDB) {
    let mix = [];
    if (! Array.isArray(entries)) {
        return mix;
    }
    for (let i = 0; i < entries.length; i++) {
        let entry = entries[i];
        if ( (entry == null) || (typeof(entry.id) === 'undefined') || (entry.id === 'none') ) {
            continue;
        }
        let filler = await fillerDB.getFiller(entry.id);
        if (filler == null) {
            continue;
        }
        let content = Array.isArray(filler.content) ? filler.content : [];
        let totalDurationMs = 0;
        for (let j = 0; j < content.length; j++) {
            totalDurationMs += (content[j].duration || 0);
        }
        mix.push({
            id: entry.id,
            name: filler.name,
            weight: entry.weight,
            clipCount: content.length,
            totalDurationMs: totalDurationMs,
        });
    }
    return mix;
}

/*
 * `now` is injectable for tests; every real caller lets it default to the
 * server's own clock.
 */
async function getNowPlaying(channel, fillerDB, now) {
    now = (typeof(now) === 'number') ? now : Date.now();

    if (isPausedOnDemand(channel)) {
        return { state: 'paused' };
    }
    if (! Array.isArray(channel.programs) || (channel.programs.length === 0) ) {
        return { state: 'empty' };
    }

    let obj = helperFuncs.getCurrentProgramAndTimeElapsed(now, channel);
    let program = obj.program;

    if (program.isOffline === true && program.type === 'redirect') {
        return {
            state: 'redirect',
            targetChannel: program.channel,
            elapsedMs: obj.timeElapsed,
            durationMs: program.duration,
        };
    }

    if (program.isOffline === true) {
        let next = dayParts.findNextProgram(channel, now, obj);
        let context = dayParts.resolveBreakContext(channel, now, next !== null ? next.startTime : null);
        let mixEntries = ( (context !== null) && Array.isArray(context.fillerCollections) )
            ? context.fillerCollections
            : channel.fillerCollections;
        let mix = await resolveMix(mixEntries, fillerDB);
        return {
            state: 'break',
            elapsedMs: obj.timeElapsed,
            durationMs: program.duration,
            contextName: context !== null ? context.name : null,
            contextKind: context === null ? 'channel' : (Array.isArray(context.airings) ? 'block' : 'day-part'),
            mix: mix,
            nextProgram: next !== null ? describeProgram(next.program) : null,
            msUntilNextProgram: next !== null ? Math.max(0, next.startTime - now) : null,
        };
    }

    return {
        state: 'program',
        program: describeProgram(program),
        elapsedMs: obj.timeElapsed,
        durationMs: program.duration,
    };
}

/*
 * Every filler list this channel can reach, grouped by where it's used -
 * channel-wide plus each day-part's and block's own mix - rather than
 * deduplicated the way allFillerCollections is for loading content, since the
 * point here is showing *which* context uses *which* list.
 */
async function getFillerLists(channel, fillerDB) {
    let channelWide = await resolveMix(channel.fillerCollections, fillerDB);

    let dayPartLists = [];
    if (Array.isArray(channel.dayParts)) {
        for (let i = 0; i < channel.dayParts.length; i++) {
            let dayPart = channel.dayParts[i];
            dayPartLists.push({
                name: dayPart.name,
                mix: await resolveMix(dayPart.fillerCollections, fillerDB),
            });
        }
    }

    let blockLists = [];
    if (Array.isArray(channel.blocks)) {
        for (let i = 0; i < channel.blocks.length; i++) {
            let block = channel.blocks[i];
            blockLists.push({
                name: block.name,
                mix: await resolveMix(block.fillerCollections, fillerDB),
            });
        }
    }

    return {
        channelWide: channelWide,
        dayParts: dayPartLists,
        blocks: blockLists,
    };
}

module.exports = {
    getNowPlaying: getNowPlaying,
    getFillerLists: getFillerLists,
};
