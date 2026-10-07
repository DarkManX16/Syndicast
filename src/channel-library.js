/*
 * What a channel's programs hold, grouped for the channel detail page's Library tab: movies,
 * shows (custom shows included), music, and the Flex and redirects that are neither. Pure, so
 * a test can drive it with a lineup; web/controllers/channel-detail.js is its one caller.
 */
const clipNames = require('./clip-names');

/*
 * One pass over the channel's whole programs array (up to 40,000 on a
 * real channel) into four browsable buckets. Grouping reuses
 * getShowData's showId - "tv."+showTitle for an episode's show,
 * "audio."+showTitle for a track's album - which is already how the
 * programming list and custom shows group programs, rather than a new
 * scheme. Movies have no such per-movie showId (every movie shares
 * "movie."), so they're deduplicated instead by getShowData's own
 * per-movie order number, the same key removeDuplicates already uses to
 * tell one movie from another.
 */
function buildLibrary(programs, getShowData) {
    let movies = new Map();
    let shows = new Map();
    let music = new Map();
    let flexCount = 0;
    let flexDurationMs = 0;
    let redirects = new Map();

    for (let i = 0; i < programs.length; i++) {
        let program = programs[i];
        if (program.isOffline === true) {
            if (program.type === 'redirect') {
                let key = program.channel;
                if (! redirects.has(key)) {
                    redirects.set(key, { channel: program.channel, count: 0, totalDurationMs: 0 });
                }
                let r = redirects.get(key);
                r.count++;
                r.totalDurationMs += program.duration;
            } else {
                flexCount++;
                flexDurationMs += program.duration;
            }
            continue;
        }

        let showData = getShowData(program);

        /*
         * A custom show can be built from movie- or track-typed segments
         * as freely as from episodes (addCustomShow in plex-library.js
         * copies whatever type the underlying item already had) - so this
         * has to be checked before the type-based routing below, not
         * folded into it, or a custom show built from movie-type clips
         * (e.g. a cartoon's a-side/b-side segments) lands in Movies
         * instead of appearing as its own show. getShowData already gives
         * custom shows their own showId ("custom."+id), distinct from a
         * same-named real show's "tv."+showTitle, so the two never merge
         * into one tile even when they happen to share a display name.
         */
        if (typeof(program.customShowId) !== 'undefined') {
            /*
             * A movie of the movie length the names picker uses (40 minutes or longer,
             * clipNames.isListableMovie) that sits inside a custom show is listed under
             * Movies as well, labelled with its custom show. The custom show's own tile
             * under Shows is unchanged: the movie is in both places.
             */
            if (clipNames.isListableMovie(program)) {
                let key = showData.showId + '|' + showData.order;
                if (! movies.has(key)) {
                    movies.set(key, {
                        title: program.title,
                        icon: program.icon,
                        durationMs: program.duration,
                        count: 0,
                        program: program,
                        inCustomShow: program.customShowName || 'a custom show',
                    });
                }
                movies.get(key).count++;
            }
            let groupKey = showData.showId;
            if (! shows.has(groupKey)) {
                shows.set(groupKey, {
                    title: showData.showDisplayName,
                    icon: (program.type === 'episode') ? (program.showIcon || program.icon) : program.icon,
                    isCustomShow: true,
                    items: new Map(),
                });
            }
            let group = shows.get(groupKey);
            let itemKey = showData.order;
            if (! group.items.has(itemKey)) {
                group.items.set(itemKey, { program: program, order: showData.order, count: 0 });
            }
            group.items.get(itemKey).count++;
        } else if (program.type === 'movie') {
            let key = showData.showId + '|' + showData.order;
            if (! movies.has(key)) {
                movies.set(key, {
                    title: program.title,
                    icon: program.icon,
                    durationMs: program.duration,
                    count: 0,
                    program: program,
                });
            }
            movies.get(key).count++;
        } else if ( (program.type === 'episode') || (program.type === 'track') ) {
            let target = (program.type === 'episode') ? shows : music;
            let groupKey = showData.showId;
            if (! target.has(groupKey)) {
                target.set(groupKey, {
                    title: showData.showDisplayName,
                    icon: (program.type === 'episode') ? (program.showIcon || program.icon) : program.icon,
                    items: new Map(),
                });
            }
            let group = target.get(groupKey);
            let itemKey = showData.order;
            if (! group.items.has(itemKey)) {
                group.items.set(itemKey, { program: program, order: showData.order, count: 0 });
            }
            group.items.get(itemKey).count++;
        }
    }

    let finishGroup = (group) => {
        let items = Array.from(group.items.values());
        items.sort((a, b) => a.order - b.order);
        let totalDurationMs = 0;
        for (let i = 0; i < items.length; i++) {
            totalDurationMs += items[i].program.duration;
        }
        return {
            title: group.title,
            icon: group.icon,
            isCustomShow: group.isCustomShow === true,
            itemCount: items.length,
            totalDurationMs: totalDurationMs,
            items: items,
        };
    };

    let byTitle = (a, b) => (a.title || '').localeCompare(b.title || '');

    let movieList = Array.from(movies.values()).sort(byTitle);
    let showList = Array.from(shows.values()).sort(byTitle).map(finishGroup);
    let musicList = Array.from(music.values()).sort(byTitle).map(finishGroup);
    let redirectList = Array.from(redirects.values()).sort((a, b) => a.channel - b.channel);

    return {
        movies: movieList,
        shows: showList,
        music: musicList,
        other: {
            flexCount: flexCount,
            flexDurationMs: flexDurationMs,
            redirects: redirectList,
        },
    };
}

module.exports = {
    buildLibrary: buildLibrary,
};
