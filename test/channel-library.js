/*
 * The channel detail page's Library tab (src/channel-library.js): the Movies tab also lists
 * the movies that sit inside custom shows, 40 minutes or longer, the same rule as the names
 * picker, each labelled with its custom show; the custom show's own tile stays under Shows.
 *
 * Driven with the real getShowData the page uses and fixtures only.
 */
const { MIN, Suite } = require('./support');
const clipNames = require('../src/clip-names');
const showMatch = require('../src/show-match');
const channelLibrary = require('../src/channel-library');
const makeShowData = require('../web/services/get-show-data');

const AFTERTOON = { id: 'at', name: 'AfterToon Movies' };
const DCOM = { id: 'dc', name: 'Friday DCOM Movies' };
const LOONEY = { id: 'lt', name: 'Looney Tunes' };

let counter = 0;
function movie(title, mins, custom, order) {
    const m = { title, type: 'movie', duration: mins * MIN, serverKey: 'srv', key: '/m/' + title, ratingKey: 'm-' + title, icon: 'icon-' + title };
    if (custom) {
        m.customShowId = custom.id;
        m.customShowName = custom.name;
        m.customOrder = (typeof(order) === 'number') ? order : counter++;
    }
    return m;
}
function episode(show, season, n, mins, custom, order) {
    const e = { title: `${show} S${season}E${n}`, type: 'episode', showTitle: show, season, episode: n, duration: (mins || 22) * MIN, serverKey: 'srv', key: `/e/${show}/${season}/${n}`, ratingKey: `${show}-${season}-${n}` };
    if (custom) {
        e.customShowId = custom.id;
        e.customShowName = custom.name;
        e.customOrder = (typeof(order) === 'number') ? order : counter++;
    }
    return e;
}
const track = { title: 'A Song', type: 'track', showTitle: 'An Album', duration: 3 * MIN, serverKey: 'srv', key: '/t/1', season: 1, episode: 1 };
const flex = { isOffline: true, duration: 5 * MIN };
const redirect = { isOffline: true, type: 'redirect', channel: 4, duration: 30 * MIN };

const lib = (programs) => channelLibrary.buildLibrary(programs, makeShowData());

module.exports = async function run() {
    const suite = new Suite('channel-library');

    // ---- a lineup like channel 3's -----------------------------------------------------
    {
        const programs = [
            movie('Halloweentown', 84, DCOM, 0), movie('Halloweentown II: Kalabar\'s Revenge', 81, DCOM, 1),
            movie('Alvin and the Chipmunks Meet Frankenstein', 81, AFTERTOON, 0), movie('Mickey\'s House of Villains', 68, AFTERTOON, 1),
            movie('Rabbit Fire', 8, LOONEY, 0), movie('Duck Amuck', 7, LOONEY, 1),
            episode('Lizzie McGuire', 1, 1), episode('Lizzie McGuire', 1, 2),
            movie('The Parent Trap', 128),                                  // a movie of its own
            movie('Halloweentown', 84, DCOM, 0),                            // the same item airs again
            flex, redirect, track,
        ];
        const result = lib(programs);
        const rows = result.movies.map( (m) => `${m.title}${m.inCustomShow ? ' [in ' + m.inCustomShow + ']' : ''}${m.count > 1 ? ' x' + m.count : ''}` );
        suite.check('the Movies tab lists a movie of its own and the long movies inside custom shows, by title, each labelled with its custom show',
            rows.join(' | ') === "Alvin and the Chipmunks Meet Frankenstein [in AfterToon Movies] | Halloweentown [in Friday DCOM Movies] x2 | Halloweentown II: Kalabar's Revenge [in Friday DCOM Movies] | Mickey's House of Villains [in AfterToon Movies] | The Parent Trap",
            rows.join(' | '));
        suite.check('a movie of its own has no custom show label', result.movies.find( (m) => m.title === 'The Parent Trap' ).inCustomShow === undefined);
        suite.check('the shorts inside a custom show are not movies here', ! result.movies.some( (m) => /Rabbit Fire|Duck Amuck/.test(m.title) ));
        suite.check('the count is one row per movie, and the same item airing twice is counted twice', result.movies.length === 5 && result.movies.find( (m) => m.title === 'Halloweentown' ).count === 2);
        suite.check('each row carries what the page shows: the program, its icon and its length',
            result.movies[0].program.title === 'Alvin and the Chipmunks Meet Frankenstein' && result.movies[0].icon === 'icon-Alvin and the Chipmunks Meet Frankenstein' && result.movies[0].durationMs === 81 * MIN);
        const tiles = result.shows.map( (g) => `${g.title}${g.isCustomShow ? ' (custom)' : ''}:${g.itemCount}` );
        suite.check('the custom shows keep their tiles under Shows, with every item including the movies and shorts they hold',
            tiles.join(' | ') === 'AfterToon Movies (custom):2 | Friday DCOM Movies (custom):2 | Lizzie McGuire:2 | Looney Tunes (custom):2', tiles.join(' | '));
        suite.check('music, Flex and redirects are as they were',
            result.music.length === 1 && result.other.flexCount === 1 && result.other.flexDurationMs === 5 * MIN && result.other.redirects.length === 1 && result.other.redirects[0].channel === 4);
    }

    // ---- the length rule ---------------------------------------------------------------
    {
        const just = movie('Forty Exactly', 40, DCOM, 0);
        const under = movie('Thirty Nine Fifty Nine', 40 - 1 / 60, DCOM, 1);
        const result = lib([just, under]);
        suite.check('40 minutes is a movie, a second less is not', result.movies.length === 1 && result.movies[0].title === 'Forty Exactly');
        suite.check('a movie of its own is listed whatever its length, as it always was',
            lib([movie('A Short One', 5)]).movies.length === 1);
        suite.check('an episode a custom show holds, however long, is not a movie',
            lib([episode('Some Show', 1, 1, 90, DCOM, 0)]).movies.length === 0);
        suite.check('a custom show holding only movies still has its tile and no row twice',
            (() => { const r = lib([just]); return r.shows.length === 1 && r.shows[0].isCustomShow && r.movies.length === 1; })());
        suite.check('a movie without a title is not listed in a custom show (it could not be named either)',
            lib([Object.assign(movie('x', 60, DCOM, 0), { title: '' })]).movies.length === 0);
    }

    // ---- one movie in two custom shows -------------------------------------------------
    {
        const result = lib([movie('Twitches', 86, { id: 'sat', name: 'SATurday Disney Movies' }, 0), movie('Twitches', 86, { id: 'sun', name: 'Sunday Disney Movies' }, 0)]);
        suite.check('the same movie in two custom shows is listed once for each, each with its own label',
            result.movies.map( (m) => m.inCustomShow ).join(' | ') === 'SATurday Disney Movies | Sunday Disney Movies' );
    }

    // ---- the same rule as the names picker ---------------------------------------------
    {
        suite.check('the page and the picker share one length', clipNames.MOVIE_MIN_MS === showMatch.MOVIE_MIN_MS && clipNames.MOVIE_MIN_MS === 40 * MIN);
        const programs = [ movie('Halloweentown', 84, DCOM, 0), movie('Short A', 12, LOONEY, 0), movie('Long B', 41, AFTERTOON, 0), movie('Short C', 39, AFTERTOON, 1),
            movie('Own Movie', 95), movie('Own Short', 9) ];
        const vocabulary = showMatch.buildVocabulary([ { number: 1, programs } ], { dc: 'Friday DCOM Movies', lt: 'Looney Tunes', at: 'AfterToon Movies' });
        const picker = vocabulary.movies.filter( (m) => m.custom !== null ).map( (m) => m.name + '|' + m.custom ).sort();
        const tab = lib(programs).movies.filter( (m) => m.inCustomShow ).map( (m) => m.title + '|' + m.inCustomShow ).sort();
        suite.check('the custom-show movies the Movies tab lists are exactly the ones the picker offers, with the same custom show',
            picker.join() === tab.join() && picker.length === 2, picker.join(' ; ') + ' vs ' + tab.join(' ; '));
    }

    return suite;
};

if (require.main === module) {
    module.exports().then( (suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    } );
}
