/*
 * The series of a custom show for a picker: which custom shows join two or more (the server's
 * vocabulary.series, handed over with the screen's data), the series of one, and the seasons a
 * series has. The names review screen, its nickname panel and the Nicknames page all read series
 * this way, for the custom show a slot picks and for every member of an "any one of" name.
 *
 * A part is a slot or a panel: { key, kind, series, seriesSeasons, picked } (src/names-review.js).
 * `getCatalog` gives the current { "custom.<id>": [{ key, title, count, seasons }] } and may change
 * when the screen reloads. The lists handed back are kept (the catalog's own arrays and one array of
 * season choices per series), so ng-repeat sees the same objects every digest and settles.
 */
module.exports = function seriesSource(getCatalog) {
    const EMPTY = [];
    const seasonLists = new WeakMap();
    const catalog = () => getCatalog() || {};
    // A slot names its show `key`; the nickname panels, which are not slots, `showKey`.
    const keyOf = (part) => (part == null) ? null : ( (typeof(part.key) === 'string') ? part.key : part.showKey );

    // A custom show offers "which part" only when its episodes join two or more series.
    const hasSeries = (part) => (typeof(keyOf(part)) === 'string') && /^custom[.]/.test(keyOf(part))
        && Array.isArray(catalog()[keyOf(part)]) && (catalog()[keyOf(part)].length >= 2);
    const list = (part) => hasSeries(part) ? catalog()[keyOf(part)] : EMPTY;
    const ticked = (part) => Object.keys((part && part.series) || {}).filter( (title) => part.series[title] );

    // The seasons to choose from, when exactly one series is ticked and it has more than one.
    const seasonChoices = (part) => {
        const one = ticked(part);
        if ( ! hasSeries(part) || (one.length !== 1) ) {
            return EMPTY;
        }
        const series = list(part).find( (s) => s.title === one[0] );
        if ( (typeof(series) === 'undefined') || (series.seasons.length < 2) ) {
            return EMPTY;
        }
        if (! seasonLists.has(series) ) {
            seasonLists.set(series, series.seasons.map( (n) => ({ index: n, label: (n === 0) ? 'Specials' : 'Season ' + n }) ));
        }
        return seasonLists.get(series);
    };

    return { hasSeries: hasSeries, list: list, ticked: ticked, seasonChoices: seasonChoices };
};
