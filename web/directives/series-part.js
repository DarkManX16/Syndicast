/*
 * "Which part" of a custom show that joins several series: the whole custom show, or one or more of
 * its series, and when exactly one series is ticked that has several seasons, every season of it or
 * some. The way a show with seasons offers its seasons. Used by the names review screen (the picker
 * and the nickname panel), by every member of an "any one of" name and by the Nicknames page.
 *
 * `part` is a slot or a panel (src/names-review.js: { key, kind, series, seriesSeasons, picked });
 * `source` has hasSeries/list/ticked/seasonChoices (web/series-source.js). With `radios` the whole-or-
 * series choice is drawn here (kind 'all' or 'series'); without it the screen has its own radio for
 * 'series' and this draws the series and seasons once that is chosen. `onChange` runs after anything
 * here is changed.
 */
module.exports = function () {
    return {
        restrict: 'E',
        templateUrl: 'templates/series-part.html',
        scope: {
            part: '=',
            source: '<',
            radios: '<',
            onChange: '&',
        },
        link: function (scope) {
            scope.changed = () => scope.onChange();
        },
    };
};
