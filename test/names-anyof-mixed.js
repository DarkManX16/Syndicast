/*
 * "Any one of" names that hold more than shows. A Wand ID can stand for a star who was in a
 * show and in one particular movie (A.J. Trauth: Even Stevens, or one Disney Channel movie), so
 * { anyOf: [...] } may hold a show, a custom show, a movie, one or several seasons of a show, or a
 * special; never another any-of. It ranks by the member that fits: specific before that exact
 * movie, season or special, show-level before a program of a member that is a show. The shape
 * (src/clip-names.js), the plans it makes (src/transitions.js), the matcher's reading of
 * nicknames for it (src/show-match.js), the picker's logic (src/names-review.js) and the
 * service. See docs/blocks-spec.md, Stage 5, "Which shows a clip names".
 *
 * Fixtures only, with titles from the channels. The service is driven against throwaway
 * folders under the OS temp directory. Names saved before (a show or custom show only) are
 * checked to read and play exactly as they did.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MIN, Suite } = require('./support');
const clipNames = require('../src/clip-names');
const showMatch = require('../src/show-match');
const review = require('../src/names-review');
const transitions = require('../src/transitions');
const FillerDB = require('../src/dao/filler-db');
const ShowAliasDB = require('../src/dao/show-alias-db');
const ShowMatchService = require('../src/services/show-match-service');

const EVEN = 'tv.Even Stevens';
const KIM = 'tv.Kim Possible';
const HANNAH = 'tv.Hannah Montana';
const HT = 'movie.Halloweentown';
const HP = 'movie.Hocus Pocus';
const DCOM = 'custom.dc';
const EVEN_S2 = { show: EVEN, season: 2 };
const EVEN_S1_2 = { show: EVEN, seasons: [1, 2] };
const EVEN_SPECIAL = { show: EVEN, episode: 'Bonus Special' };
const AJ = { anyOf: [EVEN, HT] };
const AJ_NICK = 'aj trauth';

function episode(show, season, n, title) {
    return { title: title || `${show} S${season}E${n}`, type: 'episode', showTitle: show, season, episode: n, duration: 22 * MIN, serverKey: 'srv', ratingKey: `${show}-${season}-${n}` };
}
function movie(title, mins, custom) {
    return Object.assign({ title, type: 'movie', duration: mins * MIN, serverKey: 'srv', ratingKey: `m-${title}` },
        custom ? { customShowId: 'dc', customShowName: 'Friday DCOM Movies', customOrder: 1 } : {});
}
const ev1 = episode('Even Stevens', 1, 1);
const ev2 = episode('Even Stevens', 2, 3);
const evSpecial = episode('Even Stevens', 0, 1, 'Bonus Special');
const km = episode('Kim Possible', 1, 1);
const hm = episode('Hannah Montana', 1, 1);
const ht = movie('Halloweentown', 84, true);          // a movie inside a custom show
const hp = movie('Hocus Pocus', 96, true);
const zenon = movie('Zenon', 90, false);              // a movie on its own
const PREV = episode('Full House', 7, 1);
const PROGRAMS = [ev1, ev2, evSpecial, km, hm, ht, hp, zenon, PREV, { isOffline: true, duration: 5 * MIN }];
const CHANNELS = [ { number: 1, name: 'Disney', programs: PROGRAMS, scheduleBackup: { slots: [] } } ];
const CUSTOM = { dc: 'Friday DCOM Movies' };
const vocab = showMatch.buildVocabulary(CHANNELS, CUSTOM);
const propose = (title, aliases) => showMatch.propose(title, vocab, aliases || {});
const ids = (p) => p.names.map(clipNames.nameId).join(' | ');
const fit = (name, program) => clipNames.fits(name, program, transitions.showKey);

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'syndicast-anyof-mixed-'));
}
function removeDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* left for the OS */ }
}

// ---- plans: the break between programs[0] and programs[2] (programs[1] is the Flex) ----
const step = (id, listId, extra) => Object.assign({ id, kind: 'list', listId, match: 'show', keyedOn: 'next', fallbackListId: null,
    onlyIfNoMatch: null, days: null, chance: null }, extra || {});
const named = (title, names) => Object.assign({ title, key: '/c/' + title, duration: 15000 }, names === undefined ? {} : { names });
function planFor(programs, lists, inn, featured) {
    const channel = {
        number: 1, name: 'T', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0, fillerCollections: [],
        programs, duration: programs.reduce((a, p) => a + p.duration, 0), startTime: new Date(2026, 9, 12, 8, 0, 0).toISOString(),
        dayParts: [ { id: 'dp', name: 'Day', fillerCollections: [], starts: [ { days: [0, 1, 2, 3, 4, 5, 6], time: 0 } ],
            transitions: { betweenShows: { out: [], in: inn || [] } } } ],
    };
    const start = new Date(channel.startTime).getTime() + programs[0].duration;
    return transitions.buildPlan(channel, transitions.findBreak(channel, 1, start), {
        getList: (id) => lists[id] || null, lastPlayed: () => 0, featuresShows: (id) => (featured || []).includes(id),
    });
}
const flexed = (a, b, more) => [a, { isOffline: true, duration: 5 * MIN }, b].concat(more || []);
const says = (plan) => plan.in.map( (s) => s.clip.title ).join(' + ') || '-';

module.exports = async function run() {
    const suite = new Suite('names-anyof-mixed');

    // ---- the shape ---------------------------------------------------------------------
    {
        suite.check('an any-of may hold a show, a custom show, a movie, a season, several seasons or a special',
            [AJ, { anyOf: [EVEN, DCOM] }, { anyOf: [EVEN_S2, HT] }, { anyOf: [EVEN_S1_2, KIM] }, { anyOf: [EVEN_SPECIAL, HP] },
                { anyOf: [HT, HP] }, { anyOf: [EVEN_S2, { show: EVEN, episode: 'Bonus Special' }] }].every(clipNames.validName));
        suite.check('two different parts of one show are allowed; a whole show beside a part of it is not',
            clipNames.validName({ anyOf: [EVEN_S2, EVEN_SPECIAL] }) && ! clipNames.validName({ anyOf: [EVEN, EVEN_S2] })
            && ! clipNames.validName({ anyOf: [EVEN, EVEN_SPECIAL, KIM] }) && ! clipNames.validName({ anyOf: [EVEN_S1_2, EVEN, HT] }));
        suite.check('never another any-of, an audio show, a bare string that is no key, or the same member twice',
            [{ anyOf: [AJ, KIM] }, { anyOf: [EVEN, { anyOf: [KIM, HT] }] }, { anyOf: [EVEN, 'audio.X'] }, { anyOf: [EVEN, 'Kim'] }, { anyOf: [HT, HT] },
                { anyOf: [EVEN_S2, { show: EVEN, season: 2 }] }, { anyOf: [EVEN, { show: 'custom.dc', season: 1 }] }, { anyOf: [EVEN, { show: EVEN, season: -1 }] },
                { anyOf: [HT] }, { anyOf: [] }, { anyOf: [EVEN, null] }].every( (n) => ! clipNames.validName(n) ));
        suite.check('two to eight members: nine of them are too many, eight are not',
            clipNames.validName({ anyOf: ['tv.1', 'tv.2', 'tv.3', 'movie.4', 'movie.5', 'tv.6', 'tv.7', 'custom.8'] })
            && ! clipNames.validName({ anyOf: ['tv.1', 'tv.2', 'tv.3', 'movie.4', 'movie.5', 'tv.6', 'tv.7', 'custom.8', 'movie.9'] }));
        suite.check('names saved before (shows and custom shows only) are valid and have the id they had',
            clipNames.validName({ anyOf: [EVEN, DCOM, 'custom.other'] }) && clipNames.nameId({ anyOf: [KIM, EVEN] }) === `anyOf:${EVEN}|${KIM}`);
        suite.check('the same members in another order are the same name; other members or a different part are not',
            clipNames.sameName(AJ, { anyOf: [HT, EVEN] }) && ! clipNames.sameName(AJ, { anyOf: [EVEN, HP] }) && ! clipNames.sameName(AJ, EVEN)
            && ! clipNames.sameName({ anyOf: [EVEN_S2, HT] }, { anyOf: [EVEN, HT] }) && clipNames.sameName({ anyOf: [EVEN_S1_2, HT] }, { anyOf: [HT, { seasons: [1, 2], show: EVEN }] })
            && ! clipNames.sameName({ anyOf: [EVEN_S2, HT] }, { anyOf: [{ show: EVEN, season: 3 }, HT] }) && ! clipNames.sameName({ anyOf: [EVEN_S2, HT] }, { anyOf: [EVEN_SPECIAL, HT] }));
        suite.check('an any-of is about the show or movie of each member, once',
            clipNames.showsOf(AJ).join() === `${EVEN},${HT}` && clipNames.showsOf({ anyOf: [EVEN_S2, EVEN_SPECIAL, HT] }).join() === `${EVEN},${HT}`
            && clipNames.showsOf({ anyOf: [EVEN_S1_2, KIM] }).join() === `${EVEN},${KIM}`);
        suite.check('anyOfName keeps members in the order given and leaves out repeats and what cannot be a member',
            JSON.stringify(clipNames.anyOfName([HT, EVEN, HT])) === JSON.stringify({ anyOf: [HT, EVEN] })
            && clipNames.anyOfName([EVEN_S2]) !== null && JSON.stringify(clipNames.anyOfName([EVEN_S2])) === JSON.stringify(EVEN_S2)
            && clipNames.anyOfName(['audio.X', { anyOf: [EVEN, KIM] }, null, 5]) === null
            && JSON.stringify(clipNames.anyOfName([EVEN, { anyOf: [KIM, HT] }, HT])) === JSON.stringify({ anyOf: [EVEN, HT] }));
        suite.check('anyOfProblem says why a set is not a name',
            clipNames.anyOfProblem([EVEN, HT]) === null && /twice/.test(clipNames.anyOfProblem([HT, HT])) && /two names/.test(clipNames.anyOfProblem([HT]))
            && /whole show and a part/.test(clipNames.anyOfProblem([EVEN, EVEN_S2])) && /not a show/.test(clipNames.anyOfProblem([EVEN, 'audio.X']))
            && /too many/.test(clipNames.anyOfProblem(['tv.1', 'tv.2', 'tv.3', 'tv.4', 'tv.5', 'tv.6', 'tv.7', 'tv.8', 'tv.9'])));
        const labels = { [EVEN]: 'Even Stevens', [KIM]: 'Kim Possible', [HT]: 'Halloweentown', [DCOM]: 'Friday DCOM Movies' };
        suite.check('it reads as words, a part of a show in brackets so it is not taken for the whole list\'s',
            clipNames.labelOf(AJ, labels) === 'Even Stevens or Halloweentown'
            && clipNames.labelOf({ anyOf: [EVEN_S1_2, KIM, HT] }, labels) === 'Even Stevens (Seasons 1, 2), Kim Possible or Halloweentown'
            && clipNames.labelOf({ anyOf: [EVEN_SPECIAL, EVEN_S2] }, labels) === 'Even Stevens (“Bonus Special”) or Even Stevens (Season 2)'
            && clipNames.labelOf({ anyOf: [EVEN, DCOM] }, labels) === 'Even Stevens or Friday DCOM Movies');
        suite.check('saved on a clip it reads back; one with a nested any-of is unusable and names nothing',
            JSON.stringify(showMatch.namesOf({ names: [AJ] })) === JSON.stringify([AJ]) && showMatch.namesProblem({ names: [AJ] }) === null
            && showMatch.namesOf({ names: [{ anyOf: [EVEN, { anyOf: [KIM, HT] }] }] }).length === 0
            && showMatch.namesProblem({ names: [{ anyOf: [EVEN, { anyOf: [KIM, HT] }] }] }) !== null);
    }

    // ---- how it fits a program -------------------------------------------------------
    {
        suite.check('a show member fits any program of the show, as the show',
            fit(AJ, ev1) === 'show' && fit(AJ, ev2) === 'show' && fit(AJ, evSpecial) === 'show' && fit(AJ, km) === false);
        suite.check('a movie member fits that exact movie, as a specific fit: in a custom show or on its own',
            fit(AJ, ht) === 'specific' && fit(AJ, hp) === false && fit({ anyOf: [EVEN, 'movie.Zenon'] }, zenon) === 'specific' && fit(AJ, zenon) === false);
        suite.check('a season member fits an episode of that season only, as a specific fit; the same members as a show fit all',
            fit({ anyOf: [EVEN_S2, HT] }, ev2) === 'specific' && fit({ anyOf: [EVEN_S2, HT] }, ev1) === false && fit({ anyOf: [EVEN_S2, HT] }, ht) === 'specific'
            && fit({ anyOf: [EVEN_S1_2, KIM] }, ev1) === 'specific' && fit({ anyOf: [EVEN_S1_2, KIM] }, ev2) === 'specific' && fit({ anyOf: [EVEN_S1_2, KIM] }, evSpecial) === false
            && fit({ anyOf: [EVEN_S1_2, KIM] }, km) === 'show');
        suite.check('a special member fits the special of that title only, as a specific fit',
            fit({ anyOf: [EVEN_SPECIAL, KIM] }, evSpecial) === 'specific' && fit({ anyOf: [EVEN_SPECIAL, KIM] }, ev1) === false && fit({ anyOf: [EVEN_SPECIAL, KIM] }, km) === 'show');
        suite.check('a custom show member fits a program of that custom show, a movie in it included, as the show',
            fit({ anyOf: [EVEN, DCOM] }, ht) === 'show' && fit({ anyOf: [EVEN, DCOM] }, hp) === 'show' && fit({ anyOf: [EVEN, DCOM] }, zenon) === false);
        suite.check('it ranks by the member that fits: when two fit, the closer one counts',
            fit({ anyOf: [DCOM, HT] }, ht) === 'specific' && fit({ anyOf: [DCOM, HT] }, hp) === 'show'
            && fit({ anyOf: [EVEN, EVEN_S2] }, ev2) === 'specific' && fit({ anyOf: [EVEN, EVEN_S2] }, ev1) === 'show');
        suite.check('Flex, nothing and a program of another show fit no member',
            fit(AJ, { isOffline: true, duration: MIN }) === false && fit(AJ, null) === false && fit(AJ, hm) === false && fit(AJ, PREV) === false);
        suite.check('an any-of is still not "specific" as a whole; its members decide in fits',
            clipNames.isSpecific(AJ) === false && clipNames.isSpecific({ anyOf: [EVEN_S2, HT] }) === false);
    }

    // ---- what plays --------------------------------------------------------------------
    {
        const lists = { wand: [ named('plain DCOM', [DCOM]), named('A.J. Wand ID', [AJ]), named('plain Even Stevens', [EVEN]), named('generic', []) ] };
        const inStep = [step('s', 'wand')];
        suite.check('before that movie the clip naming it plays, ahead of a clip for the whole custom show (it is the closer fit)',
            says(planFor(flexed(PREV, ht), lists, inStep)) === 'A.J. Wand ID');
        suite.check('before another movie of the custom show the plain custom show clip plays, and the movie\'s clip does not',
            says(planFor(flexed(PREV, hp), lists, inStep)) === 'plain DCOM');
        suite.check('before an Even Stevens episode the show-level clips share their turn, the longest idle first and ties in list order',
            says(planFor(flexed(PREV, ev1), lists, inStep)) === 'A.J. Wand ID');
        suite.check('before another show it does not play', says(planFor(flexed(PREV, km), { wand: [ named('A.J. Wand ID', [AJ]) ] }, inStep)) === '-');
        suite.check('a movie match is a specific match in the plan; a show match is not',
            planFor(flexed(PREV, ht), { wand: [ named('A.J. Wand ID', [AJ]) ] }, inStep).in[0].specific === true
            && planFor(flexed(PREV, ev1), { wand: [ named('A.J. Wand ID', [AJ]) ] }, inStep).in[0].specific !== true);
        const seasonal = { wand: [ named('show-wide', [EVEN]), named('season 2 or Hocus Pocus', [{ anyOf: [EVEN_S2, HP] }]) ] };
        suite.check('a season member beats a clip for the show before that season, and before another season the clip for the show plays',
            says(planFor(flexed(PREV, ev2), seasonal, inStep)) === 'season 2 or Hocus Pocus' && says(planFor(flexed(PREV, ev1), seasonal, inStep)) === 'show-wide'
            && says(planFor(flexed(PREV, hp), seasonal, inStep)) === 'season 2 or Hocus Pocus');
        suite.check('the fallback list is tried for a closer fit first: its movie clip beats the step list\'s plain clip',
            says(planFor(flexed(PREV, ht), { main: [ named('plain DCOM', [DCOM]) ], back: [ named('A.J. Wand ID', [AJ]) ] }, [step('s', 'main', { fallbackListId: 'back' })])) === 'A.J. Wand ID');
        suite.check('in a list whose clips feature shows it counts as naming what is coming up, ahead of any clip',
            says(planFor(flexed(PREV, ht), { f: [ named('other', [KIM]), named('A.J. Wand ID', [AJ]) ] }, [step('s', 'f')], ['f'])) === 'A.J. Wand ID');
        suite.check('with a name of several places it is one place that either can fill: movie then show, in order',
            says(planFor(flexed(PREV, ht, [km]), { l: [ named('A.J. then Kim', [AJ, KIM]) ] }, [step('s', 'l')])) === 'A.J. then Kim'
            && says(planFor(flexed(PREV, ev1, [km]), { l: [ named('A.J. then Kim', [AJ, KIM]) ] }, [step('s', 'l')])) === 'A.J. then Kim'
            && says(planFor(flexed(PREV, hp, [km]), { l: [ named('A.J. then Kim', [AJ, KIM]) ] }, [step('s', 'l')])) === '-');
        suite.check('an any-of saved before (two shows) plays exactly as it did',
            says(planFor(flexed(PREV, km), { l: [ named('CCR', [{ anyOf: [EVEN, KIM] }]) ] }, [step('s', 'l')])) === 'CCR'
            && says(planFor(flexed(PREV, hm), { l: [ named('CCR', [{ anyOf: [EVEN, KIM] }]) ] }, [step('s', 'l')])) === '-');
    }

    // ---- the matcher: nicknames that mean a mixed set ------------------------------------
    {
        const aliases = { [AJ_NICK]: AJ };
        suite.check('the vocabulary has the movie, inside its custom show', vocab.movies.some( (m) => m.key === HT && m.custom === 'Friday DCOM Movies' )
            && typeof(vocab.names[HT]) === 'string');
        suite.check('a nickname for a show or a movie reads as the any-of, from the words of a title',
            ids(propose('Wand ID - AJ Trauth', aliases)) === clipNames.nameId(AJ) && JSON.stringify(propose('Wand ID - AJ Trauth', aliases).names[0]) === JSON.stringify(AJ));
        suite.check('a season member works the same', ids(propose('Wand ID - AJ Trauth', { [AJ_NICK]: { anyOf: [EVEN_S2, HT] } })) === clipNames.nameId({ anyOf: [EVEN_S2, HT] }));
        suite.check('without the nickname the same title names nothing', propose('Wand ID - AJ Trauth').names.length === 0);
        const own = { 'even stevens aj': { anyOf: [EVEN_S2, HT] } };
        suite.check('a nickname that holds the title of one of its members (also a season member) is found in the whole title first',
            ids(propose('Even Stevens AJ Promo', own)) === clipNames.nameId({ anyOf: [EVEN_S2, HT] }) && ids(propose('Even Stevens Promo', own)) === EVEN, ids(propose('Even Stevens AJ Promo', own)));
        suite.check('a show the title names itself beats an any-of that includes it, also through a season member',
            ids(propose('AJ Trauth Even Stevens Promo', aliases)) === EVEN && ids(propose('AJ Trauth Even Stevens Promo', { [AJ_NICK]: { anyOf: [EVEN_S2, HT] } })) === EVEN);
        suite.check('and a movie the title names itself beats an any-of that includes it (a movie on its own is named by its title)',
            ids(propose('AJ Trauth Zenon Promo', { [AJ_NICK]: { anyOf: [EVEN, 'movie.Zenon'] } })) === 'movie.Zenon');
        suite.check('an any-of nickname that is not in the stored shape is dropped by the matcher, not read',
            propose('Wand ID - AJ Trauth', { [AJ_NICK]: { anyOf: [EVEN, { anyOf: [KIM, HT] }] } }).names.length === 0);
        const clips = [
            { list: 'a', index: 0, title: 'Wand ID - AJ Trauth', names: [], reviewed: false },
            { list: 'a', index: 1, title: 'Wand ID - AJ Trauth (Short)', names: [], reviewed: false },
            { list: 'b', index: 0, title: 'AJ Trauth Kim Possible Spoof', names: [KIM], reviewed: false },
        ];
        const ok = showMatch.checkNickname('AJ Trauth', { anyOf: [EVEN, HT] }, vocab, {}, clips.slice(0, 2), { sourceTitle: clips[0].title });
        suite.check('a nickname for a show or a movie is accepted and names the clip it is taught from',
            ok.ok === true && ok.sourceNames.map(clipNames.nameId).join() === clipNames.nameId(AJ) && ok.newly.length === 2, JSON.stringify(ok));
        const other = showMatch.checkNickname('AJ Trauth', { anyOf: [EVEN, HT] }, vocab, {}, clips, { sourceTitle: clips[0].title });
        suite.check('a clip saved under a show that is none of the members blocks it, as before', other.ok === false && other.problems.length > 0);
        const mine = showMatch.checkNickname('AJ Trauth', { anyOf: [EVEN, HT] }, vocab, {}, clips.slice(0, 2).concat([{ list: 'b', index: 1, title: 'AJ Trauth Spoof', names: [HT], reviewed: false }]), { sourceTitle: clips[0].title });
        suite.check('and one saved under one of the members (a movie) does not', mine.ok === true, JSON.stringify(mine.problems));
        const gone = showMatch.checkNickname('AJ Trauth', { anyOf: [EVEN, 'movie.Not On Any Channel'] }, vocab, {}, [], {});
        suite.check('a member that is no show or movie on a channel is refused', gone.ok === false && gone.problems.some( (p) => /Pick the show/.test(p) ));
        const offered = showMatch.nicknameSuggestions('Wand ID - AJ Trauth', { anyOf: [EVEN, HT] }, vocab, {}, []);
        suite.check('teaching from the title offers the words of it, as it does for a nickname for shows', offered.some( (o) => o.alias === 'trauth' ), JSON.stringify(offered));
    }

    // ---- the picker's logic --------------------------------------------------------------
    {
        const s = review.slotOfName({ anyOf: [EVEN_S1_2, HT, KIM] });
        suite.check('a slot reads a mixed any-of: each member is a slot of its own with its seasons, movie or special',
            s.any === true && s.members.length === 3 && s.members[0].key === EVEN && s.members[0].kind === 'seasons' && review.pickedSeasons(s.members[0]).join() === '1,2'
            && s.members[1].key === HT && s.members[1].kind === 'all' && s.members[2].key === KIM);
        suite.check('and writes it back the same', clipNames.sameName(review.slotName(s), { anyOf: [EVEN_S1_2, HT, KIM] }) && review.slotProblem(s) === null);
        const sp = review.slotOfName({ anyOf: [EVEN_SPECIAL, HT] });
        suite.check('a special member keeps its title', sp.members[0].kind === 'special' && sp.members[0].special === 'Bonus Special' && clipNames.sameName(review.slotName(sp), { anyOf: [EVEN_SPECIAL, HT] }));
        const mk = (members) => Object.assign(review.emptySlot(), { any: true, members });
        const m = (key, extra) => Object.assign(review.emptySlot(), { key }, extra || {});
        suite.check('a member with seasons but none ticked is that member\'s problem; so is a special not picked',
            review.slotProblem(mk([m(EVEN, { kind: 'seasons' }), m(HT)])) === 'no season is ticked' && review.slotProblem(mk([m(EVEN, { kind: 'special' }), m(HT)])) === 'no special is picked');
        suite.check('a blank member is a problem, not a name', review.slotProblem(mk([m(EVEN), m(null)])) === 'a show has not been picked' && review.slotName(mk([m(EVEN), m(null)])) === null);
        suite.check('the same movie twice, one member, and a whole show with a part of it are problems',
            review.slotProblem(mk([m(HT), m(HT)])) === 'the same name is picked twice in an any-of' && review.slotProblem(mk([m(HT)])) === 'an any-of needs two names'
            && /whole show and a part/.test(review.slotProblem(mk([m(EVEN), m(EVEN, { kind: 'seasons', picked: { 2: true } })]))));
        suite.check('but a whole show and a different show\'s part are a name, in the order picked',
            JSON.stringify(review.slotName(mk([m(HT), m(EVEN, { kind: 'seasons', picked: { 2: true } }), m(KIM)]))) === JSON.stringify({ anyOf: [HT, EVEN_S2, KIM] }));
        const nested = review.emptySlot();
        nested.any = true;
        nested.members = [m(EVEN), mk([m(KIM), m(HT)])];
        suite.check('a member cannot itself be an any-of', review.slotProblem(nested) === 'an any-of cannot hold another any-of' && review.slotName(nested) === null);
        suite.check('a member that is only { key } (an older caller) is a whole show or a movie',
            clipNames.sameName(review.slotName(Object.assign(review.emptySlot(), { any: true, members: [ { key: EVEN }, { key: HT } ] })), AJ));
        suite.check('a nickname target can be a mixed any-of, and one name is just that name',
            JSON.stringify(review.nicknameTarget({ anyOf: [EVEN, HT] })) === JSON.stringify(AJ) && JSON.stringify(review.nicknameTarget({ anyOf: [EVEN_S2, HT] })) === JSON.stringify({ anyOf: [EVEN_S2, HT] })
            && JSON.stringify(review.nicknameTarget({ anyOf: [EVEN_S2] })) === JSON.stringify(EVEN_S2) && review.nicknameTarget({ anyOf: [] }) === null);
        suite.check('picks with a mixed any-of clean and check like any others',
            review.cleanPicks([AJ, AJ, { anyOf: [HT, EVEN] }, KIM]).length === 2 && review.picksProblem([AJ, KIM]) === null
            && review.picksProblem([{ anyOf: [EVEN, { anyOf: [KIM, HT] }] }]) === 'a show has not been picked');
    }

    // ---- the alias file, the service and the review save, against real files ------------------
    {
        const dir = tempDir();
        const fillerDir = path.join(dir, 'filler');
        fs.mkdirSync(fillerDir);
        try {
            const list = { name: 'Disney Wand IDs', mode: 'custom', rank: 0, clipsFeatureShows: true, content: [
                { title: 'Wand ID - AJ Trauth', duration: 10000, key: '/1', serverKey: 'srv' },
                { title: 'Wand ID - AJ Trauth (Short)', duration: 10000, key: '/2', serverKey: 'srv' },
                { title: 'Kim Possible Promo', duration: 10000, key: '/3', serverKey: 'srv', names: [KIM] },
                { title: 'Old Wand ID', duration: 10000, key: '/4', serverKey: 'srv', names: [{ anyOf: [EVEN, DCOM] }] },
            ] };
            fs.writeFileSync(path.join(fillerDir, 'a.json'), JSON.stringify(list));
            const read = () => fs.readFileSync(path.join(fillerDir, 'a.json'), 'utf8');
            const fillerDB = new FillerDB(fillerDir);
            const aliasDB = new ShowAliasDB(dir);
            const channelService = { getAllChannelNumbers: async () => [1], getChannel: async () => CHANNELS[0] };
            const customShowDB = { getAllShowsInfo: async () => [ { id: 'dc', name: 'Friday DCOM Movies' } ],
                getAllShows: async () => [ { id: 'dc', name: 'Friday DCOM Movies', content: [] } ] };
            const service = new ShowMatchService(fillerDB, channelService, customShowDB, aliasDB);

            fs.writeFileSync(path.join(dir, 'show-aliases.json'), JSON.stringify({ aliases: {
                [AJ_NICK]: AJ, season: { anyOf: [EVEN_S1_2, HT] }, old: { anyOf: [EVEN, DCOM] }, nested: { anyOf: [EVEN, { anyOf: [KIM, HT] }] }, audio: { anyOf: [EVEN, 'audio.X'] } } }));
            const loaded = await aliasDB.load();
            suite.check('the alias file reads a mixed any-of nickname and the ones saved before, and drops one that is not in the stored shape',
                Object.keys(loaded).sort().join() === `${AJ_NICK},old,season` && JSON.stringify(loaded[AJ_NICK]) === JSON.stringify(AJ)
                && JSON.stringify(loaded.season) === JSON.stringify({ anyOf: [EVEN_S1_2, HT] }));
            fs.unlinkSync(path.join(dir, 'show-aliases.json'));

            const check = await service.checkNickname('a', AJ_NICK, undefined, 0, undefined, undefined, [EVEN, HT]);
            suite.check('the service checks a nickname for a show or a movie and answers in words',
                check.ok === true && check.showName === 'Even Stevens or Halloweentown' && check.sourceShows.join() === 'Even Stevens or Halloweentown', JSON.stringify(check));
            const seasonal = await service.checkNickname('a', AJ_NICK, undefined, 0, undefined, undefined, [EVEN_S2, HT]);
            suite.check('and for a season of one and a movie, naming the season in brackets', seasonal.ok === true && seasonal.showName === 'Even Stevens (Season 2) or Halloweentown', JSON.stringify(seasonal));
            const offers = await service.nicknameSuggestions('a', 0, undefined, undefined, undefined, [EVEN, HT]);
            suite.check('and offers the words of the title', offers.some( (o) => o.alias === 'trauth' ), JSON.stringify(offers));
            const before = read();
            suite.check('checking and suggesting wrote nothing', read() === before && ! fs.existsSync(path.join(dir, 'show-aliases.json')));

            const refuse = async (body) => { try { await service.saveNames('a', body); return null; } catch (err) { return err; } };
            const refusals = await Promise.all([
                { clips: [{ index: 0, title: list.content[0].title, names: [{ anyOf: [EVEN, { anyOf: [KIM, HT] }] }] }], aliases: {} },
                { clips: [{ index: 0, title: list.content[0].title, names: [{ anyOf: [EVEN, EVEN_S2] }] }], aliases: {} },
                { clips: [{ index: 0, title: list.content[0].title, names: [{ anyOf: [EVEN, 'movie.Not On Any Channel'] }] }], aliases: {} },
                { clips: [], aliases: { [AJ_NICK]: { anyOf: [EVEN, EVEN_S2] } } },
                { clips: [], aliases: { [AJ_NICK]: { anyOf: [EVEN, 'movie.Not On Any Channel'] } } },
            ].map(refuse));
            suite.check('a nested any-of, a whole show with a part of it, and a movie no channel has are refused, as a name or a nickname',
                refusals.every( (e) => e instanceof ShowMatchService.ReviewError ), refusals.map( (e) => e && e.message ).join(' | '));
            suite.check('and a refused save wrote nothing', read() === before && ! fs.existsSync(path.join(dir, 'show-aliases.json')));

            const saved = await service.saveNames('a', {
                clips: [ { index: 0, title: list.content[0].title, names: [AJ] } ],
                aliases: { [AJ_NICK]: AJ },
            });
            const after = JSON.parse(read());
            suite.check('the clip is saved with the mixed any-of; the others are as they were (the old any-of too)',
                JSON.stringify(after.content[0].names) === JSON.stringify([AJ]) && JSON.stringify(after.content.slice(1)) === JSON.stringify(list.content.slice(1)));
            suite.check('the nickname is in the alias file and reads back', JSON.stringify((await aliasDB.load())[AJ_NICK]) === JSON.stringify(AJ));
            suite.check('the other clip with the words is now suggested as the any-of; its list entry is not touched',
                clipNames.sameName(saved.clips[1].proposal.names[0], AJ) && saved.clips[1].names.length === 0);
            suite.check('every show and movie of the any-of has a display name for the screen',
                saved.showNames[EVEN] === 'Even Stevens' && saved.showNames[HT] === 'Halloweentown' && saved.showNames[DCOM] === 'Friday DCOM Movies');
            const page = await service.nicknames();
            suite.check('the Nicknames page lists it in words, with the movies for its pickers (marked, and not as shows)',
                page.nicknames.some( (n) => n.alias === AJ_NICK && n.kind === 'anyOf' && n.label === 'Even Stevens or Halloweentown' && n.missing === false)
                && page.shows.some( (s) => s.key === HT && s.movie === true && s.inCustomShow === 'Friday DCOM Movies' && s.group === 'Movies' )
                && page.shows.filter( (s) => s.movie !== true ).every( (s) => /^(tv|custom)\./.test(s.key) ) && page.showNames[HT] === 'Halloweentown');
            const preview = await service.previewNickname({ alias: AJ_NICK, anyOf: [EVEN_S2, HP] });
            suite.check('editing it to a season and another movie previews fine and writes nothing',
                preview.ok === true && JSON.parse(read()).content[0].names.length === 1 && JSON.stringify((await aliasDB.load())[AJ_NICK]) === JSON.stringify(AJ),
                JSON.stringify(preview.problems));
            const edited = await service.saveNickname({ alias: AJ_NICK, anyOf: [EVEN_S2, HP] });
            suite.check('and saves: the clip\'s saved name is not rewritten',
                JSON.stringify((await aliasDB.load())[AJ_NICK]) === JSON.stringify({ anyOf: [EVEN_S2, HP] }) && JSON.stringify(JSON.parse(read()).content[0].names) === JSON.stringify([AJ])
                && edited.nicknames.some( (n) => n.alias === AJ_NICK && n.label === 'Even Stevens (Season 2) or Hocus Pocus' ));
            const lines = [];
            const realError = console.error;
            console.error = (...a) => lines.push(a.join(' '));
            try {
                fillerDB.saveFiller('a', JSON.parse(read()));
            } finally {
                console.error = realError;
            }
            suite.check('the list saves without a warning about its names', lines.length === 0, lines.join(' | '));
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
