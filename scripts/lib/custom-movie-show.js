/*
 * The custom show, and the movie in it, that the checklist's breaks-page workflow marks
 * theatrical from the show's own Movies list. `shows` is /api/breaks/shows' list, which
 * is in the order the shows next air, so what is first there changes with the time of
 * day; these are by name, so the same show is tried every run.
 */

// Custom shows with a movie in them that are not marked theatrical, by name (then key).
function customShowsWithMovies(shows) {
    return shows
        .filter( (s) => (s.kind === 'custom') && (s.movieFiles > 0) && !s.theatrical )
        .sort( (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key) );
}

// The movie in an opened custom show (/api/breaks/show's answer) to mark: one never scanned
// when there is one, else any; a name of plain characters only, which the workflow can find
// in the page. By name, whatever order the episodes came in.
function movieIn(detail) {
    const plain = detail.episodes
        .filter( (e) => e.movie && !e.theatrical && /^[\x20-\x7e]+$/.test(e.name) )
        .sort( (a, b) => a.name.localeCompare(b.name) );
    return plain.find( (e) => e.unscanned ) || plain[0] || null;
}

module.exports = { customShowsWithMovies, movieIn };
