/*
 * Stage 5, step 6: the names review screen's logic and its save. Phrase
 * nicknames in the matcher, the nickname rules (src/show-match.js's
 * checkNickname and nicknameSuggestions), the screen's grouping, accept-all and
 * save payload (src/names-review.js), the save itself (ShowMatchService.saveNames
 * and its routes) and the preview's "would fit once accepted" hints. See
 * docs/blocks-spec.md, Stage 5, "Which shows a clip names" and the build order.
 *
 * Fixtures only. The save is driven against throwaway folders under the OS temp
 * directory with the real FillerDB and ShowAliasDB, so what is checked is the
 * bytes on disk; no test here reads or writes a data folder of the user's.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { MIN, Suite } = require('./support');
const showMatch = require('../src/show-match');
const review = require('../src/names-review');
const editor = require('../src/transitions-editor');
const FillerDB = require('../src/dao/filler-db');
const ShowAliasDB = require('../src/dao/show-alias-db');
const ShowMatchService = require('../src/services/show-match-service');
const FillerService = require('../src/services/filler-service');
const api = require('../src/api');

function ep(show) {
    return { title: show + ' 1', type: 'episode', showTitle: show, duration: 22 * MIN, serverKey: 'srv' };
}
function custom(id, name) {
    return { title: name + ' item', type: 'episode', showTitle: name, customShowId: id, customShowName: name, duration: 7 * MIN };
}
function channel(number, programs, extra) {
    return Object.assign({ number, name: 'C' + number, programs, scheduleBackup: { slots: [] } }, extra || {});
}

const SHOWS = [
    "Foster's Home for Imaginary Friends", 'Camp Lazlo', 'The Grim Adventures of Billy & Mandy', 'Grim & Evil',
    'The New Batman Adventures', 'Static Shock', 'Teenage Mutant Ninja Turtles (2003)', 'Teen Titans', 'Gundam Wing',
    'Codename: Kids Next Door', 'Cowboy Bebop', 'Dragon Ball Z', 'Space Ghost Coast to Coast', 'Ed, Edd n Eddy',
    'Totally Spies!', 'Doug',
];
const CHANNELS = [channel(1, SHOWS.map(ep).concat([custom('g1', 'Mobile Suit Gundam Series')]))];
const K = {
    foster: "tv.Foster's Home for Imaginary Friends", lazlo: 'tv.Camp Lazlo', grim: 'tv.The Grim Adventures of Billy & Mandy',
    grimEvil: 'tv.Grim & Evil', batman: 'tv.The New Batman Adventures', static: 'tv.Static Shock',
    tmnt: 'tv.Teenage Mutant Ninja Turtles (2003)', titans: 'tv.Teen Titans', gundamWing: 'tv.Gundam Wing',
    knd: 'tv.Codename: Kids Next Door', bebop: 'tv.Cowboy Bebop', dbz: 'tv.Dragon Ball Z', sgc: 'tv.Space Ghost Coast to Coast',
    ed: 'tv.Ed, Edd n Eddy', doug: 'tv.Doug', gundam: 'custom.g1',
};
const vocab = showMatch.buildVocabulary(CHANNELS, { g1: 'Mobile Suit Gundam Series' });
const names = (p) => p.names.join();

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'syndicast-review-'));
}
function removeDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* left for the OS */ }
}

// A row as the match route gives it.
function row(index, title, o) {
    const proposal = (o && o.proposal) || { names: [], found: [], extra: 0 };
    return { index, title, names: (o && o.names) || [], reviewed: !!(o && o.reviewed), proposal };
}
const hit = (flags) => Object.assign({ key: 'tv.X', text: 'x', via: 'title' }, flags || {});
const confident = (keys) => ({ names: keys, found: keys.map(() => hit()), extra: 0 });

module.exports = async function () {
    const suite = new Suite('names review');

    // ---- phrase nicknames, in the matcher -------------------------------------
    {
        const p = (t, aliases) => showMatch.propose(t, vocab, aliases || {});
        suite.check('a phrase nickname names its show: "grim advs"',
            names(p('Adult Swim - Grim Advs Promo', { 'grim advs': K.grim })) === K.grim);
        suite.check('and says it was found by an alias, with the phrase as the text',
            p('Grim Advs Promo', { 'grim advs': K.grim }).found[0].via === 'alias' && p('Grim Advs Promo', { 'grim advs': K.grim }).found[0].text === 'grim advs');
        suite.check('the phrase does not name a clip that has only one of its words ("The New Batman Advs")',
            p('The New Batman Advs promo', { 'grim advs': K.grim }).names.length === 0);
        suite.check('a phrase is matched as whole words: "grim advsx" is not "grim advs"',
            p('Grim Advsx promo', { 'grim advs': K.grim }).names.length === 0);
        suite.check('the phrase is read through different case and punctuation: "GRIM-ADVS"',
            names(p('GRIM-ADVS bumper', { 'grim advs': K.grim })) === K.grim);
        suite.check('a number in a phrase works: "gundam 0083" names Mobile Suit Gundam Series',
            names(p('Gundam 0083 NEXT', { 'gundam 0083': K.gundam })) === K.gundam);
        suite.check('... and not a clip for another Gundam: "Gundam 0080" and "Gundam Wing"',
            p('Gundam 0080 NEXT', { 'gundam 0083': K.gundam }).names.length === 0
            && names(p('Gundam Wing NEXT', { 'gundam 0083': K.gundam })) === K.gundamWing);
        suite.check('the longest nickname wins over a word inside it',
            names(p('Gundam 0083 NEXT', { 'gundam 0083': K.gundam, '0083': K.doug })) === K.gundam
            && names(p('Gundam 0083 NEXT', { 'gundam': K.sgc, 'gundam 0083': K.gundam })) === K.gundam);
        suite.check('a phrase never reaches into a show title that was found first ("Grim & Evil")',
            names(p('Grim & Evil promo', { 'grim': K.grim })) === K.grimEvil);
        suite.check('a nickname stored with capitals still works (the file may be edited by hand)',
            names(p('sgc2c promo', { SGC2C: K.sgc })) === K.sgc);
        suite.check('"Foster\'s" is the phrase "foster s": the half-read two-show title now names both, in order',
            names(p("Now/Then (Foster's / Camp Lazlo)", { 'foster s': K.foster })) === `${K.foster},${K.lazlo}`
            && p("Now/Then (Foster's / Camp Lazlo)").unresolved != null);
        suite.check('"static" resolves the three-show Miguzi title, in airing order',
            names(p('Miguzi - Next Bumper (TMNT-Static-Teen Titans)', { static: K.static })) === `${K.tmnt},${K.static},${K.titans}`
            && p('Miguzi - Next Bumper (TMNT-Static-Teen Titans)', { static: K.static }).unresolved == null);
        suite.check('and without it, the same title is flagged and names nothing',
            p('Miguzi - Next Bumper (TMNT-Static-Teen Titans)').names.length === 0
            && p('Miguzi - Next Bumper (TMNT-Static-Teen Titans)').unresolved.recognised.join() === `${K.tmnt},${K.titans}`);
        const aliases = { 'grim advs': K.grim };
        const before = JSON.stringify(aliases);
        p('Grim Advs promo', aliases);
        suite.check('proposing leaves the nicknames it was given alone', JSON.stringify(aliases) === before);
    }

    // ---- the nickname rules ---------------------------------------------------
    {
        const clips = [
            { list: 'a', index: 0, title: 'Adult Swim Promo - Cowboy Bebop [2003]', names: [], reviewed: false },
            { list: 'a', index: 1, title: 'Grim Advs Promo 1', names: [], reviewed: false },
            { list: 'a', index: 2, title: 'Grim Advs Promo 2', names: [K.grim], reviewed: false },
            { list: 'b', index: 0, title: 'The New Batman Advs - Next', names: [], reviewed: false },
            { list: 'b', index: 1, title: 'Grim Advs Billy Bumper', names: [], reviewed: false },
            { list: 'b', index: 2, title: 'Dragon Ball Z Kai NEXT', names: [K.dbz], reviewed: false },
            { list: 'b', index: 3, title: 'Grim Advs - saved as no show', names: [], reviewed: true },
        ];
        const check = (text, key, aliases, o) => showMatch.checkNickname(text, key, vocab, aliases || {}, clips, o);
        const refused = (r, pattern) => !r.ok && r.problems.some((m) => pattern.test(m));

        suite.check('"NEXT" is refused: an everyday word', refused(check('NEXT', K.grim), /everyday words/));
        suite.check('"promo bumper" is refused: only everyday words', refused(check('promo bumper', K.grim), /everyday words/));
        suite.check('a number on its own is refused', refused(check('0083', K.gundam), /number/));
        suite.check('under three letters is refused', refused(check('ab', K.grim), /three letters/));
        suite.check('nothing typed is refused', refused(check('  ', K.grim), /Type a word/));
        suite.check('"Adult" is refused: another show\'s clip uses it',
            refused(check('Adult', K.sgc), /Other shows' clips use/) && check('Adult', K.sgc).changed[0].title.startsWith('Adult Swim Promo'));
        suite.check('a nickname that is a show\'s whole title is refused', refused(check('Doug', K.sgc), /already the title of Doug/));
        suite.check('a nickname already taught for another show is refused, naming it',
            refused(check('grim advs', K.doug, { 'grim advs': K.grim }), /already means The Grim Adventures/));
        suite.check('... and for this show, is just already there', refused(check('grim advs', K.grim, { 'grim advs': K.grim }), /already a nickname/));
        suite.check('no show picked is refused', refused(check('grim advs', ''), /Pick the show/));
        suite.check('a long phrase is refused', refused(check('a b c d e f g', K.grim), /at most/));

        const good = check('grim advs', K.grim);
        suite.check('"grim advs" is fine', good.ok && good.alias === 'grim advs' && good.problems.length === 0, JSON.stringify(good.problems));
        suite.check('it lists the unsaved clips it would name, and only those',
            good.newly.map((c) => c.title).join('|') === 'Grim Advs Promo 1|Grim Advs Billy Bumper', good.newly.map((c) => c.title).join('|'));
        suite.check('a clip saved with names, or saved as naming no show, is never listed or changed',
            !good.newly.some((c) => c.index === 2 || c.title.includes('saved as no show')) && good.changed.length === 0);
        suite.check('the clips it would name carry the names they would get',
            good.newly.every((c) => c.names.join() === K.grim));
        suite.check('a word is not made generic by a clip it does not touch ("Batman" is in no clip with it)',
            check('grim advs', K.grim, {}, { sourceTitle: 'Grim Advs Promo 1' }).ok);
        const lost = check('grim advs', K.grim, {}, { sourceTitle: 'Some other title' });
        suite.check('a nickname that would not name the clip it is taught from is refused, saying how the title reads',
            refused(lost, /would not be used for the clip you are teaching it from/));
        const kndSource = 'CN Next (Dexter to KND) [Boat]';
        const kndTaught = showMatch.checkNickname('KND', K.knd, vocab, {}, [], { sourceTitle: kndSource });
        suite.check('a nickname that is used for its clip is fine even when the same title has another show nobody has named yet',
            kndTaught.ok && kndTaught.sourceUnresolved === true && kndTaught.sourceNames.length === 0, JSON.stringify(kndTaught.problems));
        const fosterTaught = showMatch.checkNickname("Foster's", K.foster, vocab, {}, [], { sourceTitle: "Now/Then (Foster's / Camp Lazlo)" });
        suite.check('and when the nickname completes the title, the clip is named and not unresolved',
            fosterTaught.ok && fosterTaught.sourceUnresolved === false && fosterTaught.sourceNames.join() === K.foster + ',' + K.lazlo, JSON.stringify(fosterTaught));
        suite.check('a clip saved under another show makes the phrase refused too',
            (() => {
                const r = showMatch.checkNickname('grim advs', K.sgc, vocab, {}, clips.concat([{ list: 'c', index: 0, title: 'Grim Advs again', names: [K.doug], reviewed: false }]));
                return !r.ok && r.changed.some((c) => c.list === 'c');
            })());
        suite.check('checking changes nothing it was given', (() => {
            const a = { x: K.sgc };
            const snapshot = JSON.stringify([a, clips]);
            check('grim advs', K.grim, a);
            return JSON.stringify([a, clips]) === snapshot;
        })());
        const abbreviated = showMatch.checkNickname('knd', K.knd, vocab, {}, [{ list: 'a', index: 0, title: 'KND Next', names: [], reviewed: false }]);
        suite.check('"knd" for Codename: Kids Next Door is fine and would name the KND clip',
            abbreviated.ok && abbreviated.newly.length === 1);
    }

    // ---- what to offer when teaching ---------------------------------------------
    {
        const channelWords = [{ title: 'Adult Swim Promo - Dragon Ball Z', names: [K.dbz] }, { title: 'Adult Swim NEXT Sealab', names: [K.sgc] }];
        const offer = (title, key, aliases) => showMatch.nicknameSuggestions(title, key, vocab, aliases || {}, channelWords);
        const miguzi = offer('Miguzi - Next Bumper (TMNT-Static-Teen Titans)', K.static);
        suite.check('"static" is offered for the three-show Miguzi title', miguzi.some((s) => s.alias === 'static'), JSON.stringify(miguzi));
        suite.check('"next", "bumper" and "miguzi\'s" structural words are not offered on their own',
            !miguzi.some((s) => s.alias === 'next' || s.alias === 'bumper'));
        const gundam = offer('Gundam 0083 NEXT', K.gundam);
        suite.check('"gundam 0083" is offered as a phrase, trimmed of "NEXT"', gundam.some((s) => s.alias === 'gundam 0083' && s.text === 'Gundam 0083'), JSON.stringify(gundam));
        const foster = offer("Now/Then (Foster's / Camp Lazlo)", K.foster);
        suite.check('"Foster\'s" is offered as the title spells it, stored as "foster s"',
            foster.some((s) => s.text === "Foster's" && s.alias === 'foster s'), JSON.stringify(foster));
        suite.check('a whole title of leftover words is not offered as one nickname (three words at most)',
            offer('Acme Hour Quite Long Leftover Words Here Teen Titans', K.titans).every((s) => s.alias.split(' ').length <= 3));
        suite.check('a nickname already taught is not offered again',
            !offer('Gundam 0083 NEXT', K.gundam, { 'gundam 0083': K.gundam }).some((s) => s.alias === 'gundam 0083'));
        suite.check('"Adult Swim" and "NEXT" are not offered for a Bebop promo',
            !offer('Adult Swim NEXT - Cowboy Bebop', K.bebop).some((s) => /adult|swim|next/.test(s.alias)));
    }

    // ---- the screen's grouping, marks and accept-all ------------------------------
    {
        const flagged = row(0, 'Miguzi (TMNT-Static-Teen Titans)', { proposal: { names: [], found: [hit()], unresolved: { recognised: [K.tmnt], reason: 'x' }, extra: 0 } });
        const shortened = row(1, 'Ghost in the Shell NEXT', { proposal: { names: ['tv.G'], found: [hit({ shortened: true })], extra: 0 } });
        const abbreviation = row(2, 'TMNT promo', { proposal: { names: [K.tmnt], found: [hit({ abbreviation: true })], extra: 0 } });
        const standalone = row(3, 'Jeffersons', { proposal: { names: ['tv.J'], found: [hit({ standalone: true })], extra: 0 } });
        const ambiguous = row(4, 'G.I. Joe promo', { proposal: { names: ['tv.J1'], found: [hit({ alsoKeys: ['tv.J2'] })], extra: 0 } });
        const plain = row(5, 'Up Next (Doug)', { proposal: confident([K.doug]) });
        const plain2 = row(6, 'Up Next (Bebop)', { proposal: confident([K.bebop]) });
        const none = row(7, 'AcTN Next Promo');
        const saved = row(8, 'Up Next (Ed)', { names: [K.ed], proposal: confident([K.ed]) });
        const reviewedNone = row(9, 'Ident', { reviewed: true });
        const savedElsewhere = row(10, 'Saved but flagged', { names: [K.ed], proposal: { names: [], found: [], unresolved: { recognised: [], reason: 'x' }, extra: 0 } });
        const rows = [saved, none, plain, ambiguous, flagged, standalone, shortened, reviewedNone, abbreviation, plain2, savedElsewhere];

        suite.check('a clip with saved names is saved; one saved as naming no show is saved too',
            review.statusOf(saved) === 'saved' && review.statusOf(reviewedNone) === 'saved' && review.groupOf(savedElsewhere) === 'saved');
        suite.check('suggested and none read as such',
            review.statusOf(plain) === 'suggested' && review.statusOf(none) === 'none' && review.statusOf(flagged) === 'none');
        suite.check('groups: flagged, less certain (shortened, abbreviation, one word, shared title), confident, none, saved',
            [flagged, shortened, abbreviation, standalone, ambiguous, plain, none, saved].map(review.groupOf).join()
            === 'flagged,uncertain,uncertain,uncertain,uncertain,confident,none,saved');
        suite.check('the marks say how a suggestion was reached',
            review.marksOf(shortened.proposal).map((m) => m.label).join() === 'from a shortened title'
            && review.marksOf(abbreviation.proposal)[0].label === 'from an abbreviation'
            && /one word/.test(review.marksOf(standalone.proposal)[0].label)
            && /more than one show/.test(review.marksOf(ambiguous.proposal)[0].label)
            && /flagged/.test(review.marksOf(flagged.proposal)[0].label)
            && review.marksOf(plain.proposal).length === 0);
        const order = review.orderRows(rows).map((r) => review.groupOf(r));
        suite.check('the order is by group in the screen\'s order',
            order.join() === 'flagged,uncertain,uncertain,uncertain,uncertain,confident,confident,none,saved,saved,saved', order.join());
        suite.check('and by position inside a group', review.orderRows(rows).filter((r) => review.groupOf(r) === 'uncertain').map((r) => r.index).join() === '1,2,3,4');
        suite.check('ordering does not reorder what it was given', rows[0] === saved);
        const sum = review.summarize(rows);
        suite.check('the summary counts every group and the total',
            sum.flagged === 1 && sum.uncertain === 4 && sum.confident === 2 && sum.none === 1 && sum.saved === 3 && sum.total === 11, JSON.stringify(sum));
        suite.check('"needs a look" is flagged plus less certain', review.needsLook(sum) === 5);

        const plan = review.acceptAllPlan(rows, {});
        suite.check('accept-all takes only the confident ones and counts what it skips',
            plan.accept.join() === '5,6' && plan.skippedUncertain === 4 && plan.skippedFlagged === 1, JSON.stringify(plan));
        suite.check('it never takes a saved clip, a none, a flagged or a less-certain one',
            !plan.accept.some((i) => [0, 1, 2, 3, 4, 7, 8, 9, 10].includes(i)));
        suite.check('a clip already decided on the screen is not counted again',
            review.acceptAllPlan(rows, { 5: { names: [K.sgc] } }).accept.join() === '6');
        const accepted = review.acceptAll(rows, { 5: { names: [K.sgc] } });
        suite.check('accepting all adds the suggestions and keeps a decision already made',
            accepted[5].names.join() === K.sgc && accepted[6].names.join() === K.bebop && Object.keys(accepted).length === 2);
        suite.check('accepting hands back a new object', (() => { const p = {}; review.acceptAll(rows, p); return Object.keys(p).length === 0; })());

        suite.check('a decision shows as pending, a suggestion as suggested, and saved as saved',
            review.effective(plain, { 5: { names: [K.sgc] } }).state === 'pending'
            && review.effective(plain, {}).state === 'suggested' && review.effective(saved, {}).state === 'saved'
            && review.effective(none, {}).state === 'none');
        suite.check('picks: blanks go, at most four, the same show is not repeated in a row',
            review.cleanPicks([K.tmnt, '', K.tmnt, K.static, K.titans, K.doug, K.ed]).join() === [K.tmnt, K.static, K.titans, K.doug].join());
        suite.check('picks are refused when empty slots, five, or a repeat', review.picksProblem([K.tmnt, '']) !== null
            && review.picksProblem([K.tmnt, K.tmnt]) !== null && review.picksProblem([1, 2, 3, 4, 5].map(String)) !== null
            && review.picksProblem([]) === null && review.picksProblem([K.tmnt, K.static, K.tmnt]) === null);

        const payload = review.savePayload(rows, { 6: { names: [K.bebop] }, 1: { names: [] } }, [{ alias: 'static', showKey: K.static }]);
        suite.check('a save carries only the clips decided here, in order, with their titles, and the nicknames taught',
            JSON.stringify(payload) === JSON.stringify({
                clips: [{ index: 1, title: 'Ghost in the Shell NEXT', names: [] }, { index: 6, title: 'Up Next (Bebop)', names: [K.bebop] }],
                aliases: { static: K.static },
            }), JSON.stringify(payload));
        suite.check('with nothing decided a save carries nothing', JSON.stringify(review.savePayload(rows, {}, [])) === '{"clips":[],"aliases":{}}');
    }

    // ---- Plex refreshes keep the names -----------------------------------------
    {
        const oldClips = [{ title: 'A', ratingKey: '1', names: [K.doug] }, { title: 'B', ratingKey: '2', names: [] },
            { title: 'C', plexFile: '/f/c', names: [K.ed] }, { title: 'D', ratingKey: '4' }];
        const fresh = [{ title: 'A', ratingKey: '1' }, { title: 'B', ratingKey: '2' }, { title: 'C new', plexFile: '/f/c' },
            { title: 'D', ratingKey: '4' }, { title: 'E', ratingKey: '5' }, { title: 'A2', ratingKey: '1', names: [K.sgc] }];
        const merged = review.carryNames(oldClips, fresh);
        suite.check('names are carried over by rating key, and by file when there is no key',
            merged[0].names.join() === K.doug && merged[2].names.join() === K.ed);
        suite.check('a clip saved as naming no show stays that way', Array.isArray(merged[1].names) && merged[1].names.length === 0);
        suite.check('a clip that had none, or is new, gets none', typeof(merged[3].names) === 'undefined' && typeof(merged[4].names) === 'undefined');
        suite.check('a clip that comes with its own names keeps them', merged[5].names.join() === K.sgc);
        suite.check('carrying changes neither list', typeof(fresh[0].names) === 'undefined' && oldClips[0].names.length === 1);
    }

    // ---- the save, against real files -----------------------------------------------
    {
        const dir = tempDir();
        const fillerDir = path.join(dir, 'filler');
        fs.mkdirSync(fillerDir);
        try {
            const listA = { name: 'Up Next', mode: 'custom', rank: 0, content: [
                { title: 'Up Next Bumper (Doug)', duration: 10000, key: '/1', serverKey: 'srv' },
                { title: 'Ghost Next', duration: 10000, key: '/2', serverKey: 'srv', custom: 'untouched' },
                { title: 'Miguzi - Next Bumper (TMNT-Static-Teen Titans)', duration: 10000, key: '/3', serverKey: 'srv' },
                { title: 'Foster Home Promo', duration: 10000, key: '/4', serverKey: 'srv' },
                { title: 'Ident', duration: 10000, key: '/5', serverKey: 'srv' },
            ] };
            const listB = { name: 'Other', mode: 'custom', rank: 1, content: [
                { title: 'Static NEXT', duration: 10000, key: '/6', serverKey: 'srv' },
                { title: 'Adult Swim Promo - Cowboy Bebop', duration: 10000, key: '/7', serverKey: 'srv' },
            ] };
            const write = (id, list) => fs.writeFileSync(path.join(fillerDir, id + '.json'), JSON.stringify(list));
            write('a', listA);
            write('b', listB);
            const read = (id) => fs.readFileSync(path.join(fillerDir, id + '.json'), 'utf8');
            const fillerDB = new FillerDB(fillerDir);
            const aliasDB = new ShowAliasDB(dir);
            const channelService = { getAllChannelNumbers: async () => [1], getChannel: async () => CHANNELS[0] };
            const customShowDB = { getAllShowsInfo: async () => [{ id: 'g1', name: 'Mobile Suit Gundam Series' }] };
            const service = new ShowMatchService(fillerDB, channelService, customShowDB, aliasDB);
            const bytesB = read('b');

            const first = await service.matchFiller('a');
            suite.check('the match carries every show and custom show on the channels for the pickers, by name',
                first.shows.length === SHOWS.length + 1 && first.shows.some((s) => s.key === 'custom.g1' && s.custom === true)
                && first.shows.map((s) => s.name).join() === first.shows.map((s) => s.name).sort((a, b) => a.localeCompare(b)).join());
            suite.check('and says which clips are flagged and which are named', first.clips[2].proposal.unresolved != null
                && first.clips[0].proposal.names.join() === K.doug && first.clips[0].names.length === 0 && first.clips[0].reviewed === false);

            // a save of one accepted clip, one "names no show", one pick, and the "static" nickname
            const saved = await service.saveNames('a', {
                clips: [
                    { index: 0, title: 'Up Next Bumper (Doug)', names: [K.doug] },
                    { index: 4, title: 'Ident', names: [] },
                    { index: 2, title: 'Miguzi - Next Bumper (TMNT-Static-Teen Titans)', names: [K.tmnt, K.static, K.titans] },
                ],
                aliases: { static: K.static },
            });
            const after = JSON.parse(read('a'));
            suite.check('the clips named are written with exactly those names',
                after.content[0].names.join() === K.doug && after.content[2].names.join() === [K.tmnt, K.static, K.titans].join());
            suite.check('"names no show" is written as an empty list',
                Array.isArray(after.content[4].names) && after.content[4].names.length === 0);
            suite.check('a clip nobody decided on is byte for byte as it was (no names field, other fields kept)',
                JSON.stringify(after.content[1]) === JSON.stringify(listA.content[1]) && JSON.stringify(after.content[3]) === JSON.stringify(listA.content[3]));
            suite.check('the rest of the list is as it was: name, mode, rank, every clip\'s other fields',
                after.name === 'Up Next' && after.mode === 'custom' && after.rank === 0
                && after.content.every((c, i) => c.title === listA.content[i].title && c.key === listA.content[i].key && c.duration === 10000));
            suite.check('another list is not touched', read('b') === bytesB);
            suite.check('the nickname is in show-aliases.json', (await aliasDB.load()).static === K.static
                && JSON.parse(fs.readFileSync(path.join(dir, 'show-aliases.json'), 'utf8')).aliases.static === K.static);
            suite.check('the answer is the list as it now reads: saved, and a flagged clip no longer flagged',
                saved.clips[0].names.join() === K.doug && saved.clips[4].reviewed === true && saved.clips[2].names.length === 3);
            suite.check('a clip saved as naming no show is not suggested again',
                review.statusOf(saved.clips[4]) === 'saved' && review.groupOf(saved.clips[4]) === 'saved');
            suite.check('the list now saves without a warning about its empty names', await (async () => {
                const lines = [];
                const real = console.error;
                console.error = (...a) => lines.push(a.join(' '));
                try { await fillerDB.saveFiller('a', JSON.parse(read('a'))); } finally { console.error = real; }
                return lines.length === 0;
            })());

            // a refused save writes nothing: a stale clip, a made-up show, a bad nickname, one good clip beside them
            const snapshot = read('a');
            const aliasBytes = fs.readFileSync(path.join(dir, 'show-aliases.json'), 'utf8');
            const refuse = async (body) => {
                try { await service.saveNames('a', body); return null; } catch (err) { return err; }
            };
            const stale = await refuse({ clips: [{ index: 1, title: 'Ghost Next', names: [K.doug] }, { index: 3, title: 'Not that title', names: [K.doug] }], aliases: {} });
            suite.check('a clip that is no longer where the screen saw it refuses the save, with a sentence',
                stale instanceof ShowMatchService.ReviewError && /changed since this screen was opened/.test(stale.message));
            suite.check('a show that is on no channel is refused', (await refuse({ clips: [{ index: 1, title: 'Ghost Next', names: ['tv.Nope'] }], aliases: {} })) instanceof ShowMatchService.ReviewError);
            suite.check('five shows, a repeat, an empty slot are refused', (await Promise.all([
                [K.doug, K.ed, K.sgc, K.bebop, K.dbz], [K.doug, K.doug], [K.doug, ''],
            ].map((n) => refuse({ clips: [{ index: 1, title: 'Ghost Next', names: n }], aliases: {} })))).every((e) => e instanceof ShowMatchService.ReviewError));
            const bad = await refuse({ clips: [{ index: 1, title: 'Ghost Next', names: [K.doug] }], aliases: { next: K.doug } });
            suite.check('a generic nickname refuses the whole save, saying why', bad instanceof ShowMatchService.ReviewError && /everyday words/.test(bad.message), bad && bad.message);
            const generic = await refuse({ clips: [], aliases: { adult: K.sgc } });
            suite.check('"adult" is refused on the server too: the Bebop promo in the other list uses it', generic instanceof ShowMatchService.ReviewError && /Other shows' clips/.test(generic.message), generic && generic.message);
            suite.check('after every refusal the list and the alias file are exactly as they were',
                read('a') === snapshot && fs.readFileSync(path.join(dir, 'show-aliases.json'), 'utf8') === aliasBytes && read('b') === bytesB);

            // a nickname check across lists
            const checked = await service.checkNickname('a', 'static', K.static, 2);
            suite.check('"static" is already taught, so it is not offered again', !checked.ok && /already a nickname/.test(checked.problems.join(' ')));
            const foster = await service.checkNickname('a', "Foster's", K.foster, 3);
            suite.check('a check answers with the show\'s name and counts in this list and in the others',
                typeof(foster.showName) === 'string' && typeof(foster.thisList) === 'number' && typeof(foster.otherLists) === 'number');
            const aboutSelf = await service.checkNickname('a', 'foster', K.foster, 3);
            suite.check('the clip a nickname is taught from is not counted as another clip it would name',
                aboutSelf.ok && aboutSelf.thisList === 0 && aboutSelf.otherLists === 0 && aboutSelf.newly.length === 0
                && aboutSelf.sourceNames.join() === K.foster, JSON.stringify([aboutSelf.problems, aboutSelf.thisList, aboutSelf.otherLists]));
            const suggestions = await service.nicknameSuggestions('a', 2, K.static);
            suite.check('suggestions are offered for a clip', Array.isArray(suggestions));
            suite.check('after all that, the check and the suggestions wrote nothing', read('a') === snapshot);

            // the second save: nothing decided changes nothing on disk
            const again = await service.saveNames('a', { clips: [], aliases: {} });
            suite.check('a save with nothing in it writes nothing', read('a') === snapshot && again.clips.length === 5);

            // the overview
            const withSteps = Object.assign({}, CHANNELS[0], { number: 1, name: 'Nick', dayParts: [{ id: 'dp', name: 'Day', start: 0, end: 1440,
                days: [0, 1, 2, 3, 4, 5, 6], mix: [], transitions: { betweenShows: { out: [], in: [{ id: 's1', kind: 'list', listId: 'b', match: 'show', keyedOn: 'next', fallbackListId: null }] } } }] });
            const overviewService = new ShowMatchService(fillerDB, { getAllChannelNumbers: async () => [1], getChannel: async () => withSteps }, customShowDB, aliasDB);
            const overview = await overviewService.overview();
            suite.check('the overview lists every list with its counts, and the list a step uses comes first',
                overview.lists.length === 2 && overview.lists[0].id === 'b' && overview.lists[0].usedBy.length === 1 && overview.lists[0].usedBy[0].name === 'Nick'
                && overview.lists[1].id === 'a' && overview.lists[1].usedBy.length === 0, JSON.stringify(overview.lists.map((l) => [l.id, l.usedBy.length])));
            suite.check('the counts add up to the clips, per group',
                overview.lists.every((l) => l.flagged + l.uncertain + l.confident + l.none + l.saved === l.total)
                && overview.lists[1].saved === 3 && overview.lists[1].total === 5, JSON.stringify(overview.lists[1]));
            suite.check('reading the overview wrote nothing', read('a') === snapshot && read('b') === bytesB);

            // the routes, through the real router
            const app = express();
            app.use(express.json());
            app.use(api.router({}, channelService, fillerDB, customShowDB, null, null, null, null, null, null, null, null, null, service));
            const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
            try {
                const call = (method, p, body) => new Promise((resolve, reject) => {
                    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p,
                        headers: { 'content-type': 'application/json' } }, (res) => {
                        let text = '';
                        res.on('data', (d) => { text += d; });
                        res.on('end', () => resolve({ status: res.statusCode, text }));
                    });
                    req.on('error', reject);
                    req.end(body === undefined ? undefined : JSON.stringify(body));
                });
                const ok = await call('POST', '/api/filler/a/names', { clips: [{ index: 3, title: 'Foster Home Promo', names: [K.foster] }], aliases: {} });
                suite.check('POST /api/filler/:id/names saves and answers with the list', ok.status === 200
                    && JSON.parse(ok.text).clips[3].names.join() === K.foster && JSON.parse(read('a')).content[3].names.join() === K.foster, ok.text.slice(0, 80));
                const refused = await call('POST', '/api/filler/a/names', { clips: [{ index: 3, title: 'nope', names: [K.foster] }], aliases: {} });
                suite.check('a refused save is a 400 with the sentence', refused.status === 400 && /changed since/.test(JSON.parse(refused.text).error), refused.text);
                const realError = console.error;
                console.error = () => {};
                const missing = await call('POST', '/api/filler/zzz/names', { clips: [], aliases: {} });
                console.error = realError;
                suite.check('an unknown list is a 404', missing.status === 404);
                const check = await call('POST', '/api/filler/a/nickname-check', { text: 'foster s promo', showKey: K.foster, index: 3 });
                suite.check('POST nickname-check answers without saving', check.status === 200 && typeof(JSON.parse(check.text).ok) === 'boolean');
                const sug = await call('POST', '/api/filler/a/nickname-suggestions', { index: 2, showKey: K.static });
                suite.check('POST nickname-suggestions answers with a list', sug.status === 200 && Array.isArray(JSON.parse(sug.text).suggestions));
                const ov = await call('GET', '/api/names-overview');
                suite.check('GET /api/names-overview answers', ov.status === 200 && JSON.parse(ov.text).lists.length === 2);
            } finally {
                server.close();
            }
        } finally {
            removeDir(dir);
        }
    }

    // ---- an imported list keeps its names when Plex refreshes it ----------------------
    {
        const stored = { name: 'Imported', mode: 'import', import: { serverName: 'srv', key: '/k' }, content: [
            { title: 'A', ratingKey: '1', names: [K.doug] }, { title: 'B', ratingKey: '2', names: [] }, { title: 'C', ratingKey: '3' } ] };
        const fromPlex = () => [{ title: 'A', ratingKey: '1' }, { title: 'B', ratingKey: '2' }, { title: 'C', ratingKey: '3' }, { title: 'D', ratingKey: '4' }];
        let written = null;
        const fillerDB = { getFiller: async () => JSON.parse(JSON.stringify(stored)), saveFiller: async (id, body) => { written = body; } };
        const service = new FillerService(fillerDB, { getKeyMediaContents: async () => fromPlex() }, null);
        const quiet = console.log;
        console.log = () => {};
        try {
            // the editor posts an imported list with no clips
            await service.saveFiller('x', { name: 'Imported', mode: 'import', content: [], import: { serverName: 'srv', key: '/k' } });
            const afterEdit = written.content;
            // the refresh posts the stored list itself
            await service.saveFiller('x', JSON.parse(JSON.stringify(stored)));
            const afterRefresh = written.content;
            suite.check('saving an imported list from the editor keeps the names that were saved',
                afterEdit[0].names.join() === K.doug && Array.isArray(afterEdit[1].names) && afterEdit[1].names.length === 0
                && typeof(afterEdit[2].names) === 'undefined' && typeof(afterEdit[3].names) === 'undefined', JSON.stringify(afterEdit));
            suite.check('a refresh from Plex keeps them too', afterRefresh[0].names.join() === K.doug && afterRefresh.length === 4, JSON.stringify(afterRefresh));
        } finally {
            console.log = quiet;
        }
        suite.check('a list that is not imported is saved as it was given',
            await (async () => {
                const body = { name: 'Custom', mode: 'custom', content: [{ title: 'A', names: [K.doug] }] };
                await service.saveFiller('y', body);
                return written.content.length === 1 && written.content[0].names.join() === K.doug;
            })());
    }

    // ---- the preview says what would fit once names are accepted --------------------
    {
        const programs = [ep('Doug'), { isOffline: true, duration: 4 * MIN }, ep('Cowboy Bebop'), { isOffline: true, duration: 4 * MIN },
            ep('Totally Spies!'), { isOffline: true, duration: 4 * MIN }];
        const ch = Object.assign(channel(1, programs), { offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0, fillerCollections: [],
            startTime: new Date(2026, 9, 12, 8, 0, 0).toISOString(),
            duration: programs.reduce((a, p) => a + p.duration, 0),
            dayParts: [{ id: 'dp', name: 'Day', fillerCollections: [], starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 0 }],
                transitions: { betweenShows: { out: [], in: [{ id: 's1', kind: 'list', listId: 'L', match: 'show', keyedOn: 'next', fallbackListId: null,
                    onlyIfNoMatch: null, days: null, chance: null }] } } }] });
        const from = new Date(ch.startTime).getTime();
        const day = () => from;
        const clips = [
            { title: 'Up Next Bumper (Cowboy Bebop)', duration: 10000 }, { title: 'Bebop promo', duration: 10000 },
            { title: 'Ident', duration: 10000 },
        ];
        const matchResponse = { clips: clips.map((c) => ({ proposal: { names: /Bebop/i.test(c.title) ? [K.bebop] : [] } })) };
        const env = (list) => ({ getList: () => list, lastPlayed: () => 0, featuresShows: () => false, listName: () => 'Up Next' });
        const walk = (list) => editor.previewBreaks(ch, ch.dayParts[0], from, from + ch.duration, env(list));
        const savedView = walk(clips);
        const suggestedView = walk(editor.overlayProposedNames(clips, matchResponse));
        const hints = editor.wouldFitHints(savedView, suggestedView);
        const items = savedView.situations.betweenShows.items;
        suite.check('with no names saved the step finds nothing, and with suggestions it finds two clips',
            items.length > 0 && items.every((i) => i.in.length === 0) && suggestedView.situations.betweenShows.items.some((i) => i.in.length === 1 && i.in[0].fits.length === 2));
        const withHint = hints.betweenShows.map((h, i) => [h, items[i]]).filter(([h]) => h.length > 0);
        suite.check('the hint says how many clips would fit, which list, and which step',
            withHint.length > 0 && withHint.every(([h]) => h.length === 1 && h[0].count === 2 && h[0].listId === 'L' && h[0].stepId === 's1' && h[0].side === 'in'), JSON.stringify(hints.betweenShows));
        suite.check('it is only for the break the clips would fit: the break before Doug, which no clip names, gets none',
            hints.betweenShows.some((h) => h.length === 0));
        const named = clips.map((c) => (/Bebop/i.test(c.title) ? Object.assign({}, c, { names: [K.bebop] }) : c));
        const namedHints = editor.wouldFitHints(walk(named), walk(editor.overlayProposedNames(named, matchResponse)));
        suite.check('once the names are saved there is nothing left to hint at', Object.values(namedHints).every((arr) => arr.every((h) => h.length === 0)));
        const none = clips.map((c) => (/Bebop/i.test(c.title) ? Object.assign({}, c, { names: [] }) : c));
        const noneHints = editor.wouldFitHints(walk(none), walk(editor.overlayProposedNames(none, matchResponse)));
        suite.check('a clip saved as naming no show is not offered a suggestion, so it is no hint',
            Object.values(noneHints).every((arr) => arr.every((h) => h.length === 0)));
        suite.check('the preview\'s plan entries now say which step and list they came from',
            suggestedView.situations.betweenShows.items.some((i) => i.in.some((s) => s.stepId === 's1' && s.listId === 'L')));
    }

    return suite;
};
