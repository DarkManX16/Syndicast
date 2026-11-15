/*
 * One frame of a file, for the Breaks page: <breaks-frame path="..." t="98.1" label="before">.
 * The server cuts it on request (src/break-frames.js) and may say why it cannot - the drive
 * is skipped, a viewer is catching up - which is shown where the picture would be.
 *
 * Saves never wait behind frames (docs/blocks-spec.md, step 5c): a browser keeps at most six
 * requests open to one server and holds every further one, an Approve included, until one
 * finishes; a slow drive's frames used to fill all six. So the page keeps at most two frame
 * requests open, the newest (the point on screen) first, and a frame it no longer shows has
 * its request cancelled, not just its answer ignored.
 */
const MAX_OPEN = 2;

module.exports = function ($http, $q) {
    const clock = (s) => {
        const t = Math.max(0, s);
        const m = Math.floor(t / 60);
        return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
    };

    // Shared by every frame on the page: requests waiting their turn, newest last, and how many are open.
    const waiting = [];
    let open = 0;
    const pump = () => {
        while ( (open < MAX_OPEN) && (waiting.length > 0) ) {
            const job = waiting.pop();
            open++;
            $http.get('/api/breaks/frame', { params: job.params, responseType: 'blob', timeout: job.cancel.promise })
                .then(job.done, job.failed)
                .finally( () => {
                    open--;
                    pump();
                } );
        }
    };
    const request = (params, done, failed) => {
        const job = { params, done, failed, cancel: $q.defer() };
        waiting.push(job);
        pump();
        return () => {
            const i = waiting.indexOf(job);
            if (i >= 0) {
                waiting.splice(i, 1);
            }
            job.cancel.resolve('left');
        };
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
            let cancel = null;
            const forget = () => {
                if (cancel !== null) {
                    cancel();
                    cancel = null;
                }
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
                cancel = request( { path: scope.path, t: scope.t }, (r) => {
                    if (mine === current) {
                        cancel = null;
                        scope.url = URL.createObjectURL(r.data);
                    }
                }, async (err) => {
                    if (mine !== current) {
                        return;
                    }
                    cancel = null;
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
