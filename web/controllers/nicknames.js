const clipNames = require('../../src/clip-names');
const review = require('../../src/names-review');

/*
 * The Nicknames page (docs/blocks-spec.md, Stage 5, "Which shows a clip names"): every
 * nickname with what it means, where one can be edited (its text, what it means, or both) or
 * deleted. A nickname only changes what is *suggested* for clips whose names are not saved, so
 * editing or deleting one never rewrites a name already saved on a clip. Before anything is
 * saved the page asks the server what would change (POST /api/nicknames/preview, which
 * writes nothing) and lists those clips, the way the teach panel on the review screen does.
 */
module.exports = function ($scope, $timeout, dizquetv) {
    const SHOWN = 12;

    $scope.loading = true;
    $scope.error = '';
    $scope.notice = '';
    $scope.rows = [];
    $scope.shows = [];
    $scope.showNames = {};
    $scope.search = '';
    $scope.panel = null;
    $scope.shownChanges = SHOWN;

    const nameLabel = (name) => clipNames.labelOf(name, $scope.showNames);
    $scope.nameLabel = nameLabel;

    // ---- the list --------------------------------------------------------------------
    const load = async () => {
        try {
            const data = await dizquetv.getNicknames();
            $scope.rows = data.nicknames;
            $scope.shows = data.shows;
            $scope.showNames = data.showNames;
            $scope.error = '';
        } catch (err) {
            console.error(err);
            $scope.error = 'Unable to read the nicknames. Reload the page to try again.';
        } finally {
            $scope.loading = false;
            $timeout();
        }
    };
    load();

    $scope.visible = () => {
        const q = ($scope.search || '').trim().toLowerCase();
        return $scope.rows.filter( (r) => (q === '') || (r.alias.indexOf(q) !== -1) || (r.label.toLowerCase().indexOf(q) !== -1) );
    };
    $scope.kindLabel = (row) => ({ show: 'a show', seasons: 'some seasons', anyOf: 'any one of several' }[row.kind]);

    // ---- one open panel: edit or delete ---------------------------------------------------
    const pickedOf = (target) => {
        const picked = {};
        for (const n of clipNames.seasonsOf(target) ) {
            picked[n] = true;
        }
        return picked;
    };
    $scope.openEdit = (row) => {
        const anyOf = clipNames.isAnyOfName(row.target);
        $scope.panel = {
            mode: 'edit', alias: row.alias, text: row.alias, filter: '',
            kind: anyOf ? 'anyOf' : (clipNames.seasonsOf(row.target).length > 0 ? 'seasons' : 'all'),
            showKey: anyOf ? null : clipNames.showOf(row.target), picked: pickedOf(row.target),
            members: anyOf ? row.target.anyOf.map( (k) => ({ key: k }) ) : [ { key: null }, { key: null } ],
            preview: null, busy: false, saving: false, error: '',
        };
        $scope.shownChanges = SHOWN;
        $scope.notice = '';
        ensureSeasons($scope.panel.showKey);
        runPreview();
    };
    $scope.openDelete = (row) => {
        $scope.panel = { mode: 'delete', alias: row.alias, preview: null, busy: false, saving: false, error: '' };
        $scope.shownChanges = SHOWN;
        $scope.notice = '';
        runPreview();
    };
    $scope.close = () => {
        $scope.panel = null;
    };
    $scope.isOpen = (row) => ($scope.panel != null) && ($scope.panel.alias === row.alias);

    // ---- what it means: a show, some of its seasons, or any one of several shows -----------
    const pickedSeasons = (panel) => review.pickedSeasons(panel);
    // The request for the panel as it stands, or a sentence about what is missing.
    const requestOf = (panel) => {
        if (panel.mode === 'delete') {
            return { body: { alias: panel.alias, remove: true } };
        }
        const body = { alias: panel.alias, newAlias: panel.text };
        if (panel.kind === 'anyOf') {
            const keys = panel.members.map( (m) => m.key );
            if (keys.some( (k) => ! k )) {
                return { problem: 'Pick a show for every box, or remove the empty one.' };
            }
            if (new Set(keys).size !== keys.length) {
                return { problem: 'The same show is picked twice.' };
            }
            if (keys.length < 2) {
                return { problem: 'Pick at least two shows.' };
            }
            body.anyOf = keys;
        } else {
            if (! panel.showKey) {
                return { problem: 'Pick the show it means.' };
            }
            body.showKey = panel.showKey;
            if ( (panel.kind === 'seasons') && /^tv[.]/.test(panel.showKey) ) {
                const seasons = pickedSeasons(panel);
                if (seasons.length === 0) {
                    return { problem: 'Tick at least one season, or choose “The whole show”.' };
                }
                body.seasons = seasons;
            }
        }
        return { body: body };
    };
    $scope.reads = () => {
        const panel = $scope.panel;
        if ( (panel == null) || (panel.mode !== 'edit') ) {
            return '';
        }
        const asked = requestOf(panel);
        if (asked.body === undefined) {
            return '';
        }
        const target = review.nicknameTarget(asked.body);
        return (target == null) ? '' : nameLabel(target);
    };

    let serial = 0;
    let typing = null;
    const runPreview = async () => {
        const panel = $scope.panel;
        if (panel == null) {
            return;
        }
        const mine = ++serial;
        const asked = requestOf(panel);
        if (asked.body === undefined) {
            panel.preview = null;
            panel.error = asked.problem;
            return;
        }
        panel.error = '';
        panel.busy = true;
        try {
            const result = await dizquetv.previewNickname(asked.body);
            if ( (mine === serial) && ($scope.panel === panel) ) {
                panel.preview = result;
            }
        } catch (err) {
            console.error(err);
            if ( (mine === serial) && ($scope.panel === panel) ) {
                panel.preview = null;
                panel.error = 'Unable to check that. Nothing was changed.';
            }
        } finally {
            if ($scope.panel === panel) {
                panel.busy = false;
            }
            $timeout();
        }
    };
    // Anything the person changes in the panel asks again what it would do.
    $scope.changed = (soon) => {
        const panel = $scope.panel;
        panel.preview = null;
        panel.error = '';
        if (typing !== null) {
            $timeout.cancel(typing);
        }
        typing = $timeout(runPreview, soon ? 350 : 0);
    };
    $scope.kindChanged = () => {
        const panel = $scope.panel;
        if ( (panel.kind === 'anyOf') && (panel.members.length < 2) ) {
            panel.members.push( { key: null } );
        }
        if ( (panel.kind !== 'anyOf') && panel.showKey ) {
            ensureSeasons(panel.showKey);
        }
        $scope.changed(false);
    };
    $scope.showChanged = () => {
        const panel = $scope.panel;
        panel.kind = 'all';
        panel.picked = {};
        ensureSeasons(panel.showKey);
        $scope.changed(false);
    };
    $scope.addMember = () => {
        if ($scope.panel.members.length < clipNames.MAX_ANY_OF) {
            $scope.panel.members.push( { key: null } );
        }
    };
    $scope.removeMember = (i) => {
        if ($scope.panel.members.length > 2) {
            $scope.panel.members.splice(i, 1);
            $scope.changed(false);
        }
    };
    $scope.canAddMember = () => ($scope.panel != null) && ($scope.panel.members.length < clipNames.MAX_ANY_OF);

    // The shows a select offers: the ones the filter allows plus whatever is picked, one option
    // object per show kept between digests so ng-options settles.
    const extras = new Map();
    $scope.optionsFor = (current) => {
        const q = (($scope.panel && $scope.panel.filter) || '').trim().toLowerCase();
        const keep = ($scope.panel && ($scope.panel.kind === 'anyOf')) ? $scope.panel.members.map( (m) => m.key ) : [current];
        const out = $scope.shows.filter( (s) => (q === '') || (s.name.toLowerCase().indexOf(q) !== -1) || keep.includes(s.key) );
        if ( current && ! out.some( (s) => s.key === current) ) {
            if (! extras.has(current) ) {
                extras.set(current, { key: current, name: clipNames.labelOf(current, $scope.showNames), custom: false, group: 'Shows' });
            }
            out.unshift(extras.get(current));
        }
        return out;
    };
    $scope.showLabel = (s) => s.custom ? `${s.name} (custom show)` : s.name;

    // ---- a show's seasons, from Plex or the lineups ----------------------------------------
    $scope.seasonInfo = {};
    const ensureSeasons = async (key) => {
        if ( ! key || ! /^tv[.]/.test(key) || (typeof($scope.seasonInfo[key]) !== 'undefined') ) {
            return;
        }
        const info = { loading: true, choices: [], error: '' };
        $scope.seasonInfo[key] = info;
        try {
            const data = await dizquetv.getShowSeasons(key);
            for (const season of data.seasons) {
                info.choices.push( { index: season.index, label: season.label } );
            }
        } catch (err) {
            console.error(err);
            info.error = 'Unable to read this show’s seasons.';
        } finally {
            info.loading = false;
            $timeout();
        }
    };
    const extraChoices = new Map();
    $scope.seasonChoices = () => {
        const panel = $scope.panel;
        if ( (panel == null) || (panel.mode !== 'edit') ) {
            return [];
        }
        const info = $scope.seasonInfo[panel.showKey];
        const base = (info == null) ? [] : info.choices;
        const missing = pickedSeasons(panel).filter( (n) => ! base.some( (c) => c.index === n ) );
        if (missing.length === 0) {
            return base;
        }
        const once = panel.showKey + '|' + base.length + '|' + missing.join(',');
        if (! extraChoices.has(once) ) {
            extraChoices.set(once, base.concat( missing.map( (n) => ({ index: n, label: n === 0 ? 'Specials' : 'Season ' + n }) ) ).sort( (a, b) => a.index - b.index ));
        }
        return extraChoices.get(once);
    };
    $scope.hasSeasons = () => ($scope.panel != null) && /^tv[.]/.test($scope.panel.showKey || '');
    $scope.seasonState = () => ($scope.panel == null) ? undefined : $scope.seasonInfo[$scope.panel.showKey];

    // ---- saving ---------------------------------------------------------------------------
    $scope.canSave = () => ($scope.panel != null) && ($scope.panel.preview != null) && ($scope.panel.preview.ok === true)
        && ! $scope.panel.busy && ! $scope.panel.saving;
    $scope.moreChanges = (preview) => Math.max(0, preview.changed - $scope.shownChanges);
    $scope.showMoreChanges = () => { $scope.shownChanges += 40; };
    $scope.save = async () => {
        const panel = $scope.panel;
        if ( ! $scope.canSave() ) {
            return;
        }
        const asked = requestOf(panel);
        if (asked.body === undefined) {
            return;
        }
        panel.saving = true;
        const deleted = panel.mode === 'delete';
        const alias = panel.alias;
        try {
            const data = await dizquetv.saveNickname(asked.body);
            $scope.rows = data.nicknames;
            $scope.shows = data.shows;
            $scope.showNames = data.showNames;
            $scope.panel = null;
            $scope.notice = deleted ? `Deleted “${alias}”.` : `Saved “${alias}”.`;
            $scope.notice += ' No name saved on a clip was changed.';
        } catch (err) {
            console.error(err);
            panel.error = (err && err.data && err.data.error) ? err.data.error : 'Unable to save. Nothing was changed.';
        } finally {
            panel.saving = false;
            $timeout();
        }
    };
};
