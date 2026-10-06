/*
 * Movies and seasons in clip names. A clip can name one movie, one season of a show
 * or one special, as well as a show: the shapes (src/clip-names.js), the matcher's
 * suggestions for them (src/show-match.js), the plans they make
 * (src/transitions.js: the most specific clip wins), the seasons lookup the picker
 * uses (src/show-seasons.js and ShowMatchService#showSeasons) and the review screen's
 * save of them. See docs/blocks-spec.md, Stage 5, "Which shows a clip names".
 *
 * Fixtures only, with the real Dragon Ball Z titles from the channels and Plex. The
 * save is driven against throwaway folders under the OS temp directory; no test here
 * reads or writes a data folder of the user's, and the Plex client is a fake.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { MIN, Suite } = require('./support');
const clipNames = require('../src/clip-names');
const showMatch = require('../src/show-match');
const review = require('../src/names-review');
const transitions = require('../src/transitions');
const showSeasons = require('../src/show-seasons');
const FillerDB = require('../src/dao/filler-db');
const ShowAliasDB = require('../src/dao/show-alias-db');
const ShowMatchService = require('../src/services/show-match-service');
const api = require('../src/api');

const DBZ = 'tv.Dragon Ball Z';
const DB = 'tv.Dragon Ball';
const COOLER = "movie.Dragon Ball Z: Cooler's Revenge";
const SLUG = 'movie.Dragon Ball Z: Lord Slug';
const TREE = 'movie.Dragon Ball Z: The Tree of Might';
const STRONGEST = "movie.Dragon Ball Z: The World's Strongest";
const BARDOCK = 'Bardock - The Father of Goku';
const S3 = { show: DBZ, season: 3 };
const SPECIAL = { show: DBZ, episode: BARDOCK };

function episode(show, season, n, mins) {
    return { title: `${show} S${season}E${n}`, type: 'episode', showTitle: show, season, episode: n, duration: (mins || 22) * MIN, serverKey: 'srv', ratingKey: `${show}-${season}-${n}` };
}
function movie(title, mins, customShow) {
    const m = { title, type: 'movie', duration: mins * MIN, serverKey: 'srv', ratingKey: 'm-' + title };
    if (customShow) {
        m.customShowId = customShow.id;
        m.customShowName = customShow.name;
    }
    return m;
}
const TOONAMI_MOVIES = { id: 'tm', name: 'Toonami Movies' };
const SPECIAL_EP = Object.assign(episode('Dragon Ball Z', 0, 16, 48), { title: BARDOCK });
const PROGRAMS = [
    episode('Dragon Ball Z', 1, 1), episode('Dragon Ball Z', 2, 1), episode('Dragon Ball Z', 3, 1), SPECIAL_EP,
    episode('Dragon Ball', 1, 1), episode('Dragon Ball GT', 1, 1), episode('Cowboy Bebop', 1, 1), episode('Full House', 7, 1),
    movie("Dragon Ball Z: Cooler's Revenge", 47, TOONAMI_MOVIES), movie('Dragon Ball Z: Lord Slug', 52, TOONAMI_MOVIES),
    movie('Dragon Ball Z: The Tree of Might', 61, TOONAMI_MOVIES), movie("Dragon Ball Z: The World's Strongest", 59, TOONAMI_MOVIES),
    movie('Batman: The Movie', 90, TOONAMI_MOVIES), movie('Scooby-Doo and the Goblin King', 74, { id: 'ct', name: 'Cartoon Theatre Movies' }),
    // movies that run under 40 minutes are shorts and gags a custom show holds as movies
    movie('Looney Tunes: Rabbit Fire', 8, { id: 'lt', name: 'Looney Tunes' }),
    // a movie that is not in a custom show is a key of its own whatever its length
    movie('Inuyasha the Movie 2: The Castle Beyond the Looking Glass', 99),
    { isOffline: true, duration: 5 * MIN },
];
const CHANNELS = [ { number: 1, name: 'Toonami', programs: PROGRAMS, scheduleBackup: { slots: [] } } ];
const CUSTOM = { tm: 'Toonami Movies', ct: 'Cartoon Theatre Movies', lt: 'Looney Tunes' };
const vocab = showMatch.buildVocabulary(CHANNELS, CUSTOM);
const propose = (title, aliases) => showMatch.propose(title, vocab, aliases || {});
const ids = (p) => p.names.map(clipNames.nameId).join(' | ');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'syndicast-movies-seasons-'));
}
function removeDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* left for the OS */ }
}

// ---- plans: a lineup, a step or two, the lists they read ----------------------------
const step = (id, listId, extra) => Object.assign({ id, kind: 'list', listId, match: 'show', keyedOn: 'next', fallbackListId: null,
    onlyIfNoMatch: null, days: null, chance: null }, extra || {});
const named = (title, names) => Object.assign({ title, key: '/c/' + title, duration: 15000 }, names === undefined ? {} : { names });
// The plan for the break between programs[0] and programs[2] (programs[1] is the Flex), on a
// channel that has one day-part with the given between-shows steps.
function planFor(programs, lists, out, inn) {
    const channel = {
        number: 1, name: 'T', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0, fillerCollections: [],
        programs, duration: programs.reduce((a, p) => a + p.duration, 0), startTime: new Date(2026, 9, 12, 8, 0, 0).toISOString(),
        dayParts: [ { id: 'dp', name: 'Day', fillerCollections: [], starts: [ { days: [0, 1, 2, 3, 4, 5, 6], time: 0 } ],
            transitions: { betweenShows: { out: out || [], in: inn || [] } } } ],
    };
    const start = new Date(channel.startTime).getTime() + programs[0].duration;
    return transitions.buildPlan(channel, transitions.findBreak(channel, 1, start), {
        getList: (id) => lists[id] || null, lastPlayed: () => 0, featuresShows: () => false,
    });
}
const flexed = (a, b, more) => [a, { isOffline: true, duration: 5 * MIN }, b].concat(more || []);
const says = (plan) => ['out', 'in'].map( (side) => plan[side].map( (s) => s.clip.title ).join(' + ') || '-' ).join(' / ');
const PREV = episode('Dragon Ball', 1, 1);
const MOVIE_COOLER = PROGRAMS[8], MOVIE_SLUG = PROGRAMS[9], MOVIE_OTHER = movie('Batman: The Movie', 90, TOONAMI_MOVIES);

module.exports = async function run() {
    const suite = new Suite('names-movies-seasons');

    // ---- the shapes ----------------------------------------------------------------
    {
        suite.check('a show key, a movie key, a season and a special are names',
            [DBZ, COOLER, S3, SPECIAL, { show: DBZ, season: 0 }, 'custom.abc', 'audio.x'].every(clipNames.validName));
        suite.check('everything else is not',
            [null, undefined, '', 3, [], {}, { show: DBZ }, { season: 3 }, { show: DBZ, season: -1 }, { show: DBZ, season: 1.5 },
                { show: DBZ, season: '3' }, { show: DBZ, episode: '' }, { show: 'movie.X', season: 1 }, { show: 'custom.c1', season: 1 },
                { show: DBZ, season: 3, episode: 'x' }, { show: DBZ, season: 3, extra: 1 }, { show: 5, season: 1 }].every( (n) => ! clipNames.validName(n) ));
        suite.check('equal names have one id and different ones differ',
            clipNames.sameName(S3, { season: 3, show: DBZ }) && ! clipNames.sameName(S3, { show: DBZ, season: 4 }) && ! clipNames.sameName(S3, DBZ)
            && ! clipNames.sameName(SPECIAL, { show: DBZ, episode: 'other' }) && clipNames.sameName(DBZ, DBZ));
        suite.check('a season and a special belong to their show; a movie to itself',
            clipNames.showOf(S3) === DBZ && clipNames.showOf(SPECIAL) === DBZ && clipNames.showOf(COOLER) === COOLER && clipNames.showOf(DBZ) === DBZ);
        suite.check('a season, a special and a movie are specific; a show is not',
            clipNames.isSpecific(S3) && clipNames.isSpecific(SPECIAL) && clipNames.isSpecific(COOLER) && ! clipNames.isSpecific(DBZ));
        const labels = { [DBZ]: 'Dragon Ball Z', [COOLER]: "Dragon Ball Z: Cooler's Revenge" };
        suite.check('names read as words',
            clipNames.labelOf(S3, labels) === 'Dragon Ball Z · Season 3' && clipNames.labelOf({ show: DBZ, season: 0 }, labels) === 'Dragon Ball Z · Specials'
            && clipNames.labelOf(SPECIAL, labels) === `Dragon Ball Z · “${BARDOCK}”` && clipNames.labelOf(COOLER, labels) === "Dragon Ball Z: Cooler's Revenge"
            && clipNames.labelOf(DBZ, labels) === 'Dragon Ball Z' && clipNames.labelOf('tv.Unknown Show', {}) === 'Unknown Show');
        const showKey = transitions.showKey;
        const e3 = episode('Dragon Ball Z', 3, 1), e1 = episode('Dragon Ball Z', 1, 1);
        const fit = (name, program) => clipNames.fits(name, program, showKey);
        suite.check('a show key fits every program of the show, as the show',
            fit(DBZ, e3) === 'show' && fit(DBZ, e1) === 'show' && fit(DBZ, MOVIE_COOLER) === false && fit(DB, e3) === false);
        suite.check('a season fits only that season of the show, as a specific fit',
            fit(S3, e3) === 'specific' && fit(S3, e1) === false && fit({ show: DB, season: 3 }, e3) === false && fit(S3, MOVIE_COOLER) === false);
        suite.check('a special fits only the episode of that title',
            fit(SPECIAL, SPECIAL_EP) === 'specific' && fit(SPECIAL, e3) === false && fit({ show: DBZ, season: 0 }, SPECIAL_EP) === 'specific');
        suite.check('a movie key fits that movie, in a custom show or not, and nothing else; it is not the custom show',
            fit(COOLER, MOVIE_COOLER) === 'specific' && fit(COOLER, MOVIE_SLUG) === false && fit(COOLER, e3) === false
            && fit('custom.tm', MOVIE_COOLER) === 'show' && fit(COOLER, movie("Dragon Ball Z: Cooler's Revenge", 47)) === 'specific');
        suite.check('Flex and no program fit nothing', fit(DBZ, { isOffline: true }) === false && fit(DBZ, null) === false);
    }

    // ---- what is stored: the saved shape reads back, the old one is untouched -------
    {
        suite.check('old names read exactly as they did', JSON.stringify(showMatch.namesOf({ names: [DBZ, DB] })) === JSON.stringify([DBZ, DB])
            && showMatch.namesProblem({ names: [DBZ, DB] }) === null && showMatch.namesOf({ names: [] }).length === 0);
        suite.check('new names read back and are not a problem',
            showMatch.namesProblem({ names: [S3, COOLER, SPECIAL] }) === null && showMatch.namesOf({ names: [S3, COOLER, SPECIAL] }).length === 3);
        suite.check('a name that is not one is a problem and reads as naming nothing',
            /not a show key/.test(showMatch.namesProblem({ names: [{ show: DBZ, season: 'three' }] })) && showMatch.namesOf({ names: [DBZ, { show: DBZ, season: 'three' }] }).length === 0);
        suite.check('four names at most, whatever they are',
            showMatch.namesProblem({ names: [S3, S3, S3, S3, S3] }) !== null && showMatch.namesProblem({ names: [S3, COOLER, SPECIAL, DBZ] }) === null);
    }

    // ---- the vocabulary: which movies, which specials ----------------------------------
    {
        const movieKeys = vocab.movies.map( (m) => m.key );
        suite.check('a movie of at least 40 minutes is offered, in a custom show or not',
            [COOLER, SLUG, TREE, STRONGEST, 'movie.Scooby-Doo and the Goblin King', 'movie.Inuyasha the Movie 2: The Castle Beyond the Looking Glass'].every( (k) => movieKeys.includes(k) ));
        suite.check('a short a custom show holds as a movie is not', ! movieKeys.includes('movie.Looney Tunes: Rabbit Fire'));
        suite.check('a movie says which custom show holds it, and has its own display name',
            vocab.movies.find( (m) => m.key === COOLER ).custom === 'Toonami Movies' && vocab.movies.find( (m) => m.key.startsWith('movie.Inuyasha') ).custom === null
            && vocab.names[COOLER] === "Dragon Ball Z: Cooler's Revenge");
        suite.check('the specials of a show are its season 0 episodes, and the seasons seen are listed',
            vocab.specials.get(DBZ).length === 1 && vocab.specials.get(DBZ)[0].title === BARDOCK && JSON.stringify(vocab.seasons[DBZ]) === '[0,1,2,3]');
    }

    // ---- movies: the title names the movie by its subtitle -----------------------------
    {
        const cooler = propose("DragonBall Z Movie Cooler's Revenge Intro");
        suite.check('"DragonBall Z Movie Cooler\'s Revenge Intro" is for that movie, not for the show', ids(cooler) === COOLER && ! cooler.unresolved, JSON.stringify(cooler.names));
        suite.check('and says it was found by the movie\'s subtitle, which is a confident answer',
            cooler.found.some( (h) => h.subtitle === true ) && ! review.marksOf(cooler).some( (m) => m.uncertain ) && review.marksOf(cooler).some( (m) => m.id === 'movie' ));
        suite.check('the same with a clip length tag on the end', ids(propose("DragonBall Z Movie Cooler's Revenge Intro ['15]")) === COOLER);
        suite.check('Lord Slug, Tree of Might (without its "The") and World\'s Strongest',
            ids(propose('DragonBall Z Movie Lord Slug Intro')) === SLUG && ids(propose('DragonBall Z Tree of Might Intro')) === TREE
            && ids(propose("DragonBall Z World's Strongest Intro V1 [Fan-Made]")) === STRONGEST);
        suite.check('the subtitle alone names the movie, with no show in the title', ids(propose('Lord Slug Intro')) === SLUG);
        suite.check('a movie is preferred to its show only where the movie is named: a clip for the show is still the show',
            ids(propose('DBZ NEXT Bumper')) === DBZ && ids(propose('Toonami - NEXT [DragonBall Z]')) === DBZ);
        suite.check('"The Movie" is the end of many titles and names nothing', ids(propose('Spongebob The Movie promo')) === '' && ! propose('Spongebob The Movie promo').unresolved);
        suite.check('a movie that is not on a channel is not named: a clip that says "Movie" after a show is flagged, not read as the show',
            (() => { const p = propose('DragonBall Z Movie Broly Second Coming Intro'); return p.names.length === 0 && p.unresolved && p.unresolved.kind === 'movie'; })());
        suite.check('the flag says so and names no show', (() => { const p = propose('TV Ad (Dragon Ball Z Movie DVD) (2002)'); return p.names.length === 0 && /movie or special/.test(p.unresolved.reason); })());
        suite.check('a movie that has a whole title of its own on a channel (not in a custom show) is found by it as before',
            ids(propose('Inuyasha the Movie 2: The Castle Beyond the Looking Glass promo')) === 'movie.Inuyasha the Movie 2: The Castle Beyond the Looking Glass');
        suite.check('and by its subtitle, which is longer than a word',
            ids(propose('Inuyasha Castle Beyond the Looking Glass promo')) === 'movie.Inuyasha the Movie 2: The Castle Beyond the Looking Glass');
        suite.check('a short in a custom show is never matched by a subtitle: "Rabbit Fire" names nothing',
            ids(propose('Rabbit Fire promo')) === '');
    }

    // ---- specials: a season 0 episode, only when the show is named too ------------------
    {
        const bardock = propose('DragonBall Z Special Bardock Father of Goku Intro');
        suite.check('"DragonBall Z Special Bardock Father of Goku Intro" is for that special', ids(bardock) === clipNames.nameId(SPECIAL), JSON.stringify(bardock.names));
        suite.check('and is less certain, which sends it to the review group that needs a look',
            review.marksOf(bardock).some( (m) => m.id === 'special' && m.uncertain ) && review.groupOf({ index: 0, names: [], proposal: bardock }) === 'uncertain');
        suite.check('without the show in the title it is not read as the special', ids(propose('Father of Goku Intro')) === '');
        suite.check('a special\'s title inside another show\'s clip does not make it a special of a show that was not named',
            ids(propose('Space Ghost Time Machine')) === '');
        suite.check('with the special not on any channel, the clip says "Special" and is flagged instead of read as the show',
            (() => { const p = showMatch.propose('DragonBall Z Special Bardock Father of Goku Intro', showMatch.buildVocabulary([{ number: 1, programs: [episode('Dragon Ball Z', 1, 1)] }], {}), {});
                return p.names.length === 0 && p.unresolved && p.unresolved.kind === 'movie'; })());
    }

    // ---- seasons: "Season N" and the nicknames a person teaches --------------------------
    {
        const six = propose('DBZ NEXT Promo (Season 6)');
        suite.check('"Season 6" narrows the show to that season, less certain', ids(six) === clipNames.nameId({ show: DBZ, season: 6 })
            && review.marksOf(six).some( (m) => m.id === 'season' && m.uncertain ), JSON.stringify(six.names));
        suite.check('a season is attached to the show before it, in either order of words',
            ids(propose('Dragon Ball Z Season 4 Promo [TOM 1]')) === clipNames.nameId({ show: DBZ, season: 4 })
            && ids(propose('Season 4 Dragon Ball Z Promo')) === clipNames.nameId({ show: DBZ, season: 4 }));
        suite.check('"Season 1" on a show that has seasons: the whole show is left to the show, a season is not invented',
            ids(propose('Cowboy Bebop promo')) === 'tv.Cowboy Bebop' && ids(propose('Full House Season 7 DVD')) === clipNames.nameId({ show: 'tv.Full House', season: 7 }));
        suite.check('a clip with two shows and one season narrows the show the season follows',
            ids(propose('Cowboy Bebop to Full House Season 7 promo')).endsWith(clipNames.nameId({ show: 'tv.Full House', season: 7 })));
        const frieza = { 'frieza saga': S3 };
        suite.check('without the nickname, a title that names a saga is flagged and names nothing',
            (() => { const p = propose('DBZ Intro [Frieza Saga]'); return p.names.length === 0 && p.unresolved && p.unresolved.kind === 'saga' && p.unresolved.recognised[0] === DBZ; })());
        suite.check('with the nickname taught, the saga is season 3 of the show named beside it',
            ids(propose('DBZ Intro [Frieza Saga]', frieza)) === clipNames.nameId(S3) && ! propose('DBZ Intro [Frieza Saga]', frieza).unresolved);
        suite.check('the nickname stands for its season when the show is not in the title', ids(propose('Frieza Saga Intro', frieza)) === clipNames.nameId(S3));
        suite.check('a taught nickname is a confident answer and shows in what matched',
            propose('Dragon Ball Z Intro [Frieza Saga]', frieza).found.some( (h) => h.via === 'alias' && h.text === 'frieza saga' )
            && ! review.marksOf(propose('Dragon Ball Z Intro [Frieza Saga]', frieza)).some( (m) => m.uncertain ));
        suite.check('a plain word nickname still means its show, and a season nickname does not leak into other clips',
            ids(propose('DBZ promo', { sgc2c: 'tv.Space Ghost Coast to Coast', 'frieza saga': S3 })) === DBZ);
        suite.check('"Season N" does not override a taught season', ids(propose('DBZ Season 6 Frieza Saga Intro', frieza)) === clipNames.nameId(S3));
        suite.check('a name that is not a season in the alias file is ignored by the matcher',
            ids(propose('Frieza Saga Intro', { 'frieza saga': { show: DBZ, season: 'x' } })) === '');
        suite.check('proposing changes nothing it is given', JSON.stringify(frieza) === JSON.stringify({ 'frieza saga': S3 }));
    }

    // ---- nicknames for a season ---------------------------------------------------------
    {
        const clips = [
            { list: 'L', index: 0, title: 'DBZ Intro [Frieza Saga]' },
            { list: 'L', index: 1, title: 'DBZ Intro [Frieza Saga] (2003)' },
            { list: 'L', index: 2, title: 'DBZ NEXT promo (Frieza Saga) [TOM 3]', names: [DBZ] },
            { list: 'L', index: 3, title: 'Cowboy Bebop Frieza Saga parody', names: ['tv.Cowboy Bebop'] },
            { list: 'L', index: 4, title: 'Piccolo Intro' },
        ];
        const ok = showMatch.checkNickname('frieza saga', S3, vocab, {}, clips.slice(0, 3), { sourceTitle: clips[0].title });
        suite.check('a season nickname is accepted for the clip it is taught from, which it names as that season',
            ok.ok && ok.sourceNames.map(clipNames.nameId).join() === clipNames.nameId(S3), JSON.stringify(ok));
        suite.check('and counts the clip that only gains the season as one it would newly suggest, not as another show\'s clip',
            ok.newly.some( (c) => c.index === 1 ) && ok.changed.length === 0, JSON.stringify([ok.newly.length, ok.changed.length]));
        // A clip that already names the show and only gains the season is a better suggestion, not another show's clip.
        const namek = showMatch.checkNickname('namek', { show: DBZ, season: 2 }, vocab, {}, [ { list: 'L', index: 0, title: 'Dragon Ball Z Namek Intro' } ], {});
        suite.check('a clip that already suggests the same show and only gains the season is counted as newly suggested, not as changed',
            namek.ok && namek.newly.length === 1 && namek.changed.length === 0 && clipNames.sameName(namek.newly[0].names[0], { show: DBZ, season: 2 }), JSON.stringify(namek));
        suite.check('a clip saved as the whole show is never changed by it, and does not block it',
            ! ok.changed.some( (c) => c.index === 2 ) && ! ok.newly.some( (c) => c.index === 2 ));
        const blocked = showMatch.checkNickname('frieza saga', S3, vocab, {}, clips, { sourceTitle: clips[0].title });
        suite.check('but a clip saved under a different show does, as for any nickname',
            ! blocked.ok && blocked.changed.some( (c) => c.index === 3 ), JSON.stringify(blocked.problems));
        suite.check('a nickname that already means that season says so; one that means another season is taken',
            /already a nickname/.test(showMatch.checkNickname('frieza saga', S3, vocab, { 'frieza saga': S3 }, [], {}).problems.join(' '))
            && /already means Dragon Ball Z · Season 4/.test(showMatch.checkNickname('frieza saga', S3, vocab, { 'frieza saga': { show: DBZ, season: 4 } }, [], {}).problems.join(' ')));
        suite.check('the usual rules apply: everyday words and numbers are refused for a season too',
            ! showMatch.checkNickname('season 3', S3, vocab, {}, [], {}).ok && ! showMatch.checkNickname('promo', S3, vocab, {}, [], {}).ok
            && ! showMatch.checkNickname('3', S3, vocab, {}, [], {}).ok);
        suite.check('a season of a show that is on no channel, or a season that is not a whole number, is refused',
            /Pick the show/.test(showMatch.checkNickname('frieza saga', { show: 'tv.Nope', season: 3 }, vocab, {}, [], {}).problems.join(' '))
            && /Pick the show/.test(showMatch.checkNickname('frieza saga', { show: DBZ, season: 'three' }, vocab, {}, [], {}).problems.join(' ')));
        suite.check('a season nickname is offered the phrases of the clip title',
            showMatch.nicknameSuggestions('DBZ Intro [Frieza Saga]', S3, vocab, {}, []).some( (s) => s.alias === 'frieza saga' ));
    }

    // ---- plans: the most specific clip wins -----------------------------------------------
    {
        const E = (season, n) => episode('Dragon Ball Z', season, n || 1);
        const lists = {
            Intros: [named('DBZ Intro', [DBZ]), named('Frieza Saga Intro', [S3]), named('Android Intro', [{ show: DBZ, season: 4 }]),
                named('Cooler Intro', [COOLER]), named('Slug Intro', [SLUG]), named('Bardock Intro', [SPECIAL]), named('Ident')],
        };
        const S = [step('in', 'Intros')];
        const line = (next, more, steps, lst) => says(planFor(flexed(PREV, next, more), lst || lists, [], steps || S));

        suite.check('before an episode of season 3, the season 3 clip beats the show clip', line(E(3)) === '- / Frieza Saga Intro', line(E(3)));
        suite.check('before season 1, the show clip plays and the season 3 and 4 clips never do', line(E(1)) === '- / DBZ Intro');
        suite.check('before season 4 it is the season 4 clip, and before season 5 the show clip',
            line(E(4)) === '- / Android Intro' && line(E(5)) === '- / DBZ Intro');
        suite.check('before the Cooler\'s Revenge movie, its own clip plays and the show clip does not',
            line(MOVIE_COOLER) === '- / Cooler Intro', line(MOVIE_COOLER));
        suite.check('before Lord Slug, the Lord Slug clip', line(MOVIE_SLUG) === '- / Slug Intro');
        suite.check('before a movie nobody has a clip for, no DBZ clip plays: a movie is not an episode of the show',
            line(MOVIE_OTHER) === '- / -');
        suite.check('before the Bardock special, its clip; before a regular episode it never plays',
            line(SPECIAL_EP) === '- / Bardock Intro' && line(E(2)) !== '- / Bardock Intro');
        suite.check('the show clip is a clip for the show and does not play before its movie even with nothing else there',
            line(MOVIE_COOLER, [], S, { Intros: [named('DBZ Intro', [DBZ])] }) === '- / -');
        suite.check('the plan says which kind of match it was',
            planFor(flexed(PREV, E(3)), lists, [], S).in[0].specific === true && planFor(flexed(PREV, E(1)), lists, [], S).in[0].specific === false);
        suite.check('and lists every clip of the winning kind, the chosen one first',
            (() => { const l = { Intros: [named('A', [S3]), named('B', [S3]), named('Show', [DBZ])] };
                const f = planFor(flexed(PREV, E(3)), l, [], S).in[0].fits; return f.join() === 'A,B'; })());

        // the closest clip wins whichever list it is in: a clip for that exact season in the fallback list beats
        // a clip for the show in the step's own list; the show clip still wins before other seasons.
        const fallbackStep = [step('in', 'Intros', { fallbackListId: 'Movie Intros' })];
        const two = { Intros: [named('DBZ Intro', [DBZ])], 'Movie Intros': [named('Bardock Intro', [SPECIAL]), named('Cooler Intro', [COOLER]), named('Generic')] };
        suite.check('a clip for the exact special in the fallback list beats a show clip in the main list',
            line(SPECIAL_EP, [], fallbackStep, two) === '- / Bardock Intro');
        suite.check('and for the exact movie', line(MOVIE_COOLER, [], fallbackStep, two) === '- / Cooler Intro');
        suite.check('before an ordinary episode, the show clip in the main list plays, then the fallback list for everything else',
            line(E(2), [], fallbackStep, two) === '- / DBZ Intro' && line(MOVIE_SLUG, [], fallbackStep, two) === '- / Generic');
        suite.check('a clip for another movie never plays as the fallback', line(MOVIE_SLUG, [], fallbackStep, { Intros: [], 'Movie Intros': [named('Cooler Intro', [COOLER])] }) === '- / -');
        suite.check('a clip is still used once in a plan: the out step takes the exact clip and the in step gets the next best',
            says(planFor(flexed(PREV, E(3)), { Intros: [named('Frieza Saga Intro', [S3]), named('DBZ Intro', [DBZ])] }, [step('out', 'Intros')], [step('in', 'Intros')])) === 'Frieza Saga Intro / DBZ Intro');

        // names of several: shows one after another, a season or a movie among them
        const after = (a, b) => flexed(PREV, a, [b]);
        const pairClip = { Intros: [named('Frieza then Dragon Ball', [S3, DB])] };
        suite.check('a clip naming a season then a show plays only when they air in that order',
            says(planFor(after(E(3), episode('Dragon Ball', 1, 2)), pairClip, [], S)) === '- / Frieza then Dragon Ball'
            && says(planFor(after(E(3), episode('Cowboy Bebop', 1, 2)), pairClip, [], S)) === '- / -'
            && says(planFor(after(E(1), episode('Dragon Ball', 1, 2)), pairClip, [], S)) === '- / -');
        suite.check('and that is a specific match, which beats a plain clip for the show',
            says(planFor(after(E(3), episode('Dragon Ball', 1, 2)), { Intros: [named('Plain', [DBZ]), named('Frieza then Dragon Ball', [S3, DB])] }, [], S)) === '- / Frieza then Dragon Ball');

        // a pair step: now then next
        const pairStep = [step('in', 'Intros', { match: 'pair' })];
        suite.check('a pair step sees seasons and movies in either place',
            says(planFor(flexed(PREV, E(3)), { Intros: [named('Plain pair', [DB, DBZ]), named('Next season', [{ show: DB, season: 1 }, S3])] }, [], pairStep)) === '- / Next season'
            && says(planFor(flexed(PREV, E(1)), { Intros: [named('Plain pair', [DB, DBZ]), named('Next season', [{ show: DB, season: 1 }, S3])] }, [], pairStep)) === '- / Plain pair');
        suite.check('and a clip naming only the next movie plays for it before a plain next-show clip',
            says(planFor(flexed(PREV, MOVIE_COOLER), { Intros: [named('Next show', [DB]), named('Cooler', [COOLER])] }, [], pairStep)) === '- / Cooler');

        // what is not specific is exactly as it was
        suite.check('a list of plain show clips and unnamed clips plays as before',
            line(E(3), [], S, { Intros: [named('Ident'), named('DBZ Intro', [DBZ])] }) === '- / DBZ Intro'
            && line(E(3), [], [step('in', 'Intros', { match: 'any' })], { Intros: [named('Ident')] }) === '- / Ident');
        suite.check('a clip with names that are not usable is never chosen, as before',
            line(E(3), [], S, { Intros: [named('Broken', [{ show: DBZ, season: 'x' }]), named('DBZ Intro', [DBZ])] }) === '- / DBZ Intro');
        suite.check('a season of another show never plays before this one',
            line(E(3), [], S, { Intros: [named('Bebop S3', [{ show: 'tv.Cowboy Bebop', season: 3 }])] }) === '- / -');
        suite.check('a step keyed on the show that just ended reads seasons of that show',
            says(planFor(flexed(E(3), episode('Dragon Ball', 1, 1)), { Intros: [named('After S3', [S3]), named('After show', [DBZ])] }, [], [step('in', 'Intros', { keyedOn: 'now' })])) === '- / After S3');
    }

    // ---- the review screen's logic ------------------------------------------------------------
    {
        suite.check('picks of every shape are valid, in order, up to four',
            review.picksProblem([S3, COOLER, SPECIAL, DBZ]) === null && review.picksProblem([S3, COOLER, SPECIAL, DBZ, DB]) !== null);
        suite.check('the same season twice in a row is refused, a different season of the show is not',
            review.picksProblem([S3, { show: DBZ, season: 3 }]) !== null && review.picksProblem([S3, { show: DBZ, season: 4 }]) === null && review.picksProblem([S3, DBZ]) === null);
        suite.check('a blank pick is refused', review.picksProblem([S3, null]) !== null && review.picksProblem([{ show: DBZ }]) !== null);
        suite.check('cleaning keeps valid names and drops repeats in a row',
            review.cleanPicks([S3, S3, null, COOLER, { show: DBZ, season: 'x' }, DBZ]).map(clipNames.nameId).join() === [S3, COOLER, DBZ].map(clipNames.nameId).join());
        const row = (extra) => Object.assign({ index: 0, title: 't', names: [], reviewed: false, proposal: { names: [], found: [], extra: 0 } }, extra);
        suite.check('"Season N" and specials are less certain, a movie by subtitle and a taught nickname are confident',
            review.groupOf(row({ proposal: propose('DBZ NEXT Promo (Season 6)') })) === 'uncertain'
            && review.groupOf(row({ proposal: propose("DragonBall Z Movie Lord Slug Intro") })) === 'confident'
            && review.groupOf(row({ proposal: propose('Dragon Ball Z Intro [Frieza Saga]', { 'frieza saga': S3 }) })) === 'confident');
        suite.check('a flagged clip is in the flagged group, which says what was wrong',
            review.groupOf(row({ proposal: propose('DBZ Intro [Android Saga]') })) === 'flagged'
            && review.marksOf(propose('DBZ Intro [Android Saga]')).some( (m) => /saga/.test(m.label) )
            && review.marksOf(propose('DragonBall Z Movie Broly Intro')).some( (m) => /movie or special/.test(m.label) ));
        suite.check('accept-all takes the movie and leaves seasons from "Season N", specials and flagged ones for a look',
            (() => { const rows = [row({ index: 0, proposal: propose('DragonBall Z Movie Lord Slug Intro') }), row({ index: 1, proposal: propose('DBZ NEXT Promo (Season 6)') }),
                row({ index: 2, proposal: propose('DragonBall Z Special Bardock Father of Goku Intro') }), row({ index: 3, proposal: propose('DBZ Intro [Android Saga]') })];
                const plan = review.acceptAllPlan(rows, {}); return plan.accept.join() === '0' && plan.skippedUncertain === 2 && plan.skippedFlagged === 1; })());
        suite.check('the payload carries season and movie names and the target of a nickname; older callers still work',
            (() => { const p = review.savePayload([row({ index: 4, title: 'x' })], { 4: { names: [S3, COOLER] } },
                [{ alias: 'frieza saga', target: S3 }, { alias: 'static', showKey: 'tv.Static Shock' }]);
                return p.clips[0].names.map(clipNames.nameId).join() === [S3, COOLER].map(clipNames.nameId).join() && p.aliases['frieza saga'].season === 3 && p.aliases.static === 'tv.Static Shock'; })());
    }

    // ---- folders and seasons --------------------------------------------------------------------
    {
        const hint = (folder, show) => showSeasons.seasonHint(folder, show || 'Dragon Ball Z');
        suite.check('a saga folder suggests its name: the number, the episodes and "The" go',
            hint('03. The FRIEZA Saga (Eps. 075-107)').alias === 'frieza saga' && hint('01. The SAIYAN Saga (Eps. 001-035)').text === 'SAIYAN Saga'
            && hint('The GARLIC Jr. Saga').alias === 'garlic jr saga' && hint('05. Cell Saga').alias === 'cell saga' && hint('06. CELL GAMES Saga').alias === 'cell games saga');
        suite.check('a folder that says no more than Plex does suggests nothing',
            hint('Season 3') === null && hint('Season 03') === null && hint('Specials') === null && hint('Specials (1990-2013)') === null);
        suite.check('nor does the show\'s own name, an empty one or none', hint('Dragon Ball Z') === null && hint('') === null && hint(null) === null && hint('03.') === null);
        suite.check('a season reads as Plex titles it, with its folder only as a hint',
            showSeasons.seasonLabel(3, 'Season 3') === 'Season 3' && showSeasons.seasonLabel(3, 'The Frieza Saga') === 'Season 3 · The Frieza Saga'
            && showSeasons.seasonLabel(0, 'Specials') === 'Specials' && showSeasons.seasonLabel(2, null) === 'Season 2');
        const fromLineups = showSeasons.lineupSeasons(vocab, DBZ);
        suite.check('without Plex the seasons are the ones the lineups have, and the specials the season 0 episodes',
            fromLineups.source === 'lineup' && fromLineups.seasons.map( (s) => s.index ).join() === '0,1,2,3' && fromLineups.specials[0].title === BARDOCK
            && fromLineups.seasons.every( (s) => s.hint === null ));

        // a fake Plex that answers like the real one did for Dragon Ball Z
        const FOLDERS = { 147946: '01. The SAIYAN Saga (Eps. 001-035)', 147982: '02. The NAMEK Saga (Eps. 036-067)', 148022: '03. The FRIEZA Saga (Eps. 075-107)' };
        const calls = [];
        const fakePlex = (opts) => ({ Get: async (p) => {
            calls.push(p);
            if (opts && opts.fail) { throw new Error('plex is down'); }
            if (p === '/library/metadata/ep1') { return { Metadata: [{ grandparentRatingKey: '147943' }] }; }
            if (p === '/library/metadata/147943/children') {
                return { Metadata: [ { index: 0, title: 'Specials', ratingKey: '155469' }, { index: 1, title: 'Season 1', ratingKey: '147946' },
                    { index: 2, title: 'Season 2', ratingKey: '147982' }, { index: 3, title: 'The Frieza Saga', ratingKey: '148022' } ] };
            }
            if (p === '/library/metadata/155469/children') {
                return { Metadata: [ { title: BARDOCK }, { title: 'The History of Trunks' } ] };
            }
            const m = /^\/library\/metadata\/(\d+)\/children\?X-Plex-Container-Start=0&X-Plex-Container-Size=1$/.exec(p);
            if (m && FOLDERS[m[1]]) {
                return { Metadata: [ { Media: [ { Part: [ { file: 'G:\\1.Toonami Shows\\DRAGON BALL Z (1989-2019)\\TV Series\\' + FOLDERS[m[1]] + '\\Dragon Ball Z - S01 E001.mkv' } ] } ] } ] };
            }
            throw new Error('unexpected request ' + p);
        } });
        const got = await showSeasons.plexSeasons(fakePlex(), 'ep1', DBZ, 'Dragon Ball Z');
        suite.check('Plex\'s seasons come back in order with their titles, their folders and the nicknames the folders suggest',
            got.source === 'plex' && got.seasons.map( (s) => s.index ).join() === '0,1,2,3'
            && got.seasons[3].label === 'Season 3 · The Frieza Saga' && got.seasons[3].folder === '03. The FRIEZA Saga (Eps. 075-107)' && got.seasons[3].hint.alias === 'frieza saga'
            && got.seasons[1].hint.alias === 'saiyan saga' && got.seasons[0].hint === null && got.seasons[0].label === 'Specials', JSON.stringify(got.seasons));
        suite.check('the specials are the season 0 episodes, by title', got.specials.map( (s) => s.title ).join('|') === `${BARDOCK}|The History of Trunks`);
        suite.check('each season is asked for its first episode only, and Plex is only read',
            calls.filter( (c) => /Container-Size=1/.test(c) ).length === 3 && calls.every( (c) => /^\/library\/metadata\//.test(c) ), calls.join(' '));
        let threw = null;
        try { await showSeasons.plexSeasons(fakePlex({ fail: true }), 'ep1', DBZ, 'Dragon Ball Z'); } catch (err) { threw = err; }
        suite.check('when Plex cannot be asked it throws, for the caller to fall back to the lineups', threw !== null);
        const patchy = fakePlex();
        const realGet = patchy.Get;
        patchy.Get = async (p) => { if (/148022\/children\?/.test(p)) { throw new Error('one season fails'); } return realGet(p); };
        const part = await showSeasons.plexSeasons(patchy, 'ep1', DBZ, 'Dragon Ball Z');
        suite.check('one season Plex will not describe is listed anyway, without a folder', part.seasons.length === 4 && part.seasons[3].folder === null && part.seasons[3].hint === null && part.seasons[2].hint !== null);
    }

    // ---- the service: seasons, picks and the save, against real files ----------------------
    {
        const dir = tempDir();
        const fillerDir = path.join(dir, 'filler');
        fs.mkdirSync(fillerDir);
        try {
            const list = { name: 'DBZ Intros', mode: 'custom', rank: 0, content: [
                { title: "DragonBall Z Movie Cooler's Revenge Intro", duration: 30000, key: '/1', serverKey: 'srv' },
                { title: 'DBZ Intro [Frieza Saga]', duration: 30000, key: '/2', serverKey: 'srv' },
                { title: 'DBZ Intro [Frieza Saga] (2003)', duration: 30000, key: '/3', serverKey: 'srv' },
                { title: 'DragonBall Z Special Bardock Father of Goku Intro', duration: 30000, key: '/4', serverKey: 'srv' },
                { title: 'DBZ NEXT Bumper', duration: 15000, key: '/5', serverKey: 'srv', names: [DBZ] },
            ] };
            fs.writeFileSync(path.join(fillerDir, 'a.json'), JSON.stringify(list));
            const read = () => fs.readFileSync(path.join(fillerDir, 'a.json'), 'utf8');
            const fillerDB = new FillerDB(fillerDir);
            const aliasDB = new ShowAliasDB(dir);
            const channelService = { getAllChannelNumbers: async () => [1], getChannel: async () => CHANNELS[0] };
            const customShowDB = { getAllShowsInfo: async () => Object.keys(CUSTOM).map( (id) => ({ id, name: CUSTOM[id] }) ) };
            let plexCalls = 0;
            let plexDown = false;
            const plexClient = () => ({ Get: async (p) => {
                plexCalls++;
                if (plexDown) { throw new Error('down'); }
                if (p === '/library/metadata/Dragon Ball Z-1-1'.replace(/ /g, '%20')) { return { Metadata: [{ grandparentRatingKey: '9' }] }; }
                if (p === '/library/metadata/9/children') { return { Metadata: [ { index: 3, title: 'Season 3', ratingKey: '33' } ] }; }
                if (/^\/library\/metadata\/33\/children/.test(p)) { return { Metadata: [ { Media: [ { Part: [ { file: '/tv/DBZ/03. The FRIEZA Saga (Eps. 075-107)/x.mkv' } ] } ] } ] }; }
                throw new Error('unexpected ' + p);
            } });
            const plexServerDB = { getPlexServerByName: async (name) => (name === 'srv') ? { name: 'srv', uri: 'http://x', accessToken: 't' } : null };
            const service = new ShowMatchService(fillerDB, channelService, customShowDB, aliasDB, plexServerDB, plexClient);

            // the match: movies in the picker, names carried as objects, labels for every show named
            const match = await service.matchFiller('a');
            suite.check('the picker is given the movies of the channels after the shows, with the custom show that holds each',
                match.shows.some( (s) => s.key === COOLER && s.movie === true && s.group === 'Movies' && s.inCustomShow === 'Toonami Movies' )
                && match.shows.some( (s) => s.key === DBZ && s.group === 'Shows' ) && match.shows.some( (s) => s.key === 'custom.tm' && s.group === 'Custom shows' )
                && ! match.shows.some( (s) => s.key === 'movie.Looney Tunes: Rabbit Fire' ));
            suite.check('the movie clip is suggested as that movie, the season clip is flagged until the saga is taught, the special is suggested',
                match.clips[0].proposal.names.join() === COOLER && match.clips[1].proposal.unresolved.kind === 'saga'
                && clipNames.sameName(match.clips[3].proposal.names[0], SPECIAL));
            suite.check('every name has a display name: the movie, and the show of a season or special',
                match.showNames[COOLER] === "Dragon Ball Z: Cooler's Revenge" && match.showNames[DBZ] === 'Dragon Ball Z');

            // the seasons, from Plex
            const seasons = await service.showSeasons(DBZ);
            suite.check('the seasons come from Plex with the folder hints', seasons.source === 'plex' && seasons.seasons[0].hint.alias === 'frieza saga', JSON.stringify(seasons));
            const callsAfterFirst = plexCalls;
            await service.showSeasons(DBZ);
            suite.check('and are remembered, so a second ask does not call Plex', plexCalls === callsAfterFirst);
            suite.check('a show that has no channel, or is not a tv show, has no seasons to give',
                (await service.showSeasons('tv.Nope')) === null && (await service.showSeasons(COOLER)) === null && (await service.showSeasons('custom.tm')) === null && (await service.showSeasons(undefined)) === null);
            plexDown = true;
            const quiet = console.error;
            console.error = () => {};
            const lineups = await service.showSeasons('tv.Dragon Ball');
            console.error = quiet;
            suite.check('with Plex down the lineups\' seasons are answered, saying so', lineups.source === 'lineup' && lineups.seasons.length === 1);
            const noPlex = new ShowMatchService(fillerDB, channelService, customShowDB, aliasDB);
            suite.check('with no Plex configured at all the same', (await noPlex.showSeasons(DBZ)).source === 'lineup');

            // a nickname check for a season
            const check = await service.checkNickname('a', 'frieza saga', DBZ, 1, 3);
            suite.check('a season nickname check answers in words, and says the clip it is taught from would name that season',
                check.ok && check.showName === 'Dragon Ball Z · Season 3' && check.sourceShows.join() === 'Dragon Ball Z · Season 3' && check.thisList === 1, JSON.stringify(check));
            const bytesBefore = read();
            suite.check('checking and suggesting wrote nothing',
                (await service.nicknameSuggestions('a', 1, DBZ, 3)).some( (s) => s.alias === 'frieza saga' ) && read() === bytesBefore && ! fs.existsSync(path.join(dir, 'show-aliases.json')));

            // the save
            const refuse = async (body) => { try { await service.saveNames('a', body); return null; } catch (err) { return err; } };
            const bad = [
                { clips: [{ index: 0, title: list.content[0].title, names: [{ show: DBZ, season: 'x' }] }], aliases: {} },
                { clips: [{ index: 0, title: list.content[0].title, names: ['movie.No Such Movie: Anywhere'] }], aliases: {} },
                { clips: [{ index: 0, title: list.content[0].title, names: [{ show: 'tv.Nope', season: 1 }] }], aliases: {} },
                { clips: [], aliases: { 'frieza saga': { show: DBZ, season: 'x' } } },
                { clips: [], aliases: { 'frieza saga': { show: DBZ, episode: BARDOCK } } },
                { clips: [], aliases: { 'frieza saga': { show: 'tv.Nope', season: 3 } } },
                { clips: [], aliases: { 'promo': S3 } },
            ];
            const refusals = await Promise.all(bad.map(refuse));
            suite.check('names that are not valid, a movie or a show no channel has, and nicknames that are not valid or are everyday words are refused',
                refusals.every( (e) => e instanceof ShowMatchService.ReviewError ), refusals.map( (e) => e && e.message ).join(' | '));
            suite.check('a nickname that is not a name at all says so, in words',
                /does not mean a show, a movie or a season/.test(refusals[3].message), refusals[3].message);
            suite.check('and a refused save writes nothing', read() === bytesBefore && ! fs.existsSync(path.join(dir, 'show-aliases.json')));
            const saved = await service.saveNames('a', {
                clips: [
                    { index: 0, title: list.content[0].title, names: [COOLER] },
                    { index: 1, title: list.content[1].title, names: [S3] },
                    { index: 3, title: list.content[3].title, names: [SPECIAL] },
                ],
                aliases: { 'frieza saga': S3 },
            });
            const after = JSON.parse(read());
            suite.check('the names are written as given: a movie key, a season object, a special object',
                after.content[0].names[0] === COOLER && JSON.stringify(after.content[1].names) === JSON.stringify([S3]) && JSON.stringify(after.content[3].names) === JSON.stringify([SPECIAL]));
            suite.check('clips nobody decided on are as they were, the saved show name too',
                JSON.stringify(after.content[2]) === JSON.stringify(list.content[2]) && JSON.stringify(after.content[4]) === JSON.stringify(list.content[4]));
            suite.check('the season nickname is in the alias file as an object, and reads back',
                JSON.parse(fs.readFileSync(path.join(dir, 'show-aliases.json'), 'utf8')).aliases['frieza saga'].season === 3
                && JSON.stringify((await aliasDB.load())['frieza saga']) === JSON.stringify(S3));
            suite.check('and now names the other clip of the same saga as that season, as a suggestion: its list entry is not touched',
                clipNames.sameName(saved.clips[2].proposal.names[0], S3) && saved.clips[2].names.length === 0 && typeof(after.content[2].names) === 'undefined');
            suite.check('a plain-word alias file written before this reads exactly as it did',
                await (async () => { const d2 = tempDir(); try { fs.writeFileSync(path.join(d2, 'show-aliases.json'), JSON.stringify({ aliases: { sgc2c: 'tv.Space Ghost Coast to Coast', 'frieza saga': { show: DBZ, season: 3 }, odd: { show: DBZ, season: 'x' }, odder: 5 } }));
                    const read2 = await new ShowAliasDB(d2).load(); return Object.keys(read2).join() === 'sgc2c,frieza saga' && read2.sgc2c === 'tv.Space Ghost Coast to Coast'; } finally { removeDir(d2); } })());
            const lines = [];
            const realError = console.error;
            console.error = (...a) => lines.push(a.join(' '));
            try {
                fillerDB.saveFiller('a', JSON.parse(read()));
            } finally {
                console.error = realError;
            }
            suite.check('the list saves without a warning about its new names', lines.length === 0, lines.join(' | '));

            // the route
            const app = express();
            app.use(express.json());
            app.use(api.router({}, channelService, fillerDB, customShowDB, null, null, null, null, null, null, null, null, null, service));
            const server = await new Promise( (resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); } );
            try {
                const call = (method, p, body) => new Promise( (resolve, reject) => {
                    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p, headers: { 'content-type': 'application/json' } }, (res) => {
                        let text = '';
                        res.on('data', (d) => { text += d; });
                        res.on('end', () => resolve({ status: res.statusCode, text }));
                    });
                    req.on('error', reject);
                    req.end(body === undefined ? undefined : JSON.stringify(body));
                } );
                const r = await call('GET', '/api/show-seasons?show=' + encodeURIComponent(DBZ));
                suite.check('GET /api/show-seasons answers with the seasons', r.status === 200 && JSON.parse(r.text).seasons.length >= 1, r.text.slice(0, 100));
                suite.check('and a 404 for a show that is not on a channel, and for none given',
                    (await call('GET', '/api/show-seasons?show=tv.Nope')).status === 404 && (await call('GET', '/api/show-seasons')).status === 404);
                const nick = await call('POST', '/api/filler/a/nickname-check', { text: 'android saga', showKey: DBZ, season: 4, index: 0 });
                suite.check('POST nickname-check takes a season', nick.status === 200 && JSON.parse(nick.text).showName === 'Dragon Ball Z · Season 4', nick.text.slice(0, 120));
            } finally {
                server.close();
            }
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
