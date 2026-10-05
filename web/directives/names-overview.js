/*
 * The overview on the Filler Lists page (stage 5, step 6): every filler list with
 * how many of its clips are flagged, less certain, confident, saved or without a
 * suggestion, the lists the channels' transition steps use first, so it is clear
 * which lists to open. A row opens that list's names review screen.
 */
module.exports = function ($timeout, dizquetv, namesReview) {
    return {
        restrict: 'E',
        templateUrl: 'templates/names-overview.html',
        replace: true,
        scope: {},
        link: function (scope) {
            scope.open = false;
            scope.loading = false;
            scope.error = '';
            scope.lists = null;

            const load = async () => {
                scope.loading = true;
                scope.error = '';
                try {
                    scope.lists = (await dizquetv.getNamesOverview()).lists;
                } catch (err) {
                    console.error(err);
                    scope.error = 'Unable to read the lists.';
                } finally {
                    scope.loading = false;
                    $timeout();
                }
            };

            scope.toggle = () => {
                scope.open = ! scope.open;
                if (scope.open) {
                    load();
                }
            };
            scope.refresh = load;
            scope.review = (list) => namesReview.open(list.id);

            // A save on the review screen changes the counts.
            const stopListening = scope.$root.$on('namesSaved', () => {
                if (scope.open) {
                    load();
                }
            });
            scope.$on('$destroy', stopListening);

            scope.used = () => (scope.lists || []).filter( (l) => l.usedBy.length > 0 );
            scope.others = () => (scope.lists || []).filter( (l) => l.usedBy.length === 0 );
            scope.usedBy = (list) => list.usedBy.map( (c) => `${c.number} ${c.name}` ).join(', ');
            scope.usedNeedLook = () => scope.used().reduce( (n, l) => n + l.needsLook, 0 );
        },
    };
};
