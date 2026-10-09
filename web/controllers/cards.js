/*
 * The Cards page (docs/blocks-spec.md, Stage 5, "Generated cards"): the
 * templates generated cards are made from, a preview of any of them for any
 * movie, and the cards the next week needs, with the stretch of each movie a
 * card shows - picked automatically, or chosen here.
 *
 * Cards render in the background: after a change the page asks again every few
 * seconds until nothing is waiting.
 */
module.exports = function ($scope, $timeout, dizquetv) {
    const POLL_MS = 4000;

    $scope.loading = true;
    $scope.error = '';
    $scope.notice = '';
    $scope.templates = [];
    $scope.upcoming = [];
    $scope.fonts = [];
    $scope.movies = [];
    $scope.form = null;          // the template being edited
    $scope.preview = { movieKey: null, busy: false, error: '', url: null, kind: null, about: '' };
    $scope.momentText = {};      // per card key, the box's text

    let poll = null;
    let defaults = null;

    // 2661.9 -> "44:21.9"; 3725 -> "1:02:05"
    const clock = (s) => {
        if ( (typeof(s) !== 'number') || ! isFinite(s) ) {
            return '';
        }
        const whole = Math.floor(s);
        const tenths = Math.round( (s - whole) * 10 );
        const h = Math.floor(whole / 3600);
        const m = Math.floor( (whole % 3600) / 60 );
        const sec = whole % 60;
        const mm = (h > 0) ? String(m).padStart(2, '0') : String(m);
        return (h > 0 ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0') + (tenths > 0 && tenths < 10 ? '.' + tenths : '');
    };
    $scope.clock = clock;
    // "44:21.9", "1:02:05" or "2661.9" -> seconds; null when it is none of those
    const parseClock = (text) => {
        const t = String(text || '').trim();
        if (/^\d+(\.\d+)?$/.test(t)) {
            return parseFloat(t);
        }
        const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
        if (m === null) {
            return null;
        }
        return (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
    };
    $scope.when = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    $scope.stateLabel = (u) => ({ ready: (u.mode === 'poster') ? 'ready (poster card)' : 'ready', rendering: 'rendering…',
        waiting: 'waiting to render', failed: 'could not render' }[u.state] || u.state);

    const apply = (data) => {
        defaults = data.defaults;
        $scope.templates = data.templates;
        $scope.upcoming = data.upcoming;
        $scope.fonts = data.fonts;
        for (const u of data.upcoming) {
            if (typeof($scope.momentText[u.key]) === 'undefined') {
                $scope.momentText[u.key] = clock(u.momentS);
            }
        }
        if ( ($scope.preview.movieKey === null) && (data.upcoming.length > 0) ) {
            $scope.preview.movieKey = data.upcoming[0].movieKey;
        }
        const busy = data.upcoming.some( (u) => (u.state === 'waiting') || (u.state === 'rendering') );
        $timeout.cancel(poll);
        if (busy) {
            poll = $timeout(load, POLL_MS);
        }
    };

    const load = async () => {
        try {
            apply(await dizquetv.getCards());
            $scope.error = '';
        } catch (err) {
            console.error(err);
            $scope.error = 'Unable to read the cards. Reload the page to try again.';
        } finally {
            $scope.loading = false;
            $timeout();
        }
    };
    load();
    dizquetv.getCardMovies().then( (movies) => {
        $scope.movies = movies;
        $timeout();
    } ).catch( (err) => console.error(err) );
    $scope.$on('$destroy', () => $timeout.cancel(poll));

    $scope.templateName = (id) => {
        const t = $scope.templates.find( (x) => x.id === id );
        return t ? t.name : '(a template that no longer exists)';
    };
    // the movies to preview with: those cards are coming up for first, then every movie on the channels
    $scope.previewMovies = () => {
        const seen = new Set();
        const out = [];
        for (const u of $scope.upcoming) {
            if (! seen.has(u.movieKey)) {
                seen.add(u.movieKey);
                out.push( { movieKey: u.movieKey, label: `${u.title} (coming up: ${u.when})` } );
            }
        }
        for (const m of $scope.movies) {
            if (! seen.has(m.movieKey)) {
                seen.add(m.movieKey);
                out.push( { movieKey: m.movieKey, label: m.title + (m.year ? ` (${m.year})` : '') } );
            }
        }
        return out;
    };

    // ---- the cards coming up -----------------------------------------------------------
    const after = (message) => async (promise) => {
        try {
            const data = await promise;
            $scope.notice = message;
            $scope.error = '';
            if (data && data.upcoming) {
                $scope.upcoming = data.upcoming;
            }
            await load();
        } catch (err) {
            console.error(err);
            $scope.error = (err && err.data && err.data.error) || 'That did not work; see the server log.';
            $timeout();
        }
    };
    $scope.setMoment = (u) => {
        const s = parseClock($scope.momentText[u.key]);
        if (s === null) {
            $scope.error = `"${$scope.momentText[u.key]}" is not a time in the movie. Write it like 44:21 or 1:02:05.`;
            return;
        }
        delete $scope.momentText[u.key];
        after(`"${u.title}" will show the stretch from ${clock(s)}. Its card is being made again.`)(dizquetv.setCardMoment(u.movieKey, s));
    };
    $scope.autoMoment = (u) => {
        delete $scope.momentText[u.key];
        after(`"${u.title}" is back to the picked stretch. Its card is being made again.`)(dizquetv.setCardMoment(u.movieKey, null));
    };
    $scope.rerender = (u) => after(`The card for "${u.title}" is being made again.`)(dizquetv.rerenderCard(u.key));
    $scope.scanNow = () => after('Looking for the cards the next week needs.')(dizquetv.scanCards());
    $scope.previewUpcoming = (u) => {
        const t = $scope.templates.find( (x) => x.id === u.templateId );
        if (t) {
            $scope.preview.movieKey = u.movieKey;
            runPreview(t, 'clip', u.when);
        }
    };

    // ---- templates -----------------------------------------------------------------------
    const copy = (x) => JSON.parse(JSON.stringify(x));
    const percent = (x) => Math.round(x * 100);
    const toForm = (t) => Object.assign(copy(t), { headingPct: percent(t.headingY), titlePct: percent(t.titleY), whenPct: percent(t.whenY),
        darkenPct: percent(t.fallback.darken), musicPct: percent(t.music.volume), underPct: percent(t.music.underFootage) });
    const fromForm = (f) => {
        const t = copy(f);
        t.headingY = f.headingPct / 100;
        t.titleY = f.titlePct / 100;
        t.whenY = f.whenPct / 100;
        t.fallback.darken = f.darkenPct / 100;
        t.music.volume = f.musicPct / 100;
        t.music.underFootage = f.underPct / 100;
        for (const k of ['headingPct', 'titlePct', 'whenPct', 'darkenPct', 'musicPct', 'underPct', 'seconds', 'problems', 'check']) {
            delete t[k];
        }
        return t;
    };
    $scope.newTemplate = () => {
        $scope.form = Object.assign(toForm(Object.assign(copy(defaults), { name: 'Cartoon Theatre Next Time' })), { check: {} });
        $scope.notice = '';
    };
    $scope.edit = (t) => {
        $scope.form = Object.assign(toForm(t), { check: {} });
        $scope.notice = '';
    };
    $scope.cancel = () => {
        $scope.form = null;
    };
    $scope.totalSeconds = () => {
        const f = $scope.form;
        const ending = (f.ending.file && f.ending.lengthS > 0) ? f.ending.lengthS : 0;
        return Math.round( (f.footageSeconds + ending) * 100 ) / 100;
    };
    $scope.save = async () => {
        try {
            const saved = await dizquetv.saveCardTemplate(fromForm($scope.form));
            $scope.notice = `Saved "${saved.template.name}". Cards made from it are being made again in the background.`;
            $scope.form = null;
            $scope.error = '';
            await load();
        } catch (err) {
            $scope.error = (err && err.data && err.data.error) || 'Unable to save the template.';
            $timeout();
        }
    };
    $scope.remove = async (t) => {
        if (! window.confirm(`Delete the template "${t.name}"? Card steps that use it will play nothing until they are given another.`)) {
            return;
        }
        after(`Deleted "${t.name}".`)(dizquetv.deleteCardTemplate(t.id));
    };
    // Whether the ending or music file can be read, how long it is, and whether it has sound.
    $scope.checkFile = async (which) => {
        const f = $scope.form;
        const file = f[which].file;
        f.check[which] = 'checking…';
        try {
            const r = await dizquetv.probeCardFile(file);
            f.check[which] = r.ok ? `${Math.round(r.durationS * 100) / 100}s long, ${r.hasAudio ? 'with sound' : 'no sound'}${r.hasVideo ? '' : ', no picture'}`
                : 'cannot be read';
        } catch (err) {
            f.check[which] = 'cannot be checked';
        }
        $timeout();
    };

    // ---- previews ------------------------------------------------------------------------
    const runPreview = async (template, kind, when) => {
        const p = $scope.preview;
        if (! p.movieKey) {
            p.error = 'Choose a movie to preview with.';
            return;
        }
        p.busy = true;
        p.error = '';
        p.url = null;
        p.kind = kind;
        $timeout();
        try {
            const r = await dizquetv.previewCard( { template: template, movieKey: p.movieKey, kind: kind, when: when } );
            p.url = r.url;
            p.about = (r.mode === 'poster') ? 'The movie\'s file could not be read, so this is the poster card.'
                : `From ${clock(r.momentS)} in the movie (${r.momentSource === 'chosen' ? 'your choice' : 'picked automatically'}). Says "${r.when}".`;
        } catch (err) {
            p.error = (err && err.data && err.data.error) || 'The preview could not be made.';
        } finally {
            p.busy = false;
            $timeout();
        }
    };
    $scope.previewForm = (kind) => runPreview(fromForm($scope.form), kind);
};
