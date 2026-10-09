/*
 * The Transitions section of a day-part or block card: four rows (Leaving, Entering,
 * Between episodes, Between shows), each reading in the order a break plays - what
 * goes before the commercials, the commercials, what goes right before the show -
 * a Quick setup that builds the usual Between shows steps from three lists, "Copy
 * transitions to..." other cards, and a preview that walks the lineup in the editor
 * and shows what each break would play. See docs/blocks-spec.md, Stage 5, "Editor".
 *
 * Everything that is not drawing lives in src/transitions-editor.js and is tested
 * there; the preview calls the same buildPlan playback does. This file holds the
 * form's state and does the fetching.
 *
 * The form edits a draft (every situation present, every step carrying every
 * field) and writes it to context.transitions only when something is changed, so
 * a card nobody touches is saved byte for byte as it was. Each change also tells
 * the channel editor ('transitionsChanged') so the tags on its Flex rows follow.
 * Copying to another card writes to that card's context and broadcasts
 * 'transitionsCopied', so the editor showing it reloads its draft.
 */
const editor = require('../../src/transitions-editor');
const transitions = require('../../src/transitions');

module.exports = function ($rootScope, $timeout, dizquetv, namesReview) {
    return {
        restrict: 'E',
        templateUrl: 'templates/transitions-editor.html',
        replace: true,
        scope: {
            context: '=context',
            channel: '=channel',
            fillerOptions: '=fillerOptions',
            listsLoaded: '=listsLoaded',
            cardTemplates: '=cardTemplates',
            templatesLoaded: '=templatesLoaded',
            kind: '@kind',
        },
        link: function (scope, element, attrs) {
            let hadStored = (scope.context != null) && (typeof(scope.context.transitions) !== 'undefined');
            scope.draft = editor.loadDraft(scope.context);
            scope.open = false;
            scope.form = null;
            scope.panel = null;       // null, 'quick' or 'copy': the small panels under the heading
            scope.notice = '';
            scope.which = editor.WHICH;
            scope.cardWhich = editor.CARD_WHICH;
            scope.weekDays = editor.DAY_NAMES.map( (name, id) => ({ id: id, name: name }) );
            // Off by default: the preview shows what will air, from the names saved on the lists.
            // Ticked, it overlays the matcher's suggestions in memory (nothing is saved).
            scope.usePreviewNames = false;
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
                templateName: (id) => {
                    const found = (scope.cardTemplates || []).find( (t) => t.id === id );
                    if (typeof(found) !== 'undefined') {
                        return found.name;
                    }
                    return (scope.templatesLoaded === true) ? null : '…';
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

            const changed = () => {
                editor.commit(scope.context, scope.draft, hadStored);
                scope.preview.stale = (scope.preview.sections !== null); scope.preview.staleNames = false;
                scope.$emit('transitionsChanged');
            };

            scope.chip = (step, situation) => editor.chipLabel(step, sequence(situation), names);
            scope.chipBad = (step, situation) => editor.problemsOf(step, sequence(situation), names).length > 0;

            // ---- the open step's form ---------------------------------------
            const rebuildChoices = () => {
                const lists = (scope.fillerOptions || []).filter( (o) => o.id !== 'none' );
                scope.allLists = lists;
                if (scope.form === null) {
                    return;
                }
                const choicesFor = (selected) => {
                    const out = lists.slice();
                    if ( (selected !== null) && ! lists.some( (o) => o.id === selected ) && (scope.listsLoaded === true) ) {
                        out.push( { id: selected, name: '(a list that no longer exists)' } );
                    }
                    return out;
                };
                scope.listChoices = choicesFor(scope.form.listId);
                scope.fallbackChoices = choicesFor(scope.form.fallback);
                const templates = (scope.cardTemplates || []).map( (t) => ({ id: t.id, name: t.name }) );
                if ( (scope.form.templateId !== null) && ! templates.some( (t) => t.id === scope.form.templateId ) && (scope.templatesLoaded === true) ) {
                    templates.push( { id: scope.form.templateId, name: '(a template that no longer exists)' } );
                }
                scope.templateChoices = templates;
                const draft = scope.draft;
                const situation = scope.form.situation;
                scope.markChoices = editor.markOptions(draft, situation, scope.form.step)
                    .map( (s) => ({ id: s.id, name: `only when “${editor.stepListName(s, names)}” (${draft[situation].out.indexOf(s) !== -1 ? 'before the commercials' : 'after the commercials'}) found nothing` }) );
                scope.form.watched = editor.isWatched(scope.draft, scope.form.situation, scope.form.step);
            };

            // Leaving a step's form. A step that was added but never given a list
            // is taken out rather than left half-made (and red).
            const closeForm = () => {
                if (scope.form === null) {
                    return;
                }
                const f = scope.form;
                scope.form = null;
                const closed = editor.closeStep(scope.draft, f.situation, f.step);
                if (closed.removed) {
                    scope.notice = (f.step.kind === 'generated') ? 'That card step had no template chosen, so it was removed.'
                        : 'That step had no list chosen, so it was removed.';
                    changed();
                }
            };
            scope.done = closeForm;

            scope.edit = (step, situation) => {
                scope.notice = '';
                if ( (scope.form !== null) && (scope.form.step === step) ) {
                    closeForm();
                    return;
                }
                closeForm();
                scope.panel = null;
                scope.form = {
                    situation: situation,
                    step: step,
                    // null, not '', is "none" in the form: the blank option an
                    // <select ng-options> shows is the one matching null.
                    kind: step.kind,
                    listId: step.listId || null,
                    fallback: step.fallbackListId || null,
                    templateId: step.templateId || null,
                    which: editor.whichOf(step),
                    mark: editor.isMarked(step) ? step.onlyIfNoMatch : null,
                    chance: (step.chance == null) ? '' : String(step.chance),
                    chanceError: '',
                    watched: false,
                };
                rebuildChoices();
            };

            scope.add = (situation, side) => {
                closeForm();
                const step = editor.addStep(scope.draft, situation, side, editor.newStep(scope.draft));
                changed();
                scope.edit(step, situation);
            };

            scope.toggleOpen = () => {
                if (scope.open) {
                    closeForm();
                    scope.panel = null;
                }
                scope.open = ! scope.open;
            };

            scope.formChanged = (field) => {
                const f = scope.form;
                const step = f.step;
                if (field === 'kind') {
                    editor.setKind(step, f.kind);
                    f.which = editor.whichOf(step);
                    f.listId = null;
                    f.fallback = null;
                    f.templateId = null;
                } else if (field === 'template') {
                    step.templateId = f.templateId || '';
                } else if (field === 'list') {
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

            // ---- Quick setup ------------------------------------------------------
            scope.openQuick = () => {
                closeForm();
                scope.notice = '';
                scope.open = true;
                scope.panel = 'quick';
                scope.quick = { promo: null, upNext: null, fallback: null };
                rebuildChoices();
            };
            scope.quickExisting = () => sequence('betweenShows').length;
            scope.quickReady = () => (scope.quick.promo !== null) || (scope.quick.upNext !== null);
            scope.buildQuick = () => {
                const made = editor.quickSetup(scope.draft, {
                    promo: scope.quick.promo, upNext: scope.quick.upNext, fallback: scope.quick.fallback,
                });
                if (made === null) {
                    return;
                }
                changed();
                scope.panel = null;
                scope.notice = `Built ${made.built} step${made.built === 1 ? '' : 's'} in Between shows`
                    + (made.replaced > 0 ? `, replacing the ${made.replaced} that ${made.replaced === 1 ? 'was' : 'were'} there` : '')
                    + '. Click a step to change anything about it.';
            };

            // ---- Copy transitions to other cards -----------------------------------
            const otherContexts = () => {
                const all = [];
                (scope.channel.dayParts || []).forEach( (c) => all.push( { context: c, kind: 'day-part' } ) );
                (scope.channel.blocks || []).forEach( (c) => all.push( { context: c, kind: 'block' } ) );
                return all.filter( (t) => t.context !== scope.context );
            };
            scope.hasOthers = () => otherContexts().length > 0;
            scope.openCopy = () => {
                closeForm();
                scope.notice = '';
                scope.open = true;
                scope.panel = 'copy';
                scope.copy = {
                    targets: otherContexts().map( (t) => ({
                        context: t.context, kind: t.kind, picked: false,
                        label: (t.context.name || '(unnamed)'),
                    }) ),
                    rows: { leaving: true, entering: true, betweenEpisodes: true, betweenShows: true },
                };
            };
            scope.copyAll = (kind) => {
                scope.copy.targets.forEach( (t) => { if (t.kind === kind) { t.picked = true; } } );
            };
            const chosenRows = () => scope.situations.map( (s) => s.id ).filter( (id) => scope.copy.rows[id] === true );
            // What copying now would replace: the steps already in the chosen rows of the chosen cards.
            scope.copyReplaces = () => {
                const rows = chosenRows();
                let n = 0;
                scope.copy.targets.filter( (t) => t.picked ).forEach( (t) => {
                    const draft = editor.loadDraft(t.context);
                    rows.forEach( (r) => { n += editor.stepsOf(draft, r).length; } );
                } );
                return n;
            };
            scope.copyReady = () => scope.copy.targets.some( (t) => t.picked ) && (chosenRows().length > 0);
            scope.doCopy = () => {
                const rows = chosenRows();
                const picked = scope.copy.targets.filter( (t) => t.picked );
                const total = { copied: 0, replaced: 0, leftOut: 0 };
                picked.forEach( (t) => {
                    const done = editor.copySituations(scope.draft, t.context, rows);
                    total.copied += done.copied;
                    total.replaced += done.replaced;
                    total.leftOut += done.leftOut;
                } );
                $rootScope.$broadcast('transitionsCopied', picked.map( (t) => t.context ));
                scope.$emit('transitionsChanged');
                scope.panel = null;
                scope.notice = `Copied ${total.copied} step${total.copied === 1 ? '' : 's'} to ${picked.length} card${picked.length === 1 ? '' : 's'}`
                    + (total.replaced > 0 ? ` (replacing ${total.replaced} that ${total.replaced === 1 ? 'was' : 'were'} there)` : '')
                    + (total.leftOut > 0 ? `; ${total.leftOut} step${total.leftOut === 1 ? '' : 's'} with no list ${total.leftOut === 1 ? 'was' : 'were'} left out` : '')
                    + '. Open the other cards to see or change them.';
            };

            // Another card's editor copied rows onto this card: take them up.
            scope.$on('transitionsCopied', (event, contexts) => {
                if (contexts.indexOf(scope.context) !== -1) {
                    scope.form = null;
                    hadStored = (typeof(scope.context.transitions) !== 'undefined');
                    scope.draft = editor.loadDraft(scope.context);
                    scope.preview.stale = (scope.preview.sections !== null); scope.preview.staleNames = false;
                }
            });

            // Leaving the tab with a form open: the same rule as closing it.
            scope.$on('$destroy', closeForm);

            scope.$watch('fillerOptions', rebuildChoices);
            scope.$watch('cardTemplates', rebuildChoices);
            scope.$watch('listsLoaded', rebuildChoices);

            // ---- the preview ----------------------------------------------------
            const WEEK = 7 * 24 * 60 * 60 * 1000;

            // `lists` are the clips as they will play (with the suggested names overlaid when
            // useNames); `suggested` always has them overlaid, so a preview on the saved names
            // can say where a step found nothing only because the names are not saved yet.
            const fetchLists = async (ids, useNames) => {
                const lists = {};
                const suggested = {};
                const featuring = {};
                for (const id of ids) {
                    let clips = null;
                    let overlaid = null;
                    try {
                        const filler = await dizquetv.getFiller(id);
                        clips = Array.isArray(filler.content) ? filler.content : [];
                        featuring[id] = (filler.clipsFeatureShows === true);
                        overlaid = editor.overlayProposedNames(clips, await dizquetv.getFillerMatch(id));
                    } catch (err) {
                        console.error('Unable to read filler list ' + id, err);
                        overlaid = clips;
                    }
                    suggested[id] = overlaid;
                    lists[id] = useNames ? overlaid : clips;
                }
                return { lists: lists, suggested: suggested, featuring: featuring };
            };

            // "4 clips would fit once their suggested names are accepted", for the steps that
            // found nothing on the saved names, with a way to open that list's review screen.
            const hintText = (h) => (h.count === 1)
                ? '1 clip would fit once its suggested name is accepted'
                : `${h.count} clips would fit once their suggested names are accepted`;
            scope.openNames = (listId) => namesReview.open(listId);

            scope.runPreview = async () => {
                const channel = scope.channel;
                closeForm();
                scope.preview = { busy: true, error: '', sections: null, header: '', stale: false, staleNames: false };
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
                        // every card step reads as playing, for its template's length
                        card: editor.previewCard( (scope.cardTemplates || []).reduce( (all, t) => {
                            all[t.id] = { name: t.name, seconds: t.seconds };
                            return all;
                        }, {} ) ),
                    };
                    const from = Date.now();
                    const view = editor.previewBreaks(channel, scope.context, from, from + WEEK, env);
                    let hints = {};
                    if (! useNames) {
                        const ifAccepted = Object.assign({}, env, { getList: (id) => got.suggested[id] || null });
                        hints = editor.wouldFitHints(view, editor.previewBreaks(channel, scope.context, from, from + WEEK, ifAccepted));
                    }
                    const sections = [];
                    for (const s of scope.situations) {
                        const bucket = view.situations[s.id];
                        sections.push( {
                            id: s.id,
                            title: s.title,
                            total: bucket.total,
                            withSteps: bucket.withSteps,
                            shown: 5,
                            items: bucket.items.map( (i, itemIndex) => {
                                // A clip as shown, and the titles of every clip that fitted its step.
                                const clipView = (c) => ({ text: `${c.clip} (${c.seconds}s)`, titles: c.fits, open: false });
                                const outs = i.out.map(clipView);
                                const ins = i.in.map(clipView);
                                return {
                                    head: `${editor.clockLabel(i.startTime)}  ${i.prev || '(nothing)'} → ${i.next || '(nothing)'}`,
                                    other: (s.id === 'leaving') ? `into ${i.other}` : ((s.id === 'entering') ? `from ${i.other}` : ''),
                                    out: outs,
                                    in: ins,
                                    // The steps that had more than one clip to choose from.
                                    several: outs.concat(ins).filter( (c) => c.titles.length > 1 ),
                                    flex: editor.mmss(i.flexMs),
                                    overrun: i.overrun,
                                    hasSteps: (i.out.length + i.in.length) > 0,
                                    left: i.left.map( (l) => ({ text: `${l.step}: ${l.why}`, problem: l.problem }) ),
                                    hints: ((hints[s.id] || [])[itemIndex] || []).map( (h) => ({ text: hintText(h), listId: h.listId, listName: names.listName(h.listId) }) ),
                                };
                            } ),
                        } );
                    }
                    const missing = Object.keys(got.lists).filter( (id) => got.lists[id] === null );
                    scope.preview.sections = sections;
                    scope.preview.header = 'Walking the lineup as it is in this editor, from now for 7 days. '
                        + (useNames ? 'Clips are named the way “Match shows” would suggest (nothing is saved). '
                            : 'Using the clip names saved on the lists, which is what will air. A clip that is only suggested does not count: where that is why a step found nothing, it says so. ')
                        + 'Where several clips fit a step, all of them are listed under it: on air they take turns, the longest idle first.'
                        + (missing.length > 0 ? ` ${missing.length} list${missing.length === 1 ? ' was' : 's were'} not found.` : '');
                } catch (err) {
                    console.error(err);
                    scope.preview.error = 'Unable to build the preview.';
                } finally {
                    scope.preview.busy = false;
                    $timeout();
                }
            };

            // Names saved on the review screen change what the preview would say.
            const stopListening = $rootScope.$on('namesSaved', () => {
                if (scope.preview.sections !== null) {
                    scope.preview.stale = true;
                    scope.preview.staleNames = true;
                }
            });
            scope.$on('$destroy', stopListening);

            scope.visible = (section) => section.items.slice(0, section.shown);
            scope.showMore = (section) => { section.shown = (section.shown === 5) ? section.items.length : 5; };
        },
    };
};
