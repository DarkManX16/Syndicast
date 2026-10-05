/*
 * How the rest of the page opens the names review screen (stage 5, step 6): the
 * Filler Lists page, the filler list editor and the transitions preview all call
 * `namesReview.open(listId)`, and the one screen mounted in index.html answers.
 */
module.exports = function () {
    let opener = null;
    return {
        // Called by the screen itself once, with the function that opens it.
        register: (fn) => {
            opener = fn;
        },
        open: (listId) => {
            if (opener !== null) {
                opener(listId);
            }
        },
    };
};
