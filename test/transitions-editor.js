/*
 * Stage 5, step 5: the logic behind the transitions editor (src/transitions-
 * editor.js) - what a step reads as in words, the rules the form keeps, the
 * draft-to-stored round trip, the one-line tag on a Flex row, and the preview.
 * See docs/blocks-spec.md, Stage 5, "Editor". The form and its drawing are the
 * directive's and are checked by hand in a browser; everything that can be wrong
 * without a browser is here.
 *
 * Fixtures only. One Friday, the machine's own zone like every fixture in this
 * suite:
 *
 *     20:00  Alpha 1            day-part "Day"
 *     20:30  Flex 3m            break A: between episodes, in Day
 *     20:33  Alpha 2
 *     21:03  Flex 2m + 2m       break B: Day -> Late, a boundary (two Flex entries)
 *     21:07  Beta               block "Late" (Fri 21:00-23:00)
 *     21:37  Flex 3m            break C: between shows, in Late
 *     21:40  Gamma
 *     22:10  Flex 3m            break D: between shows, in Late (nothing names Delta)
 *     22:13  Delta              (ends 22:43; the cycle then starts again)
 */
const { MIN, HOUR, at, flex, mix, Suite } = require('./support');
const transitions = require('../src/transitions');
const editor = require('../src/transitions-editor');
const ChannelDB = require('../src/dao/channel-db');

const LIST_NAMES = { wbrb: 'WBRB', btts: 'BTTS', signoff: 'Sign Off', intro: 'Intro', upnext: 'Up Next', generic: 'Generic',
    gone: null };
const names = { listName: (id) => (typeof(LIST_NAMES[id]) === 'undefined') ? null : LIST_NAMES[id] };

function episode(show, n, mins) {
    return { title: `${show} ${n}`, key: `/e/${show}${n}`, type: 'episode', showTitle: show,
        season: 1, episode: n, duration: mins * MIN, serverKey: 'srv' };
}
function clip(title, seconds, extra) {
    return Object.assign({ title, key: '/c/' + title, duration: seconds * 1000, serverKey: 'srv' }, extra || {});
}
function step(id, extra) {
    return Object.assign({ id, kind: 'list', listId: 'wbrb', match: 'any', keyedOn: 'next',
        fallbackListId: null, onlyIfNoMatch: null, days: null, chance: null }, extra || {});
}

const LISTS = {
    wbrb: [clip('WBRB', 8)],
    btts: [clip('BTTS', 6)],
    signoff: [clip('Sign Off', 12)],
    intro: [clip('Intro', 9)],
    upnext: [clip('Up Next Beta', 10, { names: ['tv.Beta'] }), clip('Up Next Gamma', 11, { names: ['tv.Gamma'] })],
    generic: [clip('Generic Bumper', 7)],
};

function fixtureChannel() {
    const programs = [
        episode('Alpha', 1, 30), flex(3), episode('Alpha', 2, 30),
        flex(2), flex(2),
        episode('Beta', 1, 30), flex(3), episode('Gamma', 1, 30), flex(3), episode('Delta', 1, 30),
    ];
    return {
        number: 7, name: 'Editor', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0, fillerCollections: [],
        dayParts: [{
            id: 'day', name: 'Day', fillerCollections: mix([['A', 100]]),
            starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 6 * HOUR }],
            transitions: {
                betweenEpisodes: { out: [step('wb', { listId: 'wbrb' })], in: [step('bt', { listId: 'btts' })] },
                leaving: { out: [step('lv', { listId: 'signoff' })], in: [] },
            },
        }],
        blocks: [{
            id: 'late', name: 'Late', fillerCollections: mix([['B', 100]]),
            airings: [{ days: [5], start: 21 * HOUR, end: 23 * HOUR }],
            transitions: {
                entering: { out: [step('en', { listId: 'intro' })],
                    in: [step('un', { listId: 'upnext', match: 'show', keyedOn: 'next' })] },
                betweenShows: { out: [], in: [
                    step('un2', { listId: 'upnext', match: 'show', keyedOn: 'next' }),
                    step('gen', { listId: 'generic', onlyIfNoMatch: 'un2' }),
                ] },
            },
        }],
        programs,
        duration: programs.reduce((a, p) => a + p.duration, 0),
        startTime: new Date(at('2026-10-02T20:00:00')).toISOString(),
    };
}

function startsOf(channel) {
    const starts = [];
    let t = new Date(channel.startTime).getTime();
    for (const p of channel.programs) {
        starts.push(t);
        t += p.duration;
    }
    return starts;
}

const env = () => ({
    getList: (id) => LISTS[id] || null,
    lastPlayed: () => 0,
    featuresShows: () => false,
    listName: names.listName,
});

module.exports = async function run() {
    const suite = new Suite('transitions-editor');
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    // ---- how a step chooses ---------------------------------------------------
    {
        const draft = editor.emptyDraft();
        const s = editor.newStep(draft);
        suite.check('a new step asks for a clip about the show coming up, no list chosen',
            s.kind === 'list' && s.match === 'show' && s.keyedOn === 'next' && s.listId === ''
            && s.fallbackListId === null && s.onlyIfNoMatch === null && s.days === null && s.chance === null);
        suite.check('... and carries every field a stored step carries',
            same(Object.keys(s).sort(), ['chance', 'days', 'fallbackListId', 'id', 'keyedOn', 'kind', 'listId', 'match', 'onlyIfNoMatch']));
        const ids = new Set();
        for (let i = 0; i < 200; i++) {
            const n = editor.newStep(draft);
            editor.addStep(draft, 'betweenShows', 'out', n);
            ids.add(n.id);
        }
        suite.check('200 new steps get 200 different ids', ids.size === 200);

        for (const id of ['next', 'now', 'pair', 'any']) {
            editor.setWhich(s, id);
            suite.check(`choosing "${id}" reads back as "${id}"`, editor.whichOf(s) === id, `${s.match}/${s.keyedOn}`);
        }
        suite.check('a stored step keyed on "later" is none of the four, and not supported',
            editor.whichOf(step('x', { match: 'show', keyedOn: 'later' })) === null
            && ! editor.isSupported(step('x', { match: 'show', keyedOn: 'later' })));
        suite.check('a "generated" step is not supported', ! editor.isSupported(step('x', { kind: 'generated' })));
        suite.check('a plain list step is', editor.isSupported(step('x')));
        let threw = false;
        try { editor.setWhich(s, 'later'); } catch (err) { threw = true; }
        suite.check('choosing something that is not offered is an error, not a stored guess', threw);
    }

    // ---- days and chance -------------------------------------------------------
    {
        const s = step('d');
        suite.check('the first day picked is a list of one', same(editor.toggleDay(s, 1), [1]));
        suite.check('picking more keeps them in week order', same(editor.toggleDay(s, 6) && editor.toggleDay(s, 0), [0, 1, 6]));
        editor.toggleDay(s, 0);
        editor.toggleDay(s, 6);
        suite.check('unpicking the last one leaves null, never the empty list that plays on no day',
            editor.toggleDay(s, 1) === null && s.days === null);
        let last = null;
        for (let d = 0; d < 7; d++) {
            last = editor.toggleDay(s, d);
        }
        suite.check('picking all seven means every day, stored as null', last === null && s.days === null);
        suite.check('a day that is not 0 to 6 is dropped', same(editor.normalizeDays([1, 9, -1, 1.5, '2']), [1]));
        suite.check('a day list that is not a list is null', editor.normalizeDays('mon') === null);
        suite.check('whatever the form leaves passes the save-time check',
            transitions.daysProblem({ days: editor.toggleDay(step('z'), 3) }) === null && transitions.daysProblem({ days: s.days }) === null);

        suite.check('empty "sometimes" is always', same(editor.parseChance(''), { ok: true, value: null }));
        suite.check('"50" is 50 percent', editor.parseChance('50').value === 50);
        suite.check('" 7 " is 7 percent', editor.parseChance(' 7 ').value === 7);
        suite.check('100 is always, stored as null', editor.parseChance('100').value === null && editor.parseChance('100').ok);
        for (const bad of ['0', '101', '12.5', 'half', '-5', '5%']) {
            suite.check(`"${bad}" is refused with a reason`, ! editor.parseChance(bad).ok && editor.parseChance(bad).error.length > 0);
        }
        const c = step('c', { chance: 30 });
        suite.check('a refused chance leaves the step as it was', ! editor.setChance(c, 'half').ok && c.chance === 30);
        suite.check('an accepted one is stored', editor.setChance(c, '45').ok && c.chance === 45);
        suite.check('clearing it stores null', editor.setChance(c, '').ok && c.chance === null);
        suite.check('whatever it stores passes the save-time check',
            [1, 50, 99].every( (n) => transitions.chanceProblem({ chance: editor.parseChance(String(n)).value }) === null));
    }

    // ---- "only when" -----------------------------------------------------------
    {
        const draft = editor.emptyDraft();
        const a = step('a');
        const b = step('b');
        const c = step('c');
        const other = step('o');
        draft.betweenShows.out.push(a, b);
        draft.betweenShows.in.push(c);
        draft.leaving.out.push(other);

        suite.check('a step may watch the others of its own situation, out and in together',
            same(editor.markOptions(draft, 'betweenShows', b).map( (s) => s.id ), ['a', 'c']));
        suite.check('... never itself, and never a step of another situation',
            ! editor.markOptions(draft, 'betweenShows', b).includes(b) && ! editor.markOptions(draft, 'betweenShows', b).includes(other));
        suite.check('marking watches the chosen step', editor.setMark(draft, 'betweenShows', b, 'a') && b.onlyIfNoMatch === 'a');
        suite.check('a marked step is not offered as something to watch',
            same(editor.markOptions(draft, 'betweenShows', c).map( (s) => s.id ), ['a']));
        suite.check('a step that is watched cannot itself become conditional',
            editor.isWatched(draft, 'betweenShows', a) && ! editor.setMark(draft, 'betweenShows', a, 'c') && a.onlyIfNoMatch === null);
        suite.check('a step cannot watch itself', ! editor.setMark(draft, 'betweenShows', c, 'c') && c.onlyIfNoMatch === null);
        suite.check('a step cannot watch one in another situation', ! editor.setMark(draft, 'betweenShows', c, 'o') && c.onlyIfNoMatch === null);
        suite.check('a step cannot watch another conditional step', ! editor.setMark(draft, 'betweenShows', c, 'b') && c.onlyIfNoMatch === null);
        suite.check('"always" clears the mark', editor.setMark(draft, 'betweenShows', b, '') && b.onlyIfNoMatch === null);

        editor.setMark(draft, 'betweenShows', b, 'a');
        editor.setMark(draft, 'betweenShows', c, 'a');
        const cleared = editor.removeStep(draft, 'betweenShows', a);
        suite.check('deleting a watched step clears every mark that named it, and says which',
            same(cleared.map( (s) => s.id ), ['b', 'c']) && b.onlyIfNoMatch === null && c.onlyIfNoMatch === null);
        suite.check('... and removes it from its side', same(draft.betweenShows.out.map( (s) => s.id ), ['b']));
        draft.betweenShows.out.push(a);
        editor.setMark(draft, 'betweenShows', c, 'a');
        suite.check('deleting a step nobody watches clears nothing',
            editor.removeStep(draft, 'betweenShows', b).length === 0 && c.onlyIfNoMatch === 'a');
        suite.check('a mark in another situation named like the deleted step is left alone',
            (() => {
                const d = editor.emptyDraft();
                const x = step('x');
                const y = step('y', { onlyIfNoMatch: 'x' });
                d.leaving.out.push(x);
                d.entering.out.push(y);
                return editor.removeStep(d, 'leaving', x).length === 0 && y.onlyIfNoMatch === 'x';
            })());

        const m = [step('m1'), step('m2'), step('m3')];
        const d2 = editor.emptyDraft();
        d2.leaving.out.push(...m);
        suite.check('a step moves one place later', editor.moveStep(d2, 'leaving', 'out', m[0], 1) && same(d2.leaving.out.map( (s) => s.id ), ['m2', 'm1', 'm3']));
        suite.check('... and earlier', editor.moveStep(d2, 'leaving', 'out', m[2], -1) && same(d2.leaving.out.map( (s) => s.id ), ['m2', 'm3', 'm1']));
        suite.check('... but not off either end', ! editor.moveStep(d2, 'leaving', 'out', m[1], -1) && ! editor.moveStep(d2, 'leaving', 'out', m[0], 1));
    }

    // ---- the sentence and the chip ----------------------------------------------
    {
        const sentence = (s, seq) => editor.describeStep(s, seq || [s], names);
        suite.check('the sentence the form opens with, word for word',
            sentence(step('s', { listId: 'upnext', match: 'show', keyedOn: 'next' }))
                === 'Plays a clip from Up Next about the show coming up; if none matches, plays nothing.',
            sentence(step('s', { listId: 'upnext', match: 'show', keyedOn: 'next' })));
        suite.check('keyed on the show that just ended',
            sentence(step('s', { listId: 'upnext', match: 'show', keyedOn: 'now' }))
                === 'Plays a clip from Up Next about the show that just ended; if none matches, plays nothing.');
        suite.check('a pair step says it falls back to the one coming up',
            sentence(step('s', { listId: 'upnext', match: 'pair' })).includes('the show that just ended and the one coming up (or, failing that, just the one coming up)'));
        suite.check('"any" says any clip',
            sentence(step('s', { listId: 'wbrb', match: 'any' })) === 'Plays any clip from WBRB; if nothing in it fits, plays nothing.');
        suite.check('a fallback list is named',
            sentence(step('s', { listId: 'upnext', match: 'show', fallbackListId: 'generic' }))
                === 'Plays a clip from Up Next about the show coming up; if none matches, plays a clip from Generic.');
        suite.check('days read as words',
            sentence(step('s', { days: [1, 3, 5] })).includes('only on Mon, Wed and Fri'));
        suite.check('two days read as "and"', sentence(step('s', { days: [0, 6] })).includes('only on Sun and Sat'));
        suite.check('a chance reads as a percent', sentence(step('s', { chance: 50 })).includes('about 50% of the time'));
        const watched = step('w', { listId: 'upnext' });
        const marked = step('m', { listId: 'btts', onlyIfNoMatch: 'w' });
        suite.check('a marked step names the step it watches',
            sentence(marked, [watched, marked]).includes('only when the “Up Next” step found nothing'));
        suite.check('a mark on a step that is not there says it never plays',
            sentence(step('m', { onlyIfNoMatch: 'ghost' })).includes('never plays'));
        suite.check('no list chosen is said plainly',
            sentence(step('s', { listId: '' })).startsWith('Plays any clip from a list you have not chosen yet'));
        suite.check('a list that was deleted is said plainly',
            sentence(step('s', { listId: 'gone' })).includes('a list that no longer exists'));
        suite.check('"later" and "generated" read as not built, kept as they are',
            sentence(step('s', { keyedOn: 'later', match: 'show' })).includes('not built yet')
            && sentence(step('s', { kind: 'generated' })).includes('not built yet'));
        suite.check('the sentence ends with one full stop and has no doubled punctuation',
            ['upnext', 'wbrb'].every( (l) => { const t = sentence(step('s', { listId: l, days: [2], chance: 20 })); return t.endsWith('.') && ! t.includes('..') && ! t.includes(';;'); }));

        suite.check('the chip reads list, choice, then skip',
            editor.chipLabel(step('s', { listId: 'upnext', match: 'show' }), [], names) === 'Up Next · names next show · skip');
        suite.check('... or the fallback list',
            editor.chipLabel(step('s', { listId: 'upnext', match: 'show', fallbackListId: 'generic' }), [], names) === 'Up Next · names next show · else Generic');
        suite.check('"any" and the other choices have their own words',
            editor.chipLabel(step('s', { listId: 'wbrb', match: 'any' }), [], names).includes('any clip')
            && editor.chipLabel(step('s', { match: 'show', keyedOn: 'now' }), [], names).includes('names last show')
            && editor.chipLabel(step('s', { match: 'pair' }), [], names).includes('names last → next'));
        suite.check('days and chance show on the chip, since they decide whether it plays',
            editor.chipLabel(step('s', { days: [1, 2], chance: 25 }), [], names).endsWith('Mon Tue · 25%'));
        suite.check('a mark shows on the chip',
            editor.chipLabel(marked, [watched, marked], names).includes('if “Up Next” finds nothing'));
    }

    // ---- what is wrong with a step ----------------------------------------------
    {
        const p = (s, seq) => editor.problemsOf(s, seq || [s], names);
        suite.check('a healthy step has no problems', p(step('s')).length === 0);
        suite.check('no list chosen is a problem', p(step('s', { listId: '' })).length === 1);
        suite.check('a deleted list is a problem', p(step('s', { listId: 'gone' })).length === 1);
        suite.check('a deleted fallback list is a problem', p(step('s', { fallbackListId: 'gone' })).length === 1);
        suite.check('a mark that cannot be honoured is a problem', p(step('s', { onlyIfNoMatch: 'ghost' })).length === 1);
        suite.check('an empty days list in a stored step is a problem', p(step('s', { days: [] })).length === 1);
        suite.check('a bad chance in a stored step is a problem', p(step('s', { chance: 0 })).length === 1);
        suite.check('a step that is not a list step has none to report', p(step('s', { kind: 'generated', listId: '' })).length === 0);
        const draft = editor.emptyDraft();
        suite.check('an empty draft has no unfinished step', ! editor.hasUnfinishedStep(draft));
        draft.leaving.in.push(step('u', { listId: '' }));
        suite.check('a step with no list is unfinished, and saving should wait', editor.hasUnfinishedStep(draft));
        draft.leaving.in[0].listId = 'wbrb';
        suite.check('... until it has one', ! editor.hasUnfinishedStep(draft));
    }

    // ---- draft and stored shape ---------------------------------------------------
    {
        const channel = fixtureChannel();
        const before = JSON.stringify(channel);
        const draft = editor.loadDraft(channel.dayParts[0]);
        suite.check('reading a context into a draft changes nothing', JSON.stringify(channel) === before);
        suite.check('the draft has all four situations, each side a list',
            transitions.SITUATIONS.every( (n) => Array.isArray(draft[n].out) && Array.isArray(draft[n].in) ));
        suite.check('the draft is a copy: editing it does not edit the context',
            (() => { draft.leaving.out[0].listId = 'btts'; return channel.dayParts[0].transitions.leaving.out[0].listId === 'signoff'; })());

        const bare = { name: 'Bare', fillerCollections: [], starts: [] };
        const d = editor.loadDraft(bare);
        editor.commit(bare, d, false);
        suite.check('committing a draft with no step to a context that had none adds no key', ! ('transitions' in bare));
        const s = editor.addStep(d, 'betweenShows', 'out', Object.assign(editor.newStep(d), { listId: 'wbrb' }));
        editor.commit(bare, d, false);
        suite.check('committing one step writes all four situations',
            same(Object.keys(bare.transitions), transitions.SITUATIONS) && bare.transitions.betweenShows.out.length === 1);
        editor.removeStep(d, 'betweenShows', s);
        editor.commit(bare, d, false);
        suite.check('adding a step and deleting it again leaves the context as it was', ! ('transitions' in bare));
        const had = { name: 'Had', transitions: { betweenShows: { out: [], in: [] } } };
        editor.commit(had, editor.loadDraft(had), true);
        suite.check('a context that had a (blank) transitions keeps one', 'transitions' in had);

        const withUi = editor.emptyDraft();
        editor.addStep(withUi, 'leaving', 'out', Object.assign(step('ui'), { $$chanceText: '5', $open: true }));
        const out = editor.serialize(withUi);
        suite.check('form-only fields never reach the stored shape', ! JSON.stringify(out).includes('$'));
        suite.check('everything else on a step is kept, hand-added fields included',
            (() => {
                const x = editor.emptyDraft();
                editor.addStep(x, 'leaving', 'out', Object.assign(step('h'), { note: 'by hand' }));
                return editor.serialize(x).leaving.out[0].note === 'by hand';
            })());

        // The round trip: what the editor stores reads back the same, and passes the save-time check.
        const target = { name: 'Target', fillerCollections: [], starts: [{ days: [1], time: 0 }] };
        const dd = editor.loadDraft(target);
        const first = editor.addStep(dd, 'betweenShows', 'out', Object.assign(editor.newStep(dd), { listId: 'upnext', fallbackListId: 'generic' }));
        const second = editor.addStep(dd, 'betweenShows', 'in', Object.assign(editor.newStep(dd), { listId: 'wbrb' }));
        editor.setWhich(second, 'any');
        editor.setMark(dd, 'betweenShows', second, first.id);
        editor.toggleDay(first, 1);
        editor.toggleDay(first, 4);
        editor.setChance(first, '60');
        editor.commit(target, dd, false);
        suite.check('what is stored reads back as the draft',
            same(editor.serialize(editor.loadDraft(target)), editor.serialize(dd)));
        const lines = [];
        const real = console.error;
        console.error = (...args) => lines.push(args.join(' '));
        try {
            new ChannelDB('/nonexistent').validateChannelJson(7, { dayParts: [Object.assign({ name: 'D', fillerCollections: [],
                starts: [{ days: [1], time: 0 }] }, target)], blocks: [] });
        } finally { console.error = real; }
        suite.check('and the save-time check has nothing to say about it', lines.length === 0, lines.join(' | '));
    }

    // ---- the tag on a Flex row ------------------------------------------------------
    {
        const channel = fixtureChannel();
        const starts = startsOf(channel);
        const tag = (i) => editor.flexTag(channel, i, starts[i], names);
        const before = JSON.stringify(channel);

        suite.check('between episodes, one step each side: both are named, in play order',
            tag(1) !== null && tag(1).text === 'WBRB / BTTS', tag(1) && tag(1).text);
        suite.check('the tooltip spells out what is before and after the break',
            tag(1).title === 'Before the break: WBRB\nAfter the break: BTTS', JSON.stringify(tag(1).title));
        suite.check('a break of two Flex rows: the first carries the steps before the break',
            tag(3) !== null && tag(3).text === 'Sign Off / Intro', tag(3) && tag(3).text);
        suite.check('... and the last the steps after it, keyed on the show it names',
            tag(4) !== null && tag(4).text === 'Up Next · Beta', tag(4) && tag(4).text);
        suite.check('a conditional step is in brackets and a one that plays some of the time carries "?"',
            tag(6).text === 'Up Next · Gamma / (Generic)', tag(6).text);
        suite.check('... and the tooltip says what the brackets mean', tag(6).title.includes('( ) ='));

        const chancy = fixtureChannel();
        chancy.blocks[0].transitions.betweenShows.in[0].chance = 40;
        suite.check('a step with a chance carries "?" and the tooltip explains it',
            editor.flexTag(chancy, 6, starts[6], names).text.startsWith('Up Next · Gamma ?')
            && editor.flexTag(chancy, 6, starts[6], names).title.includes('? ='));

        const monday = fixtureChannel();
        monday.blocks[0].transitions.betweenShows.in[0].days = [1];
        suite.check('a step limited to other weekdays than the break\'s is left out of the tag (this break is a Friday)',
            editor.flexTag(monday, 6, starts[6], names).text === '(Generic)');
        monday.blocks[0].transitions.betweenShows.in[0].days = [5];
        suite.check('... and one limited to this weekday stays in',
            editor.flexTag(monday, 6, starts[6], names).text === 'Up Next · Gamma / (Generic)');

        const keyed = fixtureChannel();
        keyed.blocks[0].transitions.betweenShows.in = [
            step('k1', { listId: 'upnext', match: 'show', keyedOn: 'now' }),
            step('k2', { listId: 'upnext', match: 'pair' }),
            step('k3', { listId: 'wbrb', match: 'any' }),
            step('k4', { kind: 'generated' }),
            step('k5', { match: 'show', keyedOn: 'later' }),
        ];
        suite.check('keyed on the show that ended, on both, and on neither; steps that are not built are not named',
            editor.flexTag(keyed, 6, starts[6], names).text === 'Up Next · Beta / Up Next · Beta → Gamma / WBRB',
            editor.flexTag(keyed, 6, starts[6], names).text);

        const missing = fixtureChannel();
        missing.blocks[0].transitions.betweenShows.in[0].listId = 'gone';
        suite.check('a step whose list is gone is still named, as such',
            editor.flexTag(missing, 6, starts[6], names).text.startsWith('(a list that no longer exists) · Gamma'));

        const quiet = fixtureChannel();
        quiet.dayParts[0].transitions = undefined;
        quiet.blocks[0].transitions = undefined;
        suite.check('a channel with no steps has no tag on any Flex row',
            quiet.programs.every( (p, i) => ! p.isOffline || editor.flexTag(quiet, i, starts[i], names) === null));
        suite.check('and hasSteps agrees', ! transitions.hasSteps(quiet) && transitions.hasSteps(channel));
        suite.check('a Flex row whose break has nothing on its side has no tag',
            (() => { const c = fixtureChannel(); c.dayParts[0].transitions = { betweenEpisodes: { out: [], in: [step('only', { listId: 'btts' })] } };
                return editor.flexTag(c, 1, starts[1], names).text === 'BTTS' && editor.flexTag(c, 6, starts[6], names).text.length > 0; })());
        suite.check('reading tags changes nothing', JSON.stringify(channel) === before);

        // The tag is the plan's steps, not a guess: for every break of the fixture the steps
        // it names are the ones buildPlan assembled and did not leave out for a weekday.
        const all = [];
        for (const brk of transitions.breaksBetween(channel, starts[0], starts[0] + 163 * MIN) ) {
            const plan = transitions.assemble(channel, brk);
            const expect = plan.out.length + plan.in.length;
            const got = [];
            for (let i = brk.firstFlex; i <= brk.lastFlex; i++) {
                const t = tag(i);
                if (t !== null) {
                    got.push(...t.text.split(' / '));
                }
            }
            all.push([expect, got.length]);
        }
        suite.check('every assembled step of every break is named once across the break\'s rows', all.every( ([a, b]) => a === b ), JSON.stringify(all));
    }

    // ---- the preview ----------------------------------------------------------------
    {
        const channel = fixtureChannel();
        const starts = startsOf(channel);
        const from = starts[0];
        const to = from + 163 * MIN;
        const before = JSON.stringify(channel);
        const late = channel.blocks[0];
        const day = channel.dayParts[0];

        const view = editor.previewBreaks(channel, late, from, to, env());
        const ofLate = view.situations;
        suite.check('Late sees break B as Entering and breaks C and D as Between shows',
            ofLate.entering.total === 1 && ofLate.betweenShows.total === 2 && ofLate.betweenEpisodes.total === 0 && ofLate.leaving.total === 0,
            JSON.stringify(Object.keys(ofLate).map( (k) => [k, ofLate[k].total] )));
        const entering = ofLate.entering.items[0];
        suite.check('Entering shows the whole plan: Day\'s sign-off, Late\'s intro, then Up Next for Beta',
            same(entering.out.map( (c) => c.clip ), ['Sign Off', 'Intro']) && same(entering.in.map( (c) => c.clip ), ['Up Next Beta']),
            JSON.stringify([entering.out, entering.in]));
        suite.check('... between the show that ended and the one that starts, naming the other context',
            entering.prev === 'Alpha' && entering.next === 'Beta' && entering.other === 'Day');
        suite.check('the Flex that is left is the break minus the steps (4m - 12s - 9s - 10s)',
            entering.flexMs === 4 * MIN - 31 * 1000 && editor.mmss(entering.flexMs) === '3:29', editor.mmss(entering.flexMs));
        const [c, d] = ofLate.betweenShows.items;
        suite.check('Up Next plays its clip for Gamma, and the conditional generic bumper stays out because it played',
            same(c.in.map( (x) => x.clip ), ['Up Next Gamma']) && c.left.some( (l) => l.step.startsWith('Generic') && l.why === 'stays out because “Up Next” found a clip' && ! l.step.includes('missing')),
            JSON.stringify([c.in, c.left]));
        suite.check('with no clip naming Delta, Up Next finds nothing and the generic bumper plays',
            same(d.in.map( (x) => x.clip ), ['Generic Bumper']) && d.left.some( (l) => l.step.startsWith('Up Next') && l.why === 'found no clip'),
            JSON.stringify([d.in, d.left]));
        suite.check('breaks with steps are counted', ofLate.betweenShows.withSteps === 2 && ofLate.entering.withSteps === 1);

        const ofDay = editor.previewBreaks(channel, day, from, to, env()).situations;
        suite.check('Day sees break A as Between episodes and break B as Leaving',
            ofDay.betweenEpisodes.total === 1 && ofDay.leaving.total === 1 && ofDay.entering.total === 0 && ofDay.betweenShows.total === 0);
        suite.check('Leaving shows the same break B as Entering does, from Day\'s side',
            same(ofDay.leaving.items[0].out.map( (x) => x.clip ), ['Sign Off', 'Intro']) && ofDay.leaving.items[0].other === 'Late');
        suite.check('Between episodes plays WBRB then BTTS around the Flex',
            same(ofDay.betweenEpisodes.items[0].out.map( (x) => x.clip ), ['WBRB']) && same(ofDay.betweenEpisodes.items[0].in.map( (x) => x.clip ), ['BTTS']));

        // The preview is buildPlan's answer, not a second opinion.
        let agree = true;
        for (const brk of transitions.breaksBetween(channel, from, to) ) {
            const plan = transitions.buildPlan(channel, brk, env());
            const mine = [ofDay, ofLate].map( (v) => [].concat(...transitions.SITUATIONS.map( (n) => v[n].items )) )
                .reduce( (a, b) => a.concat(b), [] ).find( (i) => i.startTime === brk.startTime );
            if ( (typeof(mine) !== 'undefined') && ! same(mine.out.map( (x) => x.clip ), plan.out.map( (x) => x.clip.title ))
                || (typeof(mine) !== 'undefined') && ! same(mine.in.map( (x) => x.clip ), plan.in.map( (x) => x.clip.title )) ) {
                agree = false;
            }
        }
        suite.check('for every break the clips shown are exactly the clips buildPlan chooses', agree);

        // A chance: the preview rolls the way playback does.
        const sometimes = fixtureChannel();
        sometimes.dayParts[0].transitions.betweenEpisodes.out[0].chance = 50;
        const seen = new Set();
        for (let w = 0; w < 60; w++) {
            const pv = editor.previewBreaks(sometimes, sometimes.dayParts[0], from + w * 3 * HOUR, to + w * 3 * HOUR, env());
            pv.situations.betweenEpisodes.items.forEach( (i) => seen.add(i.out.length) );
        }
        suite.check('a step with a chance plays on some breaks and not others', seen.has(0) && seen.has(1), JSON.stringify([...seen]));
        suite.check('... and the left-out ones say why',
            (() => {
                for (let w = 0; w < 60; w++) {
                    const pv = editor.previewBreaks(sometimes, sometimes.dayParts[0], from + w * 3 * HOUR, to + w * 3 * HOUR, env());
                    const hit = pv.situations.betweenEpisodes.items.find( (i) => i.out.length === 0 );
                    if (typeof(hit) !== 'undefined') {
                        return hit.left.some( (l) => l.why.includes('lost its 50% chance') );
                    }
                }
                return false;
            })());

        const tight = fixtureChannel();
        tight.programs[1] = flex(0.1);
        const crowded = editor.previewBreaks(tight, tight.dayParts[0], from, from + 40 * MIN, env()).situations.betweenEpisodes.items[0];
        suite.check('steps longer than their break leave no Flex and are flagged', crowded.flexMs === 0 && crowded.overrun === true);

        suite.check('previewing changes nothing', JSON.stringify(channel) === before);
        suite.check('a channel that has no steps previews as all commercials',
            (() => { const q = fixtureChannel(); q.dayParts[0].transitions = undefined; q.blocks[0].transitions = undefined;
                const v = editor.previewBreaks(q, q.blocks[0], from, to, env()).situations;
                return v.betweenShows.total === 2 && v.betweenShows.withSteps === 0 && v.entering.withSteps === 0; })());
        suite.check('clock and length labels', editor.clockLabel(at('2026-10-02T14:50:00')) === 'Fri 2:50pm'
            && editor.clockLabel(at('2026-10-04T00:05:00')) === 'Sun 12:05am' && editor.mmss(252000) === '4:12');
    }

    // ---- suggested names for the preview ------------------------------------------------
    {
        const clips = [clip('Up Next - Beta', 10), clip('Already', 10, { names: ['tv.Gamma'] }), clip('Broken', 10, { names: 'tv.Alpha' }), clip('Nothing', 10)];
        const match = { clips: [
            { proposal: { names: ['tv.Beta'] } }, { proposal: { names: ['tv.Alpha'] } },
            { proposal: { names: ['tv.Alpha'] } }, { proposal: { names: [] } },
        ] };
        const before = JSON.stringify(clips);
        const out = editor.overlayProposedNames(clips, match);
        suite.check('an unnamed clip takes the proposal', same(out[0].names, ['tv.Beta']));
        suite.check('a clip with names of its own keeps them', same(out[1].names, ['tv.Gamma']));
        suite.check('a clip whose stored names are unusable stays as it is, so it stays ineligible', out[2].names === 'tv.Alpha');
        suite.check('a clip with no proposal stays unnamed', typeof(out[3].names) === 'undefined');
        suite.check('the clips given are not changed', JSON.stringify(clips) === before);
        suite.check('no match answer at all changes nothing', editor.overlayProposedNames(clips, null).every( (c, i) => c === clips[i] ));
    }

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
