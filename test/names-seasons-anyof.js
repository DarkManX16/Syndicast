/*
 * Several seasons in one name, and "any one of" several shows. A clip can name
 * { show, seasons: [3, 4, 5] } (Justice League Unlimited is seasons 3 to 5 of Justice
 * League in the user's Plex) and { anyOf: [show, show] } (an actor's Wand ID that stands
 * for either of two shows). The shapes (src/clip-names.js), the matcher's reading of them
 * and of nicknames for them (src/show-match.js), the plans they make (src/transitions.js),
 * the picker's logic (src/names-review.js), the alias file and the review save. See
 * docs/blocks-spec.md, Stage 5, "Which shows a clip names".
 *
 * Fixtures only, with the real titles from the channels. The save is driven against
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
const FillerDB = require('../src/dao/filler-db');
const ShowAliasDB = require('../src/dao/show-alias-db');
const ShowMatchService = require('../src/services/show-match-service');

const JL = 'tv.Justice League';
const BATMAN = 'tv.Batman Beyond';
const JLU_SEASONS = { show: JL, seasons: [3, 4, 5] };
const JLU = 'justice league unlimited';
const EVEN = 'tv.Even Stevens';
const KIM = 'tv.Kim Possible';
const HANNAH = 'tv.Hannah Montana';
const CCR = { anyOf: [EVEN, KIM] };
const CCR_NICK = 'christy carlson romano';

function episode(show, season, n, mins) {
    return { title: `${show} S${season}E${n}`, type: 'episode', showTitle: show, season, episode: n, duration: (mins || 22) * MIN, serverKey: 'srv', ratingKey: `${show}-${season}-${n}` };
}
const PROGRAMS = [
    episode('Justice League', 1, 1), episode('Justice League', 2, 1), episode('Justice League', 3, 1), episode('Justice League', 4, 1),
    episode('Justice League', 5, 1), episode('Batman Beyond', 1, 1), episode('Full House', 7, 1),
    episode('Even Stevens', 1, 1), episode('Kim Possible', 1, 1), episode('Hannah Montana', 1, 1), episode('Lizzie McGuire', 1, 1),
    { isOffline: true, duration: 5 * MIN },
];
const customEpisode = Object.assign(episode('Halloweentown', 1, 1), { customShowId: 'dc', customShowName: 'Friday DCOM Movies', customOrder: 1 });
PROGRAMS.push(customEpisode);
const CHANNELS = [ { number: 1, name: 'Toonami', programs: PROGRAMS, scheduleBackup: { slots: [] } } ];
const CUSTOM = { dc: 'Friday DCOM Movies' };
const vocab = showMatch.buildVocabulary(CHANNELS, CUSTOM);
const propose = (title, aliases) => showMatch.propose(title, vocab, aliases || {});
const ids = (p) => p.names.map(clipNames.nameId).join(' | ');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'syndicast-seasons-anyof-'));
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
function planFor(programs, lists, out, inn, featured) {
    const channel = {
        number: 1, name: 'T', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0, fillerCollections: [],
        programs, duration: programs.reduce((a, p) => a + p.duration, 0), startTime: new Date(2026, 9, 12, 8, 0, 0).toISOString(),
        dayParts: [ { id: 'dp', name: 'Day', fillerCollections: [], starts: [ { days: [0, 1, 2, 3, 4, 5, 6], time: 0 } ],
            transitions: { betweenShows: { out: out || [], in: inn || [] } } } ],
    };
    const start = new Date(channel.startTime).getTime() + programs[0].duration;
    return transitions.buildPlan(channel, transitions.findBreak(channel, 1, start), {
        getList: (id) => lists[id] || null, lastPlayed: () => 0, featuresShows: (id) => (featured || []).includes(id),
    });
}
const flexed = (a, b, more) => [a, { isOffline: true, duration: 5 * MIN }, b].concat(more || []);
const says = (plan) => ['out', 'in'].map( (side) => plan[side].map( (s) => s.clip.title ).join(' + ') || '-' ).join(' / ');
const PREV = episode('Full House', 7, 1);
const jl = (season) => episode('Justice League', season, 1);

module.exports = async function run() {
    const suite = new Suite('names-seasons-anyof');

    // ---- several seasons: the shape --------------------------------------------------
    {
        suite.check('a show, a season and several seasons are names',
            [JL, { show: JL, season: 3 }, JLU_SEASONS, { show: JL, seasons: [0, 3] }, { show: JL, seasons: [1, 2] }].every(clipNames.validName));
        suite.check('several seasons are two or more, whole, ascending and without repeats, of a tv show',
            [{ show: JL, seasons: [3] }, { show: JL, seasons: [] }, { show: JL, seasons: [5, 3] }, { show: JL, seasons: [3, 3] }, { show: JL, seasons: [3, 4.5] },
                { show: JL, seasons: [-1, 3] }, { show: JL, seasons: ['3', '4'] }, { show: JL, seasons: 3 }, { show: JL, seasons: [3, 4], season: 3 },
                { show: JL, seasons: [3, 4], extra: 1 }, { show: 'custom.c1', seasons: [1, 2] }, { show: 'movie.X', seasons: [1, 2] }, { seasons: [1, 2] }].every( (n) => ! clipNames.validName(n) ));
        suite.check('equal sets have one id, different sets differ, and it is not a season or the show',
            clipNames.sameName(JLU_SEASONS, { seasons: [3, 4, 5], show: JL }) && ! clipNames.sameName(JLU_SEASONS, { show: JL, seasons: [3, 4] })
            && ! clipNames.sameName(JLU_SEASONS, { show: JL, season: 3 }) && ! clipNames.sameName(JLU_SEASONS, JL));
        suite.check('the show of several seasons is their show, and they are specific',
            clipNames.showOf(JLU_SEASONS) === JL && clipNames.isSpecific(JLU_SEASONS));
        suite.check('seasonsName gives the one stored shape: the show, one season, or sorted seasons',
            clipNames.seasonsName(JL, []) === JL && JSON.stringify(clipNames.seasonsName(JL, [4])) === JSON.stringify({ show: JL, season: 4 })
            && JSON.stringify(clipNames.seasonsName(JL, [5, 3, 4, 3])) === JSON.stringify(JLU_SEASONS) && clipNames.seasonsName(JL, ['x', 2.5]) === JL);
        suite.check('seasonsOf reads the seasons of a season or seasons name, and nothing else',
            clipNames.seasonsOf(JLU_SEASONS).join() === '3,4,5' && clipNames.seasonsOf({ show: JL, season: 2 }).join() === '2'
            && clipNames.seasonsOf(JL).length === 0 && clipNames.seasonsOf({ show: JL, episode: 'x' }).length === 0);
        const labels = { [JL]: 'Justice League' };
        suite.check('several seasons read as words: a range, a list, specials first',
            clipNames.labelOf(JLU_SEASONS, labels) === 'Justice League · Seasons 3–5' && clipNames.labelOf({ show: JL, seasons: [3, 5] }, labels) === 'Justice League · Seasons 3, 5'
            && clipNames.labelOf({ show: JL, seasons: [1, 2] }, labels) === 'Justice League · Seasons 1, 2'
            && clipNames.labelOf({ show: JL, seasons: [0, 3, 4, 5, 7, 8, 9] }, labels) === 'Justice League · Specials, Seasons 3–5, 7–9'
            && clipNames.labelOf({ show: JL, seasons: [0, 2] }, labels) === 'Justice League · Specials, Season 2');
        const fit = (name, program) => clipNames.fits(name, program, transitions.showKey);
        suite.check('several seasons fit an episode of any of them, as a specific fit, and no other season, show or Flex',
            [3, 4, 5].every( (n) => fit(JLU_SEASONS, jl(n)) === 'specific') && [1, 2].every( (n) => fit(JLU_SEASONS, jl(n)) === false)
            && fit(JLU_SEASONS, episode('Batman Beyond', 3, 1)) === false && fit(JLU_SEASONS, { isOffline: true }) === false && fit(JLU_SEASONS, null) === false);
        suite.check('a show key still fits every season, as the show, and one season still fits only itself',
            fit(JL, jl(4)) === 'show' && fit({ show: JL, season: 4 }, jl(4)) === 'specific' && fit({ show: JL, season: 4 }, jl(3)) === false);
        suite.check('a clip with several seasons saved reads back as it was, and an unsorted one is unusable (names nothing)',
            JSON.stringify(showMatch.namesOf({ names: [JLU_SEASONS] })) === JSON.stringify([JLU_SEASONS])
            && showMatch.namesOf({ names: [{ show: JL, seasons: [5, 3] }] }).length === 0 && showMatch.namesProblem({ names: [{ show: JL, seasons: [5, 3] }] }) !== null
            && showMatch.namesProblem({ names: [JLU_SEASONS] }) === null);
    }

    // ---- several seasons: the matcher -------------------------------------------------
    {
        const aliases = { [JLU]: JLU_SEASONS };
        const title = 'Toonami - Justice League Unlimited Short Intro (4K HD)';
        suite.check('without the nickname the title reads as the whole show, as it always did',
            ids(propose(title)) === JL);
        const got = propose(title, aliases);
        suite.check('"justice league unlimited" names seasons 3 to 5, though the phrase holds the show\'s own title',
            ids(got) === `${JL}#seasons:3,4,5` && got.found.some( (h) => h.via === 'alias' && h.text === JLU ), JSON.stringify(got));
        suite.check('and the title is not read a second time as the whole show',
            got.names.length === 1 && got.found.length === 1);
        suite.check('a title with the show but not the nickname is still the whole show',
            ids(propose('Justice League Promo (1)', aliases)) === JL && ids(propose('Justice League NEXT Promo [2003]', aliases)) === JL);
        suite.check('the nickname works in capitals, with punctuation and at either end of the title',
            ids(propose('JUSTICE LEAGUE: UNLIMITED promo', aliases)) === `${JL}#seasons:3,4,5` && ids(propose('Promo - Justice League Unlimited', aliases)) === `${JL}#seasons:3,4,5`);
        suite.check('"justice league unlimited" inside a longer title with another show is one name of the pair',
            ids(propose('Justice League Unlimited to Batman Beyond', aliases)) === `${JL}#seasons:3,4,5 | ${BATMAN}`, ids(propose('Justice League Unlimited to Batman Beyond', aliases)));
        // the old single word, taught before phrases like this could be: still works, the phrase wins where both appear
        const both = { unlimited: { show: JL, season: 3 }, [JLU]: JLU_SEASONS };
        suite.check('an older one-word season nickname still narrows the show, and the longer phrase wins where both are in a title',
            ids(propose('Justice League Unlimited Promo', { unlimited: { show: JL, season: 3 } })) === `${JL}#season:3`
            && ids(propose('Justice League Unlimited Promo', both)) === `${JL}#seasons:3,4,5`);
        suite.check('a nickname for several seasons narrows the hit of its show in the same title when its words are not the show\'s',
            ids(propose('Justice League Unlimited Promo', { unlimited: JLU_SEASONS })) === `${JL}#seasons:3,4,5`
            && ids(propose('Unlimited Power', { unlimited: JLU_SEASONS })) === `${JL}#seasons:3,4,5`);
        suite.check('a nickname that does not hold its show\'s title reads as before (a single season, a show)',
            ids(propose('DBZ Frieza Saga Intro', { 'frieza saga': { show: JL, season: 2 } })) === `${JL}#season:2`
            && ids(propose('Batman Beyond Promo', { 'frieza saga': { show: JL, season: 2 } })) === BATMAN);
        suite.check('the same set of nicknames with and without several-season ones gives the same names for titles that do not use them',
            ['Batman Beyond Promo', 'Full House ID', 'Justice League Promo (1)', 'Unlimited anything', 'Justice League to Batman Beyond'].every( (t) =>
                ids(propose(t, { zzz: JLU_SEASONS })) === ids(propose(t))));
        // the offers: the show's own title with its neighbour
        const offers = showMatch.nicknameSuggestions(title, JLU_SEASONS, vocab, {}, []);
        suite.check('teaching from the title offers "justice league unlimited" first', offers.length > 0 && offers[0].alias === JLU && offers[0].text === 'Justice League Unlimited', JSON.stringify(offers));
        suite.check('and offers nothing like it for the whole show (its title already names it)',
            showMatch.nicknameSuggestions(title, JL, vocab, {}, []).every( (o) => o.alias !== JLU ));
    }

    // ---- several seasons: nickname checks --------------------------------------------
    {
        const clips = [
            { list: 'a', index: 0, title: 'Toonami - Justice League Unlimited Short Intro (4K HD)', names: [], reviewed: false },
            { list: 'a', index: 1, title: 'Justice League Unlimited Promo', names: [], reviewed: false },
            { list: 'a', index: 2, title: 'Justice League Unlimited Promo [2005]', names: [], reviewed: true },
            { list: 'b', index: 0, title: 'Justice League Unlimited Wrap', names: ['tv.Full House'], reviewed: false },
            { list: 'b', index: 1, title: 'Justice League Promo', names: [], reviewed: false },
        ];
        const check = showMatch.checkNickname('Justice League Unlimited', JLU_SEASONS, vocab, {}, clips, { sourceTitle: clips[0].title });
        suite.check('a nickname for several seasons that holds the show\'s title is accepted when the clip it is taught from is read by it',
            check.problems.length === 1 && /Other shows' clips use/.test(check.problems[0]) === true, JSON.stringify(check.problems));
        const clean = showMatch.checkNickname('Justice League Unlimited', JLU_SEASONS, vocab, {}, clips.filter( (c) => c.list === 'a' ), { sourceTitle: clips[0].title });
        suite.check('without a clip saved under another show it is ok, names the source as the seasons, and counts the unsaved clip it newly names (not a reviewed one)',
            clean.ok === true && clean.sourceNames.map(clipNames.nameId).join() === `${JL}#seasons:3,4,5` && clean.newly.length === 2 && clean.changed.length === 0, JSON.stringify(clean));
        suite.check('a clip that already suggests the show and is narrowed to the seasons is counted as newly named, not as another show\'s',
            clean.newly.some( (c) => c.index === 1 ) && clean.newly.find( (c) => c.index === 1 ).names.map(clipNames.nameId).join() === `${JL}#seasons:3,4,5`);
        const dup = showMatch.checkNickname('Justice League Unlimited', JLU_SEASONS, vocab, { [JLU]: JLU_SEASONS }, [], {});
        suite.check('the same phrase twice is refused, saying so', dup.ok === false && /already a nickname for this show/.test(dup.problems.join(' ')), dup.problems.join(' | '));
        const taken = showMatch.checkNickname('Justice League Unlimited', JLU_SEASONS, vocab, { [JLU]: { show: JL, season: 3 } }, [], {});
        suite.check('and refused when it already means another set', taken.ok === false && /already means/.test(taken.problems.join(' ')), taken.problems.join(' | '));
        const bad = showMatch.checkNickname('Unlimited', { show: JL, seasons: [5, 3] }, vocab, {}, [], {});
        suite.check('a set that is not in the stored shape is not a target', bad.ok === false && bad.problems.some( (p) => /Pick the show/.test(p) ));
    }

    // ---- several seasons: what plays --------------------------------------------------
    {
        const lists = { intros: [ named('JLU intro', [JLU_SEASONS]), named('JL intro', [JL]), named('Batman intro', [BATMAN]), named('generic', []) ] };
        const inStep = [step('s', 'intros')];
        suite.check('before an episode of season 3, 4 or 5 the several-seasons clip plays, ahead of the clip for the whole show',
            [3, 4, 5].every( (n) => says(planFor(flexed(PREV, jl(n)), lists, [], inStep)) === '- / JLU intro' ));
        suite.check('before season 1 or 2 it does not: the clip for the show plays',
            [1, 2].every( (n) => says(planFor(flexed(PREV, jl(n)), lists, [], inStep)) === '- / JL intro' ));
        const only = { intros: [ named('JLU intro', [JLU_SEASONS]) ] };
        suite.check('on its own it plays before seasons 3 to 5 and before nothing else',
            [3, 4, 5].every( (n) => says(planFor(flexed(PREV, jl(n)), only, [], inStep)) === '- / JLU intro' )
            && [1, 2].every( (n) => says(planFor(flexed(PREV, jl(n)), only, [], inStep)) === '- / -' )
            && says(planFor(flexed(PREV, episode('Batman Beyond', 3, 1)), only, [], inStep)) === '- / -');
        suite.check('it is a specific match in the plan', planFor(flexed(PREV, jl(4)), only, [], inStep).in[0].specific === true);
        suite.check('in a list whose clips feature shows it counts as naming the show coming up, ahead of any clip',
            says(planFor(flexed(PREV, jl(4)), { f: [ named('other show', [BATMAN]), named('JLU intro', [JLU_SEASONS]) ] }, [], [step('s', 'f')], ['f'])) === '- / JLU intro');
        suite.check('a clip of several seasons is one name of several: it fits the show coming up first, and the next show second',
            says(planFor(flexed(PREV, jl(5), [episode('Batman Beyond', 1, 1)]), { l: [ named('JLU then Batman', [JLU_SEASONS, BATMAN]) ] }, [], [step('s', 'l')])) === '- / JLU then Batman'
            && says(planFor(flexed(PREV, jl(2), [episode('Batman Beyond', 1, 1)]), { l: [ named('JLU then Batman', [JLU_SEASONS, BATMAN]) ] }, [], [step('s', 'l')])) === '- / -');
    }

    // ---- the picker's logic -----------------------------------------------------------
    {
        const slot = (name) => review.slotOfName(name);
        suite.check('a slot reads a show, a season, several seasons and a special from a stored name',
            slot(JL).kind === 'all' && slot(JL).key === JL && slot({ show: JL, season: 3 }).kind === 'seasons' && review.pickedSeasons(slot({ show: JL, season: 3 })).join() === '3'
            && review.pickedSeasons(slot(JLU_SEASONS)).join() === '3,4,5' && slot({ show: JL, episode: 'x' }).kind === 'special' && slot({ show: JL, episode: 'x' }).special === 'x');
        suite.check('and writes the stored name back: the same for each shape, one season in the old shape',
            [JL, 'movie.X: Y', { show: JL, season: 3 }, JLU_SEASONS, { show: JL, episode: 'x' }].every( (n) => clipNames.sameName(review.slotName(slot(n)), n) ));
        const s = review.emptySlot();
        s.key = JL; s.kind = 'seasons'; s.picked = { 5: true, 3: true, 4: false };
        suite.check('ticked seasons make a sorted name; an unticked one is left out',
            JSON.stringify(review.slotName(s)) === JSON.stringify({ show: JL, seasons: [3, 5] }));
        s.picked = { 4: true };
        suite.check('one ticked season is a plain season', JSON.stringify(review.slotName(s)) === JSON.stringify({ show: JL, season: 4 }));
        s.picked = { 4: false };
        suite.check('no ticked season is a problem, not a name', review.slotProblem(s) === 'no season is ticked' && review.slotName(s) === null);
        s.kind = 'special';
        suite.check('a special not picked is a problem', review.slotProblem(s) === 'no special is picked');
        s.kind = 'all';
        suite.check('any episode of the show is the show key, and a slot with no show is a problem',
            review.slotName(s) === JL && review.slotProblem(review.emptySlot()) === 'a show has not been picked');
        const movie = review.emptySlot();
        movie.key = 'movie.X: Y'; movie.kind = 'seasons';
        suite.check('a movie has no seasons whatever the slot says', review.slotName(movie) === 'movie.X: Y' && review.slotProblem(movie) === null);
        suite.check('a nickname target is the show, one season or several', review.nicknameTarget({ showKey: JL }) === JL
            && JSON.stringify(review.nicknameTarget({ showKey: JL, season: 3 })) === JSON.stringify({ show: JL, season: 3 })
            && JSON.stringify(review.nicknameTarget({ showKey: JL, seasons: [5, 3, 4] })) === JSON.stringify(JLU_SEASONS)
            && JSON.stringify(review.nicknameTarget({ showKey: JL, seasons: [4] })) === JSON.stringify({ show: JL, season: 4 })
            && review.nicknameTarget({ seasons: [3, 4] }) === null && review.nicknameTarget(null) === null);
        suite.check('picks with several seasons clean and check like any others',
            review.cleanPicks([JLU_SEASONS, JLU_SEASONS, BATMAN]).length === 2 && review.picksProblem([JLU_SEASONS, JLU_SEASONS]) === 'the same show is picked twice in a row'
            && review.picksProblem([JLU_SEASONS, { show: JL, seasons: [3, 4] }]) === null && review.picksProblem([{ show: JL, seasons: [4, 3] }]) === 'a show has not been picked');
    }

    // ---- the alias file and the review save, against real files -----------------------
    {
        const dir = tempDir();
        const fillerDir = path.join(dir, 'filler');
        fs.mkdirSync(fillerDir);
        try {
            const list = { name: 'Toonami Show Intros', mode: 'custom', rank: 0, content: [
                { title: 'Toonami - Justice League Unlimited Short Intro (4K HD)', duration: 7000, key: '/1', serverKey: 'srv', names: [{ show: JL, season: 3 }] },
                { title: 'Justice League Unlimited Promo', duration: 28000, key: '/2', serverKey: 'srv', names: [] },
                { title: 'Justice League Unlimited Promo [2005]', duration: 28000, key: '/3', serverKey: 'srv' },
                { title: 'Justice League Promo (1)', duration: 28000, key: '/4', serverKey: 'srv' },
            ] };
            fs.writeFileSync(path.join(fillerDir, 'a.json'), JSON.stringify(list));
            const read = () => fs.readFileSync(path.join(fillerDir, 'a.json'), 'utf8');
            const fillerDB = new FillerDB(fillerDir);
            const aliasDB = new ShowAliasDB(dir);
            const channelService = { getAllChannelNumbers: async () => [1], getChannel: async () => CHANNELS[0] };
            const customShowDB = { getAllShowsInfo: async () => [] };
            const service = new ShowMatchService(fillerDB, channelService, customShowDB, aliasDB);

            fs.writeFileSync(path.join(dir, 'show-aliases.json'), JSON.stringify({ aliases: {
                unlimited: { show: JL, season: 3 }, [JLU]: JLU_SEASONS,
                oneSeason: { show: JL, seasons: [3] }, unsorted: { show: JL, seasons: [5, 3] }, objects: { show: JL, seasons: 'x' }, sgc2c: 'tv.Space Ghost Coast to Coast' } }));
            const loaded = await aliasDB.load();
            suite.check('the alias file reads several seasons, and drops a set that is not in the stored shape; the rest read as they did',
                Object.keys(loaded).join() === `unlimited,${JLU},sgc2c` && JSON.stringify(loaded[JLU]) === JSON.stringify(JLU_SEASONS) && loaded.sgc2c === 'tv.Space Ghost Coast to Coast');
            fs.unlinkSync(path.join(dir, 'show-aliases.json'));

            const check = await service.checkNickname('a', JLU, JL, 0, undefined, [3, 4, 5]);
            suite.check('the service checks a nickname for several seasons and answers in words',
                check.ok === true && check.showName === 'Justice League · Seasons 3–5' && check.sourceShows.join() === 'Justice League · Seasons 3–5', JSON.stringify(check));
            const single = await service.checkNickname('a', JLU, JL, 0, 3);
            suite.check('and the older call with one season still answers as a season', single.ok === true && single.showName === 'Justice League · Season 3');
            const offers = await service.nicknameSuggestions('a', 0, JL, undefined, [3, 4, 5]);
            suite.check('and offers the show\'s title with its neighbour', offers.some( (o) => o.alias === JLU ));
            const before = read();
            suite.check('checking and suggesting wrote nothing', read() === before && ! fs.existsSync(path.join(dir, 'show-aliases.json')));

            const refuse = async (body) => { try { await service.saveNames('a', body); return null; } catch (err) { return err; } };
            const refusals = await Promise.all([
                { clips: [{ index: 0, title: list.content[0].title, names: [{ show: JL, seasons: [5, 3] }] }], aliases: {} },
                { clips: [{ index: 0, title: list.content[0].title, names: [{ show: 'tv.Nope', seasons: [1, 2] }] }], aliases: {} },
                { clips: [], aliases: { [JLU]: { show: JL, seasons: [3] } } },
                { clips: [], aliases: { [JLU]: { show: 'tv.Nope', seasons: [3, 4] } } },
            ].map(refuse));
            suite.check('several seasons that are not in the stored shape, or of a show no channel has, are refused, as a nickname or a name',
                refusals.every( (e) => e instanceof ShowMatchService.ReviewError ), refusals.map( (e) => e && e.message ).join(' | '));
            suite.check('and a refused save wrote nothing', read() === before && ! fs.existsSync(path.join(dir, 'show-aliases.json')));

            const saved = await service.saveNames('a', {
                clips: [ { index: 0, title: list.content[0].title, names: [JLU_SEASONS] } ],
                aliases: { [JLU]: JLU_SEASONS },
            });
            const after = JSON.parse(read());
            suite.check('the clip is saved with its several seasons, and the clip nobody decided is as it was',
                JSON.stringify(after.content[0].names) === JSON.stringify([JLU_SEASONS]) && JSON.stringify(after.content[3]) === JSON.stringify(list.content[3]));
            suite.check('the nickname is in the alias file with its seasons, and reads back',
                JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'show-aliases.json'), 'utf8')).aliases[JLU]) === JSON.stringify(JLU_SEASONS)
                && JSON.stringify((await aliasDB.load())[JLU]) === JSON.stringify(JLU_SEASONS));
            suite.check('the unsaved clip of the same title is now suggested as those seasons, and the plain-show one is not touched; the reviewed one stays reviewed',
                clipNames.sameName(saved.clips[2].proposal.names[0], JLU_SEASONS) && saved.clips[3].proposal.names.join() === JL && saved.clips[1].reviewed === true);
            const lines = [];
            const realError = console.error;
            console.error = (...a) => lines.push(a.join(' '));
            try {
                fillerDB.saveFiller('a', JSON.parse(read()));
            } finally {
                console.error = realError;
            }
            suite.check('the list saves without a warning about its new names', lines.length === 0, lines.join(' | '));
        } finally {
            removeDir(dir);
        }
    }

    // ---- any one of several shows: the shape ------------------------------------------
    {
        suite.check('any-of is two to eight different shows or custom shows, and nothing else in the object',
            [CCR, { anyOf: [EVEN, KIM, HANNAH] }, { anyOf: [EVEN, 'custom.dc'] }].every(clipNames.validName)
            && [{ anyOf: [EVEN] }, { anyOf: [] }, { anyOf: [EVEN, EVEN] }, { anyOf: [EVEN, 'movie.X'] }, { anyOf: [EVEN, 'audio.X'] }, { anyOf: [EVEN, 5] },
                { anyOf: [EVEN, ''] }, { anyOf: EVEN }, { anyOf: [EVEN, KIM], show: EVEN }, { anyOf: [EVEN, KIM], extra: 1 },
                { anyOf: ['tv.1', 'tv.2', 'tv.3', 'tv.4', 'tv.5', 'tv.6', 'tv.7', 'tv.8', 'tv.9'] }, { anyOf: [{ show: EVEN, season: 1 }, KIM] }].every( (n) => ! clipNames.validName(n) ));
        suite.check('eight shows is the most',
            clipNames.validName({ anyOf: ['tv.1', 'tv.2', 'tv.3', 'tv.4', 'tv.5', 'tv.6', 'tv.7', 'tv.8'] }));
        suite.check('the same shows in another order are the same name; other shows, a season or the show are not',
            clipNames.sameName(CCR, { anyOf: [KIM, EVEN] }) && ! clipNames.sameName(CCR, { anyOf: [EVEN, HANNAH] }) && ! clipNames.sameName(CCR, EVEN)
            && ! clipNames.sameName(CCR, { anyOf: [EVEN, KIM, HANNAH] }));
        suite.check('an any-of name is about each of its shows, and is not specific',
            clipNames.showsOf(CCR).join() === `${EVEN},${KIM}` && clipNames.showsOf(JLU_SEASONS).join() === JL && clipNames.showsOf(EVEN).join() === EVEN
            && clipNames.showsOf(null).length === 0 && clipNames.isSpecific(CCR) === false && clipNames.isSpecific(JLU_SEASONS) === true);
        suite.check('anyOfName makes the stored shape: nothing, one show, or two or more with repeats and non-shows left out, in the order given',
            clipNames.anyOfName([]) === null && clipNames.anyOfName(['movie.X']) === null && clipNames.anyOfName([KIM]) === KIM
            && JSON.stringify(clipNames.anyOfName([KIM, EVEN, KIM])) === JSON.stringify({ anyOf: [KIM, EVEN] }) && JSON.stringify(clipNames.anyOfName([EVEN, 'movie.X', KIM])) === JSON.stringify(CCR));
        const labels = { [EVEN]: 'Even Stevens', [KIM]: 'Kim Possible', [HANNAH]: 'Hannah Montana' };
        suite.check('it reads as words: A or B, A, B or C',
            clipNames.labelOf(CCR, labels) === 'Even Stevens or Kim Possible' && clipNames.labelOf({ anyOf: [EVEN, KIM, HANNAH] }, labels) === 'Even Stevens, Kim Possible or Hannah Montana');
        const fit = (name, program) => clipNames.fits(name, program, transitions.showKey);
        const ev = episode('Even Stevens', 2, 3), km = episode('Kim Possible', 1, 1), hm = episode('Hannah Montana', 1, 1);
        suite.check('it fits a program of any of its shows, as the show, and nothing else',
            fit(CCR, ev) === 'show' && fit(CCR, km) === 'show' && fit(CCR, hm) === false && fit(CCR, { isOffline: true }) === false && fit(CCR, null) === false
            && fit(CCR, { type: 'movie', title: 'Kim Possible', duration: 50 * MIN }) === false);
        suite.check('a custom show among them fits a program of that custom show',
            fit({ anyOf: [EVEN, 'custom.dc'] }, customEpisode) === 'show' && fit({ anyOf: [EVEN, 'custom.dc'] }, ev) === 'show' && fit({ anyOf: [EVEN, 'custom.dc'] }, km) === false);
        suite.check('saved on a clip it reads back; one that is not in the stored shape is unusable and names nothing',
            JSON.stringify(showMatch.namesOf({ names: [CCR] })) === JSON.stringify([CCR]) && showMatch.namesProblem({ names: [CCR] }) === null
            && showMatch.namesOf({ names: [{ anyOf: [EVEN] }] }).length === 0 && showMatch.namesProblem({ names: [{ anyOf: [EVEN] }] }) !== null);
    }

    // ---- any one of several shows: the matcher ----------------------------------------
    {
        const aliases = { [CCR_NICK]: CCR, 'emily osment': HANNAH };
        suite.check('without the nickname the clip names nothing, and a nickname for one show already works',
            ids(propose('Christy Carlson Romano Wand ID')) === '' && ids(propose('Emily Osment Wand ID', aliases)) === HANNAH);
        const got = propose('Christy Carlson Romano Wand ID', aliases);
        suite.check('a nickname for any of two shows names them both as one name',
            got.names.length === 1 && clipNames.sameName(got.names[0], CCR) && got.found.length === 1 && got.found[0].via === 'alias' && got.found[0].text === CCR_NICK, JSON.stringify(got));
        suite.check('the shows are in the name in the order they were taught, and spacing and capitals do not matter',
            JSON.stringify(propose('CHRISTY  CARLSON ROMANO - Wand ID (2004)', aliases).names) === JSON.stringify([CCR]));
        suite.check('a show the title names itself beats an any-of that includes it',
            ids(propose('Christy Carlson Romano Kim Possible Promo', aliases)) === KIM && ids(propose('Even Stevens - Christy Carlson Romano', aliases)) === EVEN);
        suite.check('and a show it does not include is a second name, in title order',
            ids(propose('Christy Carlson Romano to Hannah Montana', aliases)) === `anyOf:${EVEN}|${KIM} | ${HANNAH}`
            && ids(propose('Hannah Montana to Christy Carlson Romano', aliases)) === `${HANNAH} | anyOf:${EVEN}|${KIM}`);
        suite.check('a season of one of its shows named in the title still beats it',
            ids(propose('Christy Carlson Romano Kim Possible Season 1 Promo', aliases)) === `${KIM}#season:1`);
        suite.check('a title with several shows and one that is not recognised is flagged, and an any-of that was recognised is named in it as one name',
            (() => { const r = propose('Christy Carlson Romano to Zork Zork Zork', aliases);
                return r.names.length === 0 && r.unresolved != null && r.unresolved.recognised.length === 1 && clipNames.sameName(r.unresolved.recognised[0], CCR); })());
        suite.check('the same nickname twice in a title is one name', ids(propose('Christy Carlson Romano and Christy Carlson Romano Wand ID', aliases)) === `anyOf:${EVEN}|${KIM}`);
        suite.check('an any-of nickname does not change titles that do not use it',
            ['Batman Beyond Promo', 'Even Stevens Promo', 'Justice League Promo (1)', 'Kim Possible to Even Stevens', 'Full House ID'].every( (t) => ids(propose(t, aliases)) === ids(propose(t, { 'emily osment': HANNAH })) ));
        // a nickname that holds a title of one of its own shows is looked for in the whole title, like a season one
        const holds = { 'kim possible and friends': { anyOf: [KIM, HANNAH] } };
        suite.check('an any-of nickname that holds one of its shows\' titles is found whole, not as that show',
            ids(propose('Kim Possible and Friends Promo', holds)) === `anyOf:${HANNAH}|${KIM}` && ids(propose('Kim Possible Promo', holds)) === KIM);
        // suggestions, checks
        const offers = showMatch.nicknameSuggestions('Christy Carlson Romano Wand ID', CCR, vocab, {}, []);
        suite.check('teaching from the title offers its words, and nothing is held back for being used by one of the shows',
            offers.some( (o) => o.alias === CCR_NICK ) && offers.some( (o) => o.alias === 'christy' ), JSON.stringify(offers));
        const clips = [
            { list: 'a', index: 0, title: 'Christy Carlson Romano Wand ID', names: [], reviewed: false },
            { list: 'a', index: 1, title: 'Christy Carlson Romano Even Stevens Intro', names: [], reviewed: false },
            { list: 'a', index: 2, title: 'Christy Carlson Romano Behind the Scenes', names: [], reviewed: false },
            { list: 'a', index: 3, title: 'Christy Carlson Romano Kim Possible (Saved)', names: [KIM], reviewed: false },
            { list: 'a', index: 4, title: 'Christy Carlson Romano Reviewed', names: [], reviewed: true },
        ];
        const check = showMatch.checkNickname('Christy Carlson Romano', CCR, vocab, {}, clips, { sourceTitle: clips[0].title });
        suite.check('a nickname for any of two shows is accepted, names the clip it is taught from, and counts the unsaved clips it newly names; one saved under one of the shows or reviewed is not touched',
            check.ok === true && check.sourceNames.length === 1 && clipNames.sameName(check.sourceNames[0], CCR) && check.newly.length === 2 && check.changed.length === 0, JSON.stringify(check));
        suite.check('the clip that already says one of the shows plainly keeps that show, so the nickname changes nothing for it',
            ! check.newly.some( (c) => c.index === 1 ) && showMatch.propose(clips[1].title, vocab, { [CCR_NICK]: CCR }).names.join() === EVEN);
        const other = showMatch.checkNickname('Christy Carlson Romano', CCR, vocab, {}, clips.concat([{ list: 'b', index: 0, title: 'Christy Carlson Romano Promo', names: [HANNAH], reviewed: false }]), { sourceTitle: clips[0].title });
        suite.check('and refused when a clip saved under a show that is not one of them uses it',
            other.ok === false && other.changed.length === 1 && /Other shows' clips use/.test(other.problems.join(' ')), other.problems.join(' | '));
        const unknown = showMatch.checkNickname('Christy Carlson Romano', { anyOf: [EVEN, 'tv.Nope'] }, vocab, {}, [], {});
        suite.check('a show no channel has is not a target', unknown.ok === false && unknown.problems.some( (p) => /Pick the show/.test(p) ));
        const dup = showMatch.checkNickname('Christy Carlson Romano', CCR, vocab, { [CCR_NICK]: { anyOf: [KIM, EVEN] } }, [], {});
        suite.check('the same nickname for the same shows in another order is "already a nickname for this show"', dup.ok === false && /already a nickname for this show/.test(dup.problems.join(' ')), dup.problems.join(' | '));
        const taken = showMatch.checkNickname('Christy Carlson Romano', CCR, vocab, { [CCR_NICK]: KIM }, [], {});
        suite.check('and refused when it already means something else', taken.ok === false && /already means/.test(taken.problems.join(' ')));
        const learned = showMatch.learnAliases('Christy Carlson Romano Wand ID', [EVEN, KIM], vocab, {}, [
            { title: 'Even Stevens Behind the Scenes Wand', names: [EVEN] }, { title: 'Hannah Montana Wand Mix', names: [HANNAH] }, { title: 'Kim Possible Promo', names: [CCR] }]);
        suite.check('learning for several shows counts a clip naming any of them as the same shows, and one naming another show as elsewhere',
            Object.keys(learned.added).includes('christy') && learned.skipped.some( (s) => s.word === 'wand' && s.reason === 'used elsewhere' ), JSON.stringify(learned));
    }

    // ---- any one of several shows: what plays -----------------------------------------
    {
        const ev = episode('Even Stevens', 2, 3), km = episode('Kim Possible', 1, 1), hm = episode('Hannah Montana', 1, 1), lz = episode('Lizzie McGuire', 1, 1);
        const wand = { wands: [ named('CCR Wand ID', [CCR]), named('Osment Wand ID', [HANNAH]), named('Kim promo', [KIM]), named('generic', []) ] };
        const inStep = [step('s', 'wands')];
        suite.check('before an episode of either show the any-of clip can play, before nothing else',
            says(planFor(flexed(PREV, ev), { w: [ named('CCR Wand ID', [CCR]) ] }, [], [step('s', 'w')])) === '- / CCR Wand ID'
            && says(planFor(flexed(PREV, km), { w: [ named('CCR Wand ID', [CCR]) ] }, [], [step('s', 'w')])) === '- / CCR Wand ID'
            && says(planFor(flexed(PREV, hm), { w: [ named('CCR Wand ID', [CCR]) ] }, [], [step('s', 'w')])) === '- / -');
        suite.check('it takes its turn with a clip that names the show exactly (same tier): the longest idle plays, ties in list order',
            says(planFor(flexed(PREV, km), wand, [], inStep)) === '- / CCR Wand ID'
            && (() => { const plan = planFor(flexed(PREV, km), wand, [], inStep); return plan.in[0].fits.join() === 'CCR Wand ID,Kim promo'; })());
        suite.check('a clip for another show never plays before a show of the any-of, and does not take the any-of\'s place',
            says(planFor(flexed(PREV, hm), wand, [], inStep)) === '- / Osment Wand ID' && says(planFor(flexed(PREV, lz), wand, [], inStep)) === '- / -');
        suite.check('in a list whose clips feature shows it counts as naming the show coming up, ahead of any clip, for either show',
            says(planFor(flexed(PREV, ev), { f: [ named('other', [HANNAH]), named('CCR Wand ID', [CCR]) ] }, [], [step('s', 'f')], ['f'])) === '- / CCR Wand ID'
            && says(planFor(flexed(PREV, km), { f: [ named('other', [HANNAH]), named('CCR Wand ID', [CCR]) ] }, [], [step('s', 'f')], ['f'])) === '- / CCR Wand ID');
        suite.check('and with no clip for the show coming up, the list still plays any clip, as it did',
            says(planFor(flexed(PREV, lz), { f: [ named('other', [HANNAH]), named('CCR Wand ID', [CCR]) ] }, [], [step('s', 'f')], ['f'])) === '- / other');
        suite.check('it is not a specific match',
            planFor(flexed(PREV, km), { w: [ named('CCR Wand ID', [CCR]) ] }, [], [step('s', 'w')]).in[0].specific === false);
        suite.check('a specific clip (a season of Kim Possible) beats it, a clip for the whole show does not',
            says(planFor(flexed(PREV, km), { w: [ named('CCR Wand ID', [CCR]), named('KP season 1', [{ show: KIM, season: 1 }]) ] }, [], [step('s', 'w')])) === '- / KP season 1');
        suite.check('a step keyed on the show that just ended takes it too',
            says(planFor(flexed(ev, lz), { w: [ named('CCR Wand ID', [CCR]) ] }, [], [step('s', 'w', { keyedOn: 'now' })])) === '- / CCR Wand ID'
            && says(planFor(flexed(hm, lz), { w: [ named('CCR Wand ID', [CCR]) ] }, [], [step('s', 'w', { keyedOn: 'now' })])) === '- / -');
        // a clip naming several: an any-of is one place in the list
        suite.check('in a list of several names an any-of is one place: it fits the show coming up, then the next show must follow',
            says(planFor(flexed(PREV, ev, [km]), { l: [ named('CCR then Kim', [CCR, KIM]) ] }, [], [step('s', 'l')])) === '- / CCR then Kim'
            && says(planFor(flexed(PREV, ev, [hm]), { l: [ named('CCR then Kim', [CCR, KIM]) ] }, [], [step('s', 'l')])) === '- / -'
            && says(planFor(flexed(PREV, hm, [km]), { l: [ named('Hannah then CCR', [HANNAH, CCR]) ] }, [], [step('s', 'l')])) === '- / Hannah then CCR'
            && says(planFor(flexed(PREV, hm, [lz]), { l: [ named('Hannah then CCR', [HANNAH, CCR]) ] }, [], [step('s', 'l')])) === '- / -');
        suite.check('a multi-show title keeps its order and still plays as before',
            says(planFor(flexed(PREV, km, [ev]), { l: [ named('Kim then Even', [KIM, EVEN]) ] }, [], [step('s', 'l')])) === '- / Kim then Even'
            && says(planFor(flexed(PREV, ev, [km]), { l: [ named('Kim then Even', [KIM, EVEN]) ] }, [], [step('s', 'l')])) === '- / -');
        suite.check('a pair step reads an any-of as the show that ended and the show coming up',
            says(planFor(flexed(ev, km), { l: [ named('CCR to Kim', [CCR, KIM]) ] }, [], [step('s', 'l', { match: 'pair' })])) === '- / CCR to Kim'
            && says(planFor(flexed(hm, km), { l: [ named('CCR to Kim', [CCR, KIM]) ] }, [], [step('s', 'l', { match: 'pair' })])) === '- / -');
    }

    // ---- the picker's logic for any-of -------------------------------------------------
    {
        const slot = (name) => review.slotOfName(name);
        const s = slot(CCR);
        suite.check('a slot reads an any-of name: no single show, its members in order',
            s.any === true && s.key === null && s.members.map( (m) => m.key ).join() === `${EVEN},${KIM}`);
        suite.check('and writes it back', clipNames.sameName(review.slotName(s), CCR) && review.slotProblem(s) === null);
        const blank = review.emptySlot();
        blank.any = true;
        blank.members = [ { key: EVEN }, { key: null } ];
        suite.check('a blank member is a problem, not a name', review.slotProblem(blank) === 'a show has not been picked' && review.slotName(blank) === null);
        blank.members = [ { key: EVEN }, { key: EVEN } ];
        suite.check('the same show twice is a problem', review.slotProblem(blank) === 'the same show is picked twice in an any-of');
        blank.members = [ { key: EVEN } ];
        suite.check('one show is a problem (that is a plain show)', review.slotProblem(blank) === 'an any-of needs two shows');
        blank.members = [ { key: EVEN }, { key: KIM }, { key: HANNAH } ];
        suite.check('three are a name in the order picked', JSON.stringify(review.slotName(blank)) === JSON.stringify({ anyOf: [EVEN, KIM, HANNAH] }));
        blank.members = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map( (n) => ({ key: 'tv.' + n }) );
        suite.check('nine are too many', review.slotProblem(blank) === 'an any-of holds too many shows');
        suite.check('a nickname target can be any of several shows',
            JSON.stringify(review.nicknameTarget({ anyOf: [EVEN, KIM] })) === JSON.stringify(CCR) && review.nicknameTarget({ anyOf: [EVEN] }) === EVEN
            && review.nicknameTarget({ anyOf: [] }) === null && JSON.stringify(review.nicknameTarget({ showKey: JL, seasons: [3, 4] })) === JSON.stringify({ show: JL, seasons: [3, 4] }));
        suite.check('picks with an any-of clean and check like any others: not the same twice in a row, up to four places',
            review.picksProblem([CCR, CCR]) === 'the same show is picked twice in a row' && review.picksProblem([CCR, { anyOf: [KIM, EVEN] }]) === 'the same show is picked twice in a row'
            && review.picksProblem([CCR, EVEN]) === null && review.picksProblem([{ anyOf: [EVEN] }]) === 'a show has not been picked');
    }

    // ---- the alias file, the service and the review save, against real files ------------
    {
        const dir = tempDir();
        const fillerDir = path.join(dir, 'filler');
        fs.mkdirSync(fillerDir);
        try {
            const list = { name: 'Disney Wand IDs', mode: 'custom', rank: 0, clipsFeatureShows: true, content: [
                { title: 'Christy Carlson Romano Wand ID', duration: 10000, key: '/1', serverKey: 'srv' },
                { title: 'Emily Osment Wand ID', duration: 10000, key: '/2', serverKey: 'srv' },
                { title: 'Christy Carlson Romano Wand ID (2)', duration: 10000, key: '/3', serverKey: 'srv' },
                { title: 'Kim Possible Promo', duration: 10000, key: '/4', serverKey: 'srv', names: [KIM] },
            ] };
            fs.writeFileSync(path.join(fillerDir, 'a.json'), JSON.stringify(list));
            const read = () => fs.readFileSync(path.join(fillerDir, 'a.json'), 'utf8');
            const fillerDB = new FillerDB(fillerDir);
            const aliasDB = new ShowAliasDB(dir);
            const channelService = { getAllChannelNumbers: async () => [1], getChannel: async () => CHANNELS[0] };
            const customShowDB = { getAllShowsInfo: async () => [ { id: 'dc', name: 'Friday DCOM Movies' } ] };
            const service = new ShowMatchService(fillerDB, channelService, customShowDB, aliasDB);

            fs.writeFileSync(path.join(dir, 'show-aliases.json'), JSON.stringify({ aliases: {
                [CCR_NICK]: CCR, one: { anyOf: [EVEN] }, same: { anyOf: [EVEN, EVEN] }, movie: { anyOf: [EVEN, 'movie.X'] }, sgc2c: 'tv.Space Ghost Coast to Coast' } }));
            const loaded = await aliasDB.load();
            suite.check('the alias file reads an any-of nickname, and drops one that is not in the stored shape; the rest read as they did',
                Object.keys(loaded).join() === `${CCR_NICK},sgc2c` && JSON.stringify(loaded[CCR_NICK]) === JSON.stringify(CCR));
            fs.unlinkSync(path.join(dir, 'show-aliases.json'));

            const check = await service.checkNickname('a', CCR_NICK, undefined, 0, undefined, undefined, [EVEN, KIM]);
            suite.check('the service checks a nickname for any of two shows and answers in words, naming the clip it is taught from',
                check.ok === true && check.showName === 'Even Stevens or Kim Possible' && check.sourceShows.join() === 'Even Stevens or Kim Possible'
                && check.thisList === 1 && check.otherLists === 0, JSON.stringify(check));
            const none = await service.checkNickname('a', CCR_NICK, undefined, 0);
            suite.check('with no show picked it says to pick one', none.ok === false && none.problems.some( (p) => /Pick the show/.test(p) ));
            const offers = await service.nicknameSuggestions('a', 0, undefined, undefined, undefined, [EVEN, KIM]);
            suite.check('and offers the words of the title', offers.some( (o) => o.alias === CCR_NICK ));
            const before = read();
            suite.check('checking and suggesting wrote nothing', read() === before && ! fs.existsSync(path.join(dir, 'show-aliases.json')));

            const refuse = async (body) => { try { await service.saveNames('a', body); return null; } catch (err) { return err; } };
            const refusals = await Promise.all([
                { clips: [{ index: 0, title: list.content[0].title, names: [{ anyOf: [EVEN] }] }], aliases: {} },
                { clips: [{ index: 0, title: list.content[0].title, names: [{ anyOf: [EVEN, 'tv.Nope'] }] }], aliases: {} },
                { clips: [{ index: 0, title: list.content[0].title, names: [{ anyOf: [EVEN, 'movie.Halloweentown'] }] }], aliases: {} },
                { clips: [], aliases: { [CCR_NICK]: { anyOf: [EVEN, EVEN] } } },
                { clips: [], aliases: { [CCR_NICK]: { anyOf: [EVEN, 'tv.Nope'] } } },
            ].map(refuse));
            suite.check('an any-of that is not in the stored shape, or has a show no channel has, is refused, as a name or a nickname',
                refusals.every( (e) => e instanceof ShowMatchService.ReviewError ), refusals.map( (e) => e && e.message ).join(' | '));
            suite.check('and a refused save wrote nothing', read() === before && ! fs.existsSync(path.join(dir, 'show-aliases.json')));

            const saved = await service.saveNames('a', {
                clips: [ { index: 0, title: list.content[0].title, names: [CCR] }, { index: 1, title: list.content[1].title, names: [HANNAH] } ],
                aliases: { [CCR_NICK]: CCR, 'emily osment': HANNAH },
            });
            const after = JSON.parse(read());
            suite.check('the clips are saved with an any-of name and a show, and the one nobody decided is as it was',
                JSON.stringify(after.content[0].names) === JSON.stringify([CCR]) && JSON.stringify(after.content[1].names) === JSON.stringify([HANNAH])
                && JSON.stringify(after.content[3]) === JSON.stringify(list.content[3]) && typeof(after.content[2].names) === 'undefined');
            suite.check('both nicknames are in the alias file, and read back',
                JSON.stringify((await aliasDB.load())[CCR_NICK]) === JSON.stringify(CCR) && (await aliasDB.load())['emily osment'] === HANNAH);
            suite.check('the other Christy Carlson Romano clip is now suggested as the any-of; its list entry is not touched',
                clipNames.sameName(saved.clips[2].proposal.names[0], CCR) && saved.clips[2].names.length === 0);
            suite.check('every show of an any-of has a display name for the screen',
                saved.showNames[EVEN] === 'Even Stevens' && saved.showNames[KIM] === 'Kim Possible');
            const lines = [];
            const realError = console.error;
            console.error = (...a) => lines.push(a.join(' '));
            try {
                fillerDB.saveFiller('a', JSON.parse(read()));
            } finally {
                console.error = realError;
            }
            suite.check('the list saves without a warning about its new names', lines.length === 0, lines.join(' | '));
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
