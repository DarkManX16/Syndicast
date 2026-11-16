/*
 * The Midroll situation and the midroll setting (docs/blocks-spec.md, Stage 6, "The Midroll
 * situation"; build order 5e), pure: a fifth situation in each day-part's and block's
 * transitions, read, saved, validated and copied like the other four; and the `midrolls`
 * setting, whose default follows the Midrolls switch (`count: null`). The channel editor keeps
 * its four Transitions rows until step 7.
 */
const fs = require('fs');
const path = require('path');
const { Suite } = require('./support');
const transitions = require('../src/transitions');
const editor = require('../src/transitions-editor');
const ChannelDB = require('../src/dao/channel-db');

const step = (id, extra = {}) => Object.assign( { id, kind: 'list', listId: 'L' + id }, extra );

module.exports = async () => {
    const suite = new Suite('the Midroll situation and its setting');

    // ---- the situation ----------------------------------------------------------------------
    suite.check('"midroll" is a situation, after the four there were',
        JSON.stringify(transitions.SITUATIONS) === JSON.stringify( [ 'leaving', 'entering', 'betweenEpisodes', 'betweenShows', 'midroll' ] ), transitions.SITUATIONS.join());
    {
        const empty = transitions.normalizeTransitions(undefined);
        suite.check('a context with no transitions reads an empty midroll too',
            (empty.midroll != null) && Array.isArray(empty.midroll.out) && (empty.midroll.out.length === 0) && Array.isArray(empty.midroll.in) && (empty.midroll.in.length === 0));
        const context = { name: 'Toonami', transitions: { betweenShows: { out: [ step('a') ], in: [] }, midroll: { out: [ step('w', { keyedOn: 'now' }) ], in: [ step('b', { keyedOn: 'now' }) ] } } };
        const before = JSON.stringify(context);
        const read = transitions.normalizeTransitions(context);
        read.midroll = read.midroll || { out: [], in: [] };
        suite.check('a midroll\'s steps read with the defaults, like any situation\'s',
            (read.midroll.out.length === 1) && (read.midroll.out[0].kind === 'list') && (read.midroll.out[0].match === 'any') && (read.midroll.out[0].keyedOn === 'now') && (read.midroll.in[0].id === 'b'));
        suite.check('...and reading rewrites nothing', JSON.stringify(context) === before);
        const channel = { number: 9, dayParts: [ { id: 'd', transitions: { midroll: { out: [ step('m') ], in: [] } } } ], programs: [] };
        suite.check('a channel whose only steps are a midroll\'s has steps, and its list is loaded',
            transitions.hasSteps(channel) && transitions.stepListIds(channel).includes('Lm'), JSON.stringify(transitions.stepListIds(channel)));
    }

    // ---- saving: validated like the other four, warn-only --------------------------------------
    {
        const db = new ChannelDB(path.join(__dirname, 'no-such-folder'));
        const warningsFor = (channel) => {
            const lines = [];
            const real = console.error;
            console.error = (...args) => lines.push(args.join(' '));
            try {
                db.validateChannelJson(7, channel);
            } finally {
                console.error = real;
            }
            // the fixtures' day-parts have no start times; only what is said about transitions and midrolls counts here
            return lines.filter( (l) => /transitions|midrolls/.test(l) );
        };
        const good = { dayParts: [ { name: 'Toonami', transitions: { midroll: { out: [ step('w', { keyedOn: 'now' }) ], in: [] } } } ] };
        suite.check('a midroll\'s steps are accepted at save, not called an unknown situation', warningsFor(good).length === 0, warningsFor(good).join(' | '));
        const noList = { dayParts: [ { name: 'Toonami', transitions: { midroll: { out: [ { id: 'x', kind: 'list' } ], in: [] } } } ] };
        suite.check('...and checked like them: a step with no list is warned about', warningsFor(noList).some( (l) => /midroll\.out step 0 names no filler list/.test(l) ), warningsFor(noList).join(' | '));

        // the setting
        suite.check('a context with no midroll setting is fine', warningsFor( { blocks: [ { name: 'B', airings: [], transitions: {} } ] } ).length === 0);
        const settingWarnings = (midrolls) => warningsFor( { dayParts: [ { name: 'Late Night', midrolls } ] } );
        suite.check('a good setting saves with no warning',
            (settingWarnings( { count: null, minMs: 90000, story: true, opening: false } ).length === 0) && (settingWarnings( { count: 2 } ).length === 0) && (settingWarnings( { count: 0 } ).length === 0));
        for (const [ bad, why ] of [
            [ 'yes', /midrolls is not an object/ ],
            [ { count: -1 }, /count/ ], [ { count: 1.5 }, /count/ ], [ { count: '2' }, /count/ ],
            [ { minMs: 0 }, /minMs/ ], [ { minMs: 'long' }, /minMs/ ],
            [ { story: 'yes' }, /story/ ], [ { opening: 1 }, /opening/ ],
        ]) {
            const lines = settingWarnings(bad);
            suite.check(`a bad setting is warned about, naming the day-part: ${JSON.stringify(bad)}`,
                (lines.length === 1) && why.test(lines[0]) && /day-part 0 \("Late Night"\)/.test(lines[0]), lines.join(' | '));
        }
        const channel = { dayParts: [ { name: 'Late Night', midrolls: { count: -1 } } ] };
        warningsFor(channel);
        suite.check('...and a warning rewrites nothing', channel.dayParts[0].midrolls.count === -1);
    }

    // ---- the setting, read ---------------------------------------------------------------------
    {
        const DEFAULT = { count: null, minMs: 90000, story: true, opening: false };
        suite.check('a context saved before the setting existed reads as the default, which follows the switch (count null)',
            JSON.stringify(transitions.normalizeMidrolls( { name: 'X' } )) === JSON.stringify(DEFAULT), JSON.stringify(transitions.normalizeMidrolls( { name: 'X' } )));
        suite.check('...a null context too', JSON.stringify(transitions.normalizeMidrolls(null)) === JSON.stringify(DEFAULT));
        const set = { midrolls: { count: 2, opening: true } };
        const read = transitions.normalizeMidrolls(set);
        suite.check('what is set is kept, the rest is the default',
            (read.count === 2) && (read.opening === true) && (read.minMs === 90000) && (read.story === true), JSON.stringify(read));
        suite.check('count 0 means none here', transitions.normalizeMidrolls( { midrolls: { count: 0 } } ).count === 0);
        const bad = transitions.normalizeMidrolls( { midrolls: { count: -3, minMs: 'x', story: 'no', opening: null } } );
        suite.check('a bad value reads as its default, one field at a time', JSON.stringify(bad) === JSON.stringify(DEFAULT), JSON.stringify(bad));
        suite.check('reading the setting rewrites nothing', set.midrolls.minMs === undefined);
        read.count = 9;
        suite.check('...and hands back a fresh object each time', transitions.normalizeMidrolls(set).count === 2);
    }

    // ---- the editor: four rows until step 7, and midroll steps kept through a save ----------------
    {
        const directive = fs.readFileSync(path.join(__dirname, '..', 'web', 'directives', 'transitions-editor.js'), 'utf8');
        const rows = /scope\.situations = \[([\s\S]*?)\];/.exec(directive);
        const ids = rows ? Array.from(rows[1].matchAll(/id: '([^']+)'/g)).map( (m) => m[1] ) : [];
        suite.check('the channel editor still shows its four Transitions rows, no Midroll row yet',
            JSON.stringify(ids) === JSON.stringify( [ 'leaving', 'entering', 'betweenEpisodes', 'betweenShows' ] ), ids.join());
        // until step 7 gives it a row, the editor writes no empty midroll: a channel saved from it is as before 5e
        const plain = { name: 'Plain', transitions: { leaving: { out: [], in: [] }, entering: { out: [], in: [] }, betweenEpisodes: { out: [], in: [] }, betweenShows: { out: [ step('a') ], in: [] } } };
        editor.commit(plain, editor.loadDraft(plain), true);
        suite.check('a context saved from the editor with no midroll steps gets no empty midroll',
            JSON.stringify(Object.keys(plain.transitions)) === JSON.stringify( [ 'leaving', 'entering', 'betweenEpisodes', 'betweenShows' ] ), JSON.stringify(Object.keys(plain.transitions)));
        const context = { name: 'Toonami', transitions: { betweenShows: { out: [ step('a') ], in: [] }, midroll: { out: [ step('w', { keyedOn: 'now' }) ], in: [] } } };
        const draft = editor.loadDraft(context);
        editor.commit(context, draft, true);
        suite.check('a context saved from the editor keeps its midroll steps',
            (context.transitions.midroll != null) && (context.transitions.midroll.out.length === 1) && (context.transitions.midroll.out[0].id === 'w'), JSON.stringify(context.transitions.midroll));
        const target = { name: 'Late Night' };
        const copied = editor.copySituations(draft, target, [ 'midroll' ]);
        suite.check('...and Copy can carry a midroll to another day-part',
            (target.transitions != null) && (target.transitions.midroll.out.length === 1), JSON.stringify(copied));
    }

    // ---- the card service sees a midroll's card steps --------------------------------------------
    {
        const CardService = require('../src/services/card-service');
        const channel = { dayParts: [ { id: 'd', transitions: { midroll: { out: [ { id: 'c', kind: 'generated', templateId: 'tpl', keyedOn: 'now' } ], in: [] } } } ] };
        suite.check('a channel whose only card step is a midroll\'s counts as having card steps',
            (typeof(CardService.cardSteps) === 'function') && CardService.cardSteps(channel));
    }
    return suite;
};
