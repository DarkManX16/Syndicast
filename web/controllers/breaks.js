/*
 * The Breaks page (docs/blocks-spec.md, Stage 6, step 4): one line per show, details only when one
 * is opened. A line has the show's pattern (approved with one click, or withdrawn), the weaker
 * second line where one is offered, how many episodes have no breaks found, and how many are on the
 * list to check; the shows that need a click come in the order they next air, so what airs this
 * week is checked first. An opened show steps through its list to check one point at a time
 * (approve, reject, nudge, type a time, add a break, "no breaks"), with the picture on either
 * side of the point, and lists every episode for "these have no breaks".
 *
 * Keys, with a show open and the cursor not in a box: A approves, R rejects, N is next,
 * the arrows nudge a frame (Shift: a second).
 */
module.exports = function ($scope, $timeout, $document, dizquetv) {
    const SCANNER_POLL_MS = 5000;
    const LIST_POLL_MS = 60000;
    const PAGE = 100;
    const FRAME_S = 0.04;

    $scope.loading = true;
    $scope.error = '';
    $scope.shows = [];
    $scope.scanner = null;
    $scope.counts = null;
    $scope.scanFirst = {};          // show key -> files still waiting for their turn
    $scope.ui = { search: '', filter: 'click', details: false, limit: PAGE, drives: '', allEpisodes: false, onlyNone: false };
    $scope.openKey = null;
    $scope.detail = null;
    $scope.todo = [];               // the points waiting in the open show: [{ path, at }]
    $scope.focus = null;            // { path, at }: the episode and the point being looked at
    $scope.ticked = {};
    $scope.busy = false;
    $scope.entry = { time: '', kind: 'act', typed: '' };
    $scope.groups = [];

    let scannerTimer = null;
    let listTimer = null;
    let destroyed = false;

    // ---- small things ------------------------------------------------------------------------
    const round2 = (x) => Math.round(x * 100) / 100;

    // 98.1 -> "1:38.1"; 2262 -> "37:42"; 5400 -> "1:30:00"
    $scope.clock = (s) => {
        if ( (typeof(s) !== 'number') || ! isFinite(s) ) {
            return '';
        }
        const whole = Math.floor(s);
        const frac = Math.round( (s - whole) * 10 );
        const h = Math.floor(whole / 3600);
        const m = Math.floor( (whole % 3600) / 60 );
        const sec = whole % 60;
        const base = (h > 0) ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
        return (frac > 0) && (frac < 10) ? `${base}.${frac}` : base;
    };

    // "1:38", "98.5", "1:02:03" -> seconds, or null
    const parseTime = (text) => {
        const t = String(text || '').trim();
        if ( ! /^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(t) ) {
            return null;
        }
        return t.split(':').reduce( (sum, part) => sum * 60 + Number(part), 0 );
    };

    const DAYS = [ 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat' ];
    $scope.when = (ms) => {
        if (ms == null) {
            return 'not on a channel';
        }
        const d = new Date(ms);
        const now = new Date();
        const clock = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        if (ms <= now.getTime()) {
            return 'on now';
        }
        const days = Math.round( (new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000 );
        if (days === 0) {
            return `today ${clock}`;
        }
        if (days === 1) {
            return `tomorrow ${clock}`;
        }
        return (days < 7) ? `${DAYS[d.getDay()]} ${clock}` : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    };

    const fail = (err) => {
        console.error(err);
        $scope.error = (err && err.data && err.data.error) || 'That did not work. Reload the page to try again.';
    };

    // ---- the scanner ---------------------------------------------------------------------------
    const loadScanner = async () => {
        try {
            $scope.scanner = await dizquetv.getBreakScanner();
        } catch (err) {
            console.error(err);
        } finally {
            $timeout();
            if ( ! destroyed ) {
                scannerTimer = $timeout(loadScanner, SCANNER_POLL_MS);
            }
        }
    };

    $scope.togglePause = async () => {
        try {
            $scope.scanner = await dizquetv.setBreakScanner( { paused: ! $scope.scanner.pausedByHand } );
        } catch (err) {
            fail(err);
        }
        $timeout();
    };

    $scope.saveDrives = async () => {
        try {
            const text = String($scope.ui.drives || '').trim();
            if (text === '') {
                return;   // an empty box changes nothing; "none" scans every drive
            }
            const drives = /^none$/i.test(text) ? [] : text.split(/[\s,;]+/).filter( (d) => d !== '' );
            $scope.scanner = await dizquetv.setBreakScanner( { skipDrives: drives } );
            $scope.ui.drives = '';
        } catch (err) {
            fail(err);
        }
        $timeout();
    };

    $scope.scannedText = (c) => (c == null) ? '' : `${c.scanned.toLocaleString()} of ${c.files.toLocaleString()}`;
    $scope.paceText = (p) => (p == null) ? '' : p.toFixed(2);

    // ---- the list ----------------------------------------------------------------------------------
    const loadShows = async () => {
        try {
            const data = await dizquetv.getBreakShows();
            $scope.counts = data.counts;
            $scope.scanFirst = {};
            for (const s of data.scanFirst || []) {
                $scope.scanFirst[s.key] = s.remaining;
            }
            $scope.ready = data.ready;
            $scope.shows = data.shows;
            $scope.error = '';
        } catch (err) {
            console.error(err);
            $scope.error = 'Unable to read the shows. Reload the page to try again.';
        } finally {
            $scope.loading = false;
            $timeout();
            if ( ! destroyed ) {
                listTimer = $timeout(loadShows, LIST_POLL_MS);
            }
        }
    };

    const isMovieLine = (s) => (s.kind === 'movie') || (s.movieFiles > 0);
    const FILTERS = {
        click: (s) => s.needsClick,
        approved: (s) => s.approved,
        movies: isMovieLine,
        all: () => true,
    };
    $scope.filterCount = (name) => $scope.shows.filter(FILTERS[name]).length;

    // Shows DarkManX16 has just changed stay in the list, now saying what they are, until he changes the filter.
    let touched = {};
    let cached = { shows: null, filter: null, search: null, out: [] };
    $scope.visible = () => {
        const search = String($scope.ui.search || '').trim().toLowerCase();
        if ( (cached.shows !== $scope.shows) || (cached.filter !== $scope.ui.filter) || (cached.search !== search) ) {
            cached = {
                shows: $scope.shows, filter: $scope.ui.filter, search,
                // the show that is open stays where it is, whatever its last click did to its line
                // a search looks through every show, whichever list is showing
                out: $scope.shows.filter( (s) => (search !== '') ? s.name.toLowerCase().includes(search) : ( FILTERS[$scope.ui.filter](s) || touched[s.key] || (s.key === $scope.openKey) ) ),
            };
        }
        return cached.out;
    };
    $scope.setFilter = (name) => { $scope.ui.filter = name; $scope.ui.limit = PAGE; touched = {}; cached.shows = null; };
    $scope.showMore = () => { $scope.ui.limit += PAGE; };

    // ---- opening a show --------------------------------------------------------------------------------
    const buildTodo = (d) => {
        const todo = [];
        for (const e of d.toCheck) {
            for (const p of e.points) {
                if (p.status === 'found') {
                    todo.push( { path: e.path, at: p.at } );
                }
            }
        }
        return todo;
    };

    const groupsOf = (d) => {
        const by = new Map();
        for (const e of d.episodes) {
            if ( $scope.ui.onlyNone && (e.points.length > 0) && ! e.noBreaks ) {
                continue;
            }
            if ( ! by.has(e.folder) ) {
                by.set(e.folder, []);
            }
            by.get(e.folder).push(e);
        }
        return Array.from(by.entries()).map( ([folder, episodes]) => ({ folder, episodes, label: folder.split(/[\\/]/).pop() }) );
    };
    $scope.regroup = () => { if ($scope.detail) { $scope.groups = groupsOf($scope.detail); } };

    // The open show's movies, scanned or not: each can be marked theatrical.
    $scope.movies = () => ($scope.detail ? $scope.detail.episodes.filter( (e) => e.movie ) : []);
    $scope.canLook = (e) => ! e.unscanned || e.theatrical;
    $scope.episode = (path) => ($scope.detail ? $scope.detail.episodes.find( (e) => e.path === path ) : null) || null;
    $scope.focusEpisode = () => ($scope.focus ? $scope.episode($scope.focus.path) : null);
    $scope.focusPoint = () => {
        const e = $scope.focusEpisode();
        if ( (e == null) || ($scope.focus.at == null) ) {
            return null;
        }
        return e.points.find( (p) => Math.abs(p.at - $scope.focus.at) < 0.03 ) || null;
    };
    $scope.focusIndex = () => $scope.todo.findIndex( (t) => ($scope.focus != null) && (t.path === $scope.focus.path) && (Math.abs(t.at - $scope.focus.at) < 0.03) );

    /*
     * Takes in what the server says the show now looks like. `how` is where the cursor goes:
     * 'keep' stays on the point at `at` (a move, a new kind), 'advance' goes to the next point
     * waiting, 'first' to the first.
     */
    const apply = (d, how, at, prevPos) => {
        const key = d.line.key;
        touched[key] = true;
        const i = $scope.shows.findIndex( (s) => s.key === key );
        if (i >= 0) {
            $scope.shows[i] = d.line;
            cached.shows = null;
        }
        if (d.scanFirst != null) {
            $scope.scanFirst[key] = d.scanFirst;
        } else {
            delete $scope.scanFirst[key];
        }
        // an answer about a show that is not the one open (Approve on another line) changes its line only
        if ($scope.openKey !== key) {
            return;
        }
        $scope.detail = d;
        $scope.todo = buildTodo(d);
        $scope.groups = groupsOf(d);
        const path = $scope.focus ? $scope.focus.path : null;
        if ( (how === 'keep') && path && $scope.episode(path) ) {
            $scope.focus = { path, at: (at != null) ? at : $scope.focus.at };
            if ($scope.focusPoint() !== null) {
                return;
            }
        }
        if ( (how === 'advance') && ($scope.todo.length > 0) ) {
            const next = $scope.todo[Math.min(Math.max(prevPos, 0), $scope.todo.length - 1)];
            $scope.focus = { path: next.path, at: next.at };
            return;
        }
        if ($scope.todo.length > 0) {
            $scope.focus = { path: $scope.todo[0].path, at: $scope.todo[0].at };
        } else if (path && $scope.episode(path)) {
            $scope.focus = { path, at: null };
        } else {
            $scope.focus = null;
        }
    };

    $scope.toggleOpen = async (line) => {
        if ($scope.openKey === line.key) {
            $scope.openKey = null;
            $scope.detail = null;
            return;
        }
        $scope.openKey = line.key;
        $scope.detail = null;
        $scope.focus = null;
        $scope.ticked = {};
        $scope.ui.allEpisodes = false;
        $scope.ui.onlyNone = false;
        $scope.entry = { time: '', kind: 'act', typed: '' };
        try {
            const d = await dizquetv.getBreakShow(line.key);
            if ($scope.openKey === line.key) {
                apply(d, 'first');
            }
        } catch (err) {
            fail(err);
        }
        $timeout();
    };

    // ---- one change at a time -----------------------------------------------------------------------------
    // A change that comes while one is still on its way waits its turn, and is made against the show as
    // that one left it, so a quick second click or key is never lost.
    let waiting = 0;
    let chain = Promise.resolve();
    const run = (call, how, at) => {
        waiting++;
        $scope.busy = true;
        chain = chain.then( async () => {
            const prevPos = $scope.focusIndex();
            try {
                const d = await call();
                if (d) {
                    apply(d, how, at, prevPos);
                }
                $scope.error = '';
            } catch (err) {
                fail(err);
            } finally {
                waiting--;
                $scope.busy = (waiting > 0);
                $timeout();
            }
        } );
        return chain;
    };

    // The show's pattern, from its line or from inside it.
    $scope.pattern = (line, action, weaker) => run( () => dizquetv.breakPattern(line.key, action, weaker), 'keep');

    $scope.scanNext = (line) => run( () => dizquetv.breakScanFirst(line.key, ! ($scope.scanFirst[line.key] > 0)), 'keep');

    const point = (action, value, extra = {}) => {
        const e = $scope.focusEpisode();
        const p = $scope.focusPoint();
        if ( (e == null) || (p == null) ) {
            return Promise.resolve();
        }
        return dizquetv.breakPoint(Object.assign( { key: $scope.openKey, path: e.path, index: p.index, action, value }, extra ));
    };

    $scope.approve = () => { const p = $scope.focusPoint(); return p && run( () => point('approve'), 'advance'); };
    $scope.reject = () => { const p = $scope.focusPoint(); return p && run( () => point('reject'), 'advance'); };
    $scope.nudge = (s) => {
        const p = $scope.focusPoint();
        return p && run( () => point('nudge', s), 'keep', round2(p.at + s));
    };
    $scope.setTime = () => {
        const s = parseTime($scope.entry.time);
        if ( (s == null) || ($scope.focusPoint() === null) ) {
            $scope.error = 'Type a time like 11:46 or 706.5.';
            return;
        }
        return run( () => point('time', s), 'keep', round2(s)).then( () => { $scope.entry.time = ''; } );
    };
    // Why an episode is on the list to check.
    $scope.reasonsOf = (path) => {
        const e = $scope.detail ? $scope.detail.toCheck.find( (x) => x.path === path ) : null;
        return e ? e.reasons : [];
    };
    // The kind box shows the point in front of you and changes it.
    $scope.kindGS = (kind) => {
        if (kind === undefined) {
            const p = $scope.focusPoint();
            return p ? p.kind : '';
        }
        return $scope.setKind(kind);
    };
    $scope.setKind = (kind) => {
        const p = $scope.focusPoint();
        return p && (p.kind !== kind) && run( () => point('kind', kind), 'keep', p.at);
    };
    $scope.addBreak = () => {
        const e = $scope.focusEpisode();
        const s = parseTime($scope.entry.typed);
        if ( (e == null) || (s == null) ) {
            $scope.error = 'Type a time like 11:46 or 706.5.';
            return;
        }
        return run( () => dizquetv.breakPoint( { key: $scope.openKey, path: e.path, action: 'add', value: s, kind: $scope.entry.kind } ), 'keep', round2(s)).then( () => { $scope.entry.typed = ''; } );
    };

    // Move the cursor along the points waiting.
    $scope.next = () => {
        if ($scope.todo.length === 0) {
            return;
        }
        const i = $scope.focusIndex();
        const t = $scope.todo[(i + 1) % $scope.todo.length];
        $scope.focus = { path: t.path, at: t.at };
    };
    $scope.prev = () => {
        if ($scope.todo.length === 0) {
            return;
        }
        const i = $scope.focusIndex();
        const t = $scope.todo[(i <= 0) ? $scope.todo.length - 1 : i - 1];
        $scope.focus = { path: t.path, at: t.at };
    };
    $scope.look = (episode, p) => {
        $scope.focus = { path: episode.path, at: p ? p.at : null };
        $scope.entry.typed = '';
    };

    // ---- "these have no breaks" ----------------------------------------------------------------------------
    $scope.tickedPaths = () => Object.keys($scope.ticked).filter( (p) => $scope.ticked[p] );
    $scope.tickGroup = (g, on) => { for (const e of g.episodes) { $scope.ticked[e.path] = on; } };
    $scope.tickNothing = () => {
        $scope.ticked = {};
        for (const e of $scope.detail.episodes) {
            if ( ! e.noBreaks && ! e.unscanned && (e.points.length === 0) ) {
                $scope.ticked[e.path] = true;
            }
        }
    };
    $scope.tickNone = () => { $scope.ticked = {}; };
    $scope.tickMarked = () => {
        $scope.ticked = {};
        for (const e of $scope.detail.episodes) {
            if (e.noBreaks) {
                $scope.ticked[e.path] = true;
            }
        }
    };
    $scope.takeBack = () => {
        const ticked = $scope.tickedPaths();
        return ticked.length > 0 && ticked.every( (p) => { const e = $scope.episode(p); return e && e.noBreaks; } );
    };
    $scope.markNone = async () => {
        const paths = $scope.tickedPaths();
        const value = ! $scope.takeBack();
        await run( () => dizquetv.breakNone( { key: $scope.openKey, paths, value } ), 'keep');
        $scope.ticked = {};
    };
    // The whole show, files scanned later included; pressed again it takes the whole show back.
    $scope.markShowNone = (line) => run( () => dizquetv.breakNone( { key: $scope.openKey, all: true, value: ! line.noBreaksShow } ), 'keep');
    $scope.markOneNone = (e, value) => run( () => dizquetv.breakNone( { key: $scope.openKey, paths: [ e.path ], value } ), 'advance');

    // ---- theatrical -------------------------------------------------------------------------------------------------
    // One movie (its own file), or a whole custom show of shorts.
    $scope.movieTheatrical = (line, path, value) => run( () => dizquetv.breakTheatrical( { key: line.key, path, value } ), 'keep');
    $scope.showTheatrical = (line, value) => run( () => dizquetv.breakTheatrical( { key: line.key, value } ), 'keep');

    // ---- keys -----------------------------------------------------------------------------------------------------------
    const onKey = (event) => {
        if ( ! $scope.openKey || ($scope.focus == null) || event.ctrlKey || event.metaKey || event.altKey ) {
            return;
        }
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) {
            return;
        }
        const step = event.shiftKey ? 1 : FRAME_S;
        let done = true;
        switch (event.key) {
            case 'a': case 'A': $scope.approve(); break;
            case 'r': case 'R': $scope.reject(); break;
            case 'n': case 'N': $scope.next(); break;
            case 'p': case 'P': $scope.prev(); break;
            case 'ArrowLeft': $scope.nudge(-step); break;
            case 'ArrowRight': $scope.nudge(step); break;
            default: done = false;
        }
        if (done) {
            event.preventDefault();
            $timeout();
        }
    };
    $document.on('keydown', onKey);

    $scope.$on('$destroy', () => {
        destroyed = true;
        $timeout.cancel(scannerTimer);
        $timeout.cancel(listTimer);
        $document.off('keydown', onKey);
    });

    loadScanner();
    loadShows();
};
