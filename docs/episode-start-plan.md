# Episode Start Implementation Plan

**Goal:** Ron picks which episode a position plays next, once - Play Next, or "Air next" for Shuffle and Rerun - from the Time Slots editor, seeing each position's next episode and when it airs. Channels saved today don't change unless he sets one.

**Design (agreed Oct 10, 2026):** NOTES.md, Known issues, "Episode start". This plan does not restate its reasons.

## Global Constraints

- Never stop, restart or signal the server on port 18000, or any process this work didn't start.
- Code only in the worktree `C:\Projects\dizquetv\.claude\worktrees\episode-start`, branch `episode-start` (from `blocks` at 57334c6). `node_modules` resolves from the main checkout: never `npm install` here.
- Test only on copies of `.dizquetv-dev`. Before a proof is reported: diff the copy's channels against `.dizquetv-dev`, re-copy if they differ, state the snapshot time.
- Additive: a schedule with no start generates program for program what it generates now.
- Docs and code never name other playout programs.
- Commit messages: `Episode start: <what changed>`, ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Steps

1. **The planner takes starts.** `src/slot-progress.js`: `storiesOf` and `restOfRoundOf` hoisted out of `planProgress`; `startRecord` (Play Next: the position's place; Shuffle and Rerun: the rest of the round as a queue with the pick's story first); `planProgress({ starts })`, `starts` being `{ [positionKey]: { key, order } }`. Tests first in `test/slot-progress.js`; the generators play the result (`test/progress-generators.js`).
2. **The editor's model, pure.** `src/episode-start.js`: when a position first airs (`firstAiring`), every row's next episode from the real orderers (`describe`), the picker's list with why an episode can't be picked (`options`), the doubling and Rerun warnings. `test/episode-start.js`.
3. **The editor.** The row line, the panel (season then episode, "Start here", undo), Start from season folded in, warnings, a dropped-start note. Bundle rebuilt.
4. **Proof tooling.** `scripts/progress-check.js --start`.
5. **Proofs on copies, then the live preview** (port 18200, from the worktree, on a copy), then NOTES.
