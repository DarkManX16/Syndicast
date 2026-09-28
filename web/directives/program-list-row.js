/*
 * One row of a program list - the color square, name, a compact season/
 * episode or disc/track tag, an episode/track title or a movie's year on a
 * second line, and (when show-gauge is on) a gauge. Display only - the info
 * and delete buttons still delegate to whatever the parent list already does
 * for those.
 *
 * Two layouts, chosen by show-start-time:
 * - off (custom shows, filler lists): line 1 ends with the exact duration.
 * - on (the channel's programming list, a live schedule rather than a
 *   content list): line 1 leads with the program's absolute start time
 *   instead, and the exact duration moves to the front of line 2, since
 *   that's how the position of a program in 40,000 is actually found.
 *
 * Two gauges, chosen by break-after-mode:
 * - off (custom shows): slotFitGauge, the smallest standard slot the item
 *   fits and the time left in it for breaks - a planning tool for content
 *   that isn't scheduled to a clock yet.
 * - on (the channel's programming list): the real Flex/redirect time that
 *   already follows the item in the lineup (program.$breakAfterMs, kept
 *   current by channel-config.js's updateChannelDuration), since here the
 *   break is a fact already on the schedule, not a plan.
 *
 * Shared markup, not shared state: this directive has no knowledge of the
 * list it's in beyond these two flags and program.$breakAfterMs.
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
            <span class="plr-start-time" ng-if="showStartTime">{{ startTime() }}</span>
            <span class="plr-name">{{ rowName() }}</span>
            <span class="plr-tag" ng-if="rowTag()">{{ rowTag() }}</span>
            <span class="plr-duration" ng-if="!showStartTime">{{ exactDuration() }}</span>
        </div>
        <div class="plr-line2">{{ rowLineTwo() }}</div>
        <div class="plr-gauge" ng-if="showGauge">
            <div class="plr-gauge-bar" ng-style="{visibility: (gauge() &amp;&amp; gauge().fillPercent !== null) ? 'visible' : 'hidden'}">
                <div class="plr-gauge-fill" ng-style="{width: (gauge() &amp;&amp; gauge().fillPercent !== null ? gauge().fillPercent : 0) + '%'}"></div>
            </div>
            <span class="plr-gauge-label">{{ gauge() ? gauge().label : '' }}</span>
        </div>
    </div>
    <div class="flex-pull-right">
        <button class="btn btn-sm btn-link" ng-if="!program.isOffline" ng-click="onInfo(program); $event.stopPropagation()">
            <i class="fas fa-info-circle"></i>
        </button>
        <button class="btn btn-sm btn-link" ng-click="onDelete(program); $event.stopPropagation()">
            <i class="text-danger fa fa-trash-alt"></i>
        </button>
    </div>
</div>
`,
        replace: true,
        scope: {
            program: "=program",
            showGauge: "=showGauge",
            showStartTime: "=showStartTime",
            breakAfterMode: "=breakAfterMode",
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

            scope.startTime = () => {
                return (scope.program && scope.program.start) ? commonProgramTools.startTimeString(scope.program.start) : '';
            }

            // The "show name" line: the show/album for an episode or track,
            // otherwise the item's own title - there's no separate show to
            // name for a movie, redirect or plain clip. A custom show's own
            // name is prefixed on top of that, the way getProgramDisplayTitle
            // used to fold it into a single line, since once a custom show's
            // clip is placed in a real channel it's the one thing here that
            // isn't already implied by being in this list (unlike inside the
            // custom show's own editor, where it's the show you're editing).
            scope.rowName = () => {
                let p = scope.program;
                if (!p) {
                    return '';
                }
                if (p.isOffline) {
                    return (p.type === 'redirect') ? ('Redirect to channel: ' + p.channel) : 'Flex';
                }
                let name = (p.type === 'episode' || p.type === 'track') ? p.showTitle : p.title;
                if (typeof(p.customShowId) !== 'undefined') {
                    name = p.customShowName + ' · ' + name;
                }
                return name;
            }

            scope.rowTag = () => {
                let p = scope.program;
                if (!p || p.isOffline) {
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
            // said everything it has on line one - except in show-start-time
            // mode, where line one has no room left for the exact duration,
            // so it leads here instead (Flex/redirect included, since a
            // break's own length is exactly the thing worth showing for it).
            scope.rowLineTwo = () => {
                let p = scope.program;
                if (!p) {
                    return '';
                }
                let text = '';
                if (!p.isOffline) {
                    if (p.type === 'episode' || p.type === 'track') {
                        text = p.title;
                    } else if (p.type === 'movie' && (typeof(p.year) !== 'undefined') && (p.year !== null)) {
                        text = String(p.year);
                    }
                }
                if (scope.showStartTime) {
                    let duration = commonProgramTools.exactDurationString(p.duration);
                    return text ? (duration + ' · ' + text) : duration;
                }
                return text;
            }

            scope.gauge = () => {
                if (!scope.showGauge || !scope.program || scope.program.isOffline) {
                    return null;
                }
                if (scope.breakAfterMode) {
                    let ms = scope.program.$breakAfterMs;
                    if (typeof(ms) !== 'number') {
                        return null;
                    }
                    if (ms <= 0) {
                        return { label: 'no break', fillPercent: null };
                    }
                    return { label: 'break after: ' + commonProgramTools.exactDurationString(ms), fillPercent: null };
                }
                return commonProgramTools.slotFitGauge(scope.program);
            }
        }
    };
}
