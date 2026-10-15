/*
 * A series of a custom show as a name. A custom show such as "G Gundam/Gundam Wing/Gundam SEED+Destiny"
 * joins several series (the show title its episodes carry), and a clip such as "Gundam Wing Intro" is for
 * one of them. { show: "custom.<id>", series, season? | seasons? } fits that series' episodes inside the
 * custom show and wherever the same show airs on its own, ranks as specific (above a clip for the whole
 * custom show), may be a member of an "any one of", and is read from a title or a taught nickname.
 * The shape (src/clip-names.js), the vocabulary and the matcher (src/show-match.js), the picker's logic
 * and the hint on saved clips (src/names-review.js), the alias file, the plans (src/transitions.js) and the
 * service. See docs/blocks-spec.md, Stage 5, "Which shows a clip names".
 *
 * Fixtures only, with titles from the channels. The service and the alias file are driven against
 * throwaway folders under the OS temp directory.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MIN, Suite } = require('./support');
const clipNames = require('../src/clip-names');
const showMatch = require('../src/show-match');
const review = require('../src/names-review');
const transitions = require('../src/transitions');
const shuffleRounds = require('../src/shuffle-rounds');
const FillerDB = require('../src/dao/filler-db');
const ShowAliasDB = require('../src/dao/show-alias-db');
const ShowMatchService = require('../src/services/show-match-service');

const G = 'custom.g';                       // G Gundam/Gundam Wing/Gundam SEED+Destiny: three series
const M = 'custom.m';                       // Mobile Suit Gundam Series: two series, one named like the custom show
const P = 'custom.p';                       // You're on Nickelodeon, Charlie Brown: a one-word series
const GG = clipNames.seriesName(G, 'Mobile Fighter G Gundam');
const WING = clipNames.seriesName(G, 'Mobile Suit Gundam Wing');
const WING_S2 = clipNames.seriesName(G, 'Mobile Suit Gundam Wing', [2]);
const WING_S12 = clipNames.seriesName(G, 'Mobile Suit Gundam Wing', [1, 2]);
const SEED = clipNames.seriesName(G, 'Mobile Suit Gundam SEED');
const MSG = clipNames.seriesName(M, 'Mobile Suit Gundam');
const PEANUTS = clipNames.seriesName(P, 'Peanuts');
const WING_KEY = clipNames.seriesKey(G, 'Mobile Suit Gundam Wing');

function item(series, season, n, type) {
    return { title: `${series} S${season}E${n}`, type: type || 'episode', showTitle: series, season, episode: n, duration: 24 * MIN, serverKey: 'srv', ratingKey: `${series}-${season}-${n}` };
}
const custom = (id, name, content) => ({ id, name, content });
const CUSTOM_SHOWS = [
    custom('g', 'G Gundam/Gundam Wing/Gundam SEED+Destiny', [
        item('Mobile Fighter G Gundam', 1, 1), item('Mobile Fighter G Gundam', 1, 2),
        item('Mobile Suit Gundam Wing', 1, 1), item('Mobile Suit Gundam Wing', 2, 1),
        item('Mobile Suit Gundam SEED', 1, 1) ]),
    custom('m', 'Mobile Suit Gundam Series', [ item('Mobile Suit Gundam', 1, 1), item('Mobile Suit Zeta Gundam', 1, 1),
        Object.assign(item("Mobile Suit Gundam: The 08th MS Team - Miller's Report", 1, 1, 'movie'), { title: "Mobile Suit Gundam: The 08th MS Team - Miller's Report", duration: 52 * MIN }) ]),
    custom('tj', 'Tom & Jerry', [ item('Tom and Jerry', 1, 1), item('The New Tom & Jerry Show', 1, 1) ]),
    custom('p', "You're on Nickelodeon, Charlie Brown", [ item('Peanuts', 1, 1), item('The Charlie Brown and Snoopy Show', 1, 1) ]),
    custom('one', 'Pinky and the Brain', [ item('Pinky and the Brain', 1, 1), item('Pinky and the Brain', 2, 1) ]),
    custom('shorts', 'Looney Tunes', [ item('Bugs Hare', 1, 1, 'movie'), item('Duck Amuck', 1, 1, 'movie'), item('Rabbit Fire', 1, 1, 'movie') ]),
];
const inCustom = (id, name, program) => Object.assign({}, program, { customShowId: id, customShowName: name });
const gg1 = inCustom('g', 'G Gundam/Gundam Wing/Gundam SEED+Destiny', item('Mobile Fighter G Gundam', 1, 1));
const w1 = inCustom('g', 'G Gundam/Gundam Wing/Gundam SEED+Destiny', item('Mobile Suit Gundam Wing', 1, 1));
const w2 = inCustom('g', 'G Gundam/Gundam Wing/Gundam SEED+Destiny', item('Mobile Suit Gundam Wing', 2, 1));
const seed1 = inCustom('g', 'G Gundam/Gundam Wing/Gundam SEED+Destiny', item('Mobile Suit Gundam SEED', 1, 1));
const mg1 = inCustom('m', 'Mobile Suit Gundam Series', item('Mobile Suit Gundam', 1, 1));
const plainWing = item('Mobile Suit Gundam Wing', 1, 1);                    // the same show, airing on its own
const otherCustomWing = inCustom('other', 'Anime Block', item('Mobile Suit Gundam Wing', 1, 1));
const PREV = item('Full House', 7, 1);
const shortInCustom = inCustom('shorts', 'Looney Tunes', item('Duck Amuck', 1, 1, 'movie'));
const CHANNELS = [
    { number: 1, name: 'Toonami', programs: [gg1, w1, w2, seed1, mg1, PREV, shortInCustom, inCustom('p', "You're on Nickelodeon, Charlie Brown", item('Peanuts', 1, 1)), inCustom('tj', 'Tom & Jerry', item('Tom and Jerry', 1, 1))], scheduleBackup: { slots: [] } },
    { number: 2, name: 'Anime', programs: [item('Cowboy Bebop', 1, 1)], scheduleBackup: { slots: [] } },
];
const NAMES = {};
CUSTOM_SHOWS.forEach( (s) => { NAMES[s.id] = s.name; } );
const vocab = showMatch.buildVocabulary(CHANNELS, NAMES, CUSTOM_SHOWS);
const propose = (title, aliases, v) => showMatch.propose(title, v || vocab, aliases || {});
const ids = (p) => p.names.map(clipNames.nameId).join(' | ');
const fit = (name, program) => clipNames.fits(name, program, transitions.showKey);

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'syndicast-series-'));
}
function removeDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* left for the OS */ }
}

const step = (id, listId, extra) => Object.assign({ id, kind: 'list', listId, match: 'show', keyedOn: 'next', fallbackListId: null,
    onlyIfNoMatch: null, days: null, chance: null }, extra || {});
const named = (title, names) => Object.assign({ title, key: '/c/' + title, duration: 15000 }, names === undefined ? {} : { names });
function planFor(programs, lists) {
    const channel = {
        number: 1, name: 'T', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0, fillerCollections: [],
        programs, duration: programs.reduce((a, p) => a + p.duration, 0), startTime: new Date(2026, 9, 12, 8, 0, 0).toISOString(),
        dayParts: [ { id: 'dp', name: 'Day', fillerCollections: [], starts: [ { days: [0, 1, 2, 3, 4, 5, 6], time: 0 } ],
            transitions: { betweenShows: { out: [], in: [step('s1', 'L')] } } } ],
    };
    const start = new Date(channel.startTime).getTime() + programs[0].duration;
    return transitions.buildPlan(channel, transitions.findBreak(channel, 1, start), {
        getList: (id) => lists[id] || null, lastPlayed: () => 0, featuresShows: () => false,
    });
}
const flexed = (a, b) => [a, { isOffline: true, duration: 5 * MIN }, b];
const says = (plan) => plan.in.map( (s) => s.clip.title ).join(' + ') || '-';

module.exports = async function run() {
    const suite = new Suite('names-series');

    // ---- the shape ---------------------------------------------------------------------
    {
        suite.check('a series, with one season or several, is a name', [GG, WING, WING_S2, WING_S12].every(clipNames.validName));
        suite.check('it is a series name and not a season name, whatever fields it carries',
            clipNames.isSeriesName(WING_S2) && ! clipNames.isSeasonName(WING_S2) && ! clipNames.isSeasonsName(WING_S12) && ! clipNames.isEpisodeName(WING)
            && ! clipNames.isSeriesName({ show: 'tv.X', season: 1 }) && ! clipNames.isSeriesName('custom.g'));
        suite.check('only a custom show has series, and nothing else may ride along',
            ! clipNames.validName({ show: 'tv.Wing', series: 'Wing' }) && ! clipNames.validName({ show: G, series: '' }) && ! clipNames.validName({ show: G, series: 5 })
            && ! clipNames.validName({ show: G, series: 'X', episode: 'Y' }) && ! clipNames.validName({ show: G, series: 'X', extra: 1 }));
        suite.check('seasons follow the rules of a show\'s: whole numbers from 0, two or more together, ascending, no repeats',
            clipNames.validName({ show: G, series: 'X', season: 0 }) && ! clipNames.validName({ show: G, series: 'X', season: -1 }) && ! clipNames.validName({ show: G, series: 'X', season: 1.5 })
            && ! clipNames.validName({ show: G, series: 'X', seasons: [2] }) && ! clipNames.validName({ show: G, series: 'X', seasons: [2, 1] }) && ! clipNames.validName({ show: G, series: 'X', seasons: [1, 1] }));
        suite.check('seriesName writes the one stored shape: a series, one season, or sorted seasons without repeats',
            JSON.stringify(clipNames.seriesName(G, 'X')) === JSON.stringify({ show: G, series: 'X' })
            && JSON.stringify(clipNames.seriesName(G, 'X', [3])) === JSON.stringify({ show: G, series: 'X', season: 3 })
            && JSON.stringify(clipNames.seriesName(G, 'X', [5, 3, 5])) === JSON.stringify({ show: G, series: 'X', seasons: [3, 5] }));
        suite.check('equal names compare equal; another series, another season or another custom show does not',
            clipNames.sameName(WING_S12, { seasons: [1, 2], series: 'Mobile Suit Gundam Wing', show: G }) && ! clipNames.sameName(WING, GG) && ! clipNames.sameName(WING, WING_S2)
            && ! clipNames.sameName(WING, clipNames.seriesName(M, 'Mobile Suit Gundam Wing')) && ! clipNames.sameName(WING, G));
        suite.check('a series is a show of its own to the checks that ask which show a name is about (a key that cannot be a show\'s)',
            clipNames.showOf(WING) === WING_KEY && clipNames.showsOf(WING_S2).join() === WING_KEY
            && JSON.stringify(clipNames.parseSeriesKey(WING_KEY)) === JSON.stringify({ show: G, series: 'Mobile Suit Gundam Wing' })
            && clipNames.parseSeriesKey('custom.g') === null && clipNames.parseSeriesKey('tv.X') === null && clipNames.isSeriesKey(WING_KEY));
        suite.check('seasonsOf reads the seasons of a series name', clipNames.seasonsOf(WING).length === 0 && clipNames.seasonsOf(WING_S2).join() === '2' && clipNames.seasonsOf(WING_S12).join() === '1,2');
        const labels = { [G]: 'G Gundam/Gundam Wing/Gundam SEED+Decstiny' };
        suite.check('it reads as the series in its custom show, then its seasons',
            clipNames.labelOf(WING, labels) === 'Mobile Suit Gundam Wing (in G Gundam/Gundam Wing/Gundam SEED+Decstiny)'
            && clipNames.labelOf(WING_S12, labels) === 'Mobile Suit Gundam Wing (in G Gundam/Gundam Wing/Gundam SEED+Decstiny) · Seasons 1, 2'
            && clipNames.labelOf(WING, { [WING_KEY]: 'Wing (in G)' }) === 'Wing (in G)');
        suite.check('and as a member of an any-of its seasons stay in brackets',
            clipNames.labelOf({ anyOf: [WING_S2, 'tv.Even Stevens'] }, { [G]: 'G', 'tv.Even Stevens': 'Even Stevens' }) === 'Mobile Suit Gundam Wing (in G) (Season 2) or Even Stevens');
        suite.check('saved on a clip it reads back; one with an extra field names nothing',
            JSON.stringify(showMatch.namesOf({ names: [WING, 'tv.X'] })) === JSON.stringify([WING, 'tv.X']) && showMatch.namesProblem({ names: [WING] }) === null
            && showMatch.namesOf({ names: [{ show: G, series: 'X', extra: 1 }] }).length === 0 && showMatch.namesProblem({ names: [{ show: G, series: 'X', extra: 1 }] }) !== null);
        suite.check('seriesOf agrees with the one Ordered shuffle uses: an item\'s show title, else its title',
            [gg1, { title: 'Alone' }, { title: 'T', showTitle: '' }].every( (p) => clipNames.seriesOf(p) === shuffleRounds.seriesOf(p) ));
    }

    // ---- an any-of may hold series ------------------------------------------------------
    {
        suite.check('series are members of an any-of, with seasons, beside shows and movies',
            [{ anyOf: [WING, GG] }, { anyOf: [WING_S2, 'tv.Even Stevens'] }, { anyOf: [WING, 'movie.Halloweentown'] }, { anyOf: [WING_S2, clipNames.seriesName(G, 'Mobile Suit Gundam Wing', [1])] }].every(clipNames.validName));
        suite.check('a whole custom show beside one of its series is refused as redundant; a series beside its own seasons too',
            clipNames.anyOfProblem([G, WING]) !== null && /whole show/.test(clipNames.anyOfProblem([G, WING_S2])) && /whole series/.test(clipNames.anyOfProblem([WING, WING_S2]))
            && clipNames.anyOfProblem([WING, clipNames.seriesName(M, 'Mobile Suit Gundam Wing', [2])]) === null);
        suite.check('the same series twice is refused, and two series of one custom show are allowed',
            /twice/.test(clipNames.anyOfProblem([WING, clipNames.seriesName(G, 'Mobile Suit Gundam Wing')])) && clipNames.anyOfProblem([WING, GG]) === null);
        suite.check('the same series in another order is the same name', clipNames.sameName({ anyOf: [WING, GG] }, { anyOf: [GG, WING] }));
    }

    // ---- how it fits a program ----------------------------------------------------------
    {
        suite.check('a series fits its episodes inside its custom show, as a specific fit, and no other series of it',
            fit(WING, w1) === 'specific' && fit(WING, w2) === 'specific' && fit(WING, gg1) === false && fit(WING, seed1) === false && fit(GG, gg1) === 'specific');
        suite.check('and wherever the same show airs on its own (it is the same series), but not inside another custom show',
            fit(WING, plainWing) === 'specific' && fit(WING, otherCustomWing) === false && fit(MSG, mg1) === 'specific');
        suite.check('seasons narrow it: one, or several',
            fit(WING_S2, w2) === 'specific' && fit(WING_S2, w1) === false && fit(WING_S12, w1) === 'specific' && fit(WING_S12, w2) === 'specific'
            && fit(clipNames.seriesName(G, 'Mobile Suit Gundam Wing', [3, 4]), w1) === false && fit(WING_S2, plainWing) === false);
        suite.check('the whole custom show still fits every series of it, as the show',
            fit(G, w1) === 'show' && fit(G, gg1) === 'show' && fit(G, seed1) === 'show' && fit(G, mg1) === false && fit(G, plainWing) === false);
        suite.check('a movie, Flex and nothing fit no series',
            fit(WING, { isOffline: true, duration: MIN }) === false && fit(WING, null) === false && fit(WING, Object.assign({}, w1, { type: 'movie' })) === false && fit(WING, PREV) === false);
        suite.check('a series is specific, and an any-of that holds one ranks by the member that fits',
            clipNames.isSpecific(WING) && fit({ anyOf: [WING, 'tv.Even Stevens'] }, w1) === 'specific' && fit({ anyOf: [WING, 'tv.Even Stevens'] }, gg1) === false
            && fit({ anyOf: [WING_S2, GG] }, gg1) === 'specific' && fit({ anyOf: [WING_S2, GG] }, w1) === false && fit({ anyOf: [G, 'tv.Even Stevens'] }, w1) === 'show');
    }

    // ---- the plans: the most specific clip wins ------------------------------------------
    {
        const lists = { L: [ named('Whole show intro', [G]), named('Wing intro', [WING]), named('G Gundam intro', [GG]), named('Wing season 2 intro', [WING_S2]) ] };
        const before = (program) => says(planFor(flexed(PREV, program), lists));
        suite.check('before a Wing episode the Wing clip plays, not the one for the whole custom show and not G Gundam\'s',
            before(w1) === 'Wing intro', before(w1));
        suite.check('before a G Gundam episode only the G Gundam clip plays', before(gg1) === 'G Gundam intro', before(gg1));
        suite.check('before a series with no clip of its own the clip for the whole custom show plays', before(seed1) === 'Whole show intro', before(seed1));
        suite.check('a season clip and a series clip are both specific: before an episode of that season either plays, never the whole custom show\'s or another series\'',
            ['Wing intro', 'Wing season 2 intro'].includes(before(w2)), before(w2));
        suite.check('Wing on its own, outside the custom show, gets the Wing clip too', before(plainWing) === 'Wing intro', before(plainWing));
        suite.check('a program of no such show gets nothing', before(item('Cowboy Bebop', 1, 1)) === '-', before(item('Cowboy Bebop', 1, 1)));
    }

    // ---- the vocabulary ------------------------------------------------------------------
    {
        const keys = Object.keys(vocab.series).sort().join();
        suite.check('a custom show that joins two or more series of episodes offers them, with how many episodes and which seasons',
            keys === `${G},${M},${P},custom.tj` && vocab.series[G].map( (s) => `${s.title}:${s.count}:${s.seasons.join('/')}` ).join(' | ')
                === 'Mobile Fighter G Gundam:2:1 | Mobile Suit Gundam Wing:2:1/2 | Mobile Suit Gundam SEED:1:1', JSON.stringify(vocab.series[G]));
        suite.check('a custom show of one series, or of movies (shorts that are their own show title), offers none',
            typeof(vocab.series['custom.one']) === 'undefined' && typeof(vocab.series['custom.shorts']) === 'undefined');
        suite.check('a series has a display name and is not offered as a show or a custom show',
            vocab.names[WING_KEY] === 'Mobile Suit Gundam Wing (in G Gundam/Gundam Wing/Gundam SEED+Destiny)'
            && Object.keys(vocab.names).filter( (k) => /^(tv|custom)\./.test(k) ).every( (k) => ! clipNames.isSeriesKey(k) ));
        const without = showMatch.buildVocabulary(CHANNELS, NAMES);
        // (the movies a custom show's catalog adds are the catalog argument's too, so they are left out of the comparison)
        const plain = (v) => v.entries.filter( (e) => ! clipNames.isSeriesKey(e.key) && ! e.key.startsWith('movie.') && e.shortened !== true ).map( (e) => `${e.key}|${e.folded}` ).sort().join('\n');
        suite.check('without the custom shows\' catalogs there are no series, and every other whole title is the same',
            Object.keys(without.series).length === 0 && ! without.entries.some( (e) => clipNames.isSeriesKey(e.key) ) && plain(without) === plain(vocab));
        suite.check('a shortened name of a custom show gives way to a series\' whole title, the more certain answer: only "mobile suit gundam" does',
            without.entries.filter( (e) => e.shortened && ! vocab.entries.some( (v) => v.shortened && v.key === e.key && v.folded === e.folded ) ).map( (e) => e.key + '|' + e.folded ).join() === 'custom.m|mobile suit gundam');
        suite.check('initials make no abbreviation of a series', ! Array.from(vocab.abbreviations.values()).some( (k) => clipNames.isSeriesKey(k) ));
    }

    // ---- the matcher: a series from the title, or a nickname -------------------------------
    {
        const wing = propose('Mobile Suit Gundam Wing Intro');
        suite.check('a title that is a series\' show title suggests that series, in its custom show',
            ids(wing) === clipNames.nameId(WING) && wing.names.length === 1, ids(wing));
        suite.check('the longest title wins: Wing is not read as Mobile Suit Gundam, whose title is inside it',
            ids(propose('Mobile Suit Gundam Wing Intro')) !== clipNames.nameId(MSG) && ids(propose('Mobile Suit Zeta Gundam Intro')) === clipNames.nameId(clipNames.seriesName(M, 'Mobile Suit Zeta Gundam')));
        const nick = { 'gundam wing': WING, 'g gundam': GG, 'gundam seed': SEED };
        suite.check('a taught nickname means a series: "g gundam", "gundam wing"',
            ids(propose('G Gundam Intro', nick)) === clipNames.nameId(GG) && ids(propose('Gundam Wing Intro [1]', nick)) === clipNames.nameId(WING)
            && ids(propose('Gundam SEED Intro', nick)) === clipNames.nameId(SEED), ids(propose('G Gundam Intro', nick)));
        suite.check('and it means the whole custom show while it is taught that way: nothing saved before reads differently',
            ids(propose('Gundam Wing Intro', { 'gundam wing': G })) === G && ids(propose('G Gundam Intro', { 'g gundam': G })) === G);
        suite.check('a nickname for some seasons of a series narrows the series\' title and stands for them alone',
            ids(propose('Gundam Wing Endless Waltz', { 'endless waltz': WING_S2 })) === clipNames.nameId(WING_S2)
            && ids(propose('Mobile Suit Gundam Wing Endless Waltz', { 'endless waltz': WING_S2 })) === clipNames.nameId(WING_S2));
        suite.check('a series beside a plain show is a list in airing order',
            ids(propose('Mobile Suit Gundam Wing to Cowboy Bebop', {})) === [clipNames.nameId(WING), 'tv.Cowboy Bebop'].join(' | '), ids(propose('Mobile Suit Gundam Wing to Cowboy Bebop', {})));
        suite.check('and two series of one custom show are two names, not one show twice',
            ids(propose('Mobile Fighter G Gundam to Mobile Suit Gundam Wing', {})) === [clipNames.nameId(GG), clipNames.nameId(WING)].join(' | '), ids(propose('Mobile Fighter G Gundam to Mobile Suit Gundam Wing', {})));
        suite.check('a title that gives a custom show\'s own name is still the whole custom show',
            ids(propose('G Gundam/Gundam Wing/Gundam SEED+Destiny Intro')) === G);
        suite.check('nothing is found in a title that has none of it', propose('Totally Unrelated Promo').names.length === 0);
    }

    // ---- less certain: the custom show answers to the title too -----------------------------
    {
        const p = propose('Mobile Suit Gundam Intro');
        const marks = review.marksOf(p);
        suite.check('"Mobile Suit Gundam" is the series\' title and also the custom show\'s name without "Series": suggested as the series, less certain',
            ids(p) === clipNames.nameId(MSG) && marks.some( (m) => m.id === 'seriesOverlap' && m.uncertain ) && review.groupOf({ names: [], proposal: p }) === 'uncertain', JSON.stringify(marks));
        const q = propose('Mobile Suit Gundam Wing Intro');
        suite.check('a series whose title the custom show does not answer to is not less certain',
            ! review.marksOf(q).some( (m) => m.id === 'seriesOverlap' ) && review.groupOf({ names: [], proposal: q }) === 'confident');
        const viaNickname = propose('Gundam Mobile Suit Intro', { 'gundam mobile': MSG });
        suite.check('and a series found by a taught nickname is confident',
            ids(viaNickname) === clipNames.nameId(MSG) && ! review.marksOf(viaNickname).some( (m) => m.id === 'seriesOverlap' ), ids(viaNickname));
        const rows = [ { index: 0, title: 'a', names: [], proposal: p }, { index: 1, title: 'b', names: [], proposal: q } ];
        suite.check('"accept all" takes the confident one and skips the less certain one', JSON.stringify(review.acceptAllPlan(rows, {}).accept) === '[1]' && review.acceptAllPlan(rows, {}).skippedUncertain === 1);
    }

    // ---- a one-word series title: Peanuts ------------------------------------------------
    {
        suite.check('"Peanuts" inside a phrase is not the series: a web clip about selling peanuts names nothing',
            propose("Nickelodeon GAS - Amanda Bynes 'Selling Peanuts' Web Clip (1999)").names.length === 0 && propose('Peanuts Promo').names.length === 0);
        const alone = propose('Nick Promo (Peanuts)');
        suite.check('it counts only as a segment of its own, and then as less certain, like a bare "Jeffersons"',
            ids(alone) === clipNames.nameId(PEANUTS) && review.marksOf(alone).some( (m) => m.id === 'standalone' && m.uncertain ), ids(alone));
        suite.check('and a series\' one-word shortened title ("Batman" for "Batman: The Animated Series") is never offered',
            ! vocab.entries.some( (e) => clipNames.isSeriesKey(e.key) && e.shortened && e.folded.indexOf(' ') === -1 ));
    }

    // ---- a series with the title of a show: the show is first, and the tie is reported ------
    {
        const tvWing = [ { number: 3, name: 'Anime 2', programs: [plainWing], scheduleBackup: { slots: [] } } ];
        const v = showMatch.buildVocabulary(CHANNELS.concat(tvWing), NAMES, CUSTOM_SHOWS);
        const p = propose('Mobile Suit Gundam Wing Intro', {}, v);
        suite.check('when a show of that title airs on its own too, the title is the show\'s and the clip is marked as ambiguous',
            ids(p) === 'tv.Mobile Suit Gundam Wing' && p.found.some( (h) => Array.isArray(h.alsoKeys) && h.alsoKeys.includes(WING_KEY) )
            && review.marksOf(p).some( (m) => m.id === 'ambiguous' ), ids(p));
    }

    // ---- what a series must not disturb ---------------------------------------------------------
    {
        const tj = propose('Tom & Jerry promo');
        suite.check('a series that has the title of its own custom show does not make that title ambiguous: the custom show is the answer, as before',
            ids(tj) === 'custom.tj' && ! tj.found.some( (h) => Array.isArray(h.alsoKeys) ) && review.groupOf({ names: [], proposal: tj }) === 'confident', JSON.stringify(tj.found));
        suite.check('a movie\'s parent is a show, never a series ("Mobile Suit Gundam" is not the parent of the 08th MS Team movie)',
            vocab.entries.filter( (e) => e.specific === 'movie' ).length > 0 && vocab.entries.filter( (e) => e.specific === 'movie' ).every( (e) => ! clipNames.isSeriesKey(e.parent || '') ));
        const movie = propose("Gundam 08th MS Team NEXT Promo");
        suite.check('and that movie is still named by its subtitle, alone', ids(movie) === "movie.Mobile Suit Gundam: The 08th MS Team - Miller's Report", ids(movie));
    }

    // ---- the nickname checks tell one series from another -----------------------------------
    {
        const clips = [
            { list: 'a', index: 0, title: 'Gundam Wing Intro [1]', names: [G], reviewed: false },
            { list: 'a', index: 1, title: 'Gundam Wing Intro [2]', names: [], reviewed: false },
            { list: 'a', index: 2, title: 'Gundam Wing Promo', names: [GG], reviewed: false },
        ];
        const ok = showMatch.checkNickname('gundam wing', WING, vocab, {}, clips.slice(0, 2));
        suite.check('a nickname for a series is not blocked by a clip saved as the whole custom show, and names the clip that has none',
            ok.ok === true && ok.newly.length === 1 && ok.newly[0].index === 1 && ok.changed.length === 0, JSON.stringify(ok.problems));
        const blocked = showMatch.checkNickname('gundam wing', WING, vocab, {}, clips);
        suite.check('but it is blocked by a clip saved under another series of it', blocked.ok === false && blocked.changed.some( (c) => c.index === 2 ), JSON.stringify(blocked.problems));
        suite.check('a series must be one the vocabulary has',
            showMatch.checkNickname('wing zero', clipNames.seriesName(G, 'Nonesuch'), vocab, {}, []).ok === false
            && showMatch.checkNickname('wing zero', clipNames.seriesName('custom.zzz', 'Nonesuch'), vocab, {}, []).problems.join(' ').indexOf('Pick the show') !== -1);
        suite.check('a nickname for a series taught from its clip is the one that clip is read by',
            showMatch.checkNickname('gundam wing', WING, vocab, {}, [], { sourceTitle: 'Gundam Wing Intro [1]' }).ok === true
            && showMatch.checkNickname('gundam wing', WING, vocab, {}, [], { sourceTitle: 'Gundam Wing Intro [1]' }).sourceNames.map(clipNames.nameId).join() === clipNames.nameId(WING));
        const offered = showMatch.nicknameSuggestions('G Gundam Intro', GG, vocab, {}, []).map( (s) => s.alias );
        suite.check('the teach panel offers the words of the title for a series', offered.includes('gundam') || offered.includes('g gundam') || offered.length > 0, offered.join());
        suite.check('the whole custom show and a series of it are related, two series of it are not',
            showMatch.checkNickname('gundam wing', G, vocab, {}, [ { list: 'a', index: 0, title: 'Gundam Wing Intro [1]', names: [WING], reviewed: false } ]).ok === true
            && showMatch.checkNickname('gundam wing', WING, vocab, {}, [ { list: 'a', index: 0, title: 'Gundam Wing Intro [1]', names: [GG], reviewed: false } ]).ok === false);
    }

    // ---- the picker's logic ----------------------------------------------------------------
    {
        const ticked = (series, seasons, extra) => Object.assign(review.emptySlot(), { key: G, kind: 'series', series, picked: seasons || {}, seriesSeasons: seasons ? 'some' : 'all' }, extra || {});
        suite.check('one series ticked is a series; several are any one of them; none is a problem in words',
            clipNames.sameName(review.slotName(ticked({ 'Mobile Suit Gundam Wing': true })), WING)
            && clipNames.sameName(review.slotName(ticked({ 'Mobile Suit Gundam Wing': true, 'Mobile Fighter G Gundam': true })), { anyOf: [WING, GG] })
            && review.slotProblem(ticked({})) === 'no series is ticked' && review.slotName(ticked({})) === null);
        suite.check('a ticked box that was unticked does not count', clipNames.sameName(review.slotName(ticked({ 'Mobile Suit Gundam Wing': true, 'Mobile Fighter G Gundam': false })), WING));
        suite.check('some seasons of one series: the seasons ticked, and a problem when none is',
            clipNames.sameName(review.slotName(ticked({ 'Mobile Suit Gundam Wing': true }, { 2: true })), WING_S2)
            && clipNames.sameName(review.slotName(ticked({ 'Mobile Suit Gundam Wing': true }, { 1: true, 2: true })), WING_S12)
            && review.slotProblem(ticked({ 'Mobile Suit Gundam Wing': true }, { 1: true })) === null);
        const noSeason = ticked({ 'Mobile Suit Gundam Wing': true }, { 2: false });
        suite.check('"some seasons" with none ticked is refused', review.slotProblem(noSeason) === 'no season is ticked');
        suite.check('with several series ticked the seasons are ignored: every season of each',
            clipNames.sameName(review.slotName(ticked({ 'Mobile Suit Gundam Wing': true, 'Mobile Fighter G Gundam': true }, { 2: true })), { anyOf: [WING, GG] }));
        suite.check('a stored series reads back into the same slot',
            [WING, WING_S2, WING_S12, GG].every( (n) => clipNames.sameName(review.slotName(review.slotOfName(n)), n) ));
        const member = (series) => ticked(series);
        const any = Object.assign(review.emptySlot(), { any: true, members: [ member({ 'Mobile Suit Gundam Wing': true, 'Mobile Fighter G Gundam': true }), Object.assign(review.emptySlot(), { key: 'tv.Even Stevens' }) ] });
        suite.check('in an any-of a row with several series ticked is several members',
            clipNames.sameName(review.slotName(any), { anyOf: [WING, GG, 'tv.Even Stevens'] }) && review.slotProblem(any) === null);
        const dup = Object.assign(review.emptySlot(), { any: true, members: [ member({ 'Mobile Suit Gundam Wing': true }), member({ 'Mobile Suit Gundam Wing': true, 'Mobile Fighter G Gundam': true }) ] });
        suite.check('and the same series in two rows is refused', /twice/.test(review.slotProblem(dup)));
        suite.check('a nickname target from an any-of list of one name is that name',
            clipNames.sameName(review.nicknameTarget({ anyOf: [WING] }), WING) && clipNames.sameName(review.nicknameTarget({ anyOf: [WING, GG] }), { anyOf: [WING, GG] }));
        suite.check('the picks save as any other name: up to four, not twice in a row',
            review.picksProblem([WING, GG, WING, GG]) === null && review.picksProblem([WING, WING]) !== null && review.picksProblem([{ show: G, series: 'x', extra: 1 }]) !== null);
    }

    // ---- the hint on a clip saved as the whole custom show ------------------------------------
    {
        const row = (names, proposed) => ({ index: 0, title: 't', names, reviewed: false, proposal: { names: proposed, found: [] } });
        suite.check('a clip saved as the custom show whose title reads as one series of it has a narrower reading, whole list',
            JSON.stringify(review.narrowerOf(row([G], [WING]))) === JSON.stringify([WING])
            && JSON.stringify(review.narrowerOf(row(['tv.Cowboy Bebop', G], ['tv.Cowboy Bebop', GG]))) === JSON.stringify(['tv.Cowboy Bebop', GG]));
        suite.check('and none when nothing is saved, the reading is the same, another show, another custom show or a different count',
            review.narrowerOf(row([], [WING])) === null && review.narrowerOf(row([G], [G])) === null && review.narrowerOf(row([G], ['tv.Cowboy Bebop'])) === null
            && review.narrowerOf(row([M], [WING])) === null && review.narrowerOf(row([G], [WING, GG])) === null && review.narrowerOf(row([G], [])) === null
            && review.narrowerOf(row([WING], [GG])) === null);
    }

    // ---- the alias file -----------------------------------------------------------------------
    // ---- the service, on throwaway folders -----------------------------------------------------
    {
        const dir = tempDir();
        const fillerDir = path.join(dir, 'filler');
        fs.mkdirSync(fillerDir);
        try {
            const list = { name: 'Toonami Show Intros', mode: 'custom', rank: 0, content: [
                { title: 'Gundam Wing Intro [1]', duration: 7000, key: '/1', serverKey: 'srv', names: [G] },
                { title: 'G Gundam Intro', duration: 7000, key: '/2', serverKey: 'srv', names: [G] },
                { title: 'Mobile Suit Gundam Wing Promo', duration: 7000, key: '/3', serverKey: 'srv' },
                { title: 'Mobile Suit Gundam Wing Teaser', duration: 7000, key: '/4', serverKey: 'srv', names: [G] },
            ] };
            const listFile = path.join(fillerDir, 'a.json');
            fs.writeFileSync(listFile, JSON.stringify(list));
            const aliasFile = path.join(dir, 'show-aliases.json');
            fs.writeFileSync(aliasFile, JSON.stringify({ aliases: {
                'gundam wing': G, 'g gundam': GG, 'bad series': { show: G, series: 'x', extra: 1 }, 'wing two': WING_S2 } }, null, 2));
            const aliasDB = new ShowAliasDB(dir);
            const loaded = await aliasDB.load();
            suite.check('the alias file keeps a nickname for a series, with or without seasons, and drops a malformed one',
                clipNames.sameName(loaded['g gundam'], GG) && clipNames.sameName(loaded['wing two'], WING_S2) && loaded['gundam wing'] === G && typeof(loaded['bad series']) === 'undefined');

            const fillerDB = new FillerDB(fillerDir);
            const channelService = { getAllChannelNumbers: async () => CHANNELS.map( (c) => c.number ), getChannel: async (n) => CHANNELS.find( (c) => c.number === n ) };
            const customShowDB = { getAllShowsInfo: async () => [], getAllShows: async () => CUSTOM_SHOWS };
            const service = new ShowMatchService(fillerDB, channelService, customShowDB, aliasDB);

            const match = await service.matchFiller('a');
            suite.check('the screen is given the custom shows that join several series, each with its series, episodes and seasons',
                Object.keys(match.series).sort().join() === `${G},${M},${P},custom.tj` && match.series[G].length === 3 && match.series[G][1].seasons.join() === '1,2' && match.series[G][1].count === 2);
            suite.check('a clip saved as the custom show whose title now reads as a series of it carries the narrower reading; the others do not',
                match.clips[1].narrower === null || clipNames.sameName(match.clips[1].narrower[0], GG));
            suite.check('the reading of the first clip, "Gundam Wing" taught as the whole custom show, is no narrower: nothing changes until the nickname does',
                match.clips[0].narrower === null);
            suite.check('the clip saved under the custom show whose own title is a series\' title gets the hint',
                Array.isArray(match.clips[3].narrower) && clipNames.sameName(match.clips[3].narrower[0], WING), JSON.stringify(match.clips[3].narrower));
            suite.check('an unsaved clip has no hint (its suggestion is the reading)', match.clips[2].narrower === null && ids(match.clips[2].proposal) === clipNames.nameId(WING));
            suite.check('the names a row mentions are given a display name, a series\' included',
                match.showNames[WING_KEY] === 'Mobile Suit Gundam Wing (in G Gundam/Gundam Wing/Gundam SEED+Destiny)');
            suite.check('and a series is no entry of the shows to pick from', match.shows.every( (s) => ! clipNames.isSeriesKey(s.key) ));

            const saved = await service.saveNames('a', { clips: [ { index: 0, title: 'Gundam Wing Intro [1]', names: [WING] }, { index: 1, title: 'G Gundam Intro', names: [GG, { anyOf: [WING_S2, SEED] }] } ], aliases: {} });
            const after = JSON.parse(fs.readFileSync(listFile, 'utf8')).content;
            suite.check('a series, and an any-of of series, saves on the clip; the other clips are untouched',
                clipNames.sameName(after[0].names[0], WING) && clipNames.sameName(after[1].names[1], { anyOf: [WING_S2, SEED] })
                && after[2].names === undefined && JSON.stringify(after[3].names) === JSON.stringify([G]) && saved !== null);
            const refused = async (body) => { try { await service.saveNames('a', body); return null; } catch (err) { return err; } };
            const bad = await refused({ clips: [ { index: 0, title: 'Gundam Wing Intro [1]', names: [clipNames.seriesName(G, 'Nonesuch')] } ], aliases: {} });
            suite.check('a series the custom show does not have is refused, with the series in the sentence',
                bad instanceof ShowMatchService.ReviewError && /Nonesuch/.test(bad.message), bad && bad.message);
            const bad2 = await refused({ clips: [ { index: 0, title: 'Gundam Wing Intro [1]', names: [{ show: G, series: 'Mobile Suit Gundam Wing', extra: 1 }] } ], aliases: {} });
            suite.check('and so is a malformed one', bad2 instanceof ShowMatchService.ReviewError);
            const taught = await service.saveNames('a', { clips: [], aliases: { 'g gundam two': GG } });
            suite.check('a nickname for a series saves to the alias file', clipNames.sameName(JSON.parse(fs.readFileSync(aliasFile, 'utf8')).aliases['g gundam two'], GG) && taught !== null);

            const page = await service.nicknames();
            suite.check('the Nicknames page lists a nickname for a series as one, in words, and carries the series to pick from',
                page.nicknames.find( (n) => n.alias === 'g gundam' ).kind === 'series' && /Mobile Fighter G Gundam \(in G Gundam/.test(page.nicknames.find( (n) => n.alias === 'g gundam' ).label)
                && page.nicknames.find( (n) => n.alias === 'gundam wing' ).kind === 'show' && Object.keys(page.series).length === 4);
            const aliasBefore = fs.readFileSync(aliasFile, 'utf8');
            const listBefore = fs.readFileSync(listFile, 'utf8');
            const preview = await service.previewNickname({ alias: 'gundam wing', anyOf: [WING] });
            suite.check('editing "gundam wing" from the whole custom show to the series previews what changes: one unsaved clip is read differently, saved ones keep theirs',
                preview.ok === true && preview.meaning === 'Mobile Suit Gundam Wing (in G Gundam/Gundam Wing/Gundam SEED+Destiny)' && preview.kept >= 1, JSON.stringify(preview));
            suite.check('and previewing writes nothing', fs.readFileSync(aliasFile, 'utf8') === aliasBefore && fs.readFileSync(listFile, 'utf8') === listBefore);
            const edited = await service.saveNickname({ alias: 'gundam wing', anyOf: [WING] });
            suite.check('saved, the nickname means the series, and the clips\' saved names were not rewritten by it',
                clipNames.sameName(JSON.parse(fs.readFileSync(aliasFile, 'utf8')).aliases['gundam wing'], WING)
                && edited.nicknames.find( (n) => n.alias === 'gundam wing' ).kind === 'series'
                && JSON.stringify(JSON.parse(fs.readFileSync(listFile, 'utf8')).content[3].names) === JSON.stringify([G]));
        } finally {
            removeDir(dir);
        }
    }

    return suite;
};

if (require.main === module) {
    module.exports().then( (suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    } );
}
