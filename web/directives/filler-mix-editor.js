/*
 * The list/weight/cooldown editor for one filler mix. Extracted from the
 * channel editor's Flex tab so day-parts can reuse it for their own mixes
 * instead of a third copy of this logic - see docs/blocks-spec.md, stage 1.
 *
 * `mix` is mutated in place, the same way the Flex tab always mutated
 * channel.fillerCollections directly: rows carry `cooldownMinutes`,
 * `percentage` and `options` as UI-only fields alongside the real `id`,
 * `weight` and `cooldown` (ms) the caller persists, and it is the caller's
 * job to convert cooldownMinutes back to cooldown and strip the UI-only
 * fields before saving - exactly as channel-config.js already does for the
 * channel's own mix.
 */
const editor = require('../../src/transitions-editor');
const dateRange = require('../../src/date-range');

module.exports = function () {
    return {
        restrict: 'E',
        templateUrl: 'templates/filler-mix-editor.html',
        replace: true,
        scope: {
            mix: '=mix',
            fillerOptions: '=fillerOptions',
        },
        link: function (scope, element, attrs) {
            scope.uid = scope.$id;

            let fillerOptionsFor = (index) => {
                let used = {};
                let added = {};
                for (let i = 0; i < scope.mix.length; i++) {
                    if (scope.mix[i].id != 'none' && i != index) {
                        used[ scope.mix[i].id ] = true;
                    }
                }
                let options = [];
                for (let i = 0; i < scope.fillerOptions.length; i++) {
                    if ( used[scope.fillerOptions[i].id] !== true) {
                        added[scope.fillerOptions[i].id] = true;
                        options.push( scope.fillerOptions[i] );
                    }
                }
                if (scope.mix[index].id == 'none') {
                    added['none'] = true;
                    options.push( {
                        id: 'none',
                        name: 'Add a filler list...',
                    } );
                }
                if ( added[scope.mix[index].id] !== true ) {
                    options.push( {
                        id: scope.mix[index].id,
                        name: `[${scope.mix[index].id}]`,
                    } );
                }
                return options;
            }

            let updatePercentages = () => {
                let w = 0;
                for (let i = 0; i < scope.mix.length; i++) {
                    if (scope.mix[i].id !== 'none') {
                        w += scope.mix[i].weight;
                    }
                }
                for (let i = 0; i < scope.mix.length; i++) {
                    if (scope.mix[i].id !== 'none') {
                        scope.mix[i].percentage = (scope.mix[i].weight * 100 / w).toFixed(2) + "%";
                    }
                }
            };

            let addAddFiller = () => {
                if ( (scope.mix.length == 0) || (scope.mix[scope.mix.length-1].id !== 'none') ) {
                    scope.mix.push ( {
                        'id': 'none',
                        'weight': 300,
                        'cooldown': 0,
                    } );
                }
            }

            let refreshIndividualOptions = () => {
                for (let i = 0; i < scope.mix.length; i++) {
                    scope.mix[i].options = fillerOptionsFor(i);
                }
            }

            scope.refresh = () => {
                if ( (typeof(scope.mix) === 'undefined') || (scope.mix == null) ) {
                    return;
                }
                addAddFiller();
                updatePercentages();
                refreshIndividualOptions();
            }

            scope.deleteRow = (index) => {
                if ( (scope.datesForm !== null) && (scope.datesForm.row === scope.mix[index]) ) {
                    scope.datesForm = null;
                }
                scope.mix.splice(index, 1);
                scope.refresh();
            }

            /*
             * Dates on a row (NOTES.md, "Event tools"): one calendar button per
             * row opens From and To under it. Both or neither, as a step's
             * dates (transitions-editor.js's setDates); cleared, the row loses
             * the key, so a row nobody dates saves exactly as it was. The open
             * form lives on the scope, never on the row, so nothing of it is saved.
             */
            scope.datesForm = null;
            scope.toggleDates = (x) => {
                if ( (scope.datesForm !== null) && (scope.datesForm.row === x) ) {
                    scope.datesForm = null;
                    return;
                }
                scope.datesForm = {
                    row: x,
                    from: editor.dateInputOf(x.dates && x.dates.from),
                    to: editor.dateInputOf(x.dates && x.dates.to),
                    error: '',
                };
            };
            scope.datesChanged = () => {
                let f = scope.datesForm;
                let result = editor.setDates(f.row, f.from, f.to);
                f.error = result.ok ? '' : result.error;
                if (result.ok && (f.row.dates === null)) {
                    delete f.row.dates;
                }
            };
            scope.datesWord = (x) => editor.datesChipWord(x);
            scope.datesPassed = (x) => dateRange.passed(x.dates, Date.now());

            scope.$watch('fillerOptions', () => {
                scope.refresh();
            });
        }
    };
}
