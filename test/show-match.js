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

// Shows for the shortened-title, spacing and two-show-title checks, titled as Plex
// titles them (a subtitle after a colon, a trailing "Show"), and a custom show.
const FIX_CHANNELS = [channel(3, [
    ep('Ghost in the Shell: Stand Alone Complex'), ep('Transformers'), ep('Transformers: Robots In Disguise'),
    ep("G.I. Joe: A Real American Hero ('83)"), ep("G.I. Joe: A Real American Hero ('89)"), ep('Be: Something Long'),
    ep('Avatar: The Last Airbender'), ep('The Adventures of Jimmy Neutron: Boy Genius'),
    ep('Space Ghost Coast to Coast'), ep('Camp Lazlo'), ep("Foster's Home for Imaginary Friends"),
    ep('Ed, Edd n Eddy'), ep('Dragon Ball GT'), ep('Dragon Ball Z'), ep('Dragon Ball'), ep('InuYasha'), ep('Up'),
    ep('Sealab 2021'), ep('The Tex Avery Show'), ep('The Cosby Show'), ep('Cow and Chicken'), ep("Dexter's Laboratory"),
    ep('Tom & Jerry'), ep('Tom & Jerry Show'), ep('Gumball Show'), ep('The Big Late Show Live'), ep('Ben 10'), custom('g2', 'Mobile Suit Gundam Series'),
])];
const FIXK = {
    sac: 'tv.Ghost in the Shell: Stand Alone Complex', transformers: 'tv.Transformers', tfRid: 'tv.Transformers: Robots In Disguise',
    joe83: "tv.G.I. Joe: A Real American Hero ('83)", joe89: "tv.G.I. Joe: A Real American Hero ('89)",
    avatar: 'tv.Avatar: The Last Airbender', jimmy: 'tv.The Adventures of Jimmy Neutron: Boy Genius',
    sgc: 'tv.Space Ghost Coast to Coast', lazlo: 'tv.Camp Lazlo', fosters: "tv.Foster's Home for Imaginary Friends",
    ed: 'tv.Ed, Edd n Eddy', gt: 'tv.Dragon Ball GT', dbz: 'tv.Dragon Ball Z', db: 'tv.Dragon Ball', inuyasha: 'tv.InuYasha',
    sealab: 'tv.Sealab 2021', tex: 'tv.The Tex Avery Show', cosby: 'tv.The Cosby Show', cow: 'tv.Cow and Chicken',
    dexter: "tv.Dexter's Laboratory", tj: 'tv.Tom & Jerry', gundam: 'custom.g2',
};

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

    // ---- Up Next lists: the real clip titles, against Plex-style show titles ----
    {
        // Shows as Plex titles them, with and without a leading "The".
        const nite = (titles) => showMatch.buildVocabulary([channel(9, titles.map(ep))], {});
        const plex = nite(['Cheers', 'The Cosby Show', 'Full House', 'Roseanne', 'The Fresh Prince of Bel-Air',
            "Three's Company", 'All in the Family', 'The Jeffersons', 'The Brady Bunch', 'Happy Days',
            'Murphy Brown', 'The Facts of Life', "Who's the Boss?", 'The Wonder Years']);
        // The same shows titled the other way round on the article.
        const bare = nite(['Cheers', 'Cosby Show', 'Full House', 'Roseanne', 'Fresh Prince of Bel-Air',
            "Three's Company", 'All in the Family', 'Jeffersons', 'Brady Bunch', 'Happy Days',
            'Murphy Brown', 'Facts of Life', "Who's the Boss", 'Wonder Years']);
        const T = {
            cheers: 'Cheers', cosby: 'Cosby Show', house: 'Full House', rose: 'Roseanne',
            prince: 'Fresh Prince of Bel-Air', three: "Three's Company", family: 'All in the Family',
            jeff: 'Jeffersons', brady: 'Brady Bunch', days: 'Happy Days', murphy: 'Murphy Brown',
            facts: 'Facts of Life', boss: "Who's the Boss", wonder: 'Wonder Years',
        };
        // [clip title, show(s) it names] - every title in the Nick at Nite Up Next lists.
        const CLIPS = [
            ['Up Next Bumper (Cheers) (2003) (Back 2 Back)', ['cheers']],
            ['Up Next Bumper (Cheers) (Back 2 Back)', ['cheers']],
            ['Up Next Bumper (Cosby Show) (more)', ['cosby']],
            ['Up Next Bumper (Full House) (Back 2 Back)', ['house']],
            ['Up Next Bumper (Full House) (More)', ['house']],
            ['Up Next bumper (Roseanne) (Back 2 Back)', ['rose']],
            ['Up Next Bumper (The Cosby Show) (back 2 back)', ['cosby']],
            ['Up Next Bumper (The Fresh Prince of Bel-Air) (back2back)', ['prince']],
            ["Up Next Bumper (Three's Company) (back2back)", ['three']],
            ["Up Next Bumper (Three's Company) (more)", ['three']],
            ['Up Next Bumper (All in the family-The Jeffersons)', ['family', 'jeff']],
            ['Up Next Bumper (All in the family)', ['family']],
            ['Up Next Bumper (All in the Family) (2002)', ['family']],
            ['Up Next Bumper (Brady Bunch) (2003)', ['brady']],
            ['Up Next Bumper (Cheers)', ['cheers']],
            ['Up Next Bumper (Cosby Show) (2002)', ['cosby']],
            ['Up Next Bumper (Fresh Prince of Bel-Air) (2004)', ['prince']],
            ['Up Next Bumper (Fresh Prince of Bel-Air) (2004) (2024)', ['prince']],
            ['Up Next Bumper (Fresh Prince of Bel-Air) (2006) 2', ['prince']],
            ['Up Next Bumper (Full House) (2005)', ['house']],
            ['Up Next Bumper (Happy Days) (2000)', ['days']],
            ['Up Next Bumper (Jeffersons) (2001)', ['jeff']],
            ['Up Next Bumper (Murphy Brown)', ['murphy']],
            ['Up Next Bumper (Roseanne) (2005)', ['rose']],
            ['Up Next Bumper (The Facts of Life)', ['facts']],
            ["Up Next Bumper (Three's Company) (2001)", ['three']],
            ["Up Next Bumper (Who's the boss)", ['boss']],
            ['Full House NEXT promo', ['house']],
            ['Wonder Years NEXT Promo', ['wonder']],
        ];
        // Compare ignoring a leading "The" and a trailing "?", which is the only thing the two vocabularies differ by.
        const plain = (t) => showMatch.fold(t).replace(/^the /, '');
        for (const [label, v] of [['with "The"', plex], ['without "The"', bare]]) {
            const wrong = CLIPS.filter( ([title, want]) => {
                const got = showMatch.propose(title, v, {}).names.map( (k) => plain(k.slice(3)) );
                return got.join() !== want.map( (w) => plain(T[w]) ).join();
            } ).map( ([title]) => title );
            suite.check(`every Up Next clip names its show when Plex titles the shows ${label}`, wrong.length === 0, wrong.join(' | '));
        }
        suite.check('"(Back 2 Back)", "(More)" and "(back2back)" do not stop the show being found',
            ['(Back 2 Back)', '(back 2 back)', '(back2back)', '(More)', '(more)'].every( (tag) =>
                showMatch.propose(`Up Next Bumper (Full House) ${tag}`, plex, {}).names.join() === 'tv.Full House') );
        suite.check('two years in parentheses do not stop it either',
            showMatch.propose('Up Next Bumper (Fresh Prince of Bel-Air) (2004) (2024)', plex, {}).names.join() === 'tv.The Fresh Prince of Bel-Air');

        // A show stood alone in its own brackets can drop "The" even when one word is left.
        suite.check('"(Jeffersons)" names The Jeffersons: a bracketed word is a title on its own',
            showMatch.propose('Up Next Bumper (Jeffersons) (2001)', plex, {}).names.join() === 'tv.The Jeffersons');
        suite.check('a hit found only because the word stood alone says so, and an ordinary hit does not',
            showMatch.propose('Up Next Bumper (Jeffersons)', plex, {}).found[0].standalone === true
            && typeof(showMatch.propose('Up Next Bumper (The Jeffersons)', plex, {}).found[0].standalone) === 'undefined');
        suite.check('but "Jeffersons" inside a longer phrase still names nothing',
            showMatch.propose('Jeffersons promo', plex, {}).names.length === 0
            && showMatch.propose('The Jeffersons promo', plex, {}).names.join() === 'tv.The Jeffersons');
        const office = nite(['The Office', 'Office Space Spoof']);
        suite.check('"Office Space" does not name The Office, "(Office)" does',
            showMatch.propose('Office Space promo', office, {}).names.join() === ''
            && showMatch.propose('Promo (Office)', office, {}).names.join() === 'tv.The Office');
        suite.check('a bracketed word is only a title on its own when it is long enough to be one',
            showMatch.propose('Promo (Wire)', nite(['The Wire']), {}).names.length === 0);
        suite.check('a one-word show is found after a dash too',
            showMatch.propose('Bumper - Jeffersons', plex, {}).names.join() === 'tv.The Jeffersons');
    }

    // ---- years inside show titles ---------------------------------------------
    {
        const years = showMatch.buildVocabulary([channel(8, [
            ep('ThunderCats (2011)'), ep('Teenage Mutant Ninja Turtles (2003)'), ep('Doodle Squad'),
            ep("G.I. Joe: A Real American Hero ('83)"), ep("G.I. Joe: A Real American Hero ('89)"),
            ep('The Wonder Years'), ep('The Wonder Years (2021)'),
        ].map( (p) => p ))], {});
        const n = (t) => showMatch.propose(t, years, {}).names.join();
        suite.check('a show Plex titles with a year is found without it', n('ThunderCats Promo') === 'tv.ThunderCats (2011)');
        suite.check('and with it', n('ThunderCats (2011) Promo') === 'tv.ThunderCats (2011)');
        suite.check('the year-less title is shown as what matched',
            showMatch.propose('ThunderCats Promo', years, {}).found[0].text === 'thundercats');
        suite.check('a longer title with a year still beats a shorter one without',
            n('Teenage Mutant Ninja Turtles (2003) Promo') === 'tv.Teenage Mutant Ninja Turtles (2003)');
        suite.check('two eras of one show: the year in the clip picks the era',
            n("G.I. Joe: A Real American Hero ('89) Promo") === "tv.G.I. Joe: A Real American Hero ('89)");
        const either = showMatch.propose('G.I. Joe: A Real American Hero Promo', years, {});
        suite.check('and with no year the match says another era exists',
            either.names.length === 1 && either.found[0].alsoKeys.length === 1, JSON.stringify(either.found));
        suite.check('a remake and the original: the plain title keeps the original',
            n('The Wonder Years Promo') === 'tv.The Wonder Years'
            && showMatch.propose('The Wonder Years Promo', years, {}).found[0].alsoKeys.join() === 'tv.The Wonder Years (2021)');
        suite.check('a year in the middle of a title is left alone',
            showMatch.buildVocabulary([channel(7, [ep('Class of 3000'), ep('Sealab 2021')])], {})
                .entries.every( (e) => e.folded === 'class of 3000' || e.folded === 'sealab 2021' ));
    }

    // ---- a clip in a lineup is not a show --------------------------------------
    {
        const lineup = channel(6, [
            ep('Home Movies'),
            { title: '[As] NEXT - Home Movies (2003)', type: 'movie', duration: 10 * 1000, key: '/m/n', serverKey: 's' },
            { title: 'Quick Gag', type: 'episode', showTitle: 'Quick Gag', duration: 40 * 1000 },
            custom('shorts', 'Tiny Toons Shorts'),
        ]);
        lineup.programs[3].duration = 20 * 1000;
        const v = showMatch.buildVocabulary([lineup], {});
        const keys = v.entries.map( (e) => e.key );
        suite.check('a movie or episode under a minute is a clip, not a show',
            keys.indexOf('movie.[As] NEXT - Home Movies (2003)') === -1 && keys.indexOf('tv.Quick Gag') === -1);
        suite.check('so a NEXT promo for Home Movies names Home Movies, not itself',
            showMatch.propose('[As] NEXT - Home Movies (2003)', v, {}).names.join() === 'tv.Home Movies');
        suite.check('an episode of real length still counts', keys.indexOf('tv.Home Movies') !== -1);
        suite.check('a custom show of short items is still a show', keys.indexOf('custom.shorts') !== -1);
    }

    // ---- words that describe a clip are never learned as aliases ---------------
    {
        const own = showMatch.buildVocabulary([channel(5, [ep('Full House'), ep('Roseanne')])], {});
        const learned = showMatch.learnAliases('Up Next Bumper (Full House) (Back 2 Back)', 'tv.Full House', own, {}, []);
        suite.check('"back", "up" and a number are not learned from a "(Back 2 Back)" clip',
            Object.keys(learned.added).length === 0, JSON.stringify(learned.added));
        const more = showMatch.learnAliases('Up Next Bumper (Roseanne) (More) (back2back)', 'tv.Roseanne', own, {}, []);
        suite.check('"more" and "back2back" are not learned either',
            Object.keys(more.added).length === 0, JSON.stringify(more.added));
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

    // ---- shortened titles: the part before a colon ---------------------------------
    {
        const vocabS = showMatch.buildVocabulary(FIX_CHANNELS, { g2: 'Mobile Suit Gundam Series' });
        const p = (t) => showMatch.propose(t, vocabS, {});
        suite.check('"Ghost In The Shell NEXT promo" names Ghost in the Shell: Stand Alone Complex',
            names(p('Adult Swim AcTN - Ghost In The Shell NEXT promo')) === FIXK.sac, names(p('Adult Swim AcTN - Ghost In The Shell NEXT promo')));
        suite.check('... and says it came from a shortened title',
            p('Ghost In The Shell NEXT promo').found.length === 1 && p('Ghost In The Shell NEXT promo').found[0].shortened === true);
        suite.check('the whole title still names it, and is not marked',
            names(p('Ghost in the Shell: Stand Alone Complex promo')) === FIXK.sac
            && p('Ghost in the Shell: Stand Alone Complex promo').found[0].shortened !== true);
        suite.check('a part before the colon that is another show\'s whole title is not offered: "Transformers" is the plain show',
            names(p('Transformers promo')) === FIXK.transformers && p('Transformers promo').found[0].shortened !== true
            && typeof(p('Transformers promo').found[0].alsoKeys) === 'undefined');
        suite.check('... and the longer title still names its own show',
            names(p('Transformers: Robots In Disguise promo')) === FIXK.tfRid);
        const joe = p('G.I. Joe promo');
        suite.check('two shows sharing the part before the colon: one is proposed and the other reported, marked shortened',
            joe.names.length === 1 && joe.found[0].alsoKeys && joe.found[0].alsoKeys.length === 1 && joe.found[0].shortened === true
            && [FIXK.joe83, FIXK.joe89].includes(joe.names[0]) && [FIXK.joe83, FIXK.joe89].includes(joe.found[0].alsoKeys[0]), JSON.stringify(joe));
        suite.check('a part before the colon under three letters is not offered ("Be: Something Long")',
            p('be happy now').names.length === 0);
        suite.check('a leading "The" is optional on a shortened title too',
            names(p('Adventures of Jimmy Neutron promo')) === FIXK.jimmy && names(p('The Adventures of Jimmy Neutron promo')) === FIXK.jimmy);
        suite.check('one word before the colon is enough: "Avatar" names Avatar: The Last Airbender, marked shortened',
            names(p('Nick.com promo (Avatar)')) === FIXK.avatar && p('Nick.com promo (Avatar)').found[0].shortened === true);
        suite.check('a title with no colon gets no shortened form: "Sealab" alone names nothing',
            p('Sealab promo').names.length === 0);
    }

    // ---- spacing: "DragonBall GT" is "Dragon Ball GT" -------------------------------
    {
        const vocabS = showMatch.buildVocabulary(FIX_CHANNELS, { g2: 'Mobile Suit Gundam Series' });
        const p = (t) => showMatch.propose(t, vocabS, {});
        suite.check('"DragonBall GT NEXT Promo" names Dragon Ball GT, not the shorter Dragon Ball',
            names(p('DragonBall GT NEXT Promo')) === FIXK.gt, names(p('DragonBall GT NEXT Promo')));
        suite.check('"DragonBall Z" names Dragon Ball Z and "Dragonball" names Dragon Ball',
            names(p('Toonami - NEXT [DragonBall Z]')) === FIXK.dbz && names(p('Dragonball promo')) === FIXK.db);
        suite.check('it works the other way: "Inu Yasha" names InuYasha',
            names(p('Inu Yasha NEXT promo')) === FIXK.inuyasha);
        suite.check('respacing is not a shortened title, and is not marked as one',
            p('DragonBall GT NEXT Promo').found.length === 1 && p('DragonBall GT NEXT Promo').found[0].shortened !== true);
        suite.check('a title already matched as written is found once, not again by its respaced twin',
            p('Dragon Ball Z promo').found.length === 1 && names(p('Dragon Ball Z promo')) === FIXK.dbz);
        suite.check('words are only joined when they sit side by side: a title taken out between them breaks the join',
            names(p('Seal Dragon Ball Z ab 2021')) === FIXK.dbz, names(p('Seal Dragon Ball Z ab 2021')));
        suite.check('a one-word show is found when the clip splits it, and not inside a longer word',
            names(p('Inu Yasha')) === FIXK.inuyasha && p('Inu Yashas promo').names.length === 0);
        suite.check('a short title is not respaced: "Ben 10" is found as written, but "Be N 10" is not "Ben 10"',
            names(p('Ben 10 promo')) === 'tv.Ben 10' && p('Be N 10 promo').names.length === 0);
        suite.check('a clip that names no show still proposes nothing', p('Adult Swim Bumper 5').names.length === 0);
    }

    // ---- shortened titles: a generic last word dropped -----------------------------
    {
        const vocabS = showMatch.buildVocabulary(FIX_CHANNELS, { g2: 'Mobile Suit Gundam Series' });
        const p = (t) => showMatch.propose(t, vocabS, {});
        suite.check('"Mobile Suit Gundam NEXT [1]" names the custom show "Mobile Suit Gundam Series"',
            names(p('Mobile Suit Gundam NEXT [1]')) === FIXK.gundam, names(p('Mobile Suit Gundam NEXT [1]')));
        suite.check('... marked as from a shortened title',
            p('Mobile Suit Gundam NEXT [1]').found.length === 1 && p('Mobile Suit Gundam NEXT [1]').found[0].shortened === true);
        suite.check('the whole title still names it, unmarked',
            names(p('Mobile Suit Gundam Series promo')) === FIXK.gundam && p('Mobile Suit Gundam Series promo').found[0].shortened !== true);
        suite.check('"Show" goes too, and a leading "The" is optional: "Tex Avery" names The Tex Avery Show',
            names(p('The Tex Avery promo')) === FIXK.tex && names(p('Tex Avery promo')) === FIXK.tex
            && p('Tex Avery promo').found[0].shortened === true);
        suite.check('two words are needed: "The Cosby" names The Cosby Show, "Cosby" alone does not',
            names(p('Up Next (The Cosby)')) === FIXK.cosby && p('Up Next (Cosby)').names.length === 0);
        suite.check('a shortened form that is another show\'s whole title is left to that show: "Tom & Jerry" is the plain one',
            names(p('Tom & Jerry promo')) === FIXK.tj && p('Tom & Jerry promo').found[0].shortened !== true
            && typeof(p('Tom & Jerry promo').found[0].alsoKeys) === 'undefined');
        suite.check('only the last word is dropped: "Series" in the middle of a title is kept',
            p('Gundam Series Mobile Suit promo').names.length === 0);
        suite.check('a word in the middle is not a last word: "The Big Late Show Live" is not "Big Late"',
            p('Big Late promo').names.length === 0 && names(p('The Big Late Show Live promo')) === 'tv.The Big Late Show Live');
        suite.check('a title of one word and "Show" is not shortened to that one word: "Gumball" names nothing',
            p('Gumball promo').names.length === 0 && names(p('Gumball Show promo')) === 'tv.Gumball Show');
        suite.check('a title that is only the generic word and one more is not shortened to a single word',
            p('Ben 10 promo').found[0].shortened !== true);
    }

    // ---- a two-show title is never half-read ------------------------------------------
    {
        const vocabS = showMatch.buildVocabulary(FIX_CHANNELS, { g2: 'Mobile Suit Gundam Series' });
        const p = (t, a) => showMatch.propose(t, vocabS, a || {});
        const nowThen = 'CN City Now\u2044Then (Foster\u2019s \u2044 Camp Lazlo) (2006)';
        suite.check('"Now/Then (Foster\'s / Camp Lazlo)" with only Camp Lazlo recognised names nothing',
            p(nowThen).names.length === 0, JSON.stringify(p(nowThen)));
        suite.check('... and is flagged, with the one show that was recognised',
            p(nowThen).unresolved && p(nowThen).unresolved.recognised.join() === FIXK.lazlo
            && typeof(p(nowThen).unresolved.reason) === 'string' && p(nowThen).unresolved.reason.length > 0);
        suite.check('... and still reports what it did find, for the review screen',
            p(nowThen).found.length === 1 && p(nowThen).found[0].key === FIXK.lazlo);
        const aToB = 'CN Next (Dexter\u2019s Lab to Ed, Edd n Eddy) [Hypno]';
        suite.check('"A to B" with only B recognised is the same: unnamed and flagged',
            p(aToB).names.length === 0 && p(aToB).unresolved && p(aToB).unresolved.recognised.join() === FIXK.ed, JSON.stringify(p(aToB)));
        suite.check('"A to B" with only A recognised too, and without brackets',
            p('Ed, Edd n Eddy to Dexter\u2019s Lab [Slingshot]').names.length === 0
            && p('Ed, Edd n Eddy to Dexter\u2019s Lab [Slingshot]').unresolved.recognised.join() === FIXK.ed
            && p('Acme Hour to Cow & Chicken [Balloon]').names.length === 0
            && p('Acme Hour to Cow & Chicken [Balloon]').unresolved.recognised.join() === FIXK.cow);
        suite.check('both shows recognised: a pair, not flagged',
            names(p('CN City Now\u2044Then (Camp Lazlo \u2044 Foster\'s Home for Imaginary Friends)')) === `${FIXK.lazlo},${FIXK.fosters}`
            && typeof(p('CN City Now\u2044Then (Camp Lazlo \u2044 Foster\'s Home for Imaginary Friends)').unresolved) === 'undefined');
        suite.check('"A to B" with both recognised is a pair too',
            names(p('CN Next (Ed, Edd n Eddy to Cow and Chicken) [Hypno]')) === `${FIXK.ed},${FIXK.cow}`);
        suite.check('one show under "Now/Then" with no second show is simply that show',
            names(p('CN CITY Now\u2044Then (Camp Lazlo) (2006)')) === FIXK.lazlo
            && typeof(p('CN CITY Now\u2044Then (Camp Lazlo) (2006)').unresolved) === 'undefined');
        suite.check('the same show on both sides is one show named twice, not a half-read pair',
            names(p('CN Bumper (Camp Lazlo ⁄ Camp Lazlo)')) === FIXK.lazlo
            && typeof(p('CN Bumper (Camp Lazlo ⁄ Camp Lazlo)').unresolved) === 'undefined');
        suite.check('a show whose own title has " to " in it is one show, not a pair',
            names(p('Space Ghost Coast to Coast promo')) === FIXK.sgc && typeof(p('Space Ghost Coast to Coast promo').unresolved) === 'undefined');
        suite.check('a lower-case word after "to" is ordinary English, not a second show',
            names(p('Camp Lazlo back to the beginning')) === FIXK.lazlo && typeof(p('Camp Lazlo back to the beginning').unresolved) === 'undefined');
        suite.check('a pair with neither side recognised is just unnamed, and not flagged',
            p('CN City Now\u2044Then (Grim Advs \u2044 Foster\u2019s)').names.length === 0
            && typeof(p('CN City Now\u2044Then (Grim Advs \u2044 Foster\u2019s)').unresolved) === 'undefined');
        suite.check('both shown on the same side is not a half-read pair: two shows named is a pair as before',
            names(p('Ed, Edd n Eddy and Camp Lazlo \u2044 promo')) === `${FIXK.ed},${FIXK.lazlo}`);
        suite.check('once the nickname is taught the same title is a pair and is not flagged',
            names(p(nowThen, { foster: FIXK.fosters })) === `${FIXK.fosters},${FIXK.lazlo}`
            && typeof(p(nowThen, { foster: FIXK.fosters }).unresolved) === 'undefined');
        suite.check('a respaced title is placed correctly: "DragonBall GT to Camp Lazlo" is a pair',
            names(p('Next (DragonBall GT to Camp Lazlo)')) === `${FIXK.gt},${FIXK.lazlo}`);

        // The reason this matters for the review screen: a half-read clip used to count as a clip naming
        // Camp Lazlo, which made "foster" look like another show's word and so impossible to teach.
        const titles = [nowThen, 'CN City Now\u2044Then (Grim Advs \u2044 Camp Lazlo) (2006)', 'CN City YES! Era NEXT; Camp Lazlo (2006)'];
        const corpus = titles.map( (t) => ({ title: t, names: p(t).names }) );
        const learned = showMatch.learnAliases('CN City YES! Era NEXT; Foster\u2019s (2006)', FIXK.fosters, vocabS, {}, corpus);
        suite.check('so with the half-read clips unnamed, "foster" can be learned as the nickname for Foster\'s',
            learned.added.foster === FIXK.fosters, JSON.stringify(learned));
    }

    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
