/*
 * Stage 5, step 2: which show a filler clip is about (src/show-match.js), the
 * alias store (src/dao/show-alias-db.js), the `names` shape check in
 * src/dao/filler-db.js, and GET /api/filler/:id/match. See docs/blocks-spec.md,
 * Stage 5, "Which shows a clip names".
 *
 * Fixtures only. The alias store's writer is exercised against throwaway
 * folders under the OS temp directory and nothing else: no test here reads or
 * writes a data folder of the user's, and the matcher's proposals are checked
 * to leave everything they are given exactly as they found it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { MIN, Suite } = require('./support');
const showMatch = require('../src/show-match');
const ShowAliasDB = require('../src/dao/show-alias-db');
const FillerDB = require('../src/dao/filler-db');
const ShowMatchService = require('../src/services/show-match-service');
const api = require('../src/api');

function ep(show) {
    return { title: show + ' 1', type: 'episode', showTitle: show, duration: 22 * MIN, serverKey: 'srv' };
}
function custom(id, name) {
    return { title: name + ' item', type: 'episode', showTitle: name, customShowId: id, customShowName: name, duration: 7 * MIN };
}
function film(title) {
    return { title, type: 'movie', duration: 90 * MIN, serverKey: 'srv', key: '/m/' + title };
}
function channel(number, programs, slots) {
    return { number, name: 'C' + number, programs, scheduleBackup: { slots: slots || [] } };
}

const CHANNELS = [
    channel(1, [
        ep('Sealab 2021'), ep('Sealab 2020'), ep('Dragon Ball Z'), ep('Dragon Ball'),
        ep('Space Ghost Coast to Coast'), ep('Aqua Teen Hunger Force'), ep('Cowboy Bebop'),
        ep('Home Movies'), ep('Up'), ep('The Powerpuff Girls'), ep('The Jetsons'), custom('c1', 'Looney Tunes'), film('Heat'),
        { isOffline: true, duration: 5 * MIN },
    ], [{ time: 0, showId: 'tv.Futurama' }, { time: 1, showId: 'flex.' }, { time: 2, showId: 'movie.' }]),
    channel(2, [ep('Sealab 2021'), ep('Naruto'), { isOffline: true, type: 'redirect', channel: 1, duration: 1 }]),
];
const KEYS = {
    sealab21: 'tv.Sealab 2021', sealab20: 'tv.Sealab 2020', dbz: 'tv.Dragon Ball Z', db: 'tv.Dragon Ball',
    sgc: 'tv.Space Ghost Coast to Coast', athf: 'tv.Aqua Teen Hunger Force', bebop: 'tv.Cowboy Bebop',
    homeMovies: 'tv.Home Movies', naruto: 'tv.Naruto', futurama: 'tv.Futurama', looney: 'custom.c1', heat: 'movie.Heat',
};

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'syndicast-match-'));
}
function removeDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* left for the OS */ }
}
function captureErrors(fn) {
    const lines = [];
    const real = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    return Promise.resolve().then(fn).then(
        (r) => { console.error = real; return { lines, result: r }; },
        (e) => { console.error = real; throw e; }
    );
}
const names = (p) => p.names.join();

module.exports = async function run() {
    const suite = new Suite('show match');
    const vocab = showMatch.buildVocabulary(CHANNELS, { c1: 'Looney Tunes', c9: 'Never Aired' });
    const propose = (title, aliases) => showMatch.propose(title, vocab, aliases || {});

    // ---- folding -------------------------------------------------------------
    {
        const f = showMatch.fold;
        suite.check('folding lowercases and flattens punctuation', f("Aqua Teen: Hunger-Force!") === 'aqua teen hunger force');
        suite.check('folding drops accents', f('Pokémon') === 'pokemon');
        suite.check('folding reads & as and', f("Billy & Mandy") === 'billy and mandy');
        suite.check('folding collapses runs of space and trims', f('  A   B  ') === 'a b');
    }

    // ---- the vocabulary ------------------------------------------------------
    {
        const keys = vocab.entries.map((e) => e.key);
        suite.check('episodes, custom shows and movies from programs are in the vocabulary',
            [KEYS.sealab21, KEYS.looney, KEYS.heat, KEYS.bebop].every((k) => keys.indexOf(k) !== -1));
        suite.check('a show only in a slot is in the vocabulary', keys.indexOf(KEYS.futurama) !== -1);
        suite.check('a custom show is named by the custom show, not by its items',
            vocab.names['custom.c1'] === 'Looney Tunes');
        suite.check('Flex, redirects and the bare movie slot add nothing',
            keys.every((k) => ! /^(flex|redirect|movie)\.$/.test(k) && k.indexOf('redirect') === -1));
        suite.check('a show on two channels is one entry', keys.filter((k) => k === KEYS.sealab21).length === 1);
        suite.check('a custom show nobody schedules is not guessed at', keys.indexOf('custom.c9') === -1);
        suite.check('entries run longest title first',
            vocab.entries.every((e, i) => i === 0 || vocab.entries[i - 1].folded.length >= e.folded.length));
        suite.check('a title too short to be safe is left out', keys.indexOf('tv.Up') === -1);
    }

    // ---- proposing from titles ----------------------------------------------
    {
        suite.check('a show title in a clip title names that show',
            names(propose('Adult Swim Promo - Cowboy Bebop [2003]')) === KEYS.bebop);
        suite.check('case and punctuation do not matter', names(propose('COWBOY-BEBOP!!')) === KEYS.bebop);
        suite.check('the longest title wins: Dragon Ball Z is not Dragon Ball',
            names(propose('Toonami DBZ-style Dragon Ball Z Promo')) === KEYS.dbz);
        suite.check('and the shorter one still matches where it is the longer one\'s absence',
            names(propose('Dragon Ball promo')) === KEYS.db);
        suite.check('Sealab 2021 and Sealab 2020 stay apart',
            names(propose('[AS] Bumper - Sealab 2020')) === KEYS.sealab20
            && names(propose('[AS] Bumper - Sealab 2021')) === KEYS.sealab21);
        suite.check('a title inside a longer word is not a match', propose('Cowboy Bebopper Special').names.length === 0);
        suite.check('a clip that names no show proposes nothing',
            propose('Adult Swim Bumper 5').names.length === 0 && propose('Adult Swim Bumper 5').found.length === 0);
        suite.check('a custom show is found by its name', names(propose('Looney Tunes Promo')) === KEYS.looney);
        suite.check('a movie is found by its title', names(propose('Heat trailer')) === KEYS.heat);
        suite.check('a show only a slot knows about is found', names(propose('Futurama promo (2002)')) === KEYS.futurama);
        suite.check('"Up Next" does not name the show "Up"', propose('Up Next: tonight').names.length === 0);
    }

    // ---- a leading "The" is optional when the rest is still a phrase -----------
    {
        suite.check('"Powerpuff Girls" names "The Powerpuff Girls"',
            names(propose('Powerpuff Girls Character Promo (Blossom)')) === 'tv.The Powerpuff Girls');
        suite.check('the full title still names it, once',
            names(propose('The Powerpuff Girls Promo')) === 'tv.The Powerpuff Girls');
        suite.check('a one-word rest is not enough: "Jetsons" alone names nothing, "The Jetsons" does',
            propose('Jetsons promo').names.length === 0 && names(propose('The Jetsons promo')) === 'tv.The Jetsons');
        suite.check('the shortened title is shown as what matched',
            propose('Powerpuff Girls Promo').found[0].text === 'powerpuff girls');
    }

    // ---- pairs ---------------------------------------------------------------
    {
        const p = propose('Cowboy Bebop to Sealab 2021 bridge');
        suite.check('two titles found in order make a pair: now, then',
            names(p) === `${KEYS.bebop},${KEYS.sealab21}`, names(p));
        suite.check('the pair follows the order in the title, not the vocabulary',
            names(propose('Sealab 2021 then Cowboy Bebop')) === `${KEYS.sealab21},${KEYS.bebop}`);
        suite.check('the same show twice is one show', names(propose('Cowboy Bebop vs Cowboy Bebop')) === KEYS.bebop);
        const three = propose('Cowboy Bebop, Sealab 2021 and Naruto');
        suite.check('three shows propose the first two and say there was more',
            names(three) === `${KEYS.bebop},${KEYS.sealab21}` && three.extra === 1, `${names(three)} extra ${three.extra}`);
        suite.check('each hit says what it matched and how',
            p.found.length === 2 && p.found[0].text === 'cowboy bebop' && p.found[0].via === 'title');
    }

    // ---- aliases -------------------------------------------------------------
    {
        const aliases = { sgc2c: KEYS.sgc, dbz: KEYS.dbz };
        const p = propose('[As] NEXT - SGC2C [2003]', aliases);
        suite.check('an alias names its show where the title does not', names(p) === KEYS.sgc);
        suite.check('and a hit by alias says so', p.found[0].via === 'alias' && p.found[0].text === 'sgc2c');
        suite.check('without the alias the same clip names nothing', propose('[As] NEXT - SGC2C [2003]').names.length === 0);
        suite.check('an alias and a title in one clip make a pair in order',
            names(propose('SGC2C to Cowboy Bebop', aliases)) === `${KEYS.sgc},${KEYS.bebop}`);
        suite.check('a title and the alias for the same show are one show',
            names(propose('Dragon Ball Z DBZ', aliases)) === KEYS.dbz);
        suite.check('an alias only matches a whole word', propose('SGC2CX special', aliases).names.length === 0);
        suite.check('the longest title is taken before aliases, so an alias inside a title is not double counted',
            names(propose('Dragon Ball Z', { ball: KEYS.bebop })) === KEYS.dbz);
    }

    // ---- learning aliases ----------------------------------------------------
    {
        const corpus = [
            { title: '[as] SGC2C - Season 5 Promo', names: [] },
            { title: '[AS] Adult Swim SGC2C bumper [2003]', names: [] },
            { title: 'Adult Swim Promo - Cowboy Bebop', names: [KEYS.bebop] },
            { title: '[as] Sealab 2021 promo', names: [KEYS.sealab21] },
            { title: 'Naruto Season 5 Promo', names: [KEYS.naruto] },
            { title: '[AS] NEXT - ATHF', names: [] },
        ];
        const before = JSON.stringify(corpus);
        const learned = showMatch.learnAliases('[as] SGC2C - Season 5 Promo', KEYS.sgc, vocab, {}, corpus);
        suite.check('the one unexplained word becomes an alias', learned.added.sgc2c === KEYS.sgc, JSON.stringify(learned.added));
        suite.check('and nothing else does',
            Object.keys(learned.added).join() === 'sgc2c', Object.keys(learned.added).join());
        const why = {};
        learned.skipped.forEach((s) => { why[s.word] = s.reason; });
        suite.check('"as" and "promo" are skipped: other shows\' clips use them', why.as === 'used elsewhere' && why.promo === 'used elsewhere', JSON.stringify(why));
        suite.check('"season" is skipped for the same reason', why.season === 'used elsewhere');
        suite.check('a bare number is skipped', why['5'] === 'number');
        suite.check('learning changes neither the corpus nor the aliases it was given', JSON.stringify(corpus) === before);

        const second = showMatch.learnAliases('[AS] Adult Swim SGC2C bumper [2003]', KEYS.sgc, vocab, learned.added, corpus);
        const why2 = {};
        second.skipped.forEach((s) => { why2[s.word] = s.reason; });
        suite.check('"adult" and "swim" are not learned: a Cowboy Bebop clip uses them',
            why2.adult === 'used elsewhere' && why2.swim === 'used elsewhere', JSON.stringify(why2));
        suite.check('"bumper" is skipped as a structural word and the year as a number',
            why2.bumper === 'structural' && why2['2003'] === 'number', JSON.stringify(why2));
        suite.check('an alias already learned is reported as known, not added again',
            Object.keys(second.added).length === 0 && why2.sgc2c === 'already known');

        const after = Object.assign({}, learned.added);
        suite.check('after one fix, the other SGC2C clips are proposed',
            names(propose('[AS] Adult Swim SGC2C bumper [2003]', after)) === KEYS.sgc
            && names(propose('Comm - SGC2C [Dr. Pepper]', after)) === KEYS.sgc);
        suite.check('and "Adult Swim" still does not name anything',
            propose('Adult Swim Bumper - Empty Pool', after).names.length === 0
            && names(propose('Adult Swim Promo - Cowboy Bebop', after)) === KEYS.bebop);
        suite.check('and "NEXT" on its own names nothing', propose('[AS] NEXT - ATHF', after).names.length === 0);

        const next = showMatch.learnAliases('[as] NEXT - SGC2C', KEYS.sgc, vocab, {}, []);
        suite.check('even with nothing to compare against, "next" is not learned: it is a structural word',
            typeof next.added.next === 'undefined' && next.added.sgc2c === KEYS.sgc);

        const title = showMatch.learnAliases('Home Movies SGC2C crossover', KEYS.sgc, vocab, {}, []);
        suite.check('words that are part of a show title are not aliases',
            typeof title.added.home === 'undefined' && typeof title.added.movies === 'undefined' && title.added.sgc2c === KEYS.sgc);

        const taken = showMatch.learnAliases('SGC2C promo', KEYS.athf, vocab, { sgc2c: KEYS.sgc }, []);
        suite.check('a word that already means another show is left alone and reported',
            typeof taken.added.sgc2c === 'undefined' && taken.skipped.some((s) => s.word === 'sgc2c' && s.reason === 'taken by another show'));
    }

    // ---- the stored shape ----------------------------------------------------
    {
        const n = showMatch.namesOf;
        suite.check('a clip with no names reads as unnamed', n({ title: 'x' }).length === 0);
        suite.check('one show', n({ names: ['tv.A'] }).join() === 'tv.A');
        suite.check('two shows, now then', n({ names: ['tv.A', 'tv.B'] }).join() === 'tv.A,tv.B');
        suite.check('an empty array is unnamed', n({ names: [] }).length === 0);
        suite.check('a string, three entries or a non-string entry read as unnamed',
            n({ names: 'tv.A' }).length === 0 && n({ names: ['a', 'b', 'c'] }).length === 0 && n({ names: [4] }).length === 0);
        suite.check('reading hands back a copy', (() => { const c = { names: ['tv.A'] }; n(c).push('x'); return c.names.length === 1; })());
        suite.check('a good shape has no problem', showMatch.namesProblem({ names: ['tv.A'] }) === null
            && showMatch.namesProblem({ title: 'x' }) === null);
        suite.check('a bad shape says what is wrong',
            /array/.test(showMatch.namesProblem({ names: 'tv.A' })) && /one or two/.test(showMatch.namesProblem({ names: [] })));
    }

    // ---- the alias store: reader and writer, on throwaway folders ------------
    {
        const dir = tempDir();
        try {
            const db = new ShowAliasDB(dir);
            const file = path.join(dir, 'show-aliases.json');
            const empty = await db.load();
            suite.check('no file reads as no aliases, and reading creates nothing',
                Object.keys(empty).length === 0 && ! fs.existsSync(file));

            await db.save({ sgc2c: KEYS.sgc });
            suite.check('saving writes show-aliases.json in the folder it was given and nothing else',
                fs.existsSync(file) && fs.readdirSync(dir).join() === 'show-aliases.json');
            suite.check('it reads back', (await new ShowAliasDB(dir).load()).sgc2c === KEYS.sgc);

            const merged = await db.merge({ dbz: KEYS.dbz, sgc2c: KEYS.athf });
            suite.check('merging adds new words', merged.dbz === KEYS.dbz);
            suite.check('and never overwrites a word that already means a show', merged.sgc2c === KEYS.sgc);
            suite.check('and what it returns is what is now stored', JSON.stringify(await db.load()) === JSON.stringify(merged));

            fs.writeFileSync(file, '{ this is not json');
            const { lines, result } = await captureErrors(() => db.load());
            suite.check('an unreadable file reads as no aliases and says so', Object.keys(result).length === 0 && lines.length === 1, lines.join(' | '));
            suite.check('and reading it did not rewrite it', fs.readFileSync(file, 'utf8') === '{ this is not json');
            fs.writeFileSync(file, JSON.stringify({ aliases: { good: 'tv.A', bad: 7 } }));
            suite.check('an entry that is not a show key is ignored on read',
                JSON.stringify(await db.load()) === JSON.stringify({ good: 'tv.A' }));
        } finally {
            removeDir(dir);
        }
    }

    // ---- the shape warning at filler save -----------------------------------
    {
        const dir = tempDir();
        try {
            const db = new FillerDB(dir);
            const good = { name: 'L', content: [{ title: 'a', names: ['tv.A'] }, { title: 'b' }], rank: 0 };
            const goodRun = await captureErrors(() => db.saveFiller('good', JSON.parse(JSON.stringify(good))));
            suite.check('a list with valid names saves without a word', goodRun.lines.length === 0, goodRun.lines.join(' | '));
            suite.check('and the names are stored as given',
                JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'good.json'), 'utf8')).content) === JSON.stringify(good.content));

            const plain = { name: 'P', content: [{ title: 'a' }], mode: 'custom', rank: 0 };
            await db.saveFiller('plain', JSON.parse(JSON.stringify(plain)));
            suite.check('a list that has never heard of names saves byte for byte as it did',
                fs.readFileSync(path.join(dir, 'plain.json'), 'utf8') === JSON.stringify(plain));

            const bad = { name: 'B', content: [{ title: 'a', names: 'tv.A' }, { title: 'b', names: [] }], rank: 0 };
            const badRun = await captureErrors(() => db.saveFiller('bad', JSON.parse(JSON.stringify(bad))));
            suite.check('malformed names are warned about, once per clip, naming the clip',
                badRun.lines.length === 2 && /"a"/.test(badRun.lines[0]), badRun.lines.join(' | '));
            suite.check('and saved untouched',
                JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'bad.json'), 'utf8')).content) === JSON.stringify(bad.content));
        } finally {
            removeDir(dir);
        }
    }

    // ---- the service and the route: proposals only ---------------------------
    {
        const filler = { id: 'f1', name: 'Adult Swim', mode: 'custom', content: [
            { title: 'Adult Swim Promo - Cowboy Bebop [2003]', names: [] },
            { title: '[as] SGC2C - Season 5 Promo' },
            { title: 'Adult Swim Bumper 5', names: [KEYS.sealab21] },
            { title: 'Sealab 2021 to Home Movies' },
        ] };
        const writes = [];
        const spy = (name, fn) => (...a) => { if (/^(save|merge|create|delete|update|put)/i.test(name)) writes.push(name); return fn(...a); };
        const fillerDB = { getFiller: spy('getFiller', async (id) => (id === 'f1' ? filler : null)),
            saveFiller: spy('saveFiller', async () => {}) };
        const channelService = {
            getAllChannelNumbers: async () => [1, 2],
            getChannel: async (n) => CHANNELS.find((c) => c.number === n),
        };
        const customShowDB = { getAllShowsInfo: async () => [{ id: 'c1', name: 'Looney Tunes', count: 3 }] };
        const aliasDB = { load: spy('load', async () => ({ sgc2c: KEYS.sgc })),
            save: spy('save', async () => {}), merge: spy('merge', async () => ({})) };
        const service = new ShowMatchService(fillerDB, channelService, customShowDB, aliasDB);
        const before = JSON.stringify(filler);

        const out = await service.matchFiller('f1');
        suite.check('the service answers for every clip, in the list\'s order',
            out.clips.length === 4 && out.clips.map((c) => c.index).join() === '0,1,2,3');
        suite.check('a clip\'s own names and the proposal are reported separately',
            out.clips[2].names.join() === KEYS.sealab21 && out.clips[2].proposal.names.length === 0);
        suite.check('the alias is used', out.clips[1].proposal.names.join() === KEYS.sgc);
        suite.check('a pair comes with both shows', out.clips[3].proposal.names.join() === `${KEYS.sealab21},${KEYS.homeMovies}`);
        suite.check('the response carries display names for the keys it mentions',
            out.showNames[KEYS.bebop] === 'Cowboy Bebop' && out.showNames[KEYS.sgc] === 'Space Ghost Coast to Coast');
        suite.check('an unknown list is null', (await service.matchFiller('nope')) === null);
        suite.check('matching writes nothing: no save, merge, create or delete was called', writes.length === 0, writes.join());
        suite.check('and leaves the list exactly as it found it', JSON.stringify(filler) === before);

        // the route, through the real router, on an ephemeral port
        const app = express();
        app.use(api.router({}, channelService, fillerDB, customShowDB, null, null, null, null, null, null, null, null, null, service));
        const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        try {
            const get = (p) => new Promise((resolve, reject) => {
                http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => {
                    let body = '';
                    res.on('data', (d) => { body += d; });
                    res.on('end', () => resolve({ status: res.statusCode, body }));
                }).on('error', reject);
            });
            const ok = await get('/api/filler/f1/match');
            suite.check('GET /api/filler/:id/match answers with the proposals',
                ok.status === 200 && JSON.parse(ok.body).clips.length === 4 && JSON.parse(ok.body).id === 'f1', `${ok.status}`);
            const missing = await get('/api/filler/nope/match');
            suite.check('and 404s for a list that does not exist', missing.status === 404, `${missing.status}`);
            suite.check('the route also wrote nothing', writes.length === 0, writes.join());
        } finally {
            server.close();
        }

        const posts = await (async () => {
            const app2 = express();
            app2.use(express.json());
            app2.use(api.router({}, channelService, fillerDB, customShowDB, null, null, null, null, null, null, null, null, null, service));
            const s = await new Promise((resolve) => { const x = app2.listen(0, '127.0.0.1', () => resolve(x)); });
            try {
                return await new Promise((resolve, reject) => {
                    const req = http.request({ host: '127.0.0.1', port: s.address().port, method: 'POST',
                        path: '/api/filler/f1/match', headers: { 'content-type': 'application/json' } }, (res) => {
                        res.resume();
                        resolve(res.statusCode);
                    });
                    req.on('error', reject);
                    req.end('{}');
                });
            } finally {
                s.close();
            }
        })();
        suite.check('there is no save route yet: POST /api/filler/:id/match is not one', posts === 404, `${posts}`);
    }

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
