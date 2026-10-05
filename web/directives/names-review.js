const review = require('../../src/names-review');

/*
 * The names review screen (stage 5, step 6; docs/blocks-spec.md, "Which shows a
 * clip names"). One screen for the whole page, opened with
 * namesReview.open(listId). It shows every clip of a saved filler list with the
 * names it has, the names its title suggests and how those were reached;
 * decisions made here are pending until Save, and Save sends only what was
 * decided (names-review.savePayload). The grouping, accept-all and payload logic
 * is src/names-review.js, which test/names-review.js checks.
 */
module.exports = function ($timeout, $rootScope, dizquetv, namesReview) {
    const PAGE = 40;

    return {
        restrict: 'E',
        templateUrl: 'templates/names-review.html',
        replace: true,
        scope: {},
        link: function (scope) {
            scope.visible = false;
            scope.loading = false;
            scope.saving = false;
            scope.error = '';
            scope.notice = '';
            scope.list = null;
            scope.rows = [];
            scope.shows = [];
            scope.showNames = {};
            scope.pending = {};
            scope.nicknames = [];
            scope.only = null;
            scope.search = '';
            scope.sections = [];
            scope.counts = review.summarize([]);
            scope.plan = review.acceptAllPlan([], {});
            scope.picker = null;
            scope.teach = null;
            scope.confirmAll = false;
            scope.confirmClose = false;
            scope.groups = review.GROUPS;

            const groupOfRow = new Map();

            const showName = (key) => scope.showNames[key] || key.replace(/^[a-z]+\./, '');
            scope.showName = showName;
            const CHIP = { flagged: 'flagged', uncertain: 'less certain', confident: 'confident', none: 'no suggestion', saved: 'saved' };
            scope.chipLabel = (id) => CHIP[id];

            const rebuild = () => {
                const q = (scope.search || '').trim().toLowerCase();
                const ordered = review.orderRows(scope.rows)
                    .filter( (r) => (q === '') || (String(r.title).toLowerCase().indexOf(q) !== -1) );
                scope.sections = review.GROUPS
                    .filter( (g) => (scope.only === null) || (scope.only === g.id) )
                    .map( (g) => ({ id: g.id, title: g.title, rows: ordered.filter( (r) => groupOfRow.get(r.index) === g.id ), shown: PAGE }) )
                    .filter( (s) => s.rows.length > 0 );
            };
            const refreshPlan = () => {
                scope.plan = review.acceptAllPlan(scope.rows, scope.pending);
            };
            scope.rebuild = rebuild;

            const load = (match) => {
                scope.list = { id: match.id, name: match.name };
                scope.rows = match.clips;
                scope.shows = match.shows || [];
                scope.showNames = Object.assign({}, match.showNames);
                for (const s of scope.shows) {
                    scope.showNames[s.key] = s.name;
                }
                groupOfRow.clear();
                for (const r of scope.rows) {
                    groupOfRow.set(r.index, review.groupOf(r));
                }
                scope.counts = review.summarize(scope.rows);
                scope.pending = {};
                scope.nicknames = [];
                scope.picker = null;
                scope.teach = null;
                scope.confirmAll = false;
                scope.confirmClose = false;
                rebuild();
                refreshPlan();
            };

            const open = async (id) => {
                scope.visible = true;
                scope.loading = true;
                scope.error = '';
                scope.notice = '';
                scope.list = null;
                scope.rows = [];
                scope.sections = [];
                scope.only = null;
                scope.search = '';
                $timeout();
                try {
                    load(await dizquetv.getFillerMatch(id));
                } catch (err) {
                    console.error(err);
                    scope.error = 'Unable to read this list. Close this and try again.';
                } finally {
                    scope.loading = false;
                    $timeout();
                }
            };
            namesReview.register(open);

            // ---- how a row reads -------------------------------------------------
            scope.view = (row) => {
                const eff = review.effective(row, scope.pending);
                const text = eff.names.map(showName).join('  →  ');
                if (eff.state === 'pending') {
                    return { state: 'pending', label: 'will be saved', text: (eff.names.length === 0) ? 'names no show' : text };
                }
                if (eff.state === 'saved') {
                    return { state: 'saved', label: 'saved', text: (eff.names.length === 0) ? 'names no show' : text };
                }
                if (eff.state === 'suggested') {
                    return { state: 'suggested', label: 'only suggested', text: text };
                }
                return { state: 'none', label: 'no names', text: '' };
            };
            scope.marksOf = (row) => review.marksOf(row.proposal);
            scope.recognised = (row) => ((row.proposal.unresolved != null) ? row.proposal.unresolved.recognised : []).map(showName);
            scope.isFlagged = (row) => (row.proposal.unresolved != null) && (typeof(scope.pending[row.index]) === 'undefined') && (scope.view(row).state !== 'saved');
            scope.canAccept = (row) => (scope.view(row).state === 'suggested');
            scope.isPending = (row) => typeof(scope.pending[row.index]) !== 'undefined';
            scope.pendingCount = () => review.pendingCount(scope.pending, scope.nicknames);
            scope.hasPending = () => (Object.keys(scope.pending).length + scope.nicknames.length) > 0;
            scope.moreCount = (sec) => Math.max(0, sec.rows.length - sec.shown);
            scope.showMore = (sec) => { sec.shown += PAGE; };

            // ---- filters -----------------------------------------------------------
            scope.setOnly = (id) => {
                scope.only = (scope.only === id) ? null : id;
                rebuild();
            };

            // ---- a decision for one clip -----------------------------------------
            scope.accept = (row) => {
                if (row.proposal.names.length > 0) {
                    scope.pending[row.index] = { names: row.proposal.names.slice() };
                    refreshPlan();
                }
            };
            scope.noShow = (row) => {
                scope.pending[row.index] = { names: [] };
                scope.picker = null;
                refreshPlan();
            };
            scope.undo = (row) => {
                delete scope.pending[row.index];
                refreshPlan();
            };

            // ---- picking shows, in airing order ----------------------------------
            scope.openPicker = (row) => {
                scope.teach = null;
                const eff = review.effective(row, scope.pending);
                let slots = eff.names.slice();
                if ( (slots.length === 0) && (row.proposal.unresolved != null) ) {
                    slots = row.proposal.unresolved.recognised.slice();
                }
                scope.picker = { index: row.index, slots: (slots.length > 0) ? slots : [null], filter: '', error: '' };
            };
            scope.closePicker = () => { scope.picker = null; };
            scope.addSlot = () => {
                if (scope.picker.slots.length < review.MAX_NAMES) {
                    scope.picker.slots.push(null);
                }
            };
            scope.removeSlot = (i) => {
                scope.picker.slots.splice(i, 1);
                if (scope.picker.slots.length === 0) {
                    scope.picker.slots.push(null);
                }
            };
            scope.canAddSlot = () => (scope.picker != null) && (scope.picker.slots.length < review.MAX_NAMES);
            scope.slotLabel = (i, n) => {
                if (n === 1) {
                    return 'Show';
                }
                return ['Coming up first', 'then', 'then', 'then'][i];
            };
            // The shows a picker offers: the ones its filter allows, plus whatever is already picked.
            // An option object per show key kept between digests, so ng-options sees the same
            // objects every time and settles.
            const extras = new Map();
            scope.optionsFor = (current) => {
                const q = ((scope.picker && scope.picker.filter) || '').trim().toLowerCase();
                const out = scope.shows.filter( (s) => (q === '') || (s.name.toLowerCase().indexOf(q) !== -1) || (s.key === current) );
                if ( current && ! out.some( (s) => s.key === current) ) {
                    if (! extras.has(current) ) {
                        extras.set(current, { key: current, name: showName(current), custom: false });
                    }
                    out.unshift(extras.get(current));
                }
                return out;
            };
            scope.showLabel = (s) => s.custom ? `${s.name} (custom show)` : s.name;
            scope.applyPicker = () => {
                const p = scope.picker;
                const problem = review.picksProblem(p.slots);
                if (problem !== null) {
                    p.error = (problem === 'a show has not been picked') ? 'Pick a show for every slot, or remove the empty one.'
                        : (problem === 'the same show is picked twice in a row') ? 'The same show cannot be picked twice in a row.' : problem;
                    return;
                }
                scope.pending[p.index] = { names: p.slots.slice() };
                scope.picker = null;
                refreshPlan();
            };

            // ---- accept all confident suggestions --------------------------------
            scope.askAcceptAll = () => { scope.confirmAll = true; };
            scope.cancelAcceptAll = () => { scope.confirmAll = false; };
            scope.doAcceptAll = () => {
                scope.pending = review.acceptAll(scope.rows, scope.pending);
                scope.confirmAll = false;
                refreshPlan();
            };

            // ---- teaching a nickname ---------------------------------------------
            let checkSerial = 0;
            let typing = null;
            const firstShow = (row) => {
                const eff = review.effective(row, scope.pending);
                return (eff.names.length > 0) ? eff.names[0] : null;
            };
            scope.openTeach = (row) => {
                scope.picker = null;
                scope.teach = { index: row.index, title: row.title, showKey: firstShow(row), text: '', suggestions: [], check: null, busy: false, filter: '', error: '' };
                if (scope.teach.showKey) {
                    loadSuggestions();
                }
            };
            scope.closeTeach = () => { scope.teach = null; };
            const loadSuggestions = async () => {
                const t = scope.teach;
                if ( (t == null) || ! t.showKey ) {
                    return;
                }
                try {
                    const got = await dizquetv.getNicknameSuggestions(scope.list.id, { index: t.index, showKey: t.showKey });
                    if (scope.teach === t) {
                        t.suggestions = got;
                    }
                } catch (err) {
                    console.error(err);
                } finally {
                    $timeout();
                }
            };
            const runCheck = async () => {
                const t = scope.teach;
                if (t == null) {
                    return;
                }
                const serial = ++checkSerial;
                if ( ((t.text || '').trim() === '') || ! t.showKey ) {
                    t.check = null;
                    return;
                }
                t.busy = true;
                try {
                    const result = await dizquetv.checkNickname(scope.list.id, { text: t.text, showKey: t.showKey, index: t.index });
                    if ( (serial === checkSerial) && (scope.teach === t) ) {
                        t.check = result;
                    }
                } catch (err) {
                    console.error(err);
                    if ( (serial === checkSerial) && (scope.teach === t) ) {
                        t.check = null;
                        t.error = 'Unable to check that nickname.';
                    }
                } finally {
                    if (scope.teach === t) {
                        t.busy = false;
                    }
                    $timeout();
                }
            };
            scope.teachShowChanged = () => {
                scope.teach.suggestions = [];
                scope.teach.check = null;
                scope.teach.error = '';
                loadSuggestions();
                runCheck();
            };
            scope.teachTextChanged = () => {
                scope.teach.check = null;
                scope.teach.error = '';
                if (typing !== null) {
                    $timeout.cancel(typing);
                }
                typing = $timeout(runCheck, 350);
            };
            scope.useSuggestion = (s) => {
                scope.teach.text = s.text;
                runCheck();
            };
            scope.teachShows = () => {
                const q = ((scope.teach && scope.teach.filter) || '').trim().toLowerCase();
                const current = scope.teach ? scope.teach.showKey : null;
                return scope.shows.filter( (s) => (q === '') || (s.name.toLowerCase().indexOf(q) !== -1) || (s.key === current) );
            };
            scope.canAddNickname = () => (scope.teach != null) && (scope.teach.check != null) && (scope.teach.check.ok === true)
                && ! scope.nicknames.some( (n) => n.alias === scope.teach.check.alias );
            scope.addNickname = () => {
                const t = scope.teach;
                const check = t.check;
                scope.nicknames.push( { alias: check.alias, text: t.text.trim(), showKey: t.showKey, showName: showName(t.showKey) } );
                // The clip it was taught from takes the names the nickname gives it, unless
                // the person already decided something else for it here.
                if ( (typeof(scope.pending[t.index]) === 'undefined') && (check.sourceNames.length > 0) ) {
                    scope.pending[t.index] = { names: check.sourceNames.slice() };
                }
                scope.teach = null;
                refreshPlan();
            };
            scope.removeNickname = (i) => {
                scope.nicknames.splice(i, 1);
            };

            // ---- saving and closing ----------------------------------------------
            scope.save = async () => {
                const payload = review.savePayload(scope.rows, scope.pending, scope.nicknames);
                if ( (payload.clips.length === 0) && (Object.keys(payload.aliases).length === 0) ) {
                    return;
                }
                scope.saving = true;
                scope.error = '';
                scope.notice = '';
                try {
                    const match = await dizquetv.saveFillerNames(scope.list.id, payload);
                    const clips = payload.clips.length;
                    const aliases = Object.keys(payload.aliases).length;
                    load(match);
                    scope.notice = 'Saved '
                        + (clips > 0 ? `${clips} clip name${clips === 1 ? '' : 's'}` : '')
                        + ( (clips > 0) && (aliases > 0) ? ' and ' : '')
                        + (aliases > 0 ? `${aliases} nickname${aliases === 1 ? '' : 's'}` : '')
                        + '. Clips a new nickname now suggests a show for are listed as suggestions: nothing on them is saved until you accept them.';
                    $rootScope.$broadcast('namesSaved', match.id);
                } catch (err) {
                    console.error(err);
                    scope.error = (err && err.data && err.data.error) ? err.data.error : 'Unable to save. Nothing was changed.';
                } finally {
                    scope.saving = false;
                    $timeout();
                }
            };
            scope.close = () => {
                if (scope.hasPending() && ! scope.confirmClose) {
                    scope.confirmClose = true;
                    return;
                }
                scope.visible = false;
                scope.confirmClose = false;
                scope.picker = null;
                scope.teach = null;
            };
            scope.keepWorking = () => { scope.confirmClose = false; };
        },
    };
};
