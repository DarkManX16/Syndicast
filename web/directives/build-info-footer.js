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
            scope.startTime = null;

            dizquetv.getVersion().then((version) => {
                scope.version = version.dizquetv;
                scope.gitCommit = version.gitCommit;
                scope.startTime = version.startTime;
            });
        }
    };
}
