/*
 * One row of a program list - the color square, name, a compact season/
 * episode or disc/track tag, exact duration, an episode/track title or a
 * movie's year on a second line, and (when show-gauge is on) a slot-fit
 * gauge. Display only - the info and delete buttons still delegate to
 * whatever the parent list already does for those.
 *
 * Shared markup, not shared state: this directive has no knowledge of the
 * list it's in, only the one program it's given.
 */
module.exports = function (commonProgramTools) {
    return {
        restrict: 'E',
        // Inline, not templateUrl: this directive is repeated inside
        // vs-repeat lists, which measure the first rendered row's height
        // (offsetHeight, right after the initial digest) to lay out every
        // other row at the same assumed height. A templateUrl fetch is
        // async, so that first measurement would land before the real
        // template loaded - locking in the empty row's ~24px min-height for
        // every row, and every row's real two-line content would then
        // overlap the next one. Found live: rows rendered correctly by every
        // measure (getProgramDisplayTitle text, exact duration, gauge label
        // all correct), but visually overlapped, because vs-repeat had
        // positioned them 24px apart while they were actually ~64px tall.
        template: `
<div class="list-group-item flex-container program-list-row" style="cursor: default;">
    <div class="plr-square" ng-style="squareStyle()"></div>
    <div class="plr-body">
        <div class="plr-line1">
            <span class="plr-name">{{ rowName() }}</span>
            <span class="plr-tag" ng-if="rowTag()">{{ rowTag() }}</span>
            <span class="plr-duration">{{ exactDuration() }}</span>
        </div>
        <div class="plr-line2">{{ rowLineTwo() }}</div>
        <div class="plr-gauge" ng-if="showGauge">
            <div class="plr-gauge-bar">
                <div class="plr-gauge-fill" ng-style="{width: (gauge() ? gauge().fillPercent : 0) + '%'}"></div>
            </div>
            <span class="plr-gauge-label">{{ gauge() ? gauge().label : '' }}</span>
        </div>
    </div>
    <div class="flex-pull-right">
        <button class="btn btn-sm btn-link" ng-if="!program.isOffline" ng-click="onInfo(program)">
            <i class="fas fa-info-circle"></i>
        </button>
        <button class="btn btn-sm btn-link" ng-click="onDelete(program)">
            <i class="text-danger fa fa-trash-alt"></i>
        </button>
    </div>
</div>
`,
        replace: true,
        scope: {
            program: "=program",
            showGauge: "=showGauge",
            onInfo: "=onInfo",
            onDelete: "=onDelete",
        },
        link: function (scope, element, attrs) {
            scope.squareStyle = () => {
                return scope.program ? { 'background': commonProgramTools.programColorStyle(scope.program) } : {};
            }

            scope.exactDuration = () => {
                return scope.program ? commonProgramTools.exactDurationString(scope.program.duration) : '';
            }

            // The "show name" line: the show/album for an episode or track,
            // otherwise the item's own title - there's no separate show to
            // name for a movie, redirect or plain clip.
            scope.rowName = () => {
                let p = scope.program;
                if (!p) {
                    return '';
                }
                if (p.type === 'episode' || p.type === 'track') {
                    return p.showTitle;
                }
                return p.title;
            }

            scope.rowTag = () => {
                let p = scope.program;
                if (!p) {
                    return '';
                }
                if (p.type === 'episode') {
                    return 'S' + p.season + ' · E' + p.episode;
                }
                if (p.type === 'track') {
                    if (typeof(p.season) === 'number' && p.season > 1) {
                        return 'Disc ' + p.season + ' · Track ' + p.episode;
                    }
                    return 'Track ' + p.episode;
                }
                return '';
            }

            // Episodes and tracks get their own title here, since the name
            // above is the show/album, not this item. A movie has no second
            // name, so its year goes here instead. Everything else already
            // said everything it has on line one.
            scope.rowLineTwo = () => {
                let p = scope.program;
                if (!p) {
                    return '';
                }
                if (p.type === 'episode' || p.type === 'track') {
                    return p.title;
                }
                if (p.type === 'movie' && (typeof(p.year) !== 'undefined') && (p.year !== null)) {
                    return String(p.year);
                }
                return '';
            }

            scope.gauge = () => {
                if (!scope.showGauge || !scope.program) {
                    return null;
                }
                return commonProgramTools.slotFitGauge(scope.program);
            }
        }
    };
}
