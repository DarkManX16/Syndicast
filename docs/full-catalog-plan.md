# Full Catalogs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every slot can draw on its show's or custom show's full catalog - once Ron has reviewed that show - with a per-channel never-air list that keeps removed episodes out for good, and stored progress continuing exactly where it is.

**Architecture:** The rules live in one pure module, `src/show-catalog.js` (what a review lists, the pool for a run, what's new, applying ops), shared by the editors through browserify, the Catalog page, the server and the proof scripts. Catalogs are read in the browser with the library's own Plex code through `src/catalog-reader.js`, which takes its I/O as arguments so a script and a test can drive it too. The state is `channel.catalog`, written only by a new ops API; the server's generators don't change - the editor hands them a bigger pool.

**Tech Stack:** Node, AngularJS 1 bundled by browserify, the repo's `test/support.js` Suite. No new dependencies.

**Spec:** NOTES.md, Known issues, "Full catalogs, and a never-air list". Read it before any task; this plan argues from it and does not restate its reasons.

## Global Constraints

- Never stop, restart or signal the server on port 18000, or any process this work didn't start.
- Code changes only in the worktree `C:\Projects\dizquetv\.claude\worktrees\stored-progress`, branch `full-catalog` (from `stored-progress` at 4fe2261). Its `node_modules` is a junction to the main checkout: never `npm install` here; a needed dependency goes into the main checkout. None is planned.
- Test only on copies of `.dizquetv-dev`: `C:\Projects\dizquetv-worktrees\stored-progress-proof` (channels and custom shows), `stored-progress-data` (a full data folder, for the preview), `stored-progress-sep29` (Sep 29's channel 1). Before a step's proof is reported, diff `.dizquetv-dev/channels`, `custom-shows`, `filler` and `show-aliases.json` against the copy, re-copy if they differ, re-run, and state the snapshot time.
- Plex is read only: GET requests, the token as a header, never printed. Catalog snapshots hold program objects whose icon URLs carry the token, exactly as channel files do: they stay in the scratchpad or the copies' folder and are never committed.
- Every channel saved today keeps working and is never rebuilt: no `channel.catalog` means nothing reviewed, and Create Lineup gives the lineup it gives now, program for program.
- Docs and code describe the design on its own terms and never name other playout programs.
- Opus 5.5 end to end; `npm test` passes at the end of every task (1869/1869 at the start).
- Commit messages: `Catalog: <what changed>`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Live checks: a preview server started by hand from the worktree (`node index.js -p 18200 -d C:/Projects/dizquetv-worktrees/stored-progress-data --unlock`, Bash background), restarted after any server-code change, and the browser tab reloaded after any `npm run build` - a hash-only navigate keeps the old bundle.

## Review Focus

- **A show renamed in Plex since it was added** - catalog items carry Plex's new `grandparentTitle`; they must take the channel's title, or the show's slots find nothing. Test in Task 1.
- **Plex failing part way through a read** - some shows read, some time out: those fall back to the lineup's own episodes and are named; Create Lineup completes. Test in Task 2.
- **A channel page open in another tab, saved after a review on the Catalog page** - the stored `channel.catalog` survives the stale save. Test in Task 4.
- **A never-air episode that is a Play Next's place, or that a Repeat's source aired** - the place moves to the next episode; the Repeat plays its Rerun fallback. Test in Task 3.
- **A custom show reordered between runs** - its pool follows the custom show's current order while the place stays on the same item (by file key). Test in Task 1.

---

## Step 1 - The rules and the reader (no behaviour change)

### Task 1: `src/show-catalog.js`, the rules

**Files:**
- Create: `src/show-catalog.js`
- Create: `test/show-catalog.js` (add `'./show-catalog'` to `test/run.js`)

**Interfaces:**
- Consumes: `rounds.fileKey(program)` (`serverKey|key`), `getShowData(program)` (`showId`, `order`, `hasShow`).
- Produces (pure; a "catalog" is `{ items: program[], source }` or `{ error: string }`; `state` is the spec's `channel.catalog` shape):
  - `emptyState() -> { shows: {}, neverAir: {} }`; `stateOf(channel) -> state` (a copy; `emptyState()` when absent).
  - `showKeysOf(programs) -> string[]` - distinct `/library/metadata/(\d+)/thumb` matches in `showIcon`.
  - `fromPlex(items, server, showTitle) -> program[]` - each item copied as `plex-library.js`'s `selectItem` copies it (`server` deleted, `serverKey = server.name`, a JSON round trip), `showTitle` set to the channel's.
  - `fromCustom(show) -> program[]` - `show.content` stamped as `addCustomShow` stamps it (`customShowId`, `customShowName`, `customOrder = index`).
  - `specialsAllowed(lineupItems) -> boolean` - any season-0 episode among a Plex show's lineup items.
  - `isNeverAir(state, program) -> boolean`; `withoutNeverAir(programs, state) -> program[]`.
  - `neverAirEntry(program, getShowData, how, now) -> { key, entry }` - `entry = { showId, season, episode, title, at, how }`, `how` one of `"review" | "deleted" | "new"`.
  - `toAdd({ items, lineupItems, state, specials }) -> program[]` - catalog items whose file key the lineup doesn't hold and the list doesn't name; season 0 dropped unless `specials`.
  - `reviewList({ lineupPool, catalogs, state, getShowData }) -> [{ showId, name, count, seasons: [{ season, episodes: program[] }] }]` - unreviewed shows with `count > 0` only, `count` descending.
  - `poolFor({ lineupPool, slotted, catalogs, state, getShowData }) -> { pool, complete, fresh, fellBack, known }` - `slotted` is the showIds with a slot; `pool` as the spec's "Create Lineup" paragraph; `complete` the unreviewed showIds whose catalog had nothing to add (they join the pool from their catalog, identical episodes); `fresh: { showId: program[] }` catalog episodes of reviewed shows not in `known`, the lineup or the list (these are in `pool`); `fellBack: [{ showId, reason }]`; `known: { showId: string[] }` every file key each read catalog held.
  - `applyOps(state, ops, now) -> state` - ops `{ review }`, `{ neverAir }`, `{ restore }`, `{ known }` exactly as the spec's Shapes; unknown ops throw.

- [ ] **Step 1: Write the failing tests** in `test/show-catalog.js`, fixtures built like `test/slot-progress.js`'s `episode()` with `showIcon` set:
  - `showKeysOf reads the show key from showIcon` (and none from a program without one)
  - `fromPlex copies items as the library adds them, with the channel's show title` - `server` absent, `serverKey` the server's name, `showTitle` the given title even when the item's differs
  - `fromCustom stamps items as addCustomShow does`
  - `toAdd leaves out what the lineup holds and the never-air list names` and `...and season 0 unless specials`
  - `reviewList lists unreviewed shows with something to add, most first, by season`; `...not reviewed shows, not complete ones`
  - `poolFor with nothing reviewed is the lineup pool, less the never-air list` - same objects, same order
  - `poolFor keeps a reviewed Plex show's lineup copies and adds its other catalog episodes`
  - `poolFor takes a reviewed custom show's current list and order` (a fixture reordered since the lineup; `customOrder` follows the custom show)
  - `poolFor falls back to the lineup for a show it couldn't read, and names it`
  - `poolFor names new episodes of reviewed shows, and marks complete shows` 
  - `applyOps: review, never air, restore and known, in order; an unknown op throws`

- [ ] **Step 2:** `node -e "require('./test/show-catalog')().then(s=>console.log(s.failures))"` - Expected: fails on the missing module.
- [ ] **Step 3:** Implement `src/show-catalog.js`.
- [ ] **Step 4:** `npm test` - Expected: all pass.
- [ ] **Step 5:** Commit `Catalog: the rules for full catalogs and a never-air list`.

### Task 2: Reading catalogs, and a snapshot on the copies

**Files:**
- Create: `src/catalog-reader.js`, `test/catalog-reader.js` (add to `test/run.js`), `scripts/catalog-snapshot.js`
- Modify: `web/services/plex.js` (one function)

**Interfaces:**
- Consumes: Task 1's `showKeysOf`, `fromPlex`, `fromCustom`.
- Produces:
  - `web/services/plex.js`: `getShowKey(server, ratingKey) -> Promise<string|undefined>` - `Metadata[0].grandparentRatingKey` of `/library/metadata/<ratingKey>`.
  - `readCatalogs({ shows, servers, getNested, getShowKey, getShow, concurrency }) -> Promise<{ [showId]: catalog }>` - `shows: [{ showId, title, lineupItems, source }]`; a Plex show's keys from `source`, else `showKeysOf(lineupItems)`, else `getShowKey` on its first episode; `getNested(server, { key: '/library/metadata/<k>/allLeaves' }, false, errors)` per key, items of several keys joined; a custom show via `getShow(id)`; `concurrency` default 8; a failure becomes that show's `{ error }`, never a rejection.
  - `node scripts/catalog-snapshot.js --data <copy> --plex <plex-servers.json> --out <file> [--channels 1,2,3]` - every show on each channel, `getNested` from `web/services/plex.js` called in Node (its factory doesn't need Angular for it), custom shows from `<copy>/custom-shows`; writes `{ "<n>": { showId: catalog } }` and prints counts and the time taken.

- [ ] **Step 1: Write the failing tests**, stubs for the I/O: `reads a Plex show by its showIcon key`, `...by its episode when showIcon has none`, `joins two Plex shows of one title`, `reads a custom show`, `a failed read is that show's error and the rest still read`, `never runs more than concurrency at once`.
- [ ] **Step 2:** run them - Expected: fail, module missing.
- [ ] **Step 3:** Implement `readCatalogs`, `getShowKey` and the snapshot script.
- [ ] **Step 4:** `npm test` - Expected: all pass.
- [ ] **Step 5: Proof on the copies.** `scripts/catalog-snapshot.js` on the proof copy: every show on channels 1-3 read, 0 errors, time per channel. For each episode the lineup holds, the snapshot's copy against the lineup's, field for field on `title, key, ratingKey, type, duration, file, plexFile, showTitle, season, episode, serverKey` - Expected: 0 differences, or each one explained. `reviewList` over the snapshot - Expected: the investigation's counts (226 short Plex shows, 14 custom; Double Dare 414 to add, Married... with Children 208).
- [ ] **Step 6:** Commit `Catalog: reading a show's catalog with the library's own code`.

## Step 2 - Regeneration from full catalogs (scripts only)

### Task 3: The planner's catalog, and progress-check on full catalogs

**Files:**
- Modify: `src/slot-progress.js` (`planProgress`, `rerunNote`), `scripts/progress-check.js`, `test/slot-progress.js`, `test/progress-repeat.js`

**Interfaces:**
- Consumes: Task 1's `poolFor`, `applyOps`, `withoutNeverAir`; Task 2's snapshot file.
- Produces:
  - `planProgress({ ..., pool, catalog })` - `catalog` (program[], default `pool`) for every candidate list; `pool` only for `legacyCarry`, which rebuilds the old shuffler's round from what that shuffler shuffled.
  - `rerunNote({ ..., pool })` is passed the catalog pool by its callers; no signature change.
  - `progress-check` gains `--catalog <snapshot> --review <regex|all> [--never-air <keys.json>]`: state built with `applyOps` - each matching show reviewed with everything ticked, `specials` by `specialsAllowed`, `known` its snapshot keys - then `poolFor`, and the history filtered with `withoutNeverAir`, as the editor will.

- [ ] **Step 1: Write the failing tests:** in `test/slot-progress.js`, `a carried round is rebuilt from the lineup's list, not the catalog` (a fixture whose catalog adds stories: the queue equals the one from the lineup alone) and `a new round covers the catalog`; in `test/progress-repeat.js`, `a Repeat whose source aired a never-air episode plays a Rerun` (history filtered as the editor filters it) and, in `test/slot-progress.js`, `a Play Next place on a never-air episode moves to the next`.
- [ ] **Step 2:** run them - Expected: the first fails (one pool for both); the others fail on `catalog` being ignored.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` - Expected: all pass.
- [ ] **Step 5: Proof on the copies**, Fri 10am, Sat 11pm and Mon 10am, channels 1-3 and Sep 29's channel 1:
  - nothing reviewed (`--catalog` without `--review`): the regenerated lineup equals the one without `--catalog`, program for program - Expected: identical on all four;
  - `--review all`: every position continues exactly (138/164/155/50); channel 3's 18 carried rounds identical through their ends; `progress-audit` 0 violations; regenerated again from the output, continues exactly;
  - per short show, distinct episodes aired in the year, before against after - Expected: Double Dare past item 52, Married... with Children past S4E8, every short show more;
  - `--never-air` with ten sampled keys (a Play Next place, a Shuffle's next, a Repeat source among them): 0 airings of any in the year; specials air only for shows whose lineup aired one.
- [ ] **Step 6:** Commit `Catalog: the planner and progress-check draw on full catalogs`.

## Step 3 - The catalog state on the server

### Task 4: `channel.catalog`, its ops API, and saves that keep it

**Files:**
- Modify: `src/services/channel-service.js`, `src/api.js`, `src/dao/plex-server-db.js`
- Create: `test/channel-catalog.js` (temp data folder, as `test/channel-save.js`; add to `test/run.js`)

**Interfaces:**
- Consumes: Task 1's `applyOps`, `emptyState`.
- Produces:
  - `channelService.getCatalog(number) -> state`; `channelService.applyCatalogOps(number, ops) -> state` (loads the stored channel, `applyOps`, saves once).
  - `saveChannel(number, json, { keepCatalog: true })` - copies the stored channel's `catalog` over whatever `json` holds; both `/api/channel` routes pass it.
  - `GET /api/channel/:number/catalog`, `POST /api/channel/:number/catalog { ops }` -> the new state; a bad op is a 400 with its message.
  - `fixupAllChannels` renames a renamed server's name in `catalog.neverAir` keys, every `known` key and `source.plex`.
  - `web/services/dizquetv.js`: `getChannelCatalog(number)`, `applyChannelCatalogOps(number, ops)`.

- [ ] **Step 1: Write the failing tests:** `ops are applied and saved`, `a channel save keeps the stored catalog whatever it sends`, `the other writers keep it` (filler and on-demand saves of the stored channel), `a renamed Plex server renames its catalog keys`, `a channel with no catalog reads as empty`.
- [ ] **Step 2:** run - Expected: fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` - Expected: all pass.
- [ ] **Step 5: Proof on the preview copy**, preview restarted with this code: a `review` and a `neverAir` op through `POST` on channel 2, the file holds them; a channel save sent with the catalog stripped leaves it intact; the other channels' files unchanged.
- [ ] **Step 6:** Commit `Catalog: the channel's catalog state and its API`.

## Step 4 - Create Lineup on full catalogs

### Task 5: The slot editors read catalogs and build the pool

**Files:**
- Create: `web/services/show-catalog.js` (registered in `web/app.js`)
- Modify: `web/directives/time-slots-schedule-editor.js`, `web/public/templates/time-slots-schedule-editor.html`, `web/directives/random-slots-schedule-editor.js` (and its template), `web/directives/channel-config.js`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces:
  - Angular service `showCatalog.read(shows) -> Promise<catalogs>` - `readCatalogs` with `plex.getNested`, `plex.getShowKey`, `dizquetv.getShow`, `dizquetv.getPlexServers()`.
  - `startDialog(programs, limit, backup, instant, slotScope, lineup, catalogState)` (Time Slots; Random Slots takes `catalogState` last too) - the stored state with the channel page's queued ops applied. The read starts at open for every slotted show; Create Lineup awaits it, then `poolFor`, `planProgress({ pool: lineup pool, catalog: result pool })`, history through `withoutNeverAir`, and `calculateTimeSlots(result pool, ...)`.
  - The result carries `catalogOps`: `{ known }` for each read catalog, `{ review: { by: 'complete', ... } }` for each `complete` show, `{ neverAir }` for each one-click Never air.
  - `channel-config.js`: loads the state when a channel opens (`getChannelCatalog`), queues every result's `catalogOps`, sends the queue with `applyChannelCatalogOps` after a successful save, and drops it on Cancel.
  - Dialog notes, above the slot list: "Reading N shows' episode lists..." until done; "New in Plex since the last run" by show and season, each episode with **Never air**; "Couldn't read: <show> (<reason>) - using the episodes already in the lineup"; "N shows have episodes to review" linking to `#!/channels/<n>/catalog`.

- [ ] **Step 1: Build and live-check on the preview** (no directive harness; each finding reproduced in the browser, fixed and re-checked there):
  - Married... with Children reviewed on the preview copy by API op; Time Slots on channel 2, Create Lineup, Update Channel: the notes appear, the saved lineup airs it past S4E8 within the year, `progress-check --from` the saved file continues exactly, its `known` saved; a second Create Lineup continues exactly.
  - Plex unreachable (the preview copy's server URI pointed at a closed port, preview restarted): the dialog names every show it couldn't read, the lineup is today's for them, nothing blocks.
  - One key removed from Married...'s `known` by op: the dialog names it as new; **Never air** takes it out of the run; after Update Channel the list has it with `how: "new"` and the lineup doesn't air it.
- [ ] **Step 2:** `npm test` - Expected: all pass.
- [ ] **Step 3:** Commit `Catalog: Create Lineup reads each show's catalog and names what's new`.

## Step 5 - Deleting an airing

### Task 6: "Remove this airing only" or "Never air this episode on this channel"

**Files:**
- Modify: `web/directives/channel-config.js` (`removeItem`), `web/public/templates/channel-config.html`

**Interfaces:**
- Consumes: Task 1's `neverAirEntry`; Task 5's queue.
- Produces: for a program with a show (episode, custom-show item, movie), the trash button opens a small dialog - title, `S04E09` where it has one, the two choices, and "It airs N more times in this lineup; the next Create Lineup leaves them out" for the second. Flex and redirects delete at once as today; the bulk tools don't ask.

- [ ] **Step 1: Build and live-check on the preview:** delete one Married... airing with "Never air": the dialog's count matches the lineup, the airing goes, after Update Channel the list holds it (`how: "deleted"`), the next Create Lineup airs it 0 times; "Remove this airing only" behaves exactly as today and the list is unchanged; Cancel on the channel drops both the deletion and the list entry.
- [ ] **Step 2:** `npm test` - Expected: all pass.
- [ ] **Step 3:** Commit `Catalog: deleting an airing asks whether to never air it again`.

## Step 6 - The Catalog page

### Task 7: Review shows, see and restore never-air episodes

**Files:**
- Create: `web/controllers/channel-catalog.js`, `web/public/views/channel-catalog.html`
- Modify: `web/app.js` (route `/channels/:number/catalog`), `web/public/views/channel-detail.html` (a Catalog link)

**Interfaces:**
- Consumes: Tasks 1, 2, 4, 5's service.
- Produces: the page reads the channel, its state and every show's catalog, then shows
  - **To review** - `reviewList`, each show with its count; opened, its seasons with a checkbox per season and per episode (`S04E09 Title`), all ticked to start, **Add all** / **Add none**, and **Save review**, which posts one `review` op - `by: "review"`, `specials: specialsAllowed(lineupItems)`, the `source` the read used, `known` every key the catalog held, unticked episodes as `neverAir` with `how: "review"` - then refreshes;
  - **Never air** - by show, each entry with its episode, when and how, and **Restore**, which posts `restore`;
  - a line for shows it couldn't read.

- [ ] **Step 1: Build and live-check on the preview:** channel 2's page lists every short show and no complete one, Double Dare first (414); review Married... unticking two episodes: both on the list (`how: "review"`), the show no longer listed; Create Lineup on channel 2: the two air 0 times, the rest of Married... joins; restore one: it airs after the next Create Lineup.
- [ ] **Step 2:** `npm test` - Expected: all pass.
- [ ] **Step 3:** Commit `Catalog: the Catalog page - review shows, restore never-air episodes`.

## Step 7 - Record, re-prove, preview

### Task 8: Record what shipped

**Files:**
- Modify: `NOTES.md` (the Known issues entry's status and a build record; the Scheduling roadmap line; a Testing notes line for `catalog-snapshot` and `progress-check --catalog`), this plan (boxes ticked)

- [ ] **Step 1:** Re-copy the data, diff, take a fresh snapshot, re-run every task's proof on it; state the snapshot time.
- [ ] **Step 2:** Write the NOTES changes.
- [ ] **Step 3:** Commit `Docs: record full catalogs and the never-air list`.

After Task 8: one fresh whole-branch review on the most capable model, one fix pass, then the preview for Ron - his own look in the browser, on a copy - before anything merges. `full-catalog` merges after `stored-progress`, when Ron says.
