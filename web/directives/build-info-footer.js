module.exports = function (dizquetv) {
    return {
        restrict: 'E',
        templateUrl: 'templates/build-info-footer.html',
        replace: true,
        scope: {
        },
        link: function (scope, element, attrs) {
            scope.version = "";
            scope.gitCommit = "";
            scope.gitDirty = false;
            scope.startTime = null;
            scope.bundleStale = false;

            dizquetv.getVersion().then((version) => {
                scope.version = version.dizquetv;
                scope.gitCommit = version.gitCommit;
                scope.gitDirty = version.gitDirty;
                scope.startTime = version.startTime;
                scope.bundleStale = version.bundleStale;
            });
        }
    };
}
