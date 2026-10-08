const clipNames = require('../../src/clip-names');
const review = require('../../src/names-review');
const seasonSource = require('../season-source');

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
    const seasons = seasonSource(dizquetv, $timeout);

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
            members: anyOf ? row.target.anyOf.map(review.slotOfName) : [ review.emptySlot(), review.emptySlot() ],
            preview: null, busy: false, saving: false, error: '',
        };
        $scope.shownChanges = SHOWN;
        $scope.notice = '';
        seasons.ensure($scope.panel.showKey);
        $scope.panel.members.forEach( (m) => seasons.ensure(m.key) );
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
    // A member's (or the list's) problem in words.
    const troubleWords = (trouble, members) => {
        const bad = members.find( (m) => review.slotProblem(m) !== null );
        const of = (bad && bad.key) ? clipNames.labelOf(bad.key, $scope.showNames) : 'the show';
        return (trouble === 'a show has not been picked') ? 'Pick a show or a movie for every box, or remove the empty one.'
            : (trouble === 'the same name is picked twice in an any-of') ? 'The same name is picked twice.'
            : (trouble === 'an any-of needs two names') ? 'Pick at least two names.'
            : (trouble === 'a whole show and a part of the same show are both in an any-of') ? 'A whole show and a part of the same show are both picked: keep just one of them.'
            : (trouble === 'no season is ticked') ? `Tick at least one season of ${of}, or choose “Any episode”.`
            : (trouble === 'no special is picked') ? `Pick which special of ${of}, or choose “Any episode”.`
            : trouble.charAt(0).toUpperCase() + trouble.slice(1) + '.';
    };
    // The request for the panel as it stands, or a sentence about what is missing.
    const requestOf = (panel) => {
        if (panel.mode === 'delete') {
            return { body: { alias: panel.alias, remove: true } };
        }
        const body = { alias: panel.alias, newAlias: panel.text };
        if (panel.kind === 'anyOf') {
            const trouble = review.slotProblem( { any: true, members: panel.members } );
            if (trouble !== null) {
                return { problem: troubleWords(trouble, panel.members) };
            }
            body.anyOf = panel.members.map(review.slotName);
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
        while ( (panel.kind === 'anyOf') && (panel.members.length < 2) ) {
            panel.members.push( review.emptySlot() );
        }
        if ( (panel.kind !== 'anyOf') && panel.showKey ) {
            seasons.ensure(panel.showKey);
        }
        $scope.changed(false);
    };
    $scope.showChanged = () => {
        const panel = $scope.panel;
        panel.kind = 'all';
        panel.picked = {};
        seasons.ensure(panel.showKey);
        $scope.changed(false);
    };
    $scope.addMember = () => {
        if ($scope.panel.members.length < clipNames.MAX_ANY_OF) {
            $scope.panel.members.push( review.emptySlot() );
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
    // A nickname for one show never means a movie; a member of an any-of can.
    const optionsOf = (current, withMovies) => {
        const q = (($scope.panel && $scope.panel.filter) || '').trim().toLowerCase();
        const keep = ($scope.panel && ($scope.panel.kind === 'anyOf')) ? $scope.panel.members.map( (m) => m.key ) : [current];
        const out = $scope.shows.filter( (s) => (withMovies || (s.movie !== true)) && ( (q === '') || (s.name.toLowerCase().indexOf(q) !== -1) || keep.includes(s.key) ) );
        if ( current && ! out.some( (s) => s.key === current) ) {
            if (! extras.has(current) ) {
                extras.set(current, { key: current, name: clipNames.labelOf(current, $scope.showNames), custom: false, group: 'Shows' });
            }
            out.unshift(extras.get(current));
        }
        return out;
    };
    $scope.optionsFor = (current) => optionsOf(current, false);
    $scope.showLabel = (s) => s.custom ? `${s.name} (custom show)` : ( s.inCustomShow ? `${s.name} (in ${s.inCustomShow})` : s.name );
    // What every member row of an any-of is given (web/directives/name-member.js).
    $scope.memberSource = { options: (current) => optionsOf(current, true), label: $scope.showLabel, ensure: seasons.ensure,
        hasParts: seasons.hasParts, choices: seasons.choices, specials: seasons.specials, state: seasons.state };

    // ---- a show's seasons, from Plex or the lineups (web/season-source.js) ------------------
    $scope.seasonChoices = () => {
        const panel = $scope.panel;
        return ( (panel == null) || (panel.mode !== 'edit') ) ? [] : seasons.choices( { key: panel.showKey, picked: panel.picked } );
    };
    $scope.hasSeasons = () => ($scope.panel != null) && seasons.hasParts( { key: $scope.panel.showKey } );
    $scope.seasonState = () => ($scope.panel == null) ? undefined : seasons.state( { key: $scope.panel.showKey } );

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
