/*
 * The Transitions section of a day-part or block card: four rows (Leaving,
 * Entering, Between episodes, Between shows), each reading in the order the break
 * plays - steps before it, Flex, steps after - and a preview that walks the
 * lineup in the editor and shows what each break would play. See
 * docs/blocks-spec.md, Stage 5, "Editor".
 *
 * Everything that is not drawing lives in src/transitions-editor.js and is
 * tested there; the preview calls the same buildPlan playback does. This file
 * holds the form's state and does the fetching.
 *
 * The form edits a draft (every situation present, every step carrying every
 * field) and writes it to context.transitions only when something is changed, so
 * a card nobody touches is saved byte for byte as it was. Each change also tells
 * the channel editor ('transitionsChanged') so the tags on its Flex rows follow.
 */
const editor = require('../../src/transitions-editor');
const transitions = require('../../src/transitions');

module.exports = function ($timeout, dizquetv) {
    return {
        restrict: 'E',
        templateUrl: 'templates/transitions-editor.html',
        replace: true,
        scope: {
            context: '=context',
            channel: '=channel',
            fillerOptions: '=fillerOptions',
            listsLoaded: '=listsLoaded',
            kind: '@kind',
        },
        link: function (scope, element, attrs) {
            const hadStored = (scope.context != null) && (typeof(scope.context.transitions) !== 'undefined');
            scope.draft = editor.loadDraft(scope.context);
            scope.open = false;
            scope.form = null;
            scope.notice = '';
            scope.which = editor.WHICH;
            scope.weekDays = editor.DAY_NAMES.map( (name, id) => ({ id: id, name: name }) );
            scope.usePreviewNames = true;
            scope.preview = { busy: false, error: '', sections: null, header: '', stale: false };

            const words = (scope.kind === 'block') ? 'block' : 'day-part';
            scope.situations = [
                { id: 'leaving', title: 'Leaving', hint: `the last break out of this ${words}, into something else` },
                { id: 'entering', title: 'Entering', hint: `the first break into this ${words}, from something else` },
                { id: 'betweenEpisodes', title: 'Between episodes', hint: 'the same show comes back after the break' },
                { id: 'betweenShows', title: 'Between shows', hint: 'a different show follows' },
            ];

            // Until the real list names arrive the options carry placeholders,
            // so a step's list is not reported missing just because it has not
            // been looked up yet.
            const names = {
                listName: (id) => {
                    const found = (scope.fillerOptions || []).find( (o) => o.id === id );
                    if (typeof(found) !== 'undefined') {
                        return (scope.listsLoaded === true) ? found.name : (found.name || '…');
                    }
                    return (scope.listsLoaded === true) ? null : '…';
                },
            };

            const sequence = (situation) => editor.stepsOf(scope.draft, situation);

            scope.count = () => editor.stepCount(scope.draft);
            scope.summaryLine = () => {
                const parts = [];
                for (const s of scope.situations) {
                    const n = sequence(s.id).length;
                    if (n > 0) {
                        parts.push(`${s.title.toLowerCase()} ${n}`);
                    }
                }
                return parts.join(', ');
            };
            scope.toggleOpen = () => { scope.open = ! scope.open; };

            scope.chip = (step, situation) => editor.chipLabel(step, sequence(situation), names);
            scope.chipBad = (step, situation) => editor.problemsOf(step, sequence(situation), names).length > 0;

            const changed = () => {
                editor.commit(scope.context, scope.draft, hadStored);
                scope.preview.stale = (scope.preview.sections !== null);
                scope.$emit('transitionsChanged');
            };

            // ---- the open step's form ---------------------------------------
            const rebuildChoices = () => {
                if (scope.form === null) {
                    return;
                }
                const lists = (scope.fillerOptions || []).filter( (o) => o.id !== 'none' );
                const choicesFor = (selected) => {
                    const out = lists.slice();
                    if ( (selected !== null) && ! lists.some( (o) => o.id === selected ) && (scope.listsLoaded === true) ) {
                        out.push( { id: selected, name: '(a list that no longer exists)' } );
                    }
                    return out;
                };
                scope.listChoices = choicesFor(scope.form.listId);
                scope.fallbackChoices = choicesFor(scope.form.fallback);
                const draft = scope.draft;
                const situation = scope.form.situation;
                scope.markChoices = editor.markOptions(draft, situation, scope.form.step)
                    .map( (s) => ({ id: s.id, name: `only when “${editor.stepListName(s, names)}” (${draft[situation].out.indexOf(s) !== -1 ? 'before' : 'after'} the break) found nothing` }) );
                scope.form.watched = editor.isWatched(scope.draft, scope.form.situation, scope.form.step);
            };

            scope.edit = (step, situation) => {
                scope.notice = '';
                if ( (scope.form !== null) && (scope.form.step === step) ) {
                    scope.form = null;
                    return;
                }
                scope.form = {
                    situation: situation,
                    step: step,
                    // null, not '', is "none" in the form: the blank option an
                    // <select ng-options> shows is the one matching null.
                    listId: step.listId || null,
                    fallback: step.fallbackListId || null,
                    which: editor.whichOf(step),
                    mark: editor.isMarked(step) ? step.onlyIfNoMatch : null,
                    chance: (step.chance == null) ? '' : String(step.chance),
                    chanceError: '',
                    watched: false,
                };
                rebuildChoices();
            };

            scope.add = (situation, side) => {
                const step = editor.addStep(scope.draft, situation, side, editor.newStep(scope.draft));
                changed();
                scope.edit(step, situation);
            };

            scope.formChanged = (field) => {
                const f = scope.form;
                const step = f.step;
                if (field === 'list') {
                    step.listId = f.listId || '';
                } else if (field === 'fallback') {
                    step.fallbackListId = f.fallback || null;
                } else if (field === 'which') {
                    editor.setWhich(step, f.which);
                } else if (field === 'mark') {
                    if (! editor.setMark(scope.draft, f.situation, step, f.mark) ) {
                        f.mark = editor.isMarked(step) ? step.onlyIfNoMatch : null;
                    }
                } else if (field === 'chance') {
                    const parsed = editor.setChance(step, f.chance);
                    f.chanceError = parsed.ok ? '' : parsed.error;
                }
                changed();
                rebuildChoices();
            };

            scope.isDay = (day) => editor.isDaySelected(scope.form.step, day);
            scope.toggleDay = (day) => {
                editor.toggleDay(scope.form.step, day);
                changed();
            };

            scope.describe = () => editor.describeStep(scope.form.step, sequence(scope.form.situation), names);
            scope.problems = () => editor.problemsOf(scope.form.step, sequence(scope.form.situation), names);
            scope.supported = () => editor.isSupported(scope.form.step);

            scope.move = (side, delta) => {
                const f = scope.form;
                editor.moveStep(scope.draft, f.situation, side, f.step, delta);
                changed();
            };
            scope.sideOf = () => (scope.draft[scope.form.situation].out.indexOf(scope.form.step) !== -1) ? 'out' : 'in';

            scope.remove = () => {
                const f = scope.form;
                const cleared = editor.removeStep(scope.draft, f.situation, f.step);
                scope.form = null;
                scope.notice = (cleared.length === 0) ? ''
                    : `Step deleted. ${cleared.length === 1 ? 'Another step was' : cleared.length + ' other steps were'} set to play only when it found nothing, and now play${cleared.length === 1 ? 's' : ''} always.`;
                changed();
            };

            scope.$watch('fillerOptions', rebuildChoices);
            scope.$watch('listsLoaded', rebuildChoices);

            // ---- the preview ----------------------------------------------------
            const WEEK = 7 * 24 * 60 * 60 * 1000;

            const fetchLists = async (ids, useNames) => {
                const lists = {};
                const featuring = {};
                for (const id of ids) {
                    let clips = null;
                    try {
                        const filler = await dizquetv.getFiller(id);
                        clips = Array.isArray(filler.content) ? filler.content : [];
                        featuring[id] = (filler.clipsFeatureShows === true);
                        if (useNames) {
                            clips = editor.overlayProposedNames(clips, await dizquetv.getFillerMatch(id));
                        }
                    } catch (err) {
                        console.error('Unable to read filler list ' + id, err);
                    }
                    lists[id] = clips;
                }
                return { lists: lists, featuring: featuring };
            };

            scope.runPreview = async () => {
                const channel = scope.channel;
                scope.preview = { busy: true, error: '', sections: null, header: '', stale: false };
                try {
                    if ( (channel.onDemand != null) && (channel.onDemand.isOnDemand === true) ) {
                        scope.preview.error = 'This channel is on-demand, so it has no breaks to preview.';
                        return;
                    }
                    if ( (channel.programs || []).length === 0 ) {
                        scope.preview.error = 'This channel has no lineup yet, so there is nothing to walk.';
                        return;
                    }
                    const useNames = (scope.usePreviewNames === true);
                    const got = await fetchLists(transitions.stepListIds(channel), useNames);
                    const env = {
                        getList: (id) => got.lists[id] || null,
                        lastPlayed: () => 0,
                        featuresShows: (id) => got.featuring[id] === true,
                        listName: names.listName,
                    };
                    const from = Date.now();
                    const view = editor.previewBreaks(channel, scope.context, from, from + WEEK, env);
                    const sections = [];
                    for (const s of scope.situations) {
                        const bucket = view.situations[s.id];
                        sections.push( {
                            id: s.id,
                            title: s.title,
                            total: bucket.total,
                            withSteps: bucket.withSteps,
                            shown: 5,
                            items: bucket.items.map( (i) => ({
                                head: `${editor.clockLabel(i.startTime)}  ${i.prev || '(nothing)'} → ${i.next || '(nothing)'}`,
                                other: (s.id === 'leaving') ? `into ${i.other}` : ((s.id === 'entering') ? `from ${i.other}` : ''),
                                out: i.out.map( (c) => `${c.clip} (${c.seconds}s)` ),
                                in: i.in.map( (c) => `${c.clip} (${c.seconds}s)` ),
                                flex: editor.mmss(i.flexMs),
                                overrun: i.overrun,
                                hasSteps: (i.out.length + i.in.length) > 0,
                                left: i.left.map( (l) => ({ text: `${l.step}: ${l.why}`, problem: l.problem }) ),
                            }) ),
                        } );
                    }
                    const missing = Object.keys(got.lists).filter( (id) => got.lists[id] === null );
                    scope.preview.sections = sections;
                    scope.preview.header = 'Walking the lineup as it is in this editor, from now for 7 days. '
                        + (useNames ? 'Clips are named the way “Match shows” would suggest (nothing is saved). '
                            : 'Using the clip names saved on the lists. ')
                        + 'Where several clips fit, the first in the list is shown; on air the pick rotates.'
                        + (missing.length > 0 ? ` ${missing.length} list${missing.length === 1 ? ' was' : 's were'} not found.` : '');
                } catch (err) {
                    console.error(err);
                    scope.preview.error = 'Unable to build the preview.';
                } finally {
                    scope.preview.busy = false;
                    $timeout();
                }
            };

            scope.visible = (section) => section.items.slice(0, section.shown);
            scope.showMore = (section) => { section.shown = (section.shown === 5) ? section.items.length : 5; };
        },
    };
};
