/*
 * One member of an "any one of" name: a show, a custom show or a movie to pick, and for a show
 * with seasons, any episode of it, some of its seasons, or one special. The same row on the
 * names review screen (the picker and the teach panel) and on the Nicknames page, so a member
 * means the same thing wherever it is picked.
 *
 * `member` is a slot (src/names-review.js: { key, kind, picked, special }) that the screen owns;
 * `source` is what the screen offers: options(current) is the list to pick from, label(option)
 * its text, and ensure/hasParts/choices/specials/state are web/season-source.js. `onChange`
 * runs after anything in the row is changed, `onRemove` when the row is removed.
 */
module.exports = function () {
    return {
        restrict: 'E',
        templateUrl: 'templates/name-member.html',
        scope: {
            member: '=',
            source: '=',
            removable: '<',
            onChange: '&',
            onRemove: '&',
        },
        link: function (scope) {
            scope.keyChanged = () => {
                scope.member.kind = 'all';
                scope.member.picked = {};
                scope.member.special = '';
                scope.source.ensure(scope.member.key);
                scope.onChange();
            };
            scope.folderText = (c) => (c.folder.length > 40) ? c.folder.slice(0, 40) + '…' : c.folder;
        },
    };
};
