/*
 * scripts/lib/custom-movie-show.js: the checklist's breaks-page workflow marks a movie inside
 * a custom show theatrical from the show's own Movies list. It used to take the first custom
 * show in /api/breaks/shows' list, which is in next-airing order, so which show it took
 * depended on the time of day. On Nov 15, 2026 between about 8:15 and 8:30pm Sunday Disney
 * Movies (airing at 7:00pm) came first; step 3 of the same workflow had left it open on the
 * page, and step 5's click on its name closed it ("Sunday Disney Movies's Movies list didn't
 * show"). The pick is now by name, whatever the order the list came in.
 */
const { Suite } = require('./support');
const pick = require('../scripts/lib/custom-movie-show');

const custom = (name, nextAt, extra) => Object.assign({ name, key: `custom.${name}`, kind: 'custom', movieFiles: 2, theatrical: false, nextAt }, extra);
const movie = (name, extra) => Object.assign({ path: `D:\\${name}.mkv`, name, movie: true, unscanned: false, theatrical: false }, extra);

module.exports = async function run() {
    const suite = new Suite('custom-movie-pick');
    const names = (shows) => pick.customShowsWithMovies(shows).map( (s) => s.name );

    const sunday = custom('Sunday Disney Movies', 1000);
    const friday = custom('Friday DCOM Movies', 2000);
    const after = custom('AfterToon Movies', null);

    suite.check('the list at 8:15pm (Sunday airing first) and at 11:48pm (nothing airing) give the same order',
        JSON.stringify(names([ sunday, friday, after ])) === JSON.stringify(names([ after, friday, sunday ])),
        JSON.stringify([ names([ sunday, friday, after ]), names([ after, friday, sunday ]) ]));
    suite.check('...by name', JSON.stringify(names([ sunday, friday, after ])) === JSON.stringify([ 'AfterToon Movies', 'Friday DCOM Movies', 'Sunday Disney Movies' ]), JSON.stringify(names([ sunday, friday, after ])));
    suite.check('...and the first is the same show whichever airs first',
        pick.customShowsWithMovies([ sunday, friday, after ])[0] === after && pick.customShowsWithMovies([ after, sunday, friday ])[0] === after);
    suite.check('a name in other case does not move a show', JSON.stringify(names([ custom('sunday Z', 1), custom('Sunday A', 2), custom('afterToon', 3) ])) === JSON.stringify([ 'afterToon', 'Sunday A', 'sunday Z' ]), JSON.stringify(names([ custom('sunday Z', 1), custom('Sunday A', 2), custom('afterToon', 3) ])));
    suite.check('two shows with one name keep an order by key',
        pick.customShowsWithMovies([ custom('Same', 1, { key: 'custom.b' }), custom('Same', 2, { key: 'custom.a' }) ]).map( (s) => s.key ).join() === 'custom.a,custom.b');

    const left = names([
        custom('Marked theatrical', 1, { theatrical: true }),
        custom('No movie files', 2, { movieFiles: 0 }),
        { name: 'A movie line', key: 'movie.x', kind: 'movie', movieFiles: 1, theatrical: false, nextAt: 3 },
        { name: 'A tv line', key: 'tv.x', kind: 'tv', movieFiles: 0, theatrical: false, nextAt: 4 },
        friday,
    ]);
    suite.check('theatrical shows, shows with no movie, movies and tv shows are passed over', JSON.stringify(left) === JSON.stringify([ 'Friday DCOM Movies' ]), JSON.stringify(left));
    suite.check('the list is not changed', (() => { const l = [ sunday, after ]; pick.customShowsWithMovies(l); return l[0] === sunday && l[1] === after; })());

    const scanned = movie('Scanned.mkv');
    const never = movie('Never scanned.mkv', { unscanned: true });
    suite.check('a movie never scanned is taken first, as the step covers a show nobody scanned',
        pick.movieIn({ episodes: [ scanned, never ] }) === never);
    suite.check('...else a scanned one', pick.movieIn({ episodes: [ scanned ] }) === scanned);
    suite.check('...never one already theatrical, an episode that is no movie, or a name with a character the page types badly',
        pick.movieIn({ episodes: [ movie('Done.mkv', { theatrical: true }), movie('Episode.mkv', { movie: false }), movie('Caf\u00e9.mkv') ] }) === null);
    suite.check('...and the first by name when several qualify, not the first in the list',
        pick.movieIn({ episodes: [ movie('B.mkv'), movie('A.mkv') ] }).name === 'A.mkv');
    return suite;
};
