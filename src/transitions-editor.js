/*
 * What the transitions editor needs to know that is not about drawing it: how a
 * step reads in words, the rules the form keeps (days, chance, which step a
 * step may watch), how a draft becomes the stored shape, the one-line tag on a
 * Flex row, and the preview that walks a lineup and shows what each break would
 * play. See docs/blocks-spec.md, Stage 5, "Editor".
 *
 * Pure and free of I/O, like transitions.js, which it builds on and which stays
 * the one place that decides what a step means: the preview calls buildPlan, so
 * the preview and playback cannot disagree, and the form's rules come from the
 * same watchProblem / daysProblem / chanceProblem functions the save-time
 * warning uses. The directive in web/directives/transitions-editor.js is the
 * only caller and does the drawing and the fetching.
 *
 * A draft is what the form edits: transitions.normalizeTransitions(context), so
 * all four situations are present and every step carries every field. Reading a
 * context into a draft writes nothing; the directive writes back only when the
 * user changes something, so a card nobody touches saves byte for byte as it
 * was.
 */
const transitions = require('./transitions');
const showMatch = require('./show-match');

/*
 * The five ways a step can choose its clips, as the form offers them. Each is a
 * (match, keyedOn) pair of the stored shape; `any` keeps keyedOn 'next', the
 * default, since the field is read but means nothing for it.
 */
const WHICH = [
    { id: 'next', match: 'show', keyedOn: 'next', short: 'for the show coming up',
      label: 'a clip for the show coming up next',
      about: ' for the show coming up' },
    { id: 'now', match: 'show', keyedOn: 'now', short: 'for the show that just ended',
      label: 'a clip for the show that just ended',
      about: ' for the show that just ended' },
    { id: 'pair', match: 'pair', keyedOn: 'next', short: 'for the show that just ended, then the one coming up',
      label: 'a clip for the show that just ended, then the one coming up',
      about: ' for the show that just ended, then the one coming up (or, failing that, just the one coming up)' },
    { id: 'any', match: 'any', keyedOn: 'next', short: 'any clip',
      label: 'any clip from the list', about: '' },
    { id: 'later', match: 'show', keyedOn: 'later', short: 'for the show next time',
      label: 'a clip for the show that opens this, next time it comes round',
      about: ' for the show that opens this, next time it comes round' },
];

/*
 * The three a generated card can be for (docs/blocks-spec.md, Stage 5, "Generated
 * cards"): a card is always about one show, so only the choices keyed on a show.
 */
const CARD_WHICH = WHICH.filter( (w) => w.match === 'show' )
    .map( (w) => Object.assign({}, w, { label: w.label.replace(/^a clip/, 'a card') }) );

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Which of the choices a stored step is, or null when it is none of them (a kind
// or an unknown match the editor does not know): those are shown and kept, never edited.
function whichOf(step) {
    if (step.kind === 'generated') {
        const card = CARD_WHICH.find( (w) => w.keyedOn === step.keyedOn );
        return (typeof(card) === 'undefined') ? null : card.id;
    }
    const found = WHICH.find( (w) => (w.match === step.match) && ( (w.match !== 'show') || (w.keyedOn === step.keyedOn) ) );
    return (typeof(found) === 'undefined') ? null : found.id;
}

function setWhich(step, id) {
    const choices = (step.kind === 'generated') ? CARD_WHICH : WHICH;
    const w = choices.find( (x) => x.id === id );
    if (typeof(w) === 'undefined') {
        throw new Error(`transitionsEditor.setWhich: "${id}" is not one of ${choices.map( (x) => x.id ).join(', ')}`);
    }
    if (step.kind !== 'generated') {
        step.match = w.match;
    }
    step.keyedOn = w.keyedOn;
    return step;
}

function isSupported(step) {
    return ( (step.kind === 'list') || (step.kind === 'generated') ) && (whichOf(step) !== null);
}

/*
 * A step becomes a clip from a list or a generated card, keeping the show it
 * is for (a step for "any clip" or "the pair" becomes a card for the show
 * coming up), its mark, days and chance. What only the other kind uses goes.
 */
function setKind(step, kind) {
    if (kind === 'generated') {
        const keyed = (step.match === 'show') ? step.keyedOn : 'next';
        delete step.listId;
        delete step.fallbackListId;
        delete step.match;
        step.kind = 'generated';
        step.templateId = (typeof(step.templateId) === 'string') ? step.templateId : '';
        step.keyedOn = CARD_WHICH.some( (w) => w.keyedOn === keyed ) ? keyed : 'next';
    } else {
        delete step.templateId;
        step.kind = 'list';
        step.listId = '';
        step.fallbackListId = null;
        step.match = 'show';
        step.keyedOn = CARD_WHICH.some( (w) => w.keyedOn === step.keyedOn ) ? step.keyedOn : 'next';
    }
    return step;
}

function hasNoTemplate(step) {
    return (step.kind === 'generated') && ( (typeof(step.templateId) !== 'string') || (step.templateId === '') );
}

function emptyDraft() {
    return transitions.normalizeTransitions(null);
}

function loadDraft(context) {
    return transitions.normalizeTransitions(context);
}

function stepsOf(draft, situation) {
    return draft[situation].out.concat(draft[situation].in);
}

function allSteps(draft) {
    let all = [];
    for (const name of transitions.SITUATIONS) {
        all = all.concat(stepsOf(draft, name));
    }
    return all;
}

function stepCount(draft) {
    return allSteps(draft).length;
}

// A step id no step of this draft has. Ids only have to be unique within a
// situation (that is where onlyIfNoMatch looks), but a draft-wide check costs
// nothing and keeps them unique everywhere.
function newStepId(draft) {
    const taken = new Set(allSteps(draft).map( (s) => s.id ));
    for (;;) {
        const id = 'st_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        if (! taken.has(id)) {
            return id;
        }
    }
}

// A new step as the form starts it: a clip about the show coming up, no list
// chosen yet, no fallback, every day, always.
function newStep(draft) {
    const step = transitions.normalizeTransitions({
        transitions: { betweenShows: { out: [ { id: newStepId(draft), listId: '' } ], in: [] } },
    }).betweenShows.out[0];
    return setWhich(step, 'next');
}

function addStep(draft, situation, side, step) {
    draft[situation][side].push(step);
    return step;
}

function moveStep(draft, situation, side, step, delta) {
    const list = draft[situation][side];
    const i = list.indexOf(step);
    const j = i + delta;
    if ( (i === -1) || (j < 0) || (j >= list.length) ) {
        return false;
    }
    list.splice(i, 1);
    list.splice(j, 0, step);
    return true;
}

/*
 * Delete a step, and clear the "only when" of any step that was watching it,
 * since a mark naming a step that is gone could never be honoured. Returns the
 * steps whose mark was cleared, so the form can say so.
 */
function removeStep(draft, situation, step) {
    const cleared = [];
    for (const side of ['out', 'in']) {
        const i = draft[situation][side].indexOf(step);
        if (i !== -1) {
            draft[situation][side].splice(i, 1);
        }
    }
    for (const other of stepsOf(draft, situation)) {
        if ( (step.id != null) && (other.onlyIfNoMatch === step.id) ) {
            other.onlyIfNoMatch = null;
            cleared.push(other);
        }
    }
    return cleared;
}

/*
 * Leaving a step's form: a step with no list chosen is taken out rather than
 * left half-made. Returns { removed, cleared }: whether it was removed, and the
 * steps whose "only when" named it (cleared, as for any deletion).
 */
function closeStep(draft, situation, step) {
    if ( ( (step.kind === 'list') && ( (step.listId == null) || (step.listId === '') ) ) || hasNoTemplate(step) ) {
        return { removed: true, cleared: removeStep(draft, situation, step) };
    }
    return { removed: false, cleared: [] };
}

// The steps `step` could watch: the others in its own situation, out and in
// together, that are not themselves conditional (transitions.watchProblem).
function markOptions(draft, situation, step) {
    return stepsOf(draft, situation).filter( (s) => (s !== step) && (s.id != null) && ! isMarked(s) );
}

function isMarked(step) {
    const w = step.onlyIfNoMatch;
    return ! ( (typeof(w) === 'undefined') || (w === null) || (w === false) || (w === '') );
}

// A step another step watches cannot itself be conditional.
function isWatched(draft, situation, step) {
    return stepsOf(draft, situation).some( (s) => (s !== step) && isMarked(s) && (s.onlyIfNoMatch === step.id) );
}

// Setting a mark that cannot be honoured is refused rather than stored.
function setMark(draft, situation, step, watchedId) {
    if ( (watchedId === null) || (typeof(watchedId) === 'undefined') || (watchedId === '') ) {
        step.onlyIfNoMatch = null;
        return true;
    }
    if (! markOptions(draft, situation, step).some( (s) => s.id === watchedId ) || isWatched(draft, situation, step) ) {
        return false;
    }
    step.onlyIfNoMatch = watchedId;
    return true;
}

// Days: nothing picked and all seven picked both mean "every day" and are
// stored as null, so the form can never save the empty list that plays on no day.
function normalizeDays(days) {
    if (! Array.isArray(days) ) {
        return null;
    }
    const picked = Array.from(new Set(days.filter( (d) => Number.isInteger(d) && (d >= 0) && (d <= 6) ))).sort();
    return ( (picked.length === 0) || (picked.length === 7) ) ? null : picked;
}

function isDaySelected(step, day) {
    return Array.isArray(step.days) && step.days.includes(day);
}

function toggleDay(step, day) {
    const now = Array.isArray(step.days) ? step.days.slice() : [];
    const i = now.indexOf(day);
    if (i === -1) {
        now.push(day);
    } else {
        now.splice(i, 1);
    }
    step.days = normalizeDays(now);
    return step.days;
}

/*
 * What a typed "Sometimes" means: empty is always (null), a whole number 1 to
 * 99 is a chance, 100 is always, and anything else is an error the form shows
 * and does not store.
 */
function parseChance(text) {
    const t = (text == null) ? '' : String(text).trim();
    if (t === '') {
        return { ok: true, value: null };
    }
    if (! /^[0-9]+$/.test(t) ) {
        return { ok: false, value: null, error: 'Enter a whole number from 1 to 99, or leave it empty for always.' };
    }
    const n = parseInt(t, 10);
    if ( (n < 1) || (n > 100) ) {
        return { ok: false, value: null, error: 'Enter a whole number from 1 to 99, or leave it empty for always.' };
    }
    return { ok: true, value: (n === 100) ? null : n };
}

function setChance(step, text) {
    const parsed = parseChance(text);
    if (parsed.ok) {
        step.chance = parsed.value;
    }
    return parsed;
}

function joinWords(words) {
    if (words.length <= 1) {
        return words.join('');
    }
    return words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
}

function dayWords(days) {
    return days.slice().sort().map( (d) => DAY_NAMES[d] );
}

/*
 * `names` is { listName(id) -> the list's name or null if there is no such
 * list }. A list that is not chosen reads as such, and one that no longer
 * exists as that, rather than as a blank.
 */
function listText(listId, names) {
    if ( (listId == null) || (listId === '') ) {
        return null;
    }
    const name = names.listName(listId);
    return (name == null) ? null : name;
}

// A card template's name, or null for one that is not there (or not known yet).
function templateText(templateId, names) {
    if ( (typeof(templateId) !== 'string') || (templateId === '') || (typeof(names.templateName) !== 'function') ) {
        return null;
    }
    const name = names.templateName(templateId);
    return (name == null) ? null : name;
}

function stepListName(step, names) {
    if (step.kind === 'generated') {
        if (hasNoTemplate(step)) {
            return 'Card: (no template chosen)';
        }
        const name = templateText(step.templateId, names);
        return 'Card: ' + ( (name === null) ? '(a template that no longer exists)' : name );
    }
    if ( (step.listId == null) || (step.listId === '') ) {
        return '(no list chosen)';
    }
    const name = names.listName(step.listId);
    return (name == null) ? '(a list that no longer exists)' : name;
}

/*
 * The one sentence at the top of a step's form, rebuilt as it changes:
 * "Plays a clip from Nick at Nite Up Next for the show coming up; if none
 * matches, plays nothing." `sequence` is every step of the step's situation, so
 * a watched step can be named.
 */
// What limits a step, as the clauses ending its sentence.
function limitClauses(step, sequence, names) {
    const parts = [];
    if (isMarked(step)) {
        const watched = sequence.find( (s) => (s !== step) && (s.id === step.onlyIfNoMatch) );
        parts.push(watched
            ? `only when the “${stepListName(watched, names)}” step found nothing`
            : 'only when a step that is not there found nothing, so it never plays');
    }
    if (Array.isArray(step.days) && (step.days.length > 0)) {
        parts.push(`only on ${joinWords(dayWords(step.days))}`);
    } else if (Array.isArray(step.days)) {
        parts.push('on no day at all');
    }
    if ( (step.chance != null) && (step.chance < 100) ) {
        parts.push(`about ${step.chance}% of the time`);
    }
    return parts;
}

function describeStep(step, sequence, names) {
    if ( (step.kind === 'generated') && (whichOf(step) !== null) ) {
        const w = CARD_WHICH.find( (x) => x.id === whichOf(step) );
        const name = templateText(step.templateId, names);
        const what = hasNoTemplate(step) ? 'Plays a generated card from a template you have not chosen yet'
            : (name === null) ? 'Plays a generated card from a template that no longer exists'
            : `Plays a generated card, “${name}”,`;
        return [ what + w.about ].concat(limitClauses(step, sequence, names)).join('; ') + '.';
    }
    if (step.kind !== 'list') {
        return `This is a "${step.kind}" step, which is not built yet. It is kept as it is and skipped on air.`;
    }
    const which = whichOf(step);
    if (which === null) {
        return 'This step uses a way of choosing clips this editor does not know. It is kept as it is and skipped on air.';
    }
    const w = WHICH.find( (x) => x.id === which );
    const list = (step.listId == null || step.listId === '') ? 'a list you have not chosen yet'
        : (listText(step.listId, names) === null ? 'a list that no longer exists' : listText(step.listId, names));
    const parts = [ `Plays ${which === 'any' ? 'any clip' : 'a clip'} from ${list}${w.about}` ];
    const fallback = (step.fallbackListId == null || step.fallbackListId === '') ? null
        : (listText(step.fallbackListId, names) === null ? 'a list that no longer exists' : listText(step.fallbackListId, names));
    parts.push(`if ${which === 'any' ? 'nothing in it fits' : 'none matches'}, plays ${fallback === null ? 'nothing' : 'a clip from ' + fallback}`);
    return parts.concat(limitClauses(step, sequence, names)).join('; ') + '.';
}

// The chip on a card: list, how it chooses, what happens when nothing fits, then
// whatever limits it.
function chipLabel(step, sequence, names) {
    if ( (step.kind === 'generated') && (whichOf(step) !== null) ) {
        const parts = [ stepListName(step, names), CARD_WHICH.find( (x) => x.id === whichOf(step) ).short ];
        if (isMarked(step)) {
            const watched = sequence.find( (s) => (s !== step) && (s.id === step.onlyIfNoMatch) );
            parts.push(watched ? `if “${stepListName(watched, names)}” finds nothing` : 'watches a missing step');
        }
        if (Array.isArray(step.days) && (step.days.length > 0)) {
            parts.push(dayWords(step.days).join(' '));
        }
        if ( (step.chance != null) && (step.chance < 100) ) {
            parts.push(`${step.chance}%`);
        }
        return parts.join(' · ');
    }
    if (step.kind !== 'list') {
        return `${step.kind} step (not built yet)`;
    }
    const which = whichOf(step);
    const parts = [ stepListName(step, names) ];
    if (which === null) {
        parts.push('unknown choice');
        return parts.join(' · ');
    }
    parts.push(WHICH.find( (x) => x.id === which ).short);
    if (step.fallbackListId != null && step.fallbackListId !== '') {
        const fb = listText(step.fallbackListId, names);
        parts.push('else ' + (fb === null ? '(missing list)' : fb));
    } else {
        parts.push('skip');
    }
    if (isMarked(step)) {
        const watched = sequence.find( (s) => (s !== step) && (s.id === step.onlyIfNoMatch) );
        parts.push(watched ? `if “${stepListName(watched, names)}” finds nothing` : 'watches a missing step');
    }
    if (Array.isArray(step.days) && (step.days.length > 0)) {
        parts.push(dayWords(step.days).join(' '));
    }
    if ( (step.chance != null) && (step.chance < 100) ) {
        parts.push(`${step.chance}%`);
    }
    return parts.join(' · ');
}

/*
 * Everything wrong with a step that the form should show in red, as lines. The
 * form's own controls cannot store a bad days list, chance or mark, so what is
 * left is a step with no list chosen, a list or fallback that no longer exists,
 * and a stored step that something else (a hand edit) made bad.
 */
function problemsOf(step, sequence, names) {
    const problems = [];
    if (step.kind === 'generated') {
        if (hasNoTemplate(step)) {
            problems.push('Choose the card template this step plays. (A card step with no template is removed when you close it.)');
        } else if ( (typeof(names.templateName) === 'function') && (templateText(step.templateId, names) === null) ) {
            problems.push('The card template this step plays no longer exists.');
        }
    } else if (step.kind !== 'list') {
        return problems;
    } else if (step.listId == null || step.listId === '') {
        problems.push('Choose the list this step draws from. (A step with no list is removed when you close it.)');
    } else if (listText(step.listId, names) === null) {
        problems.push('The list this step draws from no longer exists.');
    }
    if (step.kind === 'list' && step.fallbackListId != null && step.fallbackListId !== '' && listText(step.fallbackListId, names) === null) {
        problems.push('The fallback list no longer exists.');
    }
    const watch = transitions.watchProblem(step, sequence);
    if (watch !== null) {
        problems.push(`It cannot be conditional: ${watch}.`);
    }
    const days = transitions.daysProblem(step);
    if (days !== null) {
        problems.push(days.charAt(0).toUpperCase() + days.slice(1) + '.');
    }
    const chance = transitions.chanceProblem(step);
    if (chance !== null) {
        problems.push(chance.charAt(0).toUpperCase() + chance.slice(1) + '.');
    }
    return problems;
}

// True when saving should wait: a step is there with no list to draw from.
function hasUnfinishedStep(draft) {
    return allSteps(draft).some( (s) => ( (s.kind === 'list') && (s.listId == null || s.listId === '') ) || hasNoTemplate(s) );
}

// A step as stored: everything it carries, nothing that is only the form's.
function cleanStep(step) {
    const out = {};
    for (const key of Object.keys(step)) {
        if (key.charAt(0) !== '$') {
            out[key] = step[key];
        }
    }
    return out;
}

function serialize(draft) {
    const out = {};
    for (const name of transitions.SITUATIONS) {
        out[name] = { out: draft[name].out.map(cleanStep), in: draft[name].in.map(cleanStep) };
    }
    return out;
}

/*
 * Write the draft into the context. A context that had no `transitions` and
 * still has no step gets none, so adding a step and deleting it again leaves the
 * channel as it was.
 */
function commit(context, draft, hadStored) {
    if ( (stepCount(draft) === 0) && ! hadStored ) {
        delete context.transitions;
    } else {
        context.transitions = serialize(draft);
    }
}

/*
 * Quick setup: the Between shows sequence most channels want, built from up to
 * three lists, replacing whatever Between shows holds now.
 *
 *   before the commercials   a clip from the promo list for the show coming up
 *                            (nothing plays if the list has none for it)
 *   right before the show    a clip from the Up Next list for the show coming up,
 *                            else one from the fallback list, else nothing
 *
 * Both are ordinary steps afterwards, edited like any other. At least one of the
 * promo and Up Next lists is needed; a fallback only belongs to an Up Next step.
 * Returns { built, replaced } (steps made, steps they replaced), or null when
 * there was nothing to build from.
 */
function quickSetup(draft, lists) {
    const has = (id) => (typeof(id) === 'string') && (id !== '');
    if (! has(lists.promo) && ! has(lists.upNext) ) {
        return null;
    }
    const replaced = stepsOf(draft, 'betweenShows').length;
    draft.betweenShows = { out: [], in: [] };
    let built = 0;
    if (has(lists.promo)) {
        const step = addStep(draft, 'betweenShows', 'out', newStep(draft));
        step.listId = lists.promo;
        built++;
    }
    if (has(lists.upNext)) {
        const step = addStep(draft, 'betweenShows', 'in', newStep(draft));
        step.listId = lists.upNext;
        step.fallbackListId = has(lists.fallback) ? lists.fallback : null;
        built++;
    }
    return { built: built, replaced: replaced };
}

/*
 * Copy some of a draft's rows to another day-part or block, replacing the same
 * rows there and leaving its other rows alone. Every copied step gets a new id (ids
 * are per draft) and an "only when" is carried across to the copy of the step it
 * named. A step with no list chosen is left out, and an "only when" that named one
 * is cleared. The source is not changed. Returns { copied, replaced, leftOut }.
 */
function copySituations(source, targetContext, situations) {
    const target = loadDraft(targetContext);
    const hadStored = (typeof(targetContext.transitions) !== 'undefined');
    let copied = 0;
    let replaced = 0;
    let leftOut = 0;
    for (const name of situations) {
        if (transitions.SITUATIONS.indexOf(name) === -1) {
            throw new Error(`transitionsEditor.copySituations: "${name}" is not a situation`);
        }
        replaced += stepsOf(target, name).length;
        target[name] = { out: [], in: [] };
        const fresh = new Map();
        const made = [];
        for (const side of ['out', 'in']) {
            for (const step of source[name][side]) {
                if ( (step.kind === 'list') && ( (step.listId == null) || (step.listId === '') ) ) {
                    leftOut++;
                    continue;
                }
                const copy = JSON.parse( JSON.stringify(cleanStep(step)) );
                const old = copy.id;
                copy.id = newStepId(target);
                fresh.set(old, copy.id);
                target[name][side].push(copy);
                made.push(copy);
                copied++;
            }
        }
        for (const copy of made) {
            if (isMarked(copy)) {
                copy.onlyIfNoMatch = fresh.has(copy.onlyIfNoMatch) ? fresh.get(copy.onlyIfNoMatch) : null;
            }
        }
    }
    commit(targetContext, target, hadStored);
    return { copied: copied, replaced: replaced, leftOut: leftOut };
}

/*
 * The text a step reads as inside a Flex row's tag: the list, then the show it is
 * keyed on where it is keyed on one. A step that does not always play is marked:
 * "?" for one that plays only some of the time, brackets for one that plays only
 * when another found nothing.
 */
function programLabel(program) {
    if (program == null) {
        return '';
    }
    if (typeof(program.customShowId) !== 'undefined') {
        return program.customShowName || program.showTitle || program.title || '';
    }
    return program.showTitle || program.title || '';
}

function tagLabel(step, brk, names) {
    let text = stepListName(step, names);
    const which = whichOf(step);
    const prev = (brk.prev != null) ? programLabel(brk.prev.program) : '';
    const next = (brk.next != null) ? programLabel(brk.next.program) : '';
    if ( (which === 'next') && (next !== '') ) {
        text += ' · ' + next;
    } else if ( (which === 'now') && (prev !== '') ) {
        text += ' · ' + prev;
    } else if ( (which === 'pair') && (next !== '') ) {
        text += ' · ' + (prev !== '' ? prev + ' → ' : '') + next;
    }
    if ( (step.chance != null) && (step.chance < 100) ) {
        text += ' ?';
    }
    if (isMarked(step)) {
        text = '(' + text + ')';
    }
    return text;
}

/*
 * The tag for the Flex row at `index` (start `entryStart`, ms): the steps its
 * break is set to play, in play order, joined with " / ". Out steps belong to the
 * first Flex row of a break and in steps to the last, as transitions.js attaches
 * them, so a break of two Flex rows is not shown twice. A step limited to other
 * weekdays than the break's is left out; one that needs a list, or is not built,
 * is not named. `title` is the same thing spelled out for a tooltip. null when
 * the row has nothing to say.
 */
function flexTag(channel, index, entryStart, names) {
    const brk = transitions.findBreak(channel, index, entryStart);
    const first = (index === brk.firstFlex);
    const last = (index === brk.lastFlex);
    if (! first && ! last) {
        return null;
    }
    const assembled = transitions.assemble(channel, brk);
    const weekday = new Date(brk.startTime).getDay();
    const label = (e) => ( isSupported(e.step) && ! hasNoTemplate(e.step)
        && (transitions.daysProblem(e.step) === null)
        && ( (e.step.days == null) || e.step.days.includes(weekday) ) ) ? tagLabel(e.step, brk, names) : null;
    const before = first ? assembled.out.map(label).filter( (l) => l !== null ) : [];
    const after = last ? assembled.in.map(label).filter( (l) => l !== null ) : [];
    if ( (before.length === 0) && (after.length === 0) ) {
        return null;
    }
    const lines = [];
    if (before.length > 0) {
        lines.push('Before the commercials: ' + before.join(', '));
    }
    if (after.length > 0) {
        lines.push('After the commercials: ' + after.join(', '));
    }
    const all = before.concat(after);
    if (all.some( (l) => l.includes(' ?') )) {
        lines.push('? = plays only some of the time');
    }
    if (all.some( (l) => l.charAt(0) === '(' )) {
        lines.push('( ) = plays only if the step it watches found nothing');
    }
    return { text: all.join(' / '), title: lines.join('\n') };
}

/*
 * Clips with the names a review would suggest, for the preview: a clip with no
 * names of its own takes the title proposal from GET /api/filler/:id/match
 * (matched by position); a clip that has any keeps them, one saved as naming no
 * show stays that way, and one whose stored names are unusable is left exactly
 * as it is, so it stays ineligible as on air.
 * Returns new clips and changes nothing.
 */
function overlayProposedNames(clips, matchResponse) {
    const proposals = (matchResponse != null && Array.isArray(matchResponse.clips)) ? matchResponse.clips : [];
    return clips.map( (clip, i) => {
        if ( (clip == null) || (showMatch.namesProblem(clip) !== null) || (showMatch.namesOf(clip).length > 0)
            || showMatch.isReviewedNone(clip) ) {
            return clip;
        }
        const p = proposals[i];
        if ( (p == null) || (p.proposal == null) || ! Array.isArray(p.proposal.names) || (p.proposal.names.length === 0) ) {
            return clip;
        }
        return Object.assign({}, clip, { names: p.proposal.names.slice() });
    } );
}

/*
 * A stand-in for env.card in the preview: the browser cannot see which cards are
 * rendered, so every card step reads as playing, for the length its template
 * runs. `templates` is { id: { name, seconds } }; a template not there plays nothing.
 */
function previewCard(templates) {
    return (want) => {
        const t = (templates || {})[want.templateId];
        if (t == null) {
            return null;
        }
        const show = (want.program != null) ? (programLabel(want.program) || want.program.title || '') : '';
        return { file: null, key: 'preview', title: `Card: ${t.name}${show ? ' · ' + show : ''}`,
            durationMs: Math.round( (t.seconds || 15) * 1000 ), streamStats: null };
    };
}

/*
 * The preview: every break of the lineup from `from` to `to` (ms) that involves
 * this context, with the plan buildPlan gives it, grouped by the four situations
 * as this context sees them. Between episodes and between shows are breaks
 * inside the context; Entering and Leaving are boundaries into and out of it,
 * and show the whole plan, the other context's steps too, since that is what the
 * break will play.
 *
 *   env  buildPlan's env (getList, lastPlayed, featuresShows, roll), and
 *        listName(id) for the steps' words
 *
 * Returns { situations: { betweenEpisodes: { total, withSteps, items }, ... } }
 * where items are { startTime, lengthMs, prev, next, other, out, in, flexMs,
 * overrun, left }; out and in are { clip, seconds, via, fits } for the clips that
 * play (fits: every clip that fitted the step, the one shown first, which on air
 * take turns) and `left` the steps that did not play, with why.
 */
function previewBreaks(channel, context, from, to, env) {
    const result = { situations: {} };
    for (const name of transitions.SITUATIONS) {
        result.situations[name] = { total: 0, withSteps: 0, items: [] };
    }
    const names = { listName: env.listName };
    for (const brk of transitions.breaksBetween(channel, from, to) ) {
        const plan = transitions.buildPlan(channel, brk, env);
        let situation = null;
        let other = null;
        if ( (plan.situation === 'betweenEpisodes') || (plan.situation === 'betweenShows') ) {
            if (plan.from === context) {
                situation = plan.situation;
            }
        } else if (plan.situation === 'boundary') {
            if (plan.from === context) {
                situation = 'leaving';
                other = plan.to;
            } else if (plan.to === context) {
                situation = 'entering';
                other = plan.from;
            }
        }
        if (situation === null) {
            continue;
        }
        const bucket = result.situations[situation];
        bucket.total++;
        const stepsMs = plan.outMs + plan.inMs;
        const lengthMs = brk.endTime - brk.startTime;
        const hasSteps = (plan.out.length > 0) || (plan.in.length > 0);
        if (hasSteps) {
            bucket.withSteps++;
        }
        const entries = transitions.assemble(channel, brk);
        const all = entries.out.concat(entries.in);
        const entryFor = (situationName, id) => all.find( (e) => (e.situation === situationName) && (e.step.id === id) );
        const sequenceFor = (entry) => all.filter( (e) => (e.context === entry.context) && (e.situation === entry.situation) ).map( (e) => e.step );
        // buildPlan words a step left out for another step's sake with that
        // step's id; the preview says which list it means.
        const why = (skip) => {
            const m = /^only plays if "(.*)" finds no clip, and it did$/.exec(skip.reason);
            const watched = (m === null) ? undefined : entryFor(skip.situation, m[1]);
            return (typeof(watched) === 'undefined') ? skip.reason : `stays out because “${stepListName(watched.step, names)}” found a clip`;
        };
        bucket.items.push( {
            startTime: brk.startTime,
            lengthMs: lengthMs,
            prev: (brk.prev != null) ? programLabel(brk.prev.program) : '',
            next: (brk.next != null) ? programLabel(brk.next.program) : '',
            other: (other != null) ? (other.name || 'an unnamed one') : 'the channel Flex',
            out: plan.out.map( (s) => ({ clip: s.clip.title, seconds: Math.round(s.durationMs / 1000), via: s.via, fits: s.fits, stepId: s.stepId, listId: s.listId } ) ),
            in: plan.in.map( (s) => ({ clip: s.clip.title, seconds: Math.round(s.durationMs / 1000), via: s.via, fits: s.fits, stepId: s.stepId, listId: s.listId } ) ),
            flexMs: Math.max(0, lengthMs - stepsMs),
            overrun: stepsMs > lengthMs,
            left: plan.skipped.map( (s) => {
                const entry = entryFor(s.situation, s.stepId);
                return {
                    step: (typeof(entry) !== 'undefined') ? chipLabel(entry.step, sequenceFor(entry), names) : s.stepId,
                    side: s.side,
                    why: why(s),
                    problem: s.problem === true,
                };
            } ),
        } );
    }
    return result;
}

/*
 * Where the preview, run on the names saved on the lists, found nothing for a step
 * only because the clips that would fit are not named yet. `saved` and `suggested`
 * are two previewBreaks results over the same breaks, the second with the names the
 * matcher suggests overlaid (overlayProposedNames). A step that plays a clip in the
 * second and not in the first is a hint:
 *
 *   { listId, count, side, stepId }   "count clips would fit once their suggested
 *                                     names are accepted"
 *
 * Returns { [situation]: [ hints for item 0, hints for item 1, ... ] }, each item's
 * hints in the order of its steps. A step that played something in the first
 * (a fallback, say) is no hint.
 */
function wouldFitHints(saved, suggested) {
    const result = {};
    for (const name of Object.keys(saved.situations) ) {
        const savedItems = saved.situations[name].items;
        const suggestedItems = (suggested.situations[name] || { items: [] }).items;
        result[name] = savedItems.map( (item, i) => {
            const other = suggestedItems[i];
            const hints = [];
            if ( (other == null) || (other.startTime !== item.startTime) ) {
                return hints;
            }
            for (const side of ['out', 'in']) {
                for (const step of other[side]) {
                    const played = item[side].some( (s) => s.stepId === step.stepId );
                    if ( (! played) && (step.fits.length > 0) ) {
                        hints.push( { listId: step.listId, count: step.fits.length, side: side, stepId: step.stepId } );
                    }
                }
            }
            return hints;
        } );
    }
    return result;
}

// "Fri 2:50pm"
function clockLabel(t) {
    const d = new Date(t);
    const h = d.getHours();
    const m = d.getMinutes();
    const h12 = (h % 12) === 0 ? 12 : (h % 12);
    return `${DAY_NAMES[d.getDay()]} ${h12}:${m < 10 ? '0' : ''}${m}${h < 12 ? 'am' : 'pm'}`;
}

// "4:12"
function mmss(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const s = total % 60;
    return `${Math.floor(total / 60)}:${s < 10 ? '0' : ''}${s}`;
}

module.exports = {
    WHICH: WHICH,
    CARD_WHICH: CARD_WHICH,
    DAY_NAMES: DAY_NAMES,
    setKind: setKind,
    previewCard: previewCard,
    whichOf: whichOf,
    setWhich: setWhich,
    isSupported: isSupported,
    emptyDraft: emptyDraft,
    loadDraft: loadDraft,
    stepsOf: stepsOf,
    allSteps: allSteps,
    stepCount: stepCount,
    newStep: newStep,
    addStep: addStep,
    moveStep: moveStep,
    removeStep: removeStep,
    closeStep: closeStep,
    quickSetup: quickSetup,
    copySituations: copySituations,
    markOptions: markOptions,
    isMarked: isMarked,
    isWatched: isWatched,
    setMark: setMark,
    normalizeDays: normalizeDays,
    isDaySelected: isDaySelected,
    toggleDay: toggleDay,
    parseChance: parseChance,
    setChance: setChance,
    describeStep: describeStep,
    stepListName: stepListName,
    chipLabel: chipLabel,
    problemsOf: problemsOf,
    hasUnfinishedStep: hasUnfinishedStep,
    serialize: serialize,
    commit: commit,
    programLabel: programLabel,
    flexTag: flexTag,
    overlayProposedNames: overlayProposedNames,
    previewBreaks: previewBreaks,
    wouldFitHints: wouldFitHints,
    clockLabel: clockLabel,
    mmss: mmss,
};
