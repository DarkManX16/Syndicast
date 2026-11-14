/*
 * One frame of a file, for the Breaks page: <breaks-frame path="..." t="98.1" label="before">.
 * The server cuts it on request (src/break-frames.js) and may say why it cannot - the drive
 * is skipped, a viewer is catching up - which is shown where the picture would be.
 */
module.exports = function ($http) {
    const clock = (s) => {
        const t = Math.max(0, s);
        const m = Math.floor(t / 60);
        return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
    };
    return {
        restrict: 'E',
        scope: { path: '=', t: '=', label: '@' },
        template: `
            <div class="bk-frame">
                <div class="bk-frame-box">
                    <img ng-if="url" ng-src="{{url}}" alt="">
                    <div class="bk-frame-msg text-muted small" ng-if="!url">{{message}}</div>
                </div>
                <div class="bk-frame-cap small text-muted">{{label}} &middot; {{caption}}</div>
            </div>`,
        link: function (scope) {
            let current = 0;
            const forget = () => {
                if (scope.url) {
                    URL.revokeObjectURL(scope.url);
                }
                scope.url = null;
            };
            const load = () => {
                forget();
                if ( (scope.path == null) || (typeof(scope.t) !== 'number') ) {
                    return;
                }
                const mine = ++current;
                scope.caption = clock(scope.t);
                scope.message = 'cutting the picture…';
                $http.get('/api/breaks/frame', { params: { path: scope.path, t: scope.t }, responseType: 'blob' }).then( (r) => {
                    if (mine === current) {
                        scope.url = URL.createObjectURL(r.data);
                    }
                }, async (err) => {
                    if (mine !== current) {
                        return;
                    }
                    let why = 'no picture';
                    try {
                        why = JSON.parse(await err.data.text()).error || why;
                    } catch (e) {
                        // the answer was not a message
                    }
                    scope.message = why;
                    scope.$applyAsync();
                } );
            };
            scope.$watchGroup( [ 'path', 't' ], load );
            scope.$on('$destroy', () => { current++; forget(); });
        },
    };
};
