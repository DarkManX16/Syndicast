module.exports = function (dizquetv, dragRecorder) {
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

            // The drag log (web/services/drag-recorder.js): read fresh each
            // time it is opened, with the text to copy.
            scope.dragLog = null;
            let readDragLog = () => {
                scope.dragLog = {
                    count: dragRecorder.sessions().length,
                    text: dragRecorder.text(),
                    copied: '',
                };
            };
            scope.toggleDragLog = () => {
                if (scope.dragLog) {
                    scope.dragLog = null;
                } else {
                    readDragLog();
                }
            };
            scope.refreshDragLog = readDragLog;
            scope.copyDragLog = () => {
                let done = (msg) => { scope.dragLog.copied = msg; scope.$applyAsync(); };
                // Where the clipboard API is refused: select the text, and try the older copy command on it.
                let manual = () => {
                    let box = element.find('textarea')[0];
                    let copied = false;
                    if (box) {
                        box.focus();
                        box.select();
                        try {
                            copied = document.execCommand('copy');
                        } catch (e) {
                            copied = false;
                        }
                    }
                    done(copied ? 'Copied.' : 'Could not copy: the text below is selected, press Ctrl+C.');
                };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(scope.dragLog.text).then(() => done('Copied.'), manual);
                } else {
                    manual();
                }
            };
            scope.clearDragLog = () => {
                dragRecorder.clear();
                readDragLog();
            };
        }
    };
}
