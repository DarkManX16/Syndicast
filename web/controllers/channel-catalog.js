/*
 * A channel's Catalog page: the one-time review that lets each show draw on
 * its full catalog, the holiday episodes Ron places himself, and the episodes
 * never to air - each restorable. The rules are src/show-catalog.js; what
 * this page saves goes straight to the catalog API, one op per click. See
 * NOTES.md, Known issues, "Full catalogs, and a never-air list".
 */
const showCatalog = require('../../src/show-catalog');

module.exports = function ($scope, $routeParams, $timeout, dizquetv, getShowData, commonProgramTools, catalogReader) {
    let channelNumber = parseInt($routeParams.number, 10);
    $scope.channelNumber = channelNumber;
    $scope.loading = true;
    $scope.loadError = null;
    $scope.channel = null;
    $scope.limit = { minutes: showCatalog.DEFAULT_LIMIT_MS / 60000 };
    $scope.holidayNames = showCatalog.HOLIDAYS.map( (h) => h.name ).concat(['Other']);
    $scope.rows = [];
    $scope.unread = [];
    $scope.holidays = [];
    $scope.never = [];
    $scope.saving = null;

    let lineupPool = [];
    let catalogs = {};
    let state = showCatalog.emptyState();
    let names = new Map();

    let label = (p) => ( (typeof(p.season) === 'number') ? 'S' + String(p.season).padStart(2, '0') + 'E' + String(p.episode).padStart(2, '0') + ' ' : '' ) + p.title;
    $scope.clock = (ms) => {
        let s = Math.round( (ms || 0) / 1000 );
        let h = Math.floor(s / 3600), m = Math.floor( (s % 3600) / 60 ), sec = s % 60;
        return (h > 0 ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0');
    };
    $scope.nameOf = (showId) => names.get(showId) || showId.replace(/^(tv|custom)\./, '');

    // Start each episode ticked, or unticked with its reason and why.
    let applyPreUntick = (e) => {
        let u = showCatalog.preUntick(e.program, $scope.limit.minutes * 60000);
        e.ticked = (u === null);
        e.why = (u === null) ? '' : u.why;
        e.reason = (u === null) ? 'never' : u.reason;
        e.holiday = (u !== null && u.holiday) ? u.holiday : (showCatalog.holidayOf(e.program.title) || 'Christmas');
    };
    let buildRows = () => {
        $scope.rows = showCatalog.reviewList({ lineupPool, catalogs, state, getShowData }).map( (r) => {
            r.open = false;
            r.seasons.forEach( (s) => {
                s.items = s.episodes.map( (p) => {
                    let e = { program: p, label: label(p), touched: false };
                    applyPreUntick(e);
                    return e;
                } );
            } );
            return r;
        } );
        $scope.holidays = showCatalog.byHoliday(state);
        let never = new Map();
        Object.keys(state.neverAir).forEach( (key) => {
            let e = state.neverAir[key];
            if (e.reason === 'holiday') return;
            if (! never.has(e.showId)) never.set(e.showId, []);
            never.get(e.showId).push(Object.assign({ key }, e));
        } );
        $scope.never = [ ...never.keys() ].sort().map( (showId) => ({ showId, entries: never.get(showId).sort( (a, b) => (a.season - b.season) || (a.episode - b.episode) ) }) );
    };

    $scope.limitChanged = () => {
        if (! (Number($scope.limit.minutes) > 0)) return;
        $scope.rows.forEach( (r) => r.seasons.forEach( (s) => s.items.forEach( (e) => { if (! e.touched) applyPreUntick(e); } ) ) );
    };
    $scope.counts = (r) => {
        let all = 0, ticked = 0;
        r.seasons.forEach( (s) => s.items.forEach( (e) => { all++; if (e.ticked) ticked++; } ) );
        return { all, ticked, out: all - ticked };
    };
    $scope.seasonTicked = (s) => s.items.every( (e) => e.ticked );
    $scope.toggleSeason = (s) => {
        let to = ! $scope.seasonTicked(s);
        s.items.forEach( (e) => { e.ticked = to; e.touched = true; } );
    };
    $scope.touch = (e) => { e.touched = true; };
    $scope.setAll = (r, to) => r.seasons.forEach( (s) => s.items.forEach( (e) => { e.ticked = to; e.touched = true; } ) );

    let post = async (ops, what) => {
        $scope.saving = what;
        try {
            state = await dizquetv.applyChannelCatalogOps(channelNumber, ops);
            buildRows();
        } catch (err) {
            console.error(err);
            $scope.saveError = 'Could not save: ' + ( (err && err.data) || err );
        } finally {
            $scope.saving = null;
            $timeout();
        }
    };
    $scope.saveReview = async (r) => {
        let now = Date.now();
        let leftOut = [];
        r.seasons.forEach( (s) => s.items.forEach( (e) => {
            if (! e.ticked) {
                leftOut.push( showCatalog.neverAirEntry(e.program, getShowData, 'review', e.reason, (e.reason === 'holiday') ? e.holiday : undefined, now) );
            }
        } ) );
        await post([ { review: { showId: r.showId, by: 'review', specials: r.specials, source: r.source, known: r.known, neverAir: leftOut } } ], r.showId);
    };
    $scope.restore = async (key) => post([ { restore: [ key ] } ], key);
    $scope.switchReason = async (entry, reason) => post([ { reason: { key: entry.key, reason, holiday: (reason === 'holiday') ? (entry.holiday || 'Christmas') : undefined } } ], entry.key);
    $scope.changeHoliday = async (entry) => post([ { reason: { key: entry.key, reason: 'holiday', holiday: entry.holiday } } ], entry.key);

    let load = async () => {
        try {
            $scope.channel = await dizquetv.getChannel(channelNumber);
            state = await dizquetv.getChannelCatalog(channelNumber);
            lineupPool = commonProgramTools.removeDuplicates($scope.channel.programs);
            let groups = new Map();
            lineupPool.forEach( (p) => {
                if (p.isOffline) return;
                let d = getShowData(p);
                if (! d.hasShow || d.showId === 'movie.') return;
                if (! groups.has(d.showId)) groups.set(d.showId, []);
                groups.get(d.showId).push(p);
            } );
            groups.forEach( (items, showId) => names.set(showId, showId.startsWith('custom.') ? items[0].customShowName : items[0].showTitle) );
            $scope.loading = 'catalogs';
            $scope.showCount = groups.size;
            $timeout();
            catalogs = await catalogReader.read( [ ...groups.entries() ].map( ([showId, items]) => ({
                showId, title: items[0].showTitle, lineupItems: items, source: state.shows[showId] ? state.shows[showId].source : undefined,
            }) ) );
            $scope.unread = Object.keys(catalogs).filter( (id) => catalogs[id].error ).map( (id) => ({ name: $scope.nameOf(id), reason: catalogs[id].error }) );
            buildRows();
            $scope.loading = false;
        } catch (err) {
            console.error(err);
            $scope.loadError = (err && err.data) || String(err);
            $scope.loading = false;
        }
        $timeout();
    };
    load();
};
