/*
 * The "i" button's panel - display only, never touches how a program is
 * saved or played. Everything except the Plex library name is already on
 * the program object wherever it was added from the library picker
 * (services/plex.js's getNested); the library name isn't stored anywhere,
 * so it's the one field fetched live, one request per open, scoped to
 * exactly the item being looked at - never for the list behind it.
 */
module.exports = function (plex, dizquetv) {
    return {
        restrict: 'E',
        templateUrl: 'templates/program-info-panel.html',
        replace: true,
        scope: {
            program: "=program",
        },
        link: function (scope, element, attrs) {
            scope.close = () => {
                scope.program = null;
            };

            scope.durationString = (duration) => {
                if (typeof(duration) !== 'number' || isNaN(duration) || duration < 0) {
                    return 'Unknown';
                }
                var date = new Date(0);
                date.setSeconds(Math.floor(duration / 1000));
                return date.toISOString().substr(11, 8);
            }

            scope.thumbnail = (program) => {
                return program ? (program.episodeIcon || program.icon) : null;
            }

            // Only the response matching the most recently opened program is
            // allowed to write scope.library - a slow request for a program
            // the user has since closed or replaced must not land late and
            // show the wrong library.
            let requestSeq = 0;

            scope.$watch('program', (program) => {
                scope.library = null;
                scope.libraryLoading = false;
                requestSeq++;
                if (!program || !program.ratingKey || !program.serverKey) {
                    return;
                }
                const seq = requestSeq;
                scope.libraryLoading = true;
                dizquetv.getPlexServers().then((servers) => {
                    const server = servers.find((s) => s.name === program.serverKey);
                    if (!server) {
                        throw new Error('No configured Plex server matches ' + program.serverKey);
                    }
                    return plex.getMetadata(server, program.ratingKey);
                }).then((library) => {
                    if (seq !== requestSeq) {
                        return;
                    }
                    scope.library = library || 'Unknown';
                    scope.libraryLoading = false;
                    scope.$apply();
                }).catch((err) => {
                    console.error('Could not fetch Plex library info for the info panel', err);
                    if (seq !== requestSeq) {
                        return;
                    }
                    scope.library = 'Unknown';
                    scope.libraryLoading = false;
                    scope.$apply();
                });
            });
        }
    };
}
