/*
 * The seasons of a show, for the names review screen's picker: what to offer when a
 * clip is for one season, one special, and what to suggest as a season's nickname.
 * See docs/blocks-spec.md, Stage 5, "Which shows a clip names".
 *
 * Plex is asked for what it has - each season's title and the folder its files sit in,
 * which is where "The FRIEZA Saga" lives when Plex itself calls the season "Season 3" -
 * and the lineups' own seasons are the fallback when Plex cannot be reached or the show
 * has no episode to ask about. Nothing here writes anything. The Plex client is passed
 * in (anything with `Get(path)` that answers with the MediaContainer), so the module is
 * driven from a test with a fake one.
 */
const showMatch = require('./show-match');

// How many of a show's seasons are asked about at once.
const AT_ONCE = 4;
// The most specials listed for a show.
const MAX_SPECIALS = 60;

const GENERIC_SEASON_TITLE = /^(season|series|s)\s*\d+$/i;

/*
 * A nickname worth suggesting from the folder a season's files sit in: "03. The FRIEZA
 * Saga (Eps. 075-107)" is "FRIEZA Saga". The leading number, any bracketed part and a
 * leading "The" go; a folder that says nothing more than Plex's own title ("Season 3",
 * "Specials") or the show's own name suggests nothing. Returns { text, alias } or null:
 * `text` as the folder spells it, `alias` as it would be stored.
 */
function seasonHint(folderName, showTitle) {
    if ( (typeof(folderName) !== 'string') || (folderName.trim() === '') ) {
        return null;
    }
    let text = folderName.replace(/^\s*\d+\s*[.\-)_]\s*/, '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
    text = text.replace(/^(the|a|an)\s+/i, '').trim();
    const alias = showMatch.fold(text);
    if ( (alias === '') || GENERIC_SEASON_TITLE.test(text) || /^specials?$/i.test(text) || (alias === showMatch.fold(showTitle)) ) {
        return null;
    }
    return { text: text, alias: alias };
}

function seasonLabel(index, title) {
    if (index === 0) {
        return 'Specials';
    }
    return ( (typeof(title) === 'string') && (title !== '') && ! GENERIC_SEASON_TITLE.test(title.trim()) )
        ? `Season ${index} · ${title}` : `Season ${index}`;
}

/*
 * What the lineups know of a show's seasons, from the vocabulary built over the
 * channels: the seasons its episodes are in, and its season 0 episodes as specials.
 */
function lineupSeasons(vocabulary, showKey) {
    const indexes = (vocabulary.seasons && vocabulary.seasons[showKey]) || [];
    const specials = (vocabulary.specials && vocabulary.specials.get(showKey)) || [];
    return {
        show: showKey,
        name: vocabulary.names[showKey],
        source: 'lineup',
        seasons: indexes.map( (index) => ({ index: index, title: null, label: seasonLabel(index, null), folder: null, hint: null }) ),
        specials: specials.map( (sp) => ({ title: sp.title }) ),
    };
}

// Whatever `work` does, a slow Plex does not hold the screen up for more than `ms`.
function within(ms, work) {
    let timer;
    const late = new Promise( (resolve, reject) => { timer = setTimeout( () => reject(new Error('Plex did not answer in time')), ms ); } );
    return Promise.race( [ work, late ] ).finally( () => clearTimeout(timer) );
}

const lastFolder = (file) => {
    const parts = String(file == null ? '' : file).split(/[\\/]+/).filter( (p) => p !== '' );
    return (parts.length >= 2) ? parts[parts.length - 2] : null;
};

/*
 * Plex's seasons of the show an episode belongs to: each season's title, the folder of
 * its first episode and the nickname that folder suggests, and the titles of the show's
 * specials (season 0). `episodeKey` is the rating key of any episode of the show.
 * Throws when Plex cannot be asked; the caller falls back to the lineups' seasons.
 */
async function plexSeasons(plex, episodeKey, showKey, showName, options) {
    const timeout = (options && options.timeoutMs) || 8000;
    const get = (path) => within(timeout, plex.Get(path));
    const episode = await get(`/library/metadata/${encodeURIComponent(episodeKey)}`);
    const parent = episode && episode.Metadata && episode.Metadata[0] && episode.Metadata[0].grandparentRatingKey;
    if (parent == null) {
        throw new Error('Plex does not say which show that episode belongs to');
    }
    const children = await get(`/library/metadata/${encodeURIComponent(parent)}/children`);
    const listed = ( (children && children.Metadata) || [] ).filter( (s) => Number.isInteger(s.index) );
    const seasons = new Array(listed.length);
    let specials = [];
    for (let start = 0; start < listed.length; start += AT_ONCE) {
        await Promise.all(listed.slice(start, start + AT_ONCE).map( async (season, offset) => {
            const slot = start + offset;
            let folder = null;
            const entry = { index: season.index, title: season.title || null, label: null, folder: null, hint: null };
            try {
                if (season.index === 0) {
                    const all = await get(`/library/metadata/${encodeURIComponent(season.ratingKey)}/children`);
                    const episodes = (all && all.Metadata) || [];
                    specials = episodes.map( (e) => ({ title: e.title }) ).filter( (e) => typeof(e.title) === 'string' && e.title !== '' )
                        .slice(0, MAX_SPECIALS);
                } else {
                    const first = await get(`/library/metadata/${encodeURIComponent(season.ratingKey)}/children?X-Plex-Container-Start=0&X-Plex-Container-Size=1`);
                    const file = first && first.Metadata && first.Metadata[0] && first.Metadata[0].Media
                        && first.Metadata[0].Media[0] && first.Metadata[0].Media[0].Part && first.Metadata[0].Media[0].Part[0]
                        && first.Metadata[0].Media[0].Part[0].file;
                    folder = lastFolder(file);
                }
            } catch (err) {
                // One season that Plex will not describe is listed with what is known of it.
                folder = null;
            }
            entry.label = seasonLabel(season.index, season.title);
            entry.folder = folder;
            entry.hint = seasonHint(folder, showName);
            seasons[slot] = entry;
        } ));
    }
    seasons.sort( (a, b) => a.index - b.index );
    return { show: showKey, name: showName, source: 'plex', seasons: seasons, specials: specials };
}

module.exports = {
    seasonHint: seasonHint,
    seasonLabel: seasonLabel,
    lineupSeasons: lineupSeasons,
    plexSeasons: plexSeasons,
};
