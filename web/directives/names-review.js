const review = require('../../src/names-review');
const clipNames = require('../../src/clip-names');
const seasonSource = require('../season-source');

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
            scope.ui = { search: '' };
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
            // A name reads as its show, its movie, or a season or special of a show.
            const nameLabel = (name) => clipNames.labelOf(name, scope.showNames);
            scope.nameLabel = nameLabel;
            const CHIP = { flagged: 'flagged', uncertain: 'less certain', confident: 'confident', none: 'no suggestion', saved: 'saved' };
            scope.chipLabel = (id) => CHIP[id];

            const rebuild = () => {
                const q = (scope.ui.search || '').trim().toLowerCase();
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
                scope.ui.search = '';
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
                const text = eff.names.map(nameLabel).join('  →  ');
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
            // The marks are worked out once per proposal: ng-repeat over a list built fresh on every
            // digest never settles ($rootScope:infdig), so the same objects are handed back each time.
            const marksCache = new WeakMap();
            scope.marksOf = (row) => {
                if (! marksCache.has(row.proposal) ) {
                    marksCache.set(row.proposal, review.marksOf(row.proposal) );
                }
                return marksCache.get(row.proposal);
            };
            scope.recognised = (row) => ((row.proposal.unresolved != null) ? row.proposal.unresolved.recognised : []).map(nameLabel);
            scope.flagKind = (row) => (row.proposal.unresolved != null) ? (row.proposal.unresolved.kind || 'several') : null;
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
            // A slot of the picker is { key, kind, picked, special }: the show or movie picked and,
            // for a show with seasons, which part of it: any episode, the seasons ticked, or one
            // special. src/names-review.js turns a slot into a name and back.
            const slotOf = review.slotOfName;
            const nameOfSlot = review.slotName;
            scope.openPicker = (row) => {
                scope.teach = null;
                const eff = review.effective(row, scope.pending);
                let names = eff.names.slice();
                if ( (names.length === 0) && (row.proposal.unresolved != null) ) {
                    names = row.proposal.unresolved.recognised.slice();
                }
                const slots = names.map(slotOf);
                for (const slot of slots) {
                    for (const m of slot.members) {
                        seasons.ensure(m.key);
                    }
                }
                scope.picker = { index: row.index, slots: (slots.length > 0) ? slots : [ review.emptySlot() ], filter: '', error: '' };
                for (const slot of scope.picker.slots) {
                    ensureSeasons(slot.key);
                }
            };
            scope.closePicker = () => { scope.picker = null; };
            scope.addSlot = () => {
                if (scope.picker.slots.length < review.MAX_NAMES) {
                    scope.picker.slots.push( review.emptySlot() );
                }
            };
            scope.removeSlot = (i) => {
                scope.picker.slots.splice(i, 1);
                if (scope.picker.slots.length === 0) {
                    scope.picker.slots.push( review.emptySlot() );
                }
            };
            // A slot that is for any one of several names: start with two to pick, never fewer.
            scope.slotAnyChanged = (slot) => {
                while (slot.any && (slot.members.length < 2) ) {
                    slot.members.push( review.emptySlot() );
                }
            };
            scope.addMember = (members) => {
                if (members.length < clipNames.MAX_ANY_OF) {
                    members.push( review.emptySlot() );
                }
            };
            scope.removeMember = (members, i) => {
                if (members.length > 2) {
                    members.splice(i, 1);
                }
            };
            scope.canAddMember = (members) => members.length < clipNames.MAX_ANY_OF;
            // What a member row (the name-member directive) is given: the same shows, custom shows and
            // movies a single name can be, and the seasons of a show.
            scope.slotShowChanged = (slot) => {
                slot.kind = 'all';
                slot.picked = {};
                slot.special = '';
                seasons.ensure(slot.key);
            };
            // What a slot reads as once it is used, shown under it.
            scope.slotReads = (slot) => {
                const name = (review.slotProblem(slot) === null) ? nameOfSlot(slot) : null;
                return (name === null) ? '' : nameLabel(name);
            };

            // ---- a show's seasons: Plex's titles and folders, else the lineups' ------
            // Asked for when a show with seasons is picked; kept for the life of the screen (see
            // web/season-source.js). The same source serves a single name and every member of an any-of.
            const seasons = seasonSource(dizquetv, $timeout);
            scope.seasonInfo = seasons.info;
            const ensureSeasons = seasons.ensure;
            scope.seasonChoices = seasons.choices;
            scope.specialChoices = seasons.specials;
            scope.hasParts = seasons.hasParts;
            scope.partsState = seasons.state;
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
            const GROUP_ORDER = { 'Shows': 0, 'Custom shows': 1, 'Movies': 2 };
            let pickableFor = null;
            let pickable = [];
            scope.optionsFor = (current) => {
                if (pickableFor !== scope.shows) {
                    pickableFor = scope.shows;
                    pickable = scope.shows.slice().sort( (a, b) => ((GROUP_ORDER[a.group] || 0) - (GROUP_ORDER[b.group] || 0)) || a.name.localeCompare(b.name) );
                }
                const filter = (scope.picker != null) ? scope.picker.filter : (scope.teach != null ? scope.teach.filter : '');
                const q = (filter || '').trim().toLowerCase();
                const out = pickable.filter( (s) => (q === '') || (s.name.toLowerCase().indexOf(q) !== -1) || (s.key === current) );
                if ( current && ! out.some( (s) => s.key === current) ) {
                    if (! extras.has(current) ) {
                        extras.set(current, { key: current, name: showName(current), custom: false, group: 'Shows' });
                    }
                    out.unshift(extras.get(current));
                }
                return out;
            };
            scope.showLabel = (s) => s.custom ? `${s.name} (custom show)` : ( s.inCustomShow ? `${s.name} (in ${s.inCustomShow})` : s.name );
            // What every member row of an any-of is given (web/directives/name-member.js): the same
            // choices as a single name, in the picker and in the teach panel.
            scope.memberSource = { options: scope.optionsFor, label: scope.showLabel, ensure: seasons.ensure, hasParts: seasons.hasParts,
                choices: seasons.choices, specials: seasons.specials, state: seasons.state };
            // A slot's problem in words. In an any-of it may be one member's (the first that has one).
            const anyOfWords = (trouble, slot) => {
                const culprit = (slot.any === true) ? ((slot.members || []).find( (m) => review.slotProblem(m) !== null ) || slot) : slot;
                const of = culprit.key ? showName(culprit.key) : 'the show';
                const ANY = '“Any one of these”';
                return (trouble === 'a show has not been picked') ? 'Pick a show or a movie for every box, or remove the empty one.'
                    : (trouble === 'the same name is picked twice in an any-of') ? `The same name is picked twice in ${ANY}.`
                    : (trouble === 'an any-of needs two names') ? `${ANY} needs at least two names.`
                    : (trouble === 'a whole show and a part of the same show are both in an any-of') ? `${ANY} has a whole show and a part of the same show: keep just one of them.`
                    : (trouble === 'no season is ticked') ? `Tick at least one season of ${of}, or choose “Any episode”.`
                    : (trouble === 'no special is picked') ? `Pick which special of ${of}, or choose “Any episode”.`
                    : trouble.charAt(0).toUpperCase() + trouble.slice(1) + '.';
            };
            scope.applyPicker = () => {
                const p = scope.picker;
                for (const slot of p.slots) {
                    const trouble = review.slotProblem(slot);
                    if (trouble !== null) {
                        p.error = anyOfWords(trouble, slot);
                        return;
                    }
                }
                const picks = p.slots.map(nameOfSlot);
                const problem = review.picksProblem(picks);
                if (problem !== null) {
                    p.error = (problem === 'the same show is picked twice in a row') ? 'The same show cannot be picked twice in a row.' : problem;
                    return;
                }
                scope.pending[p.index] = { names: picks };
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
            // A nickname means a show or some seasons of a tv show, never a movie: the show the clip
            // names first, and its seasons when the clip names them.
            const firstShow = (row) => {
                const eff = review.effective(row, scope.pending);
                // a flagged clip names nothing yet, but says which show it recognised
                const name = (eff.names.length > 0) ? eff.names[0]
                    : ( (row.proposal.unresolved != null) && (row.proposal.unresolved.recognised.length > 0) ? row.proposal.unresolved.recognised[0] : null );
                if (clipNames.isAnyOfName(name) ) {
                    return { key: null, picked: {}, anyOf: name.anyOf.slice() };
                }
                const key = (name == null) ? null : clipNames.showOf(name);
                if ( (key == null) || /^movie[.]/.test(key) ) {
                    return { key: null, picked: {}, anyOf: null };
                }
                const picked = {};
                for (const n of clipNames.seasonsOf(name) ) {
                    picked[n] = true;
                }
                return { key: key, picked: picked, anyOf: null };
            };
            // The names a nickname for any one of several is for (a show, a movie, seasons of a show or
            // a special each), or undefined when it is not.
            const teachAnyOf = () => {
                const t = scope.teach;
                return ( (t != null) && (t.kind === 'anyOf') ) ? t.members.map(review.slotName).filter( (n) => n !== null ) : undefined;
            };
            const anyOfProblem = (members) => {
                const slot = { any: true, members: members };
                const why = review.slotProblem(slot);
                return (why === null) ? null : anyOfWords(why, slot);
            };
            // The seasons the nickname is for, or undefined for the whole show.
            const teachSeasons = () => {
                const t = scope.teach;
                return ( (t != null) && /^tv[.]/.test(t.showKey || '') && (t.kind === 'seasons') ) ? review.pickedSeasons(t) : undefined;
            };
            scope.openTeach = (row) => {
                scope.picker = null;
                const first = firstShow(row);
                scope.teach = { index: row.index, title: row.title, showKey: first.key,
                    kind: (first.anyOf !== null) ? 'anyOf' : ( (Object.keys(first.picked).length > 0) ? 'seasons' : 'all' ), picked: first.picked,
                    members: (first.anyOf !== null) ? first.anyOf.map(review.slotOfName) : [ review.emptySlot(), review.emptySlot() ],
                    text: '', suggestions: [], check: null, busy: false, filter: '', error: '' };
                if (scope.teach.showKey || (first.anyOf !== null) ) {
                    ensureSeasons(scope.teach.showKey);
                    scope.teach.members.forEach( (m) => ensureSeasons(m.key) );
                    loadSuggestions();
                }
            };
            scope.closeTeach = () => { scope.teach = null; };
            const loadSuggestions = async () => {
                const t = scope.teach;
                if ( (t == null) || ( ! t.showKey && (teachAnyOf() === undefined) ) ) {
                    return;
                }
                if ( (t.kind === 'anyOf') && (anyOfProblem(t.members) !== null) ) {
                    return;
                }
                try {
                    const got = await dizquetv.getNicknameSuggestions(scope.list.id, { index: t.index, showKey: t.showKey, seasons: teachSeasons(), anyOf: teachAnyOf() });
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
                if ( ((t.text || '').trim() === '') || ( ! t.showKey && (t.kind !== 'anyOf') ) ) {
                    t.check = null;
                    return;
                }
                if (t.kind === 'anyOf') {
                    const problem = anyOfProblem(t.members);
                    if (problem !== null) {
                        t.check = null;
                        t.error = problem;
                        return;
                    }
                }
                if ( (t.kind === 'seasons') && (teachSeasons().length === 0) ) {
                    t.check = null;
                    t.error = 'Tick at least one season, or choose \u201cThe whole show\u201d.';
                    return;
                }
                t.busy = true;
                try {
                    const result = await dizquetv.checkNickname(scope.list.id, { text: t.text, showKey: t.showKey, seasons: teachSeasons(), anyOf: teachAnyOf(), index: t.index });
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
                scope.teach.kind = 'all';
                scope.teach.picked = {};
                ensureSeasons(scope.teach.showKey);
                loadSuggestions();
                runCheck();
            };
            // The season (or none) a nickname is for changed: what the title offers and what the
            // nickname would do both depend on it.
            scope.teachSeasonChanged = () => {
                if ( (scope.teach.kind === 'anyOf') && (scope.teach.members.length < 2) ) {
                    scope.teach.members.push( review.emptySlot() );
                }
                scope.teach.suggestions = [];
                scope.teach.check = null;
                scope.teach.error = '';
                loadSuggestions();
                runCheck();
            };
            scope.teachChoices = () => (scope.teach == null) ? [] : seasons.choices( { key: scope.teach.showKey, picked: scope.teach.picked } );
            scope.teachReads = () => {
                const anyOf = teachAnyOf();
                const target = (scope.teach == null) ? null
                    : ( (anyOf !== undefined) ? ( (anyOfProblem(scope.teach.members) === null) ? review.nicknameTarget( { anyOf: anyOf } ) : null )
                        : review.nicknameTarget( { showKey: scope.teach.showKey, seasons: teachSeasons() } ) );
                return (target == null) ? '' : nameLabel(target);
            };
            // Picking one of the shows of a nickname for any one of several changes what it would do.
            scope.teachMemberChanged = () => {
                scope.teach.suggestions = [];
                scope.teach.check = null;
                scope.teach.error = '';
                loadSuggestions();
                runCheck();
            };
            scope.teachHasSeasons = () => (scope.teach != null) && /^tv[.]/.test(scope.teach.showKey || '');
            scope.teachSeasonState = () => (scope.teach == null) ? undefined : scope.seasonInfo[scope.teach.showKey];
            // The names the folders of a show's seasons suggest, as a hint only: one click
            // fills the nickname box (and picks its season), and the usual checks run on it.
            scope.teachHints = () => {
                const info = (scope.teach == null) ? null : scope.seasonInfo[scope.teach.showKey];
                if ( (info == null) || (info.data == null) ) {
                    return [];
                }
                return info.data.seasons.filter( (s) => s.hint != null );
            };
            scope.useHint = (season) => {
                scope.teach.kind = 'seasons';
                scope.teach.picked = {};
                scope.teach.picked[season.index] = true;
                scope.teach.text = season.hint.alias;
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
                const kept = (scope.teach && scope.teach.kind === 'anyOf') ? scope.teach.members.map( (m) => m.key ) : [current];
                return scope.shows.filter( (s) => (s.movie !== true) && ( (q === '') || (s.name.toLowerCase().indexOf(q) !== -1) || kept.includes(s.key) ) );
            };
            scope.canAddNickname = () => (scope.teach != null) && (scope.teach.check != null) && (scope.teach.check.ok === true)
                && ! scope.nicknames.some( (n) => n.alias === scope.teach.check.alias );
            scope.addNickname = () => {
                const t = scope.teach;
                const check = t.check;
                const target = review.nicknameTarget( { showKey: t.showKey, seasons: teachSeasons(), anyOf: teachAnyOf() } );
                scope.nicknames.push( { alias: check.alias, text: t.text.trim(), target: target, showName: nameLabel(target) } );
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
