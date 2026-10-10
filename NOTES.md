# Notes

## Design principle

Every feature is built around how Ron programs his channels, with Syndicast's
own identity. Ideas are never copied, and the docs and the code describe our
designs on their own terms, without naming other programs. Any roadmap line
below says what we do and why. **Syndicast innovates.**

## Rules for every session

- Another streaming server runs on this PC, with its own processes and load.
  Never stop or signal any process you didn't start.
- Docs and code describe our designs on their own terms and never name other
  playout programs.

## Feature roadmap

Intended work, mostly a statement of direction rather than of state. **An
unticked box is not built.** A ticked one is, and says what actually shipped,
which is not always the whole of what the line originally asked for. The Known
issues section below is separate and covers defects in what already ships.

### Blocks system

The original reason for the fork. See [docs/blocks-spec.md](docs/blocks-spec.md)
for the full spec, stages and acceptance tests.

- [x] Timed Flex Blocks - time-scoped filler switching by time of day and day of week

      Stage 1 ships: the resolver and the UI to configure a day-part from the
      channel editor. The resolver is `src/day-parts.js`, pure and free of
      I/O; `createLineup` takes a `t0` and resolves the mix when it fills a
      break. `channel.dayParts` is an optional field, so nothing needed
      migrating and a channel without one takes the same code path it always
      did.

      The UI is a "Day-Parts" tab in `web/directives/channel-config.js` /
      `channel-config.html`: a list of day-parts, each with a name, a
      `filler-mix-editor` for its mix, and its `starts` (day toggles, an
      hour/minute pair, and a "shift with daylight saving" checkbox whose
      computed text - "7:00 PM in winter, 8:00 PM in summer" - comes straight
      from `day-parts.js`'s `effectiveStartTime`, required into the web
      bundle the same way `web/services/plex.js` requires `../../src/plex`).
      A weekly strip samples `resolveContext` across the current calendar
      week to show which day-part covers when, and "Convert current Flex to a
      day-part" turns the channel's existing Flex into a single all-week
      day-part named after the channel.

      The Flex tab's list/weight/cooldown editor was pulled out into its own
      directive, `filler-mix-editor`, so both the channel's own Flex mix and
      every day-part's mix go through the same code rather than three
      near-copies of it. Verified byte-for-byte: saved a channel's
      `fillerCollections`/`fillerRepeatCooldown` before the extraction, redid
      the same edits after, and diffed - identical. (A plain reload-and-resave
      of an unrelated channel reorders unrelated JSON keys and nudges
      `startTime` even on the pre-extraction code, so that noise is
      pre-existing and unrelated to this change, confirmed by reproducing it
      against the old code directly.)

- [x] Blocks with airings - a named, possibly-repeating stretch of programming
      (Toonami, Miguzi) that overrides the day-part while it airs

      Stage 2 ships: the resolver (core) and a "Blocks" tab in the channel
      editor (UI) - the same core-then-UI split stage 1 went through.
      `channel.blocks` is the same shape as `channel.dayParts` (name, mix,
      optional guide name) plus `airings`: one or more `(days, start, end)`
      spans, crossing midnight when the end is earlier than the start. Still
      an optional field with nothing to migrate, so a channel without one
      takes the same path it always did.

      `src/day-parts.js` (kept its name; renaming it would have churned every
      one of its five callers mid-stage for no behavioural reason) now checks
      block airings before the day-part chain, so a block always outranks
      whichever day-part it overlaps - `resolveContext` is the one function
      both the picker and the guide read a context from, so this is decided
      once. The neighbour-context break rule extends to blocks for free:
      `resolveContext` is what changed, not the rule that calls it with the
      neighbour's start time. Two overlapping airings from different blocks -
      a state the editor now prevents interactively - resolve to whichever
      block was declared first, the same tie-break the day-part chain
      already used for two colliding day-part starts.

      Per-context guide names turned out not to reach the guide through
      `createLineup` at all - the earlier investigation that shaped this
      session found XMLTV/the web guide/the API guide all go through
      `TVGuideService#getChannelPrograms` instead, which never calls the
      picker. That needed its own hook: `getChannelPrograms` now finds the
      real program after each melded Flex run itself (scanning the guide
      build's own program list, since it doesn't have `channel.programs` and
      a `programIndex` to walk the way the picker does) and resolves a
      context from it via the same `resolveBreakContext` the picker calls,
      new in `day-parts.js` to hold the "given a neighbour or none, which
      instant do we resolve at" decision both call sites share. `guideName`
      is strictly opt-in - a block or day-part with none falls through to
      `guideFlexPlaceholder` then the channel name, exactly as before - so no
      existing channel's guide changes until someone types a name into the
      new field. One real constraint surfaced doing this: a break under
      `TVGUIDE_MAXIMUM_PADDING_LENGTH_MS` (30 minutes) is melded into the
      neighbouring show as padding and never becomes its own guide entry, so
      an ordinary commercial break never shows a block's guide name - only a
      long one (an overnight stretch, a gap between blocks) does.

      Airing overlap is checked in three places with three different jobs,
      not one: the resolver's tie-break above (must always answer, even from
      a hand-edited channel file), a warning in `validateChannelJson`
      (`warnAboutBlocks` in `src/dao/channel-db.js`, mirroring
      `warnAboutDayParts` - warns, rewrites nothing, and is the one place
      every channel write passes through regardless of source), and
      interactive prevention in the "Blocks" tab itself - a live message on
      any overlapping airing plus a hard block on Save, checked against the
      same pairwise-span logic as `warnAboutBlocks` (different blocks only;
      one block's own airings never conflict with each other) but
      implemented fresh in `channel-config.js` rather than sharing that code,
      since the editor's copy runs against in-progress edits rather than a
      channel already read from disk. The DAO warning is computed at
      `shiftWithDst: false` for every airing; a pair that only overlaps
      because daylight saving has carried one of them into the other is real
      but rarer, and isn't caught - the resolver's tie-break is correct
      either way, so this is a diagnostic, not the safety net.

      The UI is a "Blocks" tab in `web/directives/channel-config.js` /
      `channel-config.html`, mirroring the "Day-Parts" tab field for field: a
      list of blocks, each with a name, guide name, a `filler-mix-editor` for
      its mix, and its `airings` (day toggles, start and end hour/minute
      pairs, and the same "shift with daylight saving" checkbox and computed
      display the Day-Parts tab already has). A new airing defaults to a
      1-hour span rather than a day-part start's safe zero-length default,
      since `start === end` never airs. The weekly strip - shared with the
      Day-Parts tab, since it shows the whole resolved schedule, day-parts
      and blocks together - predates blocks and keyed segments by
      `channel.dayParts.indexOf(dayPart)`; now that `resolveContext` can
      return a block, that's fixed to classify the resolved context against
      both `channel.dayParts` and `channel.blocks` and give blocks their own
      color palette, so a block reads as visually distinct from a day-part
      instead of colouring as "none".

      Stage 2's acceptance rows were added to the same `ROWS` array in
      `test/blocks-acceptance.js` stage 1 used, tagged `row(2, ...)`, per that
      file's own comment on where they go. Adding them exposed that one
      existing stage 1 row (`CCN | Sat 12:00am`) used the default 60-minute
      break, which happened to land its neighbour exactly on the new Toonami
      block's 1am start - a fixture collision from two rows independently
      choosing round numbers, not a resolver regression; narrowed to an
      explicit 15-minute break so it keeps testing what it always claimed to.
      Guide-name resolution has its own file, `test/blocks-guide.js`, driven
      directly against `TVGuideService#getChannelPrograms` the same
      I/O-free way `test/blocks-acceptance.js` drives `createLineup` - see
      NOTES.md's testing notes. The editor itself has no automated tests, the
      same as the Day-Parts tab before it: verified instead against the dev
      fixture channel by hand - added overlapping and non-overlapping blocks,
      confirmed the strip colors and labels them correctly, and confirmed
      Save is blocked while an overlap exists and succeeds once it's fixed.

- [x] Block schedule manager - a weekly calendar view of day-parts, blocks and
      slots together

      Stage 3 ships: the "Schedule" tab in the channel editor, between Blocks
      and EPG. A vertical week grid (Sun-Sat columns, hours top to bottom)
      with day-part/block segments as background bands and slots drawn on
      top as inset chips, matching the spec's "day-parts as background
      bands, blocks as coloured regions, slots drawn inside by their times."
      Three click targets, each opening what it names: a slot chip opens the
      Time Slots editor scoped to that slot, a day heading opens it scoped to
      that day, and the band strip down the left of each column switches to
      the Day-Parts or Blocks tab and scrolls to, and briefly highlights, that
      exact card - reusing the existing inline card editors rather than
      building a second one. Blocks still never own slots:
      `channel-config.js` reads `channel.scheduleBackup.slots` and
      `channel.dayParts`/`channel.blocks` independently to build the
      calendar; neither was taught about the other's shape.

      The slot chips are inset 16% for a reason worth keeping: at the 6% they
      started at, they tiled the column so completely that the band behind
      them was a ~5px sliver, and in practice unreachable - the bands were
      only ever clicked during development by calling the handler directly.
      Anyone using the tab read the chips *as* the bands and reported them as
      such. The wider inset makes the band a real target and, incidentally,
      is what finally makes "day-parts as background bands" legible at all.

      The one new core function, `dayParts.weeklySegments(channel,
      referenceInstant)` in `src/day-parts.js`, replaces the ad-hoc
      15-minute-sampling loop `rebuildWeeklyStrip` (the Day-Parts tab's
      existing preview strip) had inlined since stage 2. Both the strip and
      the new calendar now call this one function, so they agree on what
      covers the week by construction instead of by two samplings kept in
      sync by hand. It samples `resolveContext` once a minute (10,080 calls a
      week) rather than re-deriving block/day-part precedence analytically -
      every start and airing boundary is entered as an hour/minute pair, so a
      minute is already finer than any boundary that can exist, and this way
      the function never grows a second copy of resolveContext's own
      precedence and tie-break rules to keep in sync with. Measured at
      17.65ms per call against the real 7-day-part/3-block channel in the dev
      data folder - cheap enough to recompute on every tab switch or edit,
      same as the strip always has. `airingSpans` and `spanCovers` are now
      exported too, for the block-window slot filter below. Verified in
      `test/blocks-schedule-view.js` against a hand-derived Saturday timeline
      (a day-part carried over from Friday, a block overriding it, the block
      handing back to a day-part exactly at its own boundary, a block nested
      inside a later day-part, that day-part resuming, and the
      shiftWithDst-driven January/July difference on the last boundary) plus
      the Thursday-has-no-Toonami row the spec's own stage 2 table exists to
      prove.

      "Editing a block's shows goes through the slot filter scoped to the
      block's window" (spec) is a new "Edit shows in this window" button on
      each block's card in the Blocks tab, not a calendar click of its own -
      clicking a block edits *the block* (name/mix/airings); editing what it
      airs is a distinct, explicit action from there.

      That button, and the calendar's own clicks, all open
      `time-slots-schedule-editor` with a **slot scope** - an optional
      `slotScope` argument to `startDialog`, one of
      `{kind:'block', block}`, `{kind:'day', calendarDay}` or
      `{kind:'slot', time}`. A scope narrows the list on what a slot *is*;
      the search box narrows it on what a slot *reads as*; the two are
      independent predicates that both apply, and the banner's "show all
      slots" drops only the scope, leaving typed text alone.

      **The scope exists because seeding the search box instead is wrong, and
      not subtly.** The first version of the calendar's day click set
      `slotFilter` to "Mon", which looked right until you notice
      `slotSearchText` matches the show name as well as the day label: on
      channel 1 that also selects Pokémon, Yu-Gi-Oh! Duel **Mon**sters and My
      Gym Partner's a **Mon**key, from all seven days, and "Fri" selects
      Foster's Home for Imaginary **Fri**ends. Scoping by day index has no
      such failure mode, and it keeps Monday's *own* Pokémon slot - which a
      cleverer text match would have had to special-case back in.

      A slot scope keys on `slot.time` rather than the object, because the
      editor works on its own deep copy of the backup and times are unique
      across a schedule (`refreshSlots` flags duplicates). On a daily (not
      weekly) schedule a slot has no day of its own: a day scope therefore
      does not restrict, and a block scope matches if *any* day the block
      airs on would place that time of day inside its window.

      Deliberately kept out of this stage, per the plan reported and agreed
      before building: no printable or exportable (iCal) view - on-screen
      only, since the spec's data model has no dated events to export
      (day-parts and blocks are pure day-of-week/time-of-day rules, and
      one-off airings are still deferred - see the open questions below), so
      every week looks identical and there was nothing date-specific to
      export anyway. Also left alone: `channels.js`'s `selectChannel` still
      fetches the full programs array before opening the editor at all, even
      to look at this tab - the tab itself never reads `channel.programs`
      (slot labels come from parsing `showId`, e.g. `"tv." + showTitle`, so
      no show lookup is needed), but the editor-open path wasn't changed to
      take advantage of that this time.

      Performance was investigated up front rather than assumed: channel 1's
      real file is 27MB, of which `programs` is 99.9% (27,143,345 of
      27,169,557 bytes) - `dayParts`, `blocks` and the 336-slot
      `scheduleBackup` together are 26KB. The calendar reads only the
      latter, so channel 1's 39,999 programs have no bearing on it. Exercised
      live against a copy of the real dev data folder (never the live one -
      another session had it open): the tab, its band/slot click-through to
      both tabs, and the block-window filter, on channel 1 at full size.

      **That first pass still shipped a three-day shift, and how it hid is
      the part worth keeping.** A weekly slot's `time` is ms into the *epoch*
      week, so its day 0 is a Thursday; day-parts and blocks count calendar
      days from Sunday. This tab read the first as the second, so every slot
      was drawn three columns off and the block-window filter selected the
      wrong days. Nothing looked broken: the bands were right (they resolve
      through `resolveContext`, which is calendar-based), the slot labels
      were right, the times within each day were right, and the filter
      returned a plausible count of plausible rows. Only the *pairing* of
      band to slot was wrong, which reads as a configuration problem rather
      than a display one - it was reported as "the Toonami filler isn't
      playing during the midnight run", and the resolver measured clean at
      every instant in that window. See the Known issues entry below for the
      conversion and where it now lives.

      Not exercised live: a channel on a *daily* (not weekly) Time Slots
      period with day-parts or blocks configured - none of the four dev
      channels combine those, so `dailySlotLayout`'s column-repeats-every-day
      path and the daily branch of `slotInWindow` have only been checked by
      reading them, not by a real render.

- [x] Transition bumpers: "we'll be right back", "back to the show", "up next", per series
      and per block - *steps 1 to 7 built and confirmed in TiviMate; step 8
      (`keyedOn: 'later'`, the Cartoon Theatre "Next Time") is its own line
      below*

      Designed Oct 1, 2026 on Fable 5.1 - Stage 5 in
      [docs/blocks-spec.md](docs/blocks-spec.md), from channel 1's real
      lineup (442 breaks a week: 117 between episodes, 297 between shows, 28
      boundaries; 281 distinct show pairs; the split was 113 / 301 / 28 before
      the Oct 2 boundary edits, see the spec). Sequences attach to the day-part
      or block and are shaped around the break - out steps, Flex, in steps -
      in four situations; a clip carries the shows it names, proposed from
      its title and fixed once on a review screen. Why they attach to the day-part or block, not to items, is in the spec's
      Editor section. The build order for Sonnet 5 is there too:
      eight steps, TiviMate previews at steps 4 and 7. The slot filler
      positions and sign-on lines below are folded into this one and ticked
      with it.

      **Step 1 built Oct 2, 2026 (Sonnet 5.5): situations and assembly.**
      `src/transitions.js` is pure and nothing calls it from playback yet, so no
      stream, guide or saved channel behaves differently. It finds a break (the
      run of adjacent Flex entries, wrapping round the cyclic lineup, so a Flex
      run at the head of the lineup takes the last program of the cycle as its
      P), classifies it from the contexts at P's and N's starts, and assembles
      the out and in step lists. `channel.dayParts[]` and `channel.blocks[]`
      gain an optional `transitions` field; reading it fills defaults and
      writes nothing. A movie is keyed by its own title, not the slot editor's
      single `movie.` key, or a break between two films would read as between
      episodes. `warnAboutTransitions` is in `channel-db.js`. A Flex entry
      counts as Flex when `isOffline` is true, a redirect included, the same
      test `findNextProgram` uses.

      Real-data check, `node scripts/transitions-week.js <channel.json>` on a
      copy: channel 1, week of Oct 18, reads 442 breaks, **117 / 297 / 28**.
      The spec said 113 / 301 / 28 and that was right for the Oct 1 file (the
      Oct 1 backup reproduces it exactly); Ron then moved day-part and block
      boundaries, which moves 26 of the same 442 breaks between situations.
      Only the split moves; the total and the 281 pairs depend on the lineup
      alone. Re-measure after any boundary edit before quoting the numbers.

      **Step 2 built Oct 2, 2026 (Sonnet 5.5): names and the matcher.**
      `src/show-match.js` proposes which show a filler clip is about from its
      title; `names` on a clip is the stored answer (one show key, or two for
      now and then), warned about at filler save and never written by this
      step. `GET /api/filler/:id/match` returns each clip's names and its
      proposal and saves nothing. `src/dao/show-alias-db.js` reads and writes
      `<data>/show-aliases.json`; reading creates and repairs nothing, and
      the writer is called by nothing yet - the save route is left for step 6,
      where the review screen is its only caller.

      Real-data check, `node scripts/match-lists.js <data-folder>` on a copy
      (read-only; `--fix "<clip text>=<show key>"` simulates a review-screen
      fix in memory): 24 lists, 5,528 clips, 621 named from titles alone, 4,907
      unnamed. The Nick lists name nothing (their clips are idents). Adult
      Swim [Weekday] names 67 of 395, Adult Swim [Sunday] 18 of 334, Toonami
      38 of 230 (69 once `dbz` is learned) and Toonami AcTN 28 of 128. What
      stays unnamed is mostly generic bumpers, plus clips for shows no channel
      airs (Gundam, Samurai Champloo, Megalo Box, Fullmetal Alchemist): the
      vocabulary is the shows on the channels, as designed, so those need the
      show on a channel first. "DragonBall GT" is not "Dragon Ball GT";
      spacing is not folded. The route answers in about 0.2s for a 395 clip
      list against the real 27MB channel, on a scratch server on a copy.

      **Two things the real data made me add or limit.** (1) A leading "The" is
      optional when the rest is two words or more: 54 clips named nothing
      without it ("Powerpuff Girls Promo", "Brak Show promo", "Big O Promo")
      and 3 gained a second show, all correctly; a one-word rest ("Jetsons")
      is not matched. (2) The learning rule. Read literally, mapping one clip
      makes every word of its title an alias, so "Adult", "Swim" and "NEXT"
      would each name the wrong show everywhere. A word is not learned if it
      is a number, already means a show, is part of a show title, is a
      structural word, is under three letters, or appears in a clip naming a
      different show. Simulated on Ron's lists: one SGC2C fix learns `sgc2c`
      and names all 7 SGC2C clips; one DBZ fix learns `dbz` and `piccolo` and
      names 31 more Toonami clips plus a toy ad. It is not airtight: a fix on
      "Grim Advs" learns `advs`, a generic abbreviation that also names three
      unrelated clips ("The advs of Crimson Chin", "The New Batman Advs"), and
      it will not learn `grim` at all - correctly, since "Grim & Evil" is its
      own show on these channels. So the review screen must show the words
      that would be learned and let them be unticked before anything is
      saved; `learnAliases` only returns candidates.

      **Follow-up, Oct 2, 2026: the Nick at Nite Up Next lists.** Ron moved
      his Up Next bumpers and promos into their own lists (Nick at Nite Up
      Next Bumpers 21 clips, Up Next (Back 2 Back) 10, Up Next Promos 3). The
      dev data has no Nick at Nite lineup (its "NICK Picks" channel is one
      placeholder program, and no backup has one either), so against the real
      vocabulary all 34 came back unnamed. The check was therefore run with
      `scripts/match-lists.js --shows`, which adds stand-in shows titled the
      way Plex titles them, and is labelled in its output. Result before any
      fix: 33 of 34 named. The "(Back 2 Back)", "(More)", "(back2back)" and
      doubled-year ("(2004) (2024)") variants cost nothing, and shows titled
      with or without "The" were found either way. Three real defects, all
      fixed, each with a test and the 34 titles as a regression table:

      - **"Up Next Bumper (Jeffersons) (2001)" named nothing.** The optional
        "The" needed two words left, so a one-word show could never drop it.
        A word of five letters or more now may, but only as its own segment
        (between brackets, dashes, colons, slashes, or the whole title), and
        the hit carries `standalone: true`. Across all lists that adds
        "(Jetsons)", "Smurfs - Smurfette" and "(Transformers)", and two doubtful
        ones, "Justice League promo (Batman)" also naming The Batman and
        "Animaniacs promo (Jetsons)" also naming The Jetsons: proposals for the
        review screen, which should mark `standalone` hits as less certain.
      - **Plex titles with years** ("ThunderCats (2011)", "Teenage Mutant Ninja
        Turtles (2003)", "G.I. Joe: A Real American Hero ('83)") could not be
        named by a clip without the year. A trailing year is now optional; two
        eras of one show share the plain title, the match reports `alsoKeys`,
        and a year in the clip picks the era. Four Ninja Turtles clips gained
        their show.
      - **Clips in a lineup became shows.** Channel 1's four hand-inserted NEXT
        promos are 10-15 second movie items, so `[As] NEXT - Home Movies
        (2003)` was a show and, as the longest title, would have beaten Home
        Movies on exactly the NEXT clips. A movie or episode under a minute no
        longer makes a show (the shortest real episode in the lineup is 198
        seconds); custom shows are exempt.

      With the stand-ins, 34 of 34 are named, and all lists together go from
      621 to 629 named on the real vocabulary. "Up Next Bumper (All in the
      family-The Jeffersons)" proposes a pair, now then; whether a pair in an
      Up Next list means that or "both are coming up" is for step 3 to decide
      (decided there: in a step keyed on next it means "coming up, in this
      order"; see the step 3 entry below).
      `learnAliases` also treats "more", "back", "back2back" and "b2b" as
      structural words.

      **`bundle-freshness` was flaky, and was fixed in its own commit.** It
      failed 16 runs in 40 alone. Two checks told states apart by file
      timestamps, and two writes a few milliseconds apart sometimes get the same
      timestamp on Windows: the "unreferenced new file" check compared the
      manifest's mtime before and after a rebuild, and "fixing the input" wrote a
      broken file and the fix back to back, so the checker correctly saw a state
      it had already failed on and did not retry. Each now pins the earlier
      state's mtime in the past, as `ageBundle` already did for the bundle: 0
      failures in 60 runs. The checker is unchanged.

      **Step 3 built Oct 3, 2026 (Sonnet 5.5): plans.** `buildPlan(channel,
      brk, env)` in `src/transitions.js` turns a break's steps into the clips
      that will play: `{ out, in, outMs, inMs, skipped, notes }`, each played
      step carrying its clip (a copy tagged `fillerId`, like a filler pick) and
      its `durationMs`. It is pure; `env` gives it `getList(listId)` and
      `lastPlayed(clip)`, so step 4 wires the filler DAO and the play-time
      store in. Nothing calls it from playback: `createLineup`,
      `lineup-cursor.js` and `video.js` are untouched, and the only change on a
      write path is a save-time warning.

      **Two rules were decided here, and both are in the spec's Steps section.**
      (1) *A clip naming two shows, in a step keyed on next, means "coming up:
      these two, in this order".* It plays only when the next show is the first
      name and `showAfter` (the first later program that is neither Flex nor
      the next show's own episodes) is the second. Only a `pair` step reads two
      names as now then; a step keyed on now never plays one. The spec's own
      "Now/Then (Grim / Foster's)" row needed this, since that clip plays before
      Grim. On Ron's real lists, with a stand-in lineup of the real show titles
      (below), "Up Next Bumper (All in the family-The Jeffersons)" plays before
      All in the Family when The Jeffersons follows and not when Cheers does.
      (2) *`onlyIfNoMatch` names a step; it does not mean "any step found
      nothing".* Ron's sequences put a Next Promos step before the Up Next
      bumper and most shows have no promo, so "any" would play WBRB and BTTS even
      when the Up Next bumper played. A clip from the watched step's fallback
      list counts as a match. The mutation that turns it back into "any" fails
      two acceptance rows and one unit test, which is how the rows were checked
      to be able to fail. A step that watches itself, a marked step, a missing
      or duplicated id, or something that is not an id (`true`) is skipped as a
      problem and warned about at save, never guessed at; one rule
      (`watchProblem`) serves both.

      **What else a plan does**, all in the spec: tiers (a pair step: both
      names, then only the next show, then the fallback list), a clip never
      plays twice in one plan, ties go to list order so one break always builds
      one plan, the never-a-different-show rule holds for `any` steps too, a
      clip with an unusable `names` or no length is never chosen, and
      `keyedOn: 'later'` and the `generated` kind are skipped as problems.
      `notes` is the problems only (a missing list, an unhonourable mark); a
      step that simply found nothing is not one, and the caller logs `notes`.

      **Tests: 535 to 614.** Unit tests in `test/transitions.js` (the show
      after the next one, every tier, idle order, the mark rules, purity, the
      save-time warning) and 15 stage 5 plan rows in `test/blocks-acceptance.js`
      (`planRow`), each on a fixture with its own day-parts, blocks and lineup
      so none depends on channel 1's block times: Toonami to CCF, between
      episodes inside CCF, CCF's last show, Miguzi to Cartoon Theatre, Cartoon
      Theatre to Grim with and without Foster's after it, weekday to Toonami,
      ATHF to Space Ghost, Space Ghost to a show with no NEXT clip, five Nick at
      Nite rows for the mark (promo and Up Next, promo finds nothing and Up Next
      plays, neither, promo plays and Up Next finds nothing, Up Next via its
      fallback), and a 7-day fixture week whose 336 breaks split 105 / 217 / 14
      by hand with no sequences and every plan empty. Not here: the three
      stream-timing rows (step 4's cursor) and Next Time (step 8).

      **Real-data check, on a copy of `.dizquetv-dev`.**
      `node scripts/transitions-plan-day.js <copy> [--day YYYY-MM-DD] [--seq
      "<context>=<list>"]` walks one day of channel 1 with the spec's test
      sequence (between shows, both sides, a show step keyed on next, skip if
      none) on the Adult Swim day-parts, in memory. No NEXT list exists in the
      dev data, so the Adult Swim [Weekday] and [Sunday] lists stand in, named
      from their titles in memory (747 clips; none carries `names` yet). Wed
      Oct 21: 68 breaks (22 / 42 / 4), 7 with steps (11 steps, all from the
      weekday list) and 4 more under the sequence that found no clip; Sun Oct
      25: 51 breaks, 3 with steps, 6 steps. No plan's steps outlast their
      break. A break with one fitting clip gets its out step and no in step
      (The PJs to The Venture Bros.: one Venture Bros. promo). Channel 1's week
      of Oct 18 with no sequences configured: 442 breaks, 117 / 297 / 28, none
      with anything in its plan, in 12 ms, and the channel untouched.

      **The Nick at Nite lists, with a stand-in lineup** (the dev data has no
      Nick at Nite lineup; ad hoc, not kept): the real Up Next Bumpers, Up Next
      Promos, Back 2 Back, WBRB and BTTS lists, named from titles, against a
      lineup of the real show titles. Next Promos then Up Next played as
      intended ("Full House NEXT promo -> Up Next Bumper (Full House)"), Back 2
      Back on Full House to Full House, and the two-name clip as above.
      **A finding for the review screen:** the WBRB and BTTS clips are titled
      "(I Love Lucy)" and "(The Brady Bunch)", so they are *named*, and a
      WBRB or BTTS step keyed on next plays them only before those two shows.
      That is the right reading of the titles, but if those clips are meant as
      general ones, they need "none" on the review screen, or the step should
      be keyed on now.

      Enumerating the writers of a step's shape, as the rule for this kind of
      change asks: `normalizeTransitions` (default `onlyIfNoMatch: null`),
      `warnAboutTransitions` (the mark check), `buildPlan` (the reader), the
      spec, and `transitions-plan-day.js` (builds steps in memory). The card
      editor in step 5 is the next writer and must offer the mark as a choice
      of the other steps in the same row, not free text.

      **Step 4 built Oct 3, 2026 (Sonnet 5.5), on branch `stage5-step4`: playing
      plans through the lineup cursor. Confirmed in TiviMate by Ron on 910, 911,
      912 and 913: every bumper once and whole, every show from its start, and a
      tune-in 8s before a break's end gave NEXT - SGC2C then the show.** 614 to
      662 tests.

      A break with steps plays out steps, Flex, in steps, then the next show
      from its start, as the spec's "Playing through the lineup cursor" says.
      The cursor carries `phase`, `step` and the plan; the Flex's time left is
      the break's end minus the in steps (`reserveMs`, read by
      `helperFuncs.timeLeft`), so lateness shortens Flex and never a step. A
      break is passed over only when it has no steps and too little left; one
      too short for its steps drops its Flex and keeps them. The minute's
      tolerance is measured at the Flex (after the out steps, before the in
      steps), never during a step. `lineup-cursor.js` takes the plan-builder
      as an argument and stays pure; `placeByClock` is the clock path.

      **Decisions beyond the spec's words.** (1) A tune-in with no cursor lands
      on the in step *on the air*, not always the first (three CCF intros: 5s
      before the end plays the third). (2) The clock hands a show over up to
      10s early and `video.js` used to skip a break with 11s or less left, so
      tuning in anywhere in a break's last ~11s went straight to the show;
      `placeByClock` catches both, and the skip never jumps over a step. (3)
      One plan per break per channel, in `channel-cache.js`, shared by every
      viewer and every `/m3u8` request (otherwise a second viewer could pick
      another clip once the first one's playback moved the rotation), dropped
      on save. (4) A step is a `type: 'transition'` item and counts as filler
      for "hide watermark during filler"; that is the only place playback reads
      the type.

      **A channel with no steps takes exactly the old path.** `transitions.hasSteps`
      is asked first; false builds no plan and loads no list. Proved by running
      69e2db2 and the new code side by side behind their real `video.js`
      routers, same fake clock, same seeded picks, viewers with and without
      stream ids and one joining on the replay cache: channel 1 for Wed Oct 21
      and Sat Oct 24 (24 viewer-hours each), channels 2 and 3, a stage 4 style
      channel with a 15s break and a two-Flex break, and two with empty
      sequences: 7,629 requests, every item and cursor identical. A control
      channel with an out step differed from request 3, so the comparison can
      see a difference. A harness trap: reusing one `session` number across
      scenarios tripped the throttler on one side only.

      **Tests.** `test/lineup-cursor.js` (phases, tolerance, two Flex entries,
      tune-in placement, and an 18-hour simulated viewer with steps: every
      program once and from its start, every step once and uncut, a 5s break
      keeping both steps), `test/stream-cursor.js` (one viewer through the
      real router on a fake clock, plan sharing, rebuild after a save, tune-in
      at 8s and 10.5s), `test/transitions.js` (`hasSteps`, `stepListIds`), and
      the three held-over timing rows in `test/blocks-acceptance.js`
      (`streamThrough`: 20s late, later than the whole break, tuning in 8s
      before the end). Mutation-checked: the step-on-the-air rule and plan
      sharing each fail their checks when removed.

      **Real data, on a copy of `.dizquetv-dev`.** One viewer through Wed Oct 21
      of channel 1 with the Adult Swim NEXT sequence (the four real NEXT clips
      plus the Adult Swim lists named in memory): 69 programs, no repeats or
      skips, none partway, started 10.0s early to 0.7s late, 12 steps all
      whole; Broodwich to Explode played the SGC2C promo, Flex, NEXT - SGC2C.
      Preview channels 910 to 913: real episodes of ATHF, Space Ghost, Home
      Movies and The Venture Bros. (910), I Love Lucy, The Brady Bunch, The
      Wonder Years and Full House from Plex (911), and stage 4's compressed and
      5-8s-bumper channels (912, 913). **On Ron's Nick channel a WBRB clip
      names the show coming back after the break**, so the Nick at Nite
      sequence keys WBRB, like BTTS, on the next show, both only when Up Next
      finds nothing; this settles the step 3 question about keying WBRB on now.
      **Still true:** `/m3u8` has no stream id, so no cursor; it gets
      `placeByClock` and the shared plan, nothing more.

      **Step 3b built Oct 3, 2026 (Sonnet 5.5), on branch `stage5-step3b`: days,
      chance and lists whose clips feature shows.** Three options so Ron can
      lay breaks out freely, each off by default: nothing saved changes, and the
      existing 662 tests passed untouched before any new one was added. 662 to
      724 tests.

      - **`days`** on a step: it plays only when the break's local weekday is
        listed (0 = Sunday, as in day-parts). The day is the day the break
        *starts*; an 11:50pm Friday break running into Saturday is a Friday
        break. An empty list plays on no day and is warned about at save,
        never read as "every day".
      - **`chance`** on a step, a whole percent 1 to 99 (100 or unset is
        always). **The roll is derived, not random**: a hash of channel, break
        start and step id. A plan is dropped on every save and on a restart, and a
        re-rolled break could change what a half-watched break shows; derived, every
        rebuild and every viewer agrees. The first hash (plain FNV-1a) failed
        its own test: only the last byte of the step id differed, and that barely
        reaches FNV's high bits, so two steps of one break rolled nearly alike
        (1 break in 200 differed instead of half). It now takes murmur3's final
        mix, and over 20,000 breaks 49.6% roll under 50 and two steps disagree
        49.5% of the time. `env.roll(brk, stepKey)` overrides it for tests.
      - **A step left out by day or chance has found nothing**, so a step marked
        `onlyIfNoMatch` on it plays. That is what makes "Up Next before the break
        sometimes, otherwise right before the show" two steps, and the Monday
        sign-on two steps with different days.
      - **`clipsFeatureShows`** on a filler list, a checkbox in the list editor
        ("These clips feature shows"). In a step reading such a list, as its
        list or its fallback: clips naming the keyed show first, then any clip,
        named or not, the longest idle first (`via: 'featured'`). A list without
        it keeps the old rule. Unusable `names` and no-length clips are still
        never chosen, a clip still plays once per plan, and a featured clip
        counts as a match for a watching step. **It is a setting of the list, not
        of the step**, so it applies to every step that reads that list: on a
        list of promos for particular shows (Adult Swim) it would play a promo
        for the wrong show, which is exactly what it is for on the CN City
        bumpers and exactly wrong there.

      **Writers of the new fields, enumerated:** `normalizeTransitions` (defaults
      `days` and `chance` to null), `buildPlan` (the reader), `daysProblem` and
      `chanceProblem` (one rule for the builder and for `warnAboutTransitions`),
      `transitions-plan-day.js` (`--days`, `--sometimes`, `--feature`), and the
      spec. For `clipsFeatureShows`: the list editor posts a hand-built object, so
      it had to be added there or every editor save would drop it (it is written
      only when ticked, so a list that never used it stays byte for byte as it
      was, and unticking restores the original file exactly, checked); the other
      writers (`saveFillerOrder`, the import refresh, `fixupAllFillers`) pass the
      whole object through. `FillerService.getFillersFromCollections` now carries
      the flag, and `video.js` passes it to `buildPlan` as `env.featuresShows`.
      `FillerDB` warns if it is not true or false.

      **What there was no UI for yet.** The card editor was step 5, which had
      to offer days (seven toggles) and chance (a percent box) on a step's chip
      (the spec says so); built Oct 4, see the Step 5 entry below. Until then a
      step's `days` and `chance` were set in the channel file; the list checkbox
      was the one visible change.

      **Tests.** `test/transitions.js` (days and chance each way and at the edges,
      the local day across midnight, the roll, every featured tier, the save-time
      warning, the defaults) and 18 plan rows in `test/blocks-acceptance.js`: the
      five Nick patterns (Hey Dude to Clarissa; Clarissa to Doug entering
      Nicktoons; Hey Arnold to Are You Afraid of the Dark? and to a show with no
      promo; into Kenan & Kel; entering Nick at Nite on a Tuesday, a Sunday and a
      Monday), a step skipped for its day and the marked step that plays then,
      "Up Next sometimes" both ways, and the CN City cases. Mutation-checked:
      removing the day check, the chance check, the featured setting, either
      featured tier, or shifting the weekday by one each fails rows.

      **Real data, on a copy of `.dizquetv-dev`.** Wed Oct 21 of channel 1 with
      the Adult Swim sequence, nothing new set: 68 breaks (22 / 42 / 4), 7 with
      steps, 11 steps, the same as step 3 recorded. `--sometimes 50`: every break
      that had steps now has exactly one side (4 out, 3 in), the same answer on a
      second run, and 2 to 4 on the out side across five days. `--days 0,6`
      gives none on a Wednesday. `--feature` gives all 11 breaks steps (22) with a
      clip for another show in the second step, as designed. A scratch server
      from the worktree on the full copy: the list editor shows the checkbox,
      ticking and Done wrote `clipsFeatureShows: true` to that one list and
      nothing else, reopening showed it ticked, and unticking made the file
      identical to the original.

      **Step 5 built Oct 4, 2026 (Sonnet 5.5), on branch `stage5-step5`: the card
      editor.** A Transitions section on every day-part and block card, a preview
      that walks the lineup, and a one-line tag on each Flex row. 724 to 1,014 tests.
      Nothing server-side changed except one new client call, `getFillerMatch`, for
      the read-only `GET /api/filler/:id/match`.

      - **The section**, under Mix, collapsed to "Commercials only" or "3 steps" and
        opened by a click. Four rows in the spec's order (Leaving, Entering, Between
        episodes, Between shows), each `[steps] Flex [steps]`. A step is a chip (list,
        how it chooses, "skip" or the fallback list, then days, a percent, or "if X
        finds nothing") that opens a form. **The form's first line is one plain
        sentence that rebuilds as it changes**: "Plays a clip from Nick at Nite Up
        Next for the show coming up; if none matches, plays nothing; only on Mon and
        Wed; about 50% of the time." The four ways of choosing are one radio group
        (next show, last show, last then next, any clip), not the two stored fields.
      - **The form cannot store what the save-time warning would complain about.** No
        days picked and all seven picked both store `null` (every day), never the empty
        list that plays on no day; "Sometimes" takes 1 to 99 (100 or empty is always,
        and anything else is refused with a reason and not stored); "Only when" offers
        only the other unconditional steps of the same situation, out and in together,
        and is disabled on a step something else watches; deleting a step clears the
        marks that named it and says so. A step with no list chosen is the one thing it
        can hold, so **Update Channel refuses it**, flags the tab and outlines the chip
        (read from what was written to the channel, so it holds for a tab not open).
      - **A card nobody touches saves as it was.** The form edits a draft and writes
        `context.transitions` only when something changes, and adding a step then
        deleting it again removes the key it added. Checked on channel 1's copy: opened
        every Transitions section on every day-part and block and saved; the only
        difference from the original in `dayParts`/`blocks` was `cooldown: null -> 0` on
        one mix, which the mix editor does on any save (pre-existing). Then two cards
        edited: exactly those two gained `transitions`, no program carried a `$` field,
        and the server logged no warning.
      - **The preview** is `buildPlan` itself over `breaksBetween` for 7 days from now,
        on the lineup as it is in the editor (unsaved edits included), grouped as the
        card sees its four situations (Entering and Leaving show the whole plan, the
        other context's steps too). Per break: the clips with lengths, the Flex that is
        left, and each step that did not play with why ("lost its 50% chance", "found no
        clip", "stays out because Up Next found a clip"). A "use suggested clip names"
        box, **ticked by default**, overlays `GET .../match` proposals in memory,
        because no list carries saved `names` until step 6 and a step keyed on a show
        would otherwise find nothing in the preview and on air; the header says which
        names are in use. The browser has no play history, so the first fitting clip in list
        order is shown and every clip that fits is listed under it (see the Oct 4 entry
        below; the roll for a "Sometimes" step is the real one: it is derived from the
        channel, break and step, so the preview and the stream agree).
      - **The Flex tag.** `flexTag` in `src/transitions-editor.js`: the steps the break
        is set to play, in play order, joined with " / ", the list name plus the show
        for a show-keyed step ("Up Next · Full House"); a step that plays only sometimes
        ends in "?", one that plays only if another found nothing is in brackets, and a
        step limited to other weekdays than the break's is left out. Out steps go on the
        break's first Flex row and in steps on its last, as `transitions.js` attaches
        them. The title attribute spells it out and explains the marks. **`.psr-flex-tag`
        is one line with an ellipsis and `flex-shrink`, so the row stays 26px**:
        `test/program-row-heights.js` has Flex rows with a short tag and a tag longer than
        the row, checks all 26px, that the tag is cut with an ellipsis, and that the
        duration and buttons stay inside the row. Mutation-checked: removing the tag's
        shrink, its max-width or its ellipsis each fails. (Its own `white-space: nowrap`
        is redundant with the row's, so removing only that is not caught, and cannot matter.)
      - **The tag is worked out for the rows on screen, not for the whole lineup.** Timed
        first as one pass inside `updateChannelDuration`, in the browser on channel 1's
        copy (19,978 Flex rows, steps on one day-part): **0.7 to 1.7 s per lineup change,
        against 0.08 to 0.23 s with no steps.** That is past the one second this was told
        to stay under, so `rowFlexTag(x)` computes a row's tag when the row is drawn and keeps it
        as `x.$$flexTag` (the `$$` keeps it out of `angular.toJson`); `scope.flexTagVersion`
        says which edit it belongs to and moves on every lineup change, step edit and
        list-name load. After the change `updateChannelDuration` takes 7 to 14 ms with
        steps, and finding the first tagged row by scanning 111 Flex rows took 1 ms. A
        channel with no steps never reaches `flexTag`. **A trap on the way:**
        `test/startTime-rotation.js` lifts `updateChannelDuration` out of
        `channel-config.js` and runs it with only a `scope`, so a call from inside it to
        a helper declared elsewhere in the directive broke that test (and would have
        broken the function there); it now only bumps `scope.flexTagVersion`.
      - **A friendlier pass, after Ron tried it (Oct 4).** The logic was right but too
        technical to set up comfortably, so four things changed and nothing was taken away.
        (1) *Plain labels:* the left of each row is captioned "Before the commercials" and
        the right "After the commercials, right before the show", the middle reads
        "commercials", and a step is "for the show coming up" / "for the show that just
        ended" on chips, in the form and in the sentence (not "names next show"); the Flex
        tag's tooltip says "Before the commercials" / "After the commercials". (2) *Quick
        setup* on each card asks three things (a promo to play before the commercials, an
        Up Next to play right before the show, a fallback for shows with no Up Next) and
        builds the Between shows steps: the promo as a `show` step keyed on next with
        nothing as its fallback (it plays only before a show it names), the Up Next the same
        with the third list as its fallback. At least one of the first two is needed, a
        fallback belongs to an Up Next and is ignored without one, and it replaces what
        Between shows holds, saying how many (the button reads "Replace them and build").
        The steps are ordinary ones. (3) *Copy transitions to...* copies chosen rows
        (all four ticked by default) of a card to the day-parts and blocks ticked on the
        same channel, "all day-parts" and "all blocks" being one click each. Each copy has
        new ids, an "only when" is carried to the copy of the step it named, a step with no
        list is left out (and a mark on it cleared), other rows of the target are kept, a
        target with nothing and an empty copy gains no key, and the panel says how many
        steps it will replace before it does and how many it did after. The editor
        showing a target card, if it is open, reloads its draft (`transitionsCopied`);
        one on another tab reads it from the channel when it opens. (4) *A step closed with
        no list is removed*, not left red: Done, clicking the chip, opening another step or
        panel, collapsing the section, previewing, and leaving the tab all do it (the
        refuse-to-save rule stays as a net). 32 new checks in `test/transitions-editor.js`
        (`closeStep`, `quickSetup`, `copySituations`, including quick setup's steps played
        through `buildPlan` for a show with and without an Up Next); each mutation tried
        (14, including copying with the original ids, losing the mark, clearing every row,
        sharing the step objects) fails a check. Checked in the browser on channel 1's copy:
        quick setup built the two steps, an empty step vanished on Done and on a tab
        switch, copying to a day-part and a block updated both (the open day-part live) and
        left Miguzi alone, and a save wrote `transitions` to exactly those three contexts.
      - **Up Next lists that were not found in the preview (Oct 4), and the fixes.** Ron
        saw clips he knew were in his lists missing from the preview. Investigated before
        anything was changed, on a copy, against the three lists he named (42 clips),
        then fixed. The causes, with clips affected: 18 were named correctly (only 9 of
        them showed, see the last cause); 2 gave a short title of a subtitled show
        ("Ghost In The Shell NEXT promo"); 1 spaced a title differently ("DragonBall GT");
        2 left "Series" off a custom show's name ("Mobile Suit Gundam NEXT"); 5 used
        nicknames for series inside a custom show ("Gundam 0083"); 10 used the nicknames
        Foster's and Grim Advs; 1 names no show ("AcTN Next Promo"); 3 are for shows no
        channel airs (Outlaw Star, Trigun). Two causes nobody had guessed: **(a) a
        two-show title with one show recognised was named for that one show** (6 clips:
        "Now/Then (Foster's / Camp Lazlo)" became a Camp Lazlo clip), which played a
        Foster's bumper before Camp Lazlo after Chowder and after Camp Lazlo itself, and
        made "foster" and "advs" look like another show's words so they could not be
        taught (taught on the data as it was, `learnAliases` refused them as "used
        elsewhere"; with those clips out of the comparison it learns "foster"); **(b) the
        preview showed only the first fitting clip in list order**, so 9 correctly named
        clips never showed, among them Camp Lazlo's solo "YES! Era NEXT" bumpers, 7th and
        8th of 9 clips that fit. Nothing was saved on any card of the copy, so Ron's own
        steps were not visible; the check put one "for the show coming up" step on every
        context.
      - **Built as five commits.** The four matcher fixes, each its own commit:
        the part of a title before a colon, spacing, a generic last word dropped, and a
        two-show title never half-read; then the preview. Across all 56 lists (9,195
        clips): named 1,541 to 1,658 (181 gained, 5 changed, 64 lost, which are the
        half-read ones, 65 flagged); in the three lists 5 clips gained a name (Ghost in
        the Shell twice, DragonBall GT, Mobile Suit Gundam NEXT twice) and 6 went from
        wrongly named to unnamed and flagged. 125 clips' hits come from a shortened title.
        Mutation-checked: each rule was broken in turn (the shortened form allowed to equal
        another show's whole title, spacing across a taken title, the generic word allowed
        mid-title or with one word left, both sides flagged, the straddling title read as a
        pair, `fits` unsorted or missing a clip) and a check failed each time.
      - **What the half-read rule does and does not do.** It flags a title built "A to B"
        or with a spaced slash when exactly one show is recognised and the hits are on one
        side of the separator; a hit that straddles it is one title ("Space Ghost Coast to
        Coast"). Known limits: 3 of the 65 flagged are false (a capital after "to" that is a
        verb: "7 Ways to Say 'All That'", "How to Perform CPR", "Like to Move"), and they are
        left unnamed for review, never named wrongly; pairs joined by a hyphen,
        "(TMNT-Teen Titans)" and "(Grim Advs Billy & Mandy-Ed Edd n Eddy)", are not detected
        and are still read as the one show.
      - **Still for step 6, recorded in the spec as requirements:** aliases that are phrases
        ("grim advs", "gundam 0083"), the review screen listing `unresolved` clips, and
        teaching "Foster's". Not matcher work: the 3 clips for shows no channel airs, the one
        clip naming no show (a fallback list's job), and a custom show being one show
        (a "Gundam 0083" bumper plays before whichever series starts).
      - **The preview change.** `buildPlan` returns `fits` on each step that plays, the
        titles of every clip that fitted the tier it chose from, the chosen one first (a clip
        already used in the plan is not in it). The preview lists them under the step.
      - **Hyphens, several shows and abbreviations (Oct 4, after Ron's Miguzi look).** Three
        more changes, each its own commit, then rows from the real titles. (1) *Hyphens:*
        "Miguzi - Next Bumper (TMNT-Teen Titans)" is two shows; a hyphen inside one pair of
        brackets cuts it into pieces and the never-half-read rule now runs over any number
        of pieces, for "A to B" and "Now/Then (A / B)" too. Against all 56 lists it changed
        6 clips, 3 right (the two Miguzi titles, "(Grim Advs Billy & Mandy-Ed Edd n Eddy)") and
        3 wrong, left unnamed and never named wrongly: "(Foster's Home For Imaginary Friends -
        Traffic)" twice and "(Fairly Oddparents - Cosmo)", where the piece after the hyphen is
        an episode or a character. The 13 hyphenated show titles on the channels (Scooby-Doo,
        X-Men: Evolution, He-Man and others) are tested as one title each, in brackets and as
        one of a joined pair. A first try added a protection for hyphenated words in show
        titles that changed nothing (the title's own hit straddles the hyphen), and was
        removed. (2) *Several shows:* names holds one to four keys, and a clip naming several
        fits a step keyed on next only when those shows air one after another in that order,
        starting with the show coming up (`showSequence`; `showAfter` is its second); a step
        keyed on now, and a pair step, still read what they always did. (3) *Abbreviations:*
        an all-capitals word of three or more letters that is the initials of exactly one
        show names it, `abbreviation: true` on the hit. Before committing it, what it does on
        all 56 lists was measured: 96 clips change, 93 gain a name, none loses one (TMNT 13,
        DBZ 33, MGPAM 26, ATHF 24). It found a trap: "TAS" would have named The Tex Avery Show
        for three clips that mean The Animated Series ("Batman TAS", "Superman TAS"), so
        initials are counted with and without a leading "The" and a subtitle's initials make
        an abbreviation ambiguous (never a meaning of their own): TAS names nothing, and neither
        does KND (80 clips, Codename: Kids Next Door), left to the review screen.
      - **Ron's Miguzi bumpers, as the data has them.** The three-show bumper is titled
        "(TMNT-Static-Teen Titans)", with "Static", not "Static Shock". "Static" alone is not
        Static Shock, so the clip is unresolved until "static" is taught as an alias, which is
        step 6's job; in the preview copy the alias was added by hand to show Sunday. The
        schedule is as described: Sat Oct 10 5:51pm Totally Spies! → TMNT, then Teen Titans;
        Sun Oct 11 5:21pm Totally Spies! → TMNT, then Static Shock, then Teen Titans, both in the
        Miguzi block. Plan rows run the real titles through the real matcher (see the spec's
        acceptance rows).
      - **Writers of a step, enumerated again** (the rule for this kind of change): the
        card editor (new; produces every field of the shape, unique ids), `normalizeTransitions`
        (defaults), `buildPlan` (reader), `warnAboutTransitions` and its two helper rules,
        the preview and the tag (readers, through `buildPlan`/`assemble`), `transitions-plan-day.js`
        and the spec. A stored step the editor does not know (`keyedOn: later`, kind `generated`)
        shows as "not built yet" and is kept as it is.
      - **Tests.** `test/transitions-editor.js`, 160 checks (see Testing notes), mutation-checked
        with 34 deliberate breaks, all caught. Not automated: the form and the directive's
        fetching, checked by hand on a copy of `.dizquetv-dev` in a browser (channel 1 at full size).

      **Step 6 built Oct 4, 2026 (Sonnet 5.5): the names review screen.** Nothing saved
      before it changes: a list with no `names` reads, saves and plays as before.
      - **The screen** (`web/directives/names-review.js`, one for the whole page, opened with
        `namesReview.open(listId)`): every clip of a saved list, grouped flagged / less certain /
        confident / no suggestion / saved, with how each suggestion was reached and whether its
        names are saved, only suggested or none. Per clip: accept, pick shows (up to four, in
        airing order, from the shows and custom shows on the channels), "Names no show", or teach a
        nickname. "Accept all confident suggestions" shows its count first and skips less-certain
        and flagged clips, and clips already saved or decided. Decisions are pending until Save.
        The logic that is not drawing is `src/names-review.js` (pure; grouping, accept-all, the save
        payload, names carried through a Plex refresh), tested in `test/names-review.js`.
      - **Where it opens from:** a "Match shows" button in the filler list editor (disabled with
        a line saying why when the clips were changed there and not saved, because the screen
        works on the saved list; the editor takes the new names up when the screen saves, so
        pressing Done does not write the old ones back), the **overview** on the Filler Lists page
        (every list with its counts, lists used by a transition step first, then by how many clips
        need a look), and a link in the transitions preview. Each filler row has a Names tag.
      - **Saving:** `POST /api/filler/:id/names` ({ clips: [{ index, title, names }], aliases }).
        It checks everything first (each clip still has that title at that index, the show keys
        are on a channel, picks are one to four with no show twice in a row, each nickname passes
        `checkNickname`) and a refusal writes nothing; then it sets `names` on exactly the clips
        listed and merges the nicknames. Also `POST .../nickname-check`, `POST
        .../nickname-suggestions` and `GET /api/names-overview`, none of which saves anything.
      - **"Names no show" is `names: []`.** An empty list used to be a malformed shape that
        warned at save; it now means "reviewed, names nothing". It plays like an unnamed clip,
        the preview's suggested-names overlay leaves it alone, and the screen shows it as saved.
      - **Nicknames may be phrases.** The matcher reads them folded and longest first, in what
        the show titles left over. `checkNickname` is the rule that stops "NEXT" and "Adult":
        refused when made only of everyday words, a number or under three letters, when already a
        title or a nickname, when it would not be used for the clip it was taught from, and when it
        would change the suggestion of (or sits in a clip saved under) a different show. On the
        real lists (preview copy): "Foster's" would name 120 clips ("Foster's / Camp Lazlo" becomes
        both shows), "grim advs" 64 and is accepted, "grim" alone is refused (it is in "Grim & Evil
        promo"), "KND" would name 74 more clips and is accepted for "Dexter to KND" with a note
        that Dexter still needs its own, "Adult" is refused because 19 clips for other shows use
        it, "NEXT" because it is an everyday word. Suggested phrases are at most three words and
        are not offered when another show's clip contains them ("Adult Swim").
      - **Preview.** "Use suggested clip names" is **unticked by default**. With it unticked, a
        step that found nothing only because the clips that would fit are not saved gets a line
        under its break: "2 clips would fit once their suggested names are accepted", with a link
        to that list's screen (the preview runs twice over the same breaks, the second on the
        overlaid names, and compares). Saving names marks an open preview as out of date.
      - **A trap found on the way:** a list imported from Plex has its clips replaced by Plex's
        every 30 minutes and on every save, which would have wiped saved names. `FillerService`
        now carries them over by rating key (file when there is none). All 58 lists on the data
        copy are custom lists, so nothing there depended on it.
      - **Proof on a copy of `.dizquetv-dev`, saved names only, "use suggested names" unticked:**
        with a "for the show coming up" step on the Miguzi block from "Miguzi Up Next", before the
        review no Miguzi break got a step; after accepting the TMNT-Teen Titans clip and teaching
        "static" for the TMNT-Static-Teen Titans one (and saving), Sat Oct 10 5:51pm Totally
        Spies! -> TMNT plays the TMNT-Teen Titans clip, Sun Oct 11 5:21pm Totally Spies! -> TMNT
        plays the TMNT-Static-Teen Titans clip, and every other break in the block gets nothing,
        read by a script that loads the saved lists and applies no overlay.
      - **Tests.** `test/names-review.js` (new) and a few changed in the others; every suite
        passes. Mutation-checked with 28 deliberate breaks (a phrase rule, each nickname rule,
        the group order, accept-all taking uncertain or overriding a decision, a save that carries
        every row, each save check, the Plex carry-over, the hints), 27 caught; the one that is not
        is a defensive deep copy that nothing can observe, and one more pattern did not apply. Not
        automated: the screens' fetching and clicking, checked by hand on the preview copy (the
        row-height test now has Names tags of three lengths). A first design refused a nickname
        unless it completed its clip, which refused "KND" on a title that also names Dexter; it
        now only needs to be what the clip is read by.
      - **Writers of `names`, enumerated** (the rule for this kind of change): the review save (new,
        the only one that creates names), the filler editor (carries them through, and takes the new
        ones up when the screen saves), `FillerService` (carries them through an import refresh),
        `fillerDB.saveFiller` (warns only), and readers `namesOf`/`namesProblem`/`isReviewedNone`,
        `buildPlan`, the preview overlay and the screen.
      - **Not done, step 7's:** channel 1's own lists have no saved names yet, so a sequence on the
        live channel plays nothing until the lists named in the overview are reviewed.

      **Movies and seasons in clip names, built Oct 6, 2026 (Sonnet 5.5), on branch
      `names-movies-seasons`.** Ron's ask: "DragonBall Z Movie Cooler's Revenge Intro" plays before
      that movie and not before a DBZ episode; Toonami's saga intros and Up Next promos play only
      before their season; the most specific clip wins. Full rules are in the spec's "Movies,
      seasons and specials" and "The most specific clip wins". 1,133 to 1,253 tests.

      - **Additive, and proved so.** A name is still a show key; it may also be `movie.<title>`,
        `{ show, season }` or `{ show, episode }` (`src/clip-names.js`). Names saved before read
        and play as they did. The old and the new plan builders were run side by side over channel 1's
        real lineup, 8 weeks, with a sequence on every day-part and block drawn from the 28 lists that
        carry saved names: **3,522 breaks, 2,945 with clips, 0 plans differ.** Control: turning every
        saved show name into a season name makes 2,243 differ, so the comparison can see a change.
        The only existing test that changed is "[as] SGC2C - Season 5 Promo", which now names season 5.
      - **What Plex and the data said.** Plex titles the DBZ seasons "Season 1" to "Season 9"; the sagas
        are only in the folder names ("03. The FRIEZA Saga (Eps. 075-107)"), so those are offered as
        hints, never as nicknames on their own. Specials are season 0 ("Bardock - The Father of Goku" is
        S0E16). All four DBZ movies Ron has clips for are in Plex's "Y. Toonami Movies" library but on no
        channel yet. No movie on any dev channel is outside a custom show, and 1,054 of the 1,374 distinct
        movie items are under 15 minutes (Looney Tunes shorts, My Gym Partner's a Monkey), which is why a
        movie is offered only at **40 minutes or more**. A movie in a custom show is keyed by its own title,
        not the custom show's key, and a DBZ clip does not play before it.
      - **What changes in the suggestions, on all 9,353 clips on the dev copy: 54, none with saved
        names.** 39 become a season or a special ("Season N" next to a show), 9 DBZ saga titles and 6 titles
        that say "Movie" or "Special" after a show with none on a channel become flagged and are no longer
        read as the whole show. With the four DBZ movies and Bardock on a channel, the Dragon Ball Z Movie
        Intro and Movie NEXT promos lists name their movies (9 clips) and the two Bardock clips name the
        special. Teaching "frieza saga" (the real flow, in the browser) named the clip it came from and
        suggested 5 more across lists.
      - **Decisions.** (1) Specific clips from the step's list *and* its fallback list come before show
        clips (Ron's call: the most specific clip wins), so the Bardock intro in "Dragon Ball Z Movie Intro"
        beats a plain DBZ intro in the main list. (2) A special needs its show named in the clip as well
        (without that, "The Musical Time Machine" named a Brak Show special). (3) A season from "Season N"
        and a special are less certain, so "accept all" skips them; a movie by subtitle and a taught
        nickname are confident. (4) A season nickname never counts a clip already suggesting the same show
        as another show's clip, and a clip saved as the whole show never blocks it. (5) A subtitle of only
        everyday words ("The Movie", "Part 2") is never offered.
      - **The picker and the nickname panel.** Movies are a third group after Shows and Custom shows;
        a show with seasons gets a second box ("Any episode", Specials, each season with its folder in
        brackets, each special); the nickname panel has the same season box and, under "From your Plex
        folders", one button per season that fills in the nickname (for example "frieza saga") and picks the
        season. `GET /api/show-seasons` asks Plex (one episode of the show, then each season's first episode
        for its folder, four at a time, 8s each, remembered 10 minutes) and falls back to the lineups' seasons.
        A flagged clip opens the nickname panel with the show it recognised already picked.
      - **A trap found on the way.** `marksOf(row)` built new objects on every digest, so `ng-repeat`
        never settled and the console logged `$rootScope:infdig` whenever the review screen opened (it
        worked anyway). Marks are now worked out once per proposal. Also: `show-match-service.js` checks
        its seasons cache before reading every channel.
      - **Writers and readers of a name, enumerated** (the rule for this kind of change): writers are the
        review save (picks and nicknames, validated by `validName`), the alias file (`show-alias-db.js`
        keeps strings and season objects only), the filler editor and `carryNames` (pass them through).
        Readers: `namesOf`/`namesProblem` (shape), `propose` and `checkNickname` (the matcher),
        `buildPlan` through `clipNames.fits`, the preview and Flex tag (through `buildPlan`), the
        screen and the editor's Names tag (`clipNames.labelOf`), `match-lists.js`, and
        `transitions-plan-day.js` (names in memory, through `buildPlan`).
      - **Not done, and limits.** A custom show has no seasons (it is one show). A movie under 40 minutes
        cannot be named. A special not filed under season 0 or as a movie cannot be named. The saga hint
        comes only from folder names; a library with flat folders gets no hints. Not automated: the
        screen's clicking and Plex fetching, checked by hand on a scratch server (port 18131) on a copy
        of `.dizquetv-dev`, with real Plex, in the browser.
      - **Tests.** `test/names-movies-seasons.js`, 120 checks, mutation-checked with 25 deliberate breaks,
        all caught (a season or movie fitting everything, specific clips tried late or only from the main
        list, a show clip before a movie, a movie not replacing its show, a special without its show,
        "Season N", the saga and movie flags, the stop words, short movies, a season nickname that does
        not narrow, the refinement counted as another show's clip, the repeat rule, the alias reader, the
        save's checks and the seasons cache). One defensive check in the save (the nickname's shape, before
        `checkNickname` would refuse it anyway) is covered only by its message.

      **Several seasons in one name, Oct 7, 2026 (Sonnet 5.5), on branch `names-seasons-anyof`.**
      Ron's ask: Justice League Unlimited is seasons 3 to 5 of Justice League in his Plex, so
      "Toonami - Justice League Unlimited Short Intro" should play before any episode of seasons 3, 4
      or 5, picked as several seasons in the picker and taught as a nickname ("justice league
      unlimited"). The first of four commits on the branch (the others: "any one of" several shows,
      the Movies tab, and a Nicknames page).

      - **The shape.** `{ show: "tv.Justice League", seasons: [3, 4, 5] }` beside `{ show, season }`:
        two or more seasons, ascending, no repeats (one season stays the old shape, so the picker's
        one-season choice saves exactly what it did). It is specific like a season, fits an episode of
        any listed season, and reads "Justice League · Seasons 3–5" (`clipNames.seasonsName` makes the
        one stored form, `seasonsLabel` the words). Names saved before read and play as they did.
      - **The nickname holds the show's own title.** A phrase is looked for only in what the titles
        left, and "justice league unlimited" starts with the title "Justice League", which takes those
        words first and leaves "unlimited": the phrase could never match, which is why Ron had taught
        the one word "unlimited" (as season 3) instead. Nicknames for seasons whose phrase contains a
        title of their own show are now looked for in the whole title first (`ownTitleNicknames`).
        No other nickname can hold a title of its show, so nothing taught before reads differently.
        The teach panel offers the show's title with the word next to it from the clip's title.
      - **The picker** has three radios under a show with seasons (Any episode / Some seasons / A
        special), a checkbox per season (Plex's title, the folder beside it) and a "reads as" line;
        the teach panel has The whole show / Some seasons with the same checkboxes. The slot logic is
        in `src/names-review.js` (`slotOfName`, `slotName`, `slotProblem`, `nicknameTarget`) so a test
        drives it. The check and suggestion routes take `seasons: [..]` as well as `season`.
      - **Proved additive** with `node scripts/compare-names-engines.js <data copy> <old checkout>`,
        which runs two source trees side by side: on the dev copy (9,442 clips in 100 lists, 40
        nicknames) the matcher proposes the same for every clip, and channel 1's 3,520 breaks over 8
        weeks, with `show`, `pair` and `any` steps from the 40 lists that carry saved names on every
        situation of every day-part and block, build the same plans: **0 differ**. The control
        (every saved show narrowed to one season) differs on 2,702, so the comparison can see a
        change. Test file: `test/names-seasons-anyof.js`, mutation-checked.
      - **Ron's data.** His "unlimited" nickname (season 3 only) still works and the new phrase wins
        where both are in a title. "Toonami - Justice League Unlimited Short Intro (4K HD)" is saved
        as season 3 only and stays so until it is re-picked as seasons 3 to 5; a nickname never
        rewrites a saved name.

      **"Any one of" several shows in a name, Oct 7, 2026 (Sonnet 5.5), same branch.** The second
      commit. Ron's Disney Channel Wand IDs show an actor, not a show ("Emily Osment Wand ID",
      "Christy Carlson Romano Wand ID"), and an actor can stand for more than one show (Christy
      Carlson Romano: Even Stevens and Kim Possible). A name may now be `{ anyOf: [show, show, ...] }`
      (`clipNames.anyOfName` makes the stored form): two to eight different shows or custom shows, in
      the order picked; the same shows in another order are the same name (`nameId`).

      - **What it fits and where it ranks.** A program of any member, as the show: not specific, so a
        season clip beats it and a clip naming the show exactly shares its tier and takes its turn by
        longest idle. In a "These clips feature shows" list it counts as naming the show coming up
        (first tier). It is one place in a multi-show list, so "A then B" in airing order is unchanged
        and an any-of can fill a place; the pair step reads it as the show that ended or is coming up.
        All through `clipNames.fits`, so `buildPlan` needed no change.
      - **Not the same as a multi-show title.** "Kim Possible to Even Stevens" is two places in
        order; `{ anyOf: [Even Stevens, Kim Possible] }` is one place either can fill. Both are kept.
      - **Nicknames.** A nickname for one show already worked ("emily osment" for Hannah Montana). It
        can now mean an any-of (`show-aliases.json` keeps `{ anyOf: [...] }`; the reader drops one that
        is not in the stored shape). A hit needs a key, so an any-of nickname's hit carries a made-up
        `any:...` key that never equals a show's; `nameOfHit` turns it back into the name. A show the
        title names itself beats an any-of nickname that includes it ("Christy Carlson Romano Kim
        Possible Promo" is for Kim Possible). The nickname checks are the same with "the set of shows"
        where there was "the show": a clip saved under a show that is none of them blocks it, one
        saved under one of them does not (`clipNames.showsOf`). Teaching from "Christy Carlson Romano
        Wand ID" now offers "christy carlson romano": a stretch of leftover words longer than three is
        offered by its first three when they sit in no bracket.
      - **Picker and teach panel.** A slot has "One show / Any one of these shows" and, for any-of, a
        select per show with "+ add a show" (two to eight, movies not offered); the teach panel has "One
        show / Some seasons of it / Any one of several shows". Slot logic stays in `src/names-review.js`
        (`slotProblem` says why a slot is not a name yet), the check and suggestion routes take
        `anyOf: [..]`.
      - **Proved additive** again with `scripts/compare-names-engines.js` (0 of 9,442 proposals and 0 of
        3,520 plans differ, control 2,702). Writers and readers of a name, enumerated: writers are the
        review save (`validName`, every member must be a show on a channel), the alias file, the filler
        editor and `carryNames` (pass through); readers are `namesOf`/`namesProblem`, `propose`,
        `checkNickname`, `learnAliases`, `nicknameSuggestions`, `buildPlan` through `fits`, the screen
        and Names tag through `labelOf` (the service gives every member a display name), and the
        scripts. Tests in `test/names-seasons-anyof.js`, mutation-checked.
      - **The Wand ID clips are not in the dev copy** (no title with "Wand" in any of the 100 lists), so
        the check used the nearest real titles ("Express Yourself (Christy Romano)", the Kim Possible
        and Even Stevens promos) and stand-ins named like Ron's.

      **The Nicknames page, Oct 7, 2026 (Sonnet 5.5), same branch.** The fourth commit. Until now
      a nickname could be taught on the review screen and never changed: "unlimited" (taught as
      season 3 of Justice League as a stand-in) could not be removed, and Ron will teach many more.
      A "Nicknames" button on the Filler Lists page opens `#!/nicknames`: every nickname with what it
      means in words, how many clips have it in their title ("In titles") and whether a show it
      means is no longer on any channel, searchable, with Edit and Delete.

      - **Edit** changes the text, what it means (one show, some seasons of it, any one of several
        shows, the same pickers as the teach panel) or both. **Delete** asks first. Neither writes a
        clip: `ShowMatchService#saveNickname` only calls the alias file's new writer
        (`ShowAliasDB#change`), and a test spies on `fillerDB.saveFiller` and compares the list files
        byte for byte before and after. A nickname only changes what is *suggested* for a clip with
        no saved names; a clip with names saved, or saved as naming no show, keeps them.
      - **Before it saves, it shows what would change**, as the teach panel does (`POST
        /api/nicknames/preview`, read-only; `src/nicknames.js previewEdit`): every unsaved clip
        whose suggestion would be different with what it is now and what it would become (a flagged
        title counts), the count of clips that keep a saved name, and the reason when the edit is
        refused. Save is disabled until the preview is ok, and the save runs the same check again.
      - **Rules.** The text and meaning follow teaching (`nicknameProblems`, split out of
        `checkNickname`: a show on a channel, at most six words, not only everyday words or a
        number, not a title, not another nickname) but not teaching's check against other clips,
        which would refuse changing what a nickname means whenever a clip saved under the old show
        has it in its title; here that is exactly what the preview lists.
      - **The writer** (`ShowAliasDB#change`) reads the file as it is, not through the reader that
        drops what it cannot use, so an entry the page does not touch (a hand-edited one) and any
        other key in the file is written back as it was; a nickname keeps its place when it is only
        given another meaning; the write goes through a temporary file and a rename; a file that is
        not valid JSON is refused, never replaced.
      - **What the real data showed.** On the dev copy, deleting the stand-in "unlimited" lists one
        clip, "Comm Break (WWE Unlimited Action Figure) (2003)" in Nick GaS, that the stand-in had
        been suggesting as Justice League season 3, and counts 4 clips that keep their names (the
        Justice League intro saved as seasons 3 to 5, and others). The list files were identical
        before and after (the checksum of every list in the folder).
      - Test file `test/nicknames-page.js`, mutation-checked. Writers of the alias file, enumerated:
        the review save (`merge`, adds only) and this page (`change`, edit and delete); readers are
        `propose` and the checks, which read through `load`.

      **Movies, seasons and specials inside "any one of", Oct 8, 2026 (Sonnet 5.5), on branch
      `names-anyof-mixed`.** Ron's ask: many Disney Channel Wand IDs stand for a star who was in a show
      and in one particular DCOM (A.J. Trauth: Even Stevens, and one movie). Until now an any-of could
      hold only shows and custom shows, so the only way to say "or that movie" was the whole DCOM custom
      show, which made the ID play before every DCOM. An any-of member may now be any single name: a
      show, a custom show, a movie (40 minutes or more), one season or several of a show, or a special.

      - **The shape.** `{ anyOf: [member, ...] }`, two to eight different members, never another any-of,
        never an audio show. A whole show beside a part of the same show is refused (redundant; two
        different parts of one show are allowed). `clipNames.anyOfProblem` says why a set is not a name, and
        `validName`, `slotProblem` and `anyOfName` all go through it. Every name saved before (shows and custom
        shows only) is a valid member list of the same kind and has the id it had.
      - **Ranking.** `clipNames.fits` returns the closest fit among the members: 'specific' before that
        exact movie, season or special, 'show' before a program of a member that is a show. `buildPlan` needed
        no change. On the dev copy, "Even Stevens, or Halloweentown" fits an Even Stevens episode as the show,
        Halloweentown as specific, Hocus Pocus not at all, and it beats a plain clip for the whole Friday DCOM
        custom show before Halloweentown. (Matching a movie that is in a custom show is by the movie's own
        title, `movie.<title>`, which is how a movie in a custom show is already keyed.)
      - **Nicknames** mean the same mixed sets (the alias reader keeps what `validName` accepts). An any-of
        hit's `keys` are now `showsOf` the name, so a nickname that holds a member's show title is still
        looked for in the whole title first, and "a show the title names itself beats an any-of that
        includes it" reads the show inside a season member too. A movie alone is still not offered as the
        meaning of a nickname.
      - **The UI.** One member row, `name-member` (`web/directives/name-member.js`, template
        `name-member.html`): the grouped select (Shows, Custom shows, Movies "(in Friday DCOM Movies)"), then
        Any episode / Some seasons / A special and the seasons or the special. The review picker, the
        teach panel and the Nicknames page all use it, and all three read seasons through one loader,
        `web/season-source.js` (it replaces two copies of the same code). A member is a slot in
        `src/names-review.js`. The Nicknames page's list now carries the movies, marked `movie`, for its
        member rows only.
      - **Proved additive** with `scripts/compare-names-engines.js` against the checkout before the change, on a
        fresh copy of the dev data (9,602 clips in 104 lists, 49 nicknames): 0 proposals differ, and channel
        1's 3,520 breaks over 8 weeks with `show`, `pair` and `any` steps from the 42 lists that carry
        saved names: 0 plans differ. The control (every saved show narrowed to one season) differs on 2,702.
      - **Ron's data.** The 8 Wand IDs that name the DCOM custom shows whole (A.J. Trauth, Kirsten Storms,
        Tahj Mowry, Spencer Breslin, Mickey Mouse, Rutt & Tuke, the Epic Mickey ident, Basketball) are
        untouched and read as before; narrowing them to a movie is a pick in the picker.
      - **Checked by hand** on a scratch server (port 18170) on a copy of `.dizquetv-dev`, in the browser: the
        picker on "Wand ID - A.J. Trauth" (replace the custom shows with the movie, Season 2 of Even Stevens,
        save: `{ anyOf: [{ show, season: 2 }, "movie.Halloweentown"] }`), the teach panel (check says "Even
        Stevens (Season 2) or Halloweentown") and the Nicknames editor (preview ok, 0 clips change, 12 keep
        names). A layout bug found there (the row collapsed to a sliver) is fixed in `style.css`.
      - **Writers and readers of a name, enumerated** (the rule for this kind of change): writers of an any-of
        are the review save (`validName`; every member's show or movie must be on a channel), the alias file
        (the reader keeps what `validName` accepts; the Nicknames page's writer reads the file as it is), the Nicknames save, the filler editor and
        `carryNames` (pass through). Readers: `namesOf`/`namesProblem`, `fits` (all plans), `propose`,
        `nicknameProblems`/`checkNickname`/`nicknameSuggestions` through `showsOf`, `nameOfHit`,
        `listNicknames`, `labelOf` (a part of a show reads "Kim Possible (Seasons 1, 2)"), the screens.
      - **Not done.** A nickname for one movie alone. A movie under 40 minutes. An any-of inside an any-of.
        The review screen's "Search clips" box does not filter (a scope bug from step 6, not touched here;
        its own task).
      - Tests: `test/names-anyof-mixed.js` (68 checks), 19 deliberate breaks all caught; four checks in
        `test/names-seasons-anyof.js` changed because they said a movie or a season was refused in an any-of
        or named "shows" in a message. 1,477 to 1,545 tests.

      **Step 7 built Oct 7, 2026 (Sonnet 5.5), confirmed in TiviMate by Ron on Oct 8: end to end on
      channel 1.** Nothing was changed: this step is a check, run on a snapshot of `.dizquetv-dev`
      taken Oct 7 at 7:29 PM Central (Ron saved Wand ID names and nicknames while it ran, so the
      first snapshot was thrown away and every number below was re-run on the second). 1,477 tests
      pass on `blocks` before it. Ron watched breaks from the watch list in TiviMate and they played
      as listed; which ones he watched was not recorded.

      - **Method (ad hoc, not kept).** A viewer walked through the real `video.js` router, with the
        real cursor, plans and shared breaks, the real `ChannelDB`, `FillerDB` and saved names, on a
        fake clock and a fake player, play times held in memory (seeded from the copy's play cache).
        Plan-level scans over the whole 323-day cycle used `breaksBetween` and `buildPlan` with a
        simulated rotation. Nothing wrote to the data folder.
      - **One week, Thu Oct 8 to Wed Oct 14: 448 breaks, 448 programs.** Every program started from
        its beginning, no fallback picture, and the tightest break had 72 seconds of room (a
        Checkerboard Era break with no steps); the tightest with steps was the Toonami boundary on
        Mon to Wed, a 186 to 206 second break with about 100 seconds of steps, which leaves 86 to
        103. Over the whole lineup (19,975 breaks, 5,572 with steps), 143 breaks have
        under 60 seconds of room: 123 are shorter than a minute before any step, and 20 are a
        minute or more that steps squeeze (the Mon to Wed Toonami boundary on its short days, 48 to
        57 seconds; Cartoon Theatre into CN City Night after "Yogi's First Christmas", 41; a few
        Space Ghost, CCF and Miguzi breaks). One Adult Swim break, Aug 26 at 5:45 AM, is 27 seconds
        with 40 of steps, so its Flex drops and the show starts about 13 seconds late.
      - **Two viewers, five simulated days** (offsets 3, 25, 61, 137 and 300 seconds, player delays
        0.3 to 2 seconds, about 8,000 requests): no fallback picture, and about half of each viewer's
        commercials were shared picks.
      - **What plays, by block.** Adult Swim: entering has "CN Up Next [Adult Swim]", an intro and the
        first show's NEXT bumper; between shows a show promo only 8 of 44 times (a generic bumper
        otherwise) and a NEXT bumper after; leaving a sign-off. Toonami: Mon to Wed entering the TOM
        intro and show intro, Friday the NEXT promo and the "Powerhouse NEXT" promo; between shows a
        show promo (4 of 12) or a bumper, then the show intro every time. Miguzi, Cartoon Cartoon
        Fridays and Cartoon Theatre play their sequences as configured. Adult Swim (Sun.), Powerhouse
        Era (222 breaks), CN City Day and Night between shows, Checkerboard Era, Toonami AcTN and
        Midnight Run have no steps and play commercials only.
      - **Steps that never fire or rarely do, all list gaps and none a bug.** The only step that never
        fired in the week is "CCF Show Intro" on the Friday Toonami to CCF boundary: the first CCF
        show is I Am Weasel and the list has no intro for it (also none for Johnny Bravo, What's New
        Scooby-Doo?, Samurai Jack or Time Squad). Miguzi's show intros are one clip (Teen Titans), its
        BTTS only Static Shock, its WBRB only Xiaolin Showdown, its show promos Static Shock, TMNT
        and Teen Titans. "Miguzi WBRB (Generic)" and "CCF WBRB (Generic)" are not wired as fallbacks.
        Lists no mix, step or fallback uses: the Toonami AcTN, Midnight Run and Nick at Nite lists,
        the "CN City Bumpers" lists and the Wand IDs list.
      - **The four checks.** (1) DBZ season 3: the first break before one is Mon Feb 8, 2027, 4:24 PM,
        "DBZ NEXT promo (Frieza Saga) [TOM 3]" then "DBZ Intro [Frieza Saga]"; five of the ten season
        3 breaks are in Midnight Run, which has no steps. A saga clip never played before a DBZ
        episode of another season (0 of 91 breaks). But "Toonami Show Intros" is set to feature
        shows, so season clips and unnamed intros fill in before The Transformers and Transformers:
        Robots In Disguise, 46 times in the cycle and already on Tue Oct 13 and Wed Oct 14. (2)
        Justice League Unlimited's intro was saved as season 3 only, as is the "unlimited" nickname:
        it never plays before seasons 1 or 2, and seasons 4 and 5 get the plain Justice League intro.
        (3) Channel 3 has no steps and no blocks, and the Wand IDs list (91 of 144 named by then) is
        in no mix, so no ID can play; in a scratch copy with a hypothetical "show" step on every
        day-part, an actor's ID played before their show (or any of an any-of's shows) 4,494 times
        with 0 wrong by an independent check, season-specific IDs stayed on their seasons, and the
        rest filled in. (4) Two viewers: above.
      - **Left for Ron, nothing changed:** steps for Adult Swim (Sun.) and Powerhouse Era, the "feature
        shows" setting on Toonami Show Intros, the Justice League intro as seasons 3 to 5, the missing
        CCF and Miguzi clips, and wiring the Wand IDs.
      - **The preview.** A detached worktree of `blocks` and a copy of the data under
        `C:\Projects\dizquetv-worktrees`, port 18160, started through `Win32_Process.Create` so it
        outlived the session. Two traps: `xmltv-settings.json`'s `file` is relative to the working
        directory, so the first start from the worktree failed to write the guide (harmlessly, the
        live file untouched) and the copy's setting was made absolute; and PowerShell 5.1's
        `Set-Content -Encoding utf8` writes a byte order mark, which `diskdb` refuses and which
        crashed the server at start. Write JSON with `[System.IO.File]::WriteAllText` and a
        `UTF8Encoding($false)`.

      **Step 8 built Oct 8, 2026 (Sonnet 5.5), on branch `later-step`: `keyedOn: 'later'` and
      Cartoon Theatre's "Next Time".** `transitions.js` gains `laterProgram(channel, brk, context)`:
      walks the cyclic lineup forward from the break, resolving each future program's context
      through the same `dayParts.resolveContext` every other context read already uses, rather than
      reworking its daylight-saving arithmetic forward. A day-part start or block airing names
      weekdays, so the walk only needs a week-and-a-day window to be sure of finding the context's
      next occurrence if there is one. `keyedShows('later', context)` feeds that program into the
      same `fitsHow`/tier machinery `now` and `next` already use, so a fallback list and the
      never-a-different-show rule work for it unchanged, with nothing special needed for the
      generated stand-in bumpers planned as their own session later. The editor gets a fifth
      `WHICH` choice ("for the show next time"); the two "not built yet" messages it used to show
      for this `keyedOn` are gone.

      - **Real-data check, on a copy of `.dizquetv-dev`.** A script walked channel 1's two
        upcoming Cartoon Theatre leaving-boundaries and ran the new resolver by hand: Sat Oct 10,
        2026 8:12:36 PM found the movie opening Sat Oct 17 at 7:00 PM ("Scooby-Doo"), and Sat Oct
        17's break found Sat Oct 24's ("Scooby-Doo 2: Monsters Unleashed") - both in under 1ms,
        884 and 883 scan steps respectively, over the real 39,999-program lineup.
      - **Ron's real "Cartoon Theatre Next Time" list (12 clips), checked against the real
        matcher.** 1 already has saved names that will fire correctly ("...on Zombie Island" to
        `movie.Scooby-Doo on Zombie Island`, and that movie is genuinely in the lineup). 9 propose
        nothing - not a bug: those movies (Balto, A Man Called Flintstone, An American Tail III,
        Batman Mask of the Phantasm, Bugs Bunny Movie, Land Before Time III, Life and Advs of
        Santa Clause, Millionaire Dogs, Scooby-Doo Meets The Boo Brothers) are not anywhere in the
        current 323-day lineup cycle, and (checked again below) not in any custom show's own
        catalog either, so they need adding there - to "Cartoon Theatre Movies", presumably -
        before any fix here can name them. 2 proposed something wrong, now fixed below.
      - **Two matcher fixes, asked for before merging, each its own commit.** `buildVocabulary`
        gains an optional third argument, `customShows` - every custom show's own definition
        (`CustomShowDB.getAllShows()`), read for movies of 40 minutes or more independent of
        whether any channel's current lineup is airing them, since a custom show's rotation moves
        on long before Time Slots is re-run to match (`ShowMatchService#vocabulary` now reads
        `getAllShows` instead of `getAllShowsInfo` to supply it). Checked against the real data:
        none of the 9 unmatched movies above are in any custom show's catalog either, so this
        alone does not make them namable yet - confirmed, not assumed. Separately, a movie's whole
        title now takes part in the longest-match rule exactly like a show's title, in a custom
        show or not; before, a movie with no colon subtitle inside a custom show was never offered
        by its own title at all, only by whatever show title happened to overlap its words. Fixes
        the two real clips above: "...Alvin and the Chipmunks Meet Frankenstein" no longer matches
        the show `tv.Alvin and the Chipmunks`, and "...The Jetsons Meet The Flintstones" no longer
        matches both `tv.The Jetsons` and `tv.The Flintstones` despite having none of the "A to B" /
        "(A-B)" separators the several-shows rule requires - both now name the movie, proven with a
        fixture built from the real titles. Both fixes touch only `show-match.js`'s vocabulary and
        proposals, never `transitions.js`, so they cannot change what a saved plan plays - confirmed
        by re-running the old-versus-new dump below after both and finding it unchanged.
      - **Old-versus-new, on a copy.** Every break of all three real channels over a week, built
        with the real filler lists (`env.getList`) through the code before this change and the code
        after: byte-identical, 1,149 breaks, nothing in the data touched by either run. Wiring the
        real "Cartoon Theatre Next Time" list onto Cartoon Theatre's `leaving.out` on the copy (the
        live `.dizquetv-dev` was never touched) and re-running the new code changed exactly one of
        those 1,149 breaks - the Sat Oct 10 leaving-boundary above - and even there nothing played:
        correctly, since none of the 12 clips names "Scooby-Doo" plain, only "...on Zombie Island".
        Re-run again after the two matcher fixes above: byte-identical to that wired run, as
        expected, since neither fix touches what a saved plan reads.
      - **The preview.** A second, full copy of `.dizquetv-dev` under
        `C:\Projects\dizquetv-worktrees\later-step-data` (copied Oct 8, 2026, ~11:10 AM Central,
        with the Next Time step wired onto Cartoon Theatre and `xmltv-settings.json`'s `file` made
        absolute, the same trap as step 7's preview), a detached worktree of `blocks`
        (`.claude/worktrees/later-step`), port 18180, started through `Win32_Process.Create` so it
        outlives the session. `.dizquetv-dev` itself was never written to.

      **Step 9 built Oct 9, 2026 (Sonnet 5), on branch `next-time-cards`: generated cards, the
      first piece of the Generated Up Next bumpers roadmap item.** When step 8's real "Next Time"
      clip has none for next week's movie, a card Syndicast renders itself stands in: a lively
      stretch of the movie with its title and when it airs over the picture, then Ron's real
      marquee ending. Designed from Ron's 12 real "Cartoon Theatre Next Time" clips (all ~15s, the
      same marquee ending in all 12 and reusable, no shared music bed across them - measured by
      cross-correlating their audio, which barely matched). Seven new modules
      (`src/card-templates.js`, `src/card-moment.js`, `src/card-render.js`,
      `src/dao/card-template-db.js`, `src/services/card-service.js`, `src/card-player.js`,
      `src/card-api.js`), a `kind: 'generated'` step in `transitions.js`'s `buildPlan` built on the
      same `now`/`next`/`later` lookups and `onlyIfNoMatch` rule every list step uses, and a Cards
      page. See docs/blocks-spec.md, Stage 5, "Generated cards", for the design.

      - **Playback never waits.** `buildPlan` asks `env.card(want)` for a card already on disk and
        skips the step, as a logged problem, when there isn't one - the same shape as a step whose
        list is missing. A background service (`card-service.js`) renders ahead: a minute after
        boot, every 30 minutes, and 10 seconds after a channel is saved, it builds the plan of
        every break in the next week with the real `buildPlan` and an `env.card` that only records
        what is wanted, then renders whatever is missing, one at a time.
      - **The card itself.** `footageSeconds` (11.25s by default) of the movie's own picture and
        sound, a lively stretch picked automatically (`card-moment.js`: keyframes from `ffprobe`,
        momentary loudness from `ffmpeg`'s `ebur128`, scored and kept outside the first tenth and
        last fifth of the movie, a quiet stretch passed over) or chosen by hand on the Cards page,
        with the title (Plex's own clear logo for the movie when it has one) and the airtime line
        over it, then the template's ending clip. Every line of text goes to a file `drawtext`
        reads with `textfile=`, never into the filter graph itself, so a title like "Scooby-Doo 2:
        Monsters Unleashed" or "Wakko's Wish" renders exactly as saved - checked with a real render
        of that exact title (`test/card-render.js`'s real-render pass); the two real Oct 10 and Oct
        17 cards below used Plex's own clear logo for the title instead of drawn text, since both
        movies have one, so they don't exercise this path themselves. A movie
        whose file (and Plex stream) can't be read gets the poster-and-art card instead, darkened
        by brightness alone so the colour survives. Rendered to the channel's own resolution,
        frame rate, codecs and bitrates (`card-templates.js`'s `cardFormat`), a hardware encoder
        rendering with the software encoder of the same codec, so it plays through
        `FFMPEG.spawnStream` exactly as a Plex clip does. No new dependency: ffmpeg and ffprobe,
        already required.
      - **Real-data check, on the Oct 10 and Oct 17, 2026 Cartoon Theatre leaving-breaks (the same
        two step 8 found the movie for).** Both real cards rendered through the live service, in
        the channel's real 1920x1080 MPEG-2/AAC format: the Oct 10 break's card for "Scooby-Doo"
        (15.136s, -18.9 LUFS, rendered in 6s, moment auto-picked at 44:21.9, the same stretch a
        hand check with the same measurements had picked the day before) and the Oct 17 break's
        card for "Scooby-Doo 2: Monsters Unleashed" (15.136s, moment auto-picked at 68:10.4,
        rendered in 9s). Both frames checked: the title, Plex's clear logo, and the airtime line
        all placed correctly; the second movie's colon-and-space title rendered intact.
      - **Old-versus-new, on three copies of the Oct 8 snapshot (not the Oct 8 copy itself, whose
        lineup had since moved on on the live server - a second copy was taken Oct 9 for this).**
        Every break of all three real channels over a week, built with the real filler lists
        through the code before this change and the code after: byte-identical, 1,143 breaks (the
        lineup moved between Oct 8 and Oct 9's copies, so this is not step 8's 1,149 - re-measured
        rather than assumed). Wiring the real Next Time list and the new card step onto Cartoon
        Theatre's `leaving.out`, in that order, and re-running the new code against the *same*
        Oct 9 snapshot (the first comparison's copy, unwired, read again to rule out any drift
        between separately-timed copies, which caught an unrelated day-part step id difference on
        the first attempt): exactly one break differed in each of three one-week windows -
        Oct 10's, correctly gaining the new steps as "not rendered yet" before any card existed;
        Oct 17's, the same; and Oct 24's (the week already covered by the spec's Oct 18 snapshot),
        where Ron's real "...on Zombie Island" clip actually matched the movie that leaving-break
        opens into next and played, and the card step correctly stayed out
        ("only plays if \"...\" finds no clip, and it did"). Every other break, on all three
        channels, every week checked: unchanged.
      - **The preview.** A third copy of `.dizquetv-dev` under
        `C:\Projects\dizquetv-worktrees\next-time-cards-data` (copied Oct 8, 2026, ~7:38 PM
        Central, `xmltv-settings.json`'s `file` made absolute, the same trap as steps 7 and 8's
        previews), the `next-time-cards` branch's own worktree (`.claude/worktrees/next-time-cards`,
        branched from `blocks`), port 18190, started through `Win32_Process.Create` so it outlives
        the session. A "Cartoon Theatre Next Time" template was saved through the real Cards page,
        with Ron's real ending
        clip and closing-music bed. `.dizquetv-dev` itself was never touched.
      - **A scratch channel (905), where a card airs every 20 minutes, not weekly.** Two real
        movies none of Ron's 12 real clips name (The Pagemaster, The Iron Giant), each in its own
        short block, so every cycle wants the generated card, never a real clip. Deliberately
        bounded: a `later`-keyed card whose next airing is only minutes away bakes the exact clock
        time into its when-text ("TODAY · 12:40AM"), so every occurrence is its own card, unlike
        the real weekly Cartoon Theatre, where the next airing is always a day or more out and a
        card renders once or twice a week. An unbounded every-few-minutes channel would have asked
        the real week-ahead scanner to render on the order of 2,500 distinct cards on its first
        pass - hours of work and tens of gigabytes - so the block's own airings are confined to a
        four-hour daily window (`00:00`-`04:00`), about 175 cards a week. Confirmed live, through
        the real running preview server: `/api/channel/905/now-playing` matched the predicted
        schedule, and the server's own log carried the plan line
        `Break plan, channel 905, boundary break ending 1:35:54 AM: Next Time: The Iron Giant ->
        Flex -> (none)` - the generated card chosen as the out step of a real break, by the
        production code, not a test fixture.

- [x] Next Time bumper: `keyedOn: 'later'` and the Cartoon Theatre "Next Time" row (stage 5 step
      8). **Built Oct 8, 2026**; see the "Step 8" entry above (after Step 7) and the spec.
- [x] Generated Next Time cards for Cartoon Theatre: when step 8's real clip has none for next
      week's movie, a card Syndicast renders itself stands in (stage 5 step 9, the first piece of
      the Generated Up Next bumpers roadmap item below, pulled into 1.0). **Built Oct 9, 2026**;
      see the "Step 9" entry above and the spec.
- [x] Slot filler positions (HEAD / PRE / MID / POST / TAIL) - *covered by
      stage 5's sequences, decided at its design pass: PRE and POST are the in
      and out steps, HEAD and TAIL are Entering and Leaving, MID is stage 6;
      see the spec. Nothing is left over.*
- [ ] Midrolls
- [ ] Generated Up Next bumpers (after 1.0, except the Next Time piece below)

      Syndicast builds these live at airtime from its own schedule, so they
      always match
      what actually airs next, even after a regeneration, a swap or an insert.

      Styled per day-part and block from a template (colors, logo, layout),
      so the style changes automatically when the block changes.

      Three kinds, one built:

      - [x] "Next Time": Cartoon Theatre's stand-in when step 8's real clip has
        none for next week's movie - a few seconds of the movie itself with its
        title and airtime, then a real ending clip. The first piece of this
        item, pulled into 1.0 and built on the `generated` step type below (see
        "Generated Next Time cards for Cartoon Theatre" above and
        docs/blocks-spec.md, Stage 5, "Generated cards"). **Built Oct 9, 2026.**
      - [ ] "Up Next": a short clean clip from the actual next episode, plus the
        show's Plex logo or artwork and its start time.
      - [ ] "Later Tonight": a show further down the schedule.
      - [ ] "Tonight on [block]": a lineup card listing the block's next few
        shows.

      Built as a new step type, "generated", inside stage 5's transition
      sequences, matching the channel's resolution and aspect setting. Stage
      5's design pass left room for it and the Next Time card built it (see
      docs/blocks-spec.md).

      "Up Next" and "Tonight on [block]" still depend on the chapter and
      segment detector, which picks a clip of the actual next episode that
      avoids a cold open and credits - a movie has no such episode to clip
      from, which is why the Next Time card needed none of that to come first.

- [ ] Date-aware promos (after 1.0)

      Promos whose titles say tonight, tomorrow or a weekday (for example
      "DCOM Horse Sense promo (tomorrow)") air only when that's true on the
      schedule; a "tomorrow" promo plays only on the day before that program
      actually airs. Builds on the `later` key.
- [ ] Seasonal episodes air themselves in their season (after 1.0)

      Episodes left out as "Holiday: I'll place it myself" (see "Full
      catalogs, and a never-air list" under Known issues) place themselves in
      their holiday's season, with the same date logic as date-aware promos,
      instead of Ron placing them by hand each year. Added Oct 10, 2026.

### Scheduling

- [x] Season exclusion / season start, per slot, for Play Next
- [x] Setting a season range across a group of slots in one go, and a filter for
      finding the slots to set it on
- [ ] Episode start: start a show or custom show at a specific episode, not
      just a season

      Extends the existing per-slot season start (the ticked line above),
      and, now that stored progress is built, is a seek on a position's
      stored place like season start (`seekOf` in `src/slot-progress.js`) -
      see "Per-position stored progress, and the shuffles built on it" under
      Known issues.
      Opus 5.5 designs, Sonnet 5 builds. Our stamp: pick the starting
      episode by title from a list of that season's episodes (or the custom
      show's items), and preview the date and time it will first air in that
      slot.
- [ ] Save time-slot editing progress without generating a lineup

      `channel.scheduleBackup` already round-trips the schedule -
      `onTimeSlotsDone` in `web/directives/channel-config.js` writes it - but
      only alongside a regenerated lineup: `finished` in
      `time-slots-schedule-editor.js` calls `onDone` with the result of
      `doIt`, which builds the new `channel.programs` and the schedule to
      back it up in the same call. Cancelling or closing mid-edit loses
      whatever was changed; there is no draft save. So the actual gap is
      narrow - a way to persist progress without generating - but the UI has
      to close it visibly: once a saved schedule can exist without a lineup
      built from it, the two can disagree, where today they are always in
      sync by construction (`scheduleBackup` is never written except
      alongside the programs it produced).

- [x] Sign-ons and sign-offs - *covered by stage 5's sequences, decided at
      its design pass: a Leaving sequence at the end of the broadcast day and
      an Entering one at its start. Adult Swim's sign-off and sign-on ran as
      configured in step 7. The leftover is the next line.*
- [ ] An overnight stretch that looks off-air: the neighbour rule plays one
      mix through a long break, so a stretch that should look off-air has no
      way to; see the spec's Stage 5. Recorded at step 7, not built.
- [ ] Random slot pad times below their duration
- [ ] Chapter and segment detector, to split episodes and insert bumpers between segments
- [x] Per-position stored progress, so every slot or range continues where it
      left off across a regeneration, whichever day it is run and whatever
      airs first. *Built Oct 9, 2026 (steps 1-2): every Play Next position
      continues from its own place, and every Shuffle position too, from the
      old shuffler's number until step 3's rounds replaced it - see the build
      record in the Known issues entry. Every step's proof re-run on the final
      code Oct 10 (step 7).*
- [x] Shuffle - a round per range, kept by episode, with season settings.
      *Built Oct 9, 2026 (step 3), multi-part stories kept together - see the
      build record in the Known issues entry.*
- [x] Rerun - a Shuffle of only the episodes the show's Play Next has already
      aired, so a weekend never gets ahead of its weekday strip. *Built Oct 9,
      2026 (step 4) - see the build record in the Known issues entry.*
- [x] Repeat a slot - re-airs whatever a chosen earlier slot aired, the same
      day (9pm's episode again at 1am) or another day of the week (Saturday's
      That's So Raven repeats Thursday's). *Built Oct 9, 2026 (step 5) - see the
      build record in the Known issues entry.*
- [x] Ordered shuffle - a series at random, that series' next episode in
      order, for custom shows that join several series. *Built Oct 9, 2026
      (step 6) - see the build record in the Known issues entry.*
- [x] Multi-part stories kept together by every shuffle - part 2 always
      follows part 1. *Built with Shuffle, Rerun and Ordered shuffle (steps 3,
      4 and 6), within a series for Ordered shuffle.*
- [ ] Full catalogs: every slot draws on its show's or custom show's whole
      episode list, with a per-channel never-air list, a one-time review per
      show, and a choice when deleting an airing. *Designed Oct 10, 2026 - see
      "Full catalogs, and a never-air list" under Known issues.*

All six were designed together on Oct 9, 2026 and built Oct 9-10 on the
`stored-progress` branch, which waits for Ron to merge it into `blocks` - see
"Per-position stored progress, and the shuffles built on it" under Known
issues for the design, the measurements behind it and the build record, and
[docs/stored-progress-plan.md](docs/stored-progress-plan.md) for the build
order. Orderers stopped being keyed by show when per-slot seasons shipped, but
a show still had one founder, so only one of its ranges could resume exactly;
the design replaces the founder with a stored place per position.

Grouped editing was the cost of per-slot settings meeting a weekly period.
Switching a schedule from daily to weekly clones every slot across seven days,
so a 48 slot channel becomes 336 rows, and setting one show's range for Monday
through Thursday meant finding and editing four of them by hand. The season
panel now carries a day picker, and the row list a filter. See the slot editing
entry under Known issues for why the picker works on times of day rather than
on shows.

### Media handling

- [ ] Per-channel transcoding configs, so channels can use different video and audio formats
- [x] Fix NVIDIA / h264_nvenc encoder issues

      **Investigated Sep 28 - Oct 1, 2026 (Opus 5.5); built Oct 1 (Sonnet
      5.5), see "Built" at the end of this entry.** On Ron's RTX 3060 (driver
      616.56, ffmpeg 7.1 gyan full build, the dev path) with `videoEncoder`
      set to `h264_nvenc` and everything else as in `.dizquetv-dev`.

      **The one real failure: every 10-bit source.** Everything 8-bit works;
      everything 10-bit fails before sending a byte:

          [h264_nvenc] 10 bit encode not supported
          [h264_nvenc] No capable devices found
          Error while opening encoder - maybe incorrect parameters such as
          bit_rate, rate, width or height.
          exit code 3752568763 (AVERROR_EXTERNAL, unsigned)

      Ampere's NVENC can't encode 10-bit H.264 at all. Syndicast decodes on
      the CPU and never sets a pixel format for real items, so a 10-bit
      source arrives at the encoder as `yuv420p10le`, ffmpeg picks NVENC's
      10-bit input, and the encoder refuses. (mpeg2video only takes 8-bit,
      so ffmpeg has always converted silently there; that is why this never
      showed before.) Failed: Samurai Jack (HEVC Main 10, 1440x1080), Dexter's
      Lab (HEVC Main 10, 720x480, marked), Cowboy Bebop (H.264 High 10,
      1448x1080) and InuYasha (High 10, 640x480, marked). Bebop *with* a
      watermark works, by accident: the overlay filter outputs 8-bit.

      **How much of the real channel that is**, from ffprobing every file
      channel 1 can play: 10-bit is 42.7% of the lineup's airtime (HEVC
      Main 10 37.7%, H.264 High 10 5.0%; 2,071 of 4,474 program files),
      across 22 real shows: Pokémon, Dexter's Lab, Johnny Bravo, InuYasha,
      Robot Chicken, Family Guy, Futurama, Justice League and more. Filler is
      almost all 8-bit H.264; only 2 CN Groovies clips are 10-bit. (Unrelated
      to NVIDIA: the 118 "Black Commercials" files on H: are missing, since
      the drive wasn't there.)

      **What a viewer sees when a 10-bit episode comes up**, measured on a
      copy of `.dizquetv-dev` on port 18095 through `/video`, with a scratch
      channel 900 airing Samurai Jack: the loading screen, then the item
      fails in about 1s, then `PlexPlayer`'s error handler plays 60s of
      testsrc colour bars. Then the concat asks again, the same episode is
      still on, it fails again, and there are 60s more bars, for the whole
      episode.

      **Everything else works on NVENC.** Built by the real `src/ffmpeg.js`
      (spawn recorded, as `test/aspect-mark.js` does) and run with the real
      ffmpeg against the real files: the loading screen, the interlude, the
      offline screen, all three error screens (testsrc, picture, text),
      8-bit episodes from 480x360 to 1080p60, five short filler clips (9-15s;
      Adult Swim bumper, CN City, Checkerboard ID, Toonami AcTN), the
      watermark (on ATHF, Batman TAS, Attack on Titan) and "Let the viewer's
      player decide". The loading screen and an 8-bit episode also ran end to
      end through `/video` on the test server. The marking comes out exactly:
      Batman TAS, ATHF and Cow and Chicken (anamorphic DVD) all at 1920x1080
      SAR 3:4, and marked plus watermark works too. Since nothing scales on the
      GPU, the aspect plan's warning doesn't apply yet.

      **Wrong, though nothing fails:**
      - *The channel's bitrate is ignored.* Syndicast gives nvenc `-maxrate`
        and `-bufsize` but `-b:v` only to mpeg2video, so nvenc targets its own
        2000 kb/s default at 1080p (logged as `2000 kb/s`; measured 2.0-3.0
        Mbit/s out against the channel's 5000k). It is the same omission that
        once left mpeg2video at its 200 kb/s default (56a4f3f).
      - *`-crf 22` and `-sc_threshold` do nothing for nvenc*: ffmpeg logs
        "Codec AVOption crf ... has not been used for any stream", and the
        same for `sc_threshold`. They're harmless, but noise in the log.
        `-flags cgop+ilme` is harmless too: the encoder's log says "bottom
        coded first", but every decoded frame is progressive.
      - *1080p 8-bit H.264 sources are copied, not encoded.*
        `isDifferentVideoCodec` treats h264 against `h264_nvenc` as the same
        codec, so a 1920x1080 H.264 source at 29.97fps or below with no
        watermark goes out as `-c:v copy`. That is 526 files, 10.7% of
        airtime (Attack on Titan came out at 9.4 Mbit/s, untouched). Under
        mpeg2video everything was re-encoded. None of those 526 are 10-bit
        today, but the check doesn't look at bit depth, so a 1080p High 10
        file would be copied straight through. Untested: `-ss` with `-c:v
        copy` can only start on a keyframe, which matters on a mid-episode
        tune-in.
        **Corrected Oct 1 (see "Built", 3): Plex rounds the frame rate, so
        29.97fps was never copied and the 526 files overstate it.**

      **How many streams, alongside another streaming server on this PC.**
      Three of that server's channels, each on cuda decode, `scale_cuda` and
      NVENC, were all streaming throughout. Before Syndicast uses the card
      at all, it holds 6 NVENC sessions, with the engine 57-88% busy: that
      server's 3, plus, most likely, the two OBS Studio windows and
      Streamlabs, the only visible processes with `nvEncodeAPI64.dll`
      loaded. (The other server runs elevated, so its own modules can't be
      listed.)
      - *There's no session cap here.* 20 extra encodes held open together
        made 26 at once, and every one ran, at about 150 MB of GPU memory
        each. The old consumer limit of 3, then 5, then 8, doesn't bind on
        this driver.
      - *The limit is the encoder's throughput, which is shared.* Copies of
        Syndicast's real Batman TAS command at `-re`, 30s each: 6 streams all
        at 1.000-1.001x realtime, engine 48-90% busy; 10 streams at
        0.997-0.999x, engine at 99% the whole time. So **about 6
        comfortably, 8-9 at most**, alongside today's load from the other streaming server and OBS.
        Whether the other streaming server's own streams slowed during the 10-stream run wasn't
        measured.

      **CPU saved against today's mpeg2video.** Fixed content (from 300s in),
      `-re`, each ffmpeg's own CPU time from `-benchmark`, all marked High
      QoS, 60s (45s for Samurai Jack). The machine was already busy at about
      40%: the other streaming server's three streams, port 18000 streaming channel 1, and OBS.

      - Batman TAS (1440x1080 8-bit H.264, scaled and padded): one stream,
        mpeg2video 0.76 cores against NVENC 0.30; three streams, 0.82-0.88
        each against 0.35-0.37 each.
      - Samurai Jack (HEVC Main 10; NVENC given `-pix_fmt yuv420p` in the
        test harness only, the fix below): one stream, 0.91 against 0.41;
        three streams, 1.12-1.22 each against 0.59-0.72 each. Adding cuda
        decode (`-hwaccel cuda`) took one stream to 0.31.

      So **about half a core per stream**, 1.5 cores for three, out of 20.
      All runs kept realtime either way. What's left on the CPU is decode,
      scale and audio, so NVENC is a modest saving now that `-qscale:v 1` is
      gone (fecfd2f), not a rescue. Its real gains are H.264 itself, any
      sample aspect ratio stored exactly (MPEG-2 rounds to four), and a
      smaller stream.

      **The High QoS helper matters less with NVENC, but keep it.** Forced
      throttling - each ffmpeg marked EcoQoS by the same helper with its
      state mask flipped, the mark read back as `control=1 state=1`:
      - NVENC, Batman TAS: one stream 0.999, three 1.000 each, at 0.23-0.25
        cores.
      - NVENC, Samurai Jack: three streams 0.996-0.998 and six 0.998-0.999,
        at about 0.47 cores each - the shortfall is startup.
      - mpeg2video, Batman TAS: one stream 1.000, three 0.989-0.992.

      Throttled NVENC keeps up where mpeg2video starts to slip, because there
      is so little left on the CPU. But the helper costs nothing per stream.
      Throttling still bites anything CPU-heavy (the fallback below most of
      all), and E-core headroom depends on what OBS and the other streaming server are doing.

      **Is the graceful fallback still the right fix? Not as the fix, only as
      a safety net.** The failure isn't random: it is decided by the source's
      bit depth, known before ffmpeg starts, and it hits 43% of airtime.
      Falling back each time would mean a failed start on almost every other
      episode, and the fallback itself is expensive. What's needed, in order:

      1. *Hand every H.264 encoder 8-bit 4:2:0.* `-pix_fmt yuv420p` (or a
         final `format=yuv420p` in the filter chain) whenever the video is
         encoded with an H.264 encoder. This is not only for nvenc:
         libx264 fed the same Samurai Jack wrote **High 10**
         (`yuv420p10le`), which most TV-box hardware decoders can't play.
      2. *Give nvenc `-b:v`* at the channel's bitrate, as mpeg2video already
         gets, and drop `-crf` and `-sc_threshold` for it.
      3. *Decide the copy path.* Either always encode with H.264 encoders,
         the same normalisation mpeg2video gives today, or at least treat a
         source that isn't 8-bit 4:2:0 as a different codec. That needs
         `streamStats` to carry the bit depth: Plex reports one, and
         `plexTranscoder.js` doesn't copy it.
      4. *Then a fallback, for what can't be predicted* - no GPU, the driver
         gone, an NVENC error mid-update. **It must fall back to libx264,
         not mpeg2video.** The `/video` concat joins items with `-c copy`.
         Measured: an nvenc item, then an mpeg2video item, then an nvenc
         item, joined that way, decoded only 487 of 640 frames, with 8,504
         decode errors; the MPEG-2 item is read as H.264 garbage. The same
         with a libx264 item in the middle decoded all 640. The failure is
         fast and clean: about 0.5-1.1s, exit 3752568763, before any data is
         sent, so retrying the same command with the encoder swapped needs
         no unpicking of the stream. It also has to cover the screens, which
         encode with the same encoder. And it should remember a failure for a
         while, rather than paying a second at every item. But libx264 with
         today's flags costs 2.15 cores on Batman TAS and 3.42 on Samurai
         Jack, and fell behind realtime (0.990, 0.988), partly the
         `-sc_threshold` quirk in "Heavy buffering during playback". So it
         needs a faster preset to be a fallback at all - unmeasured then;
         superfast, measured, below.
      5. *Not needed now:* GPU scaling and cuda decode. Decode is most of
         what's left, and cuda decode saved 0.1 core per stream. If either is
         ever added, it must take its size from the same `cw`/`ch` decision,
         per the aspect plan below.

      **Built Oct 1, 2026 (Sonnet 5.5): four commits, each its own, on branch
      `nvenc` and merged into `blocks`.** All four of the list above, in that
      order, except that 3 became "always encode". GPU scaling and cuda decode
      were left out, as 5 said. Test count 269 -> 312. Ron's channels use
      mpeg2video, and those 32 recorded commands (item, screens, watermark,
      fit and mark, audio only, concat) are byte-identical across all four
      commits. Every other number below is from the real `src/ffmpeg.js` and
      real ffmpeg on Ron's files.

      1. *8-bit (58cd9ad).* `-pix_fmt yuv420p` whenever the encoder name
         contains "264", once (the screens already carried it). Samurai Jack
         S01E01 (HEVC Main 10): nvenc went from exit 3752568763 and 0 bytes to
         a clean stream, and libx264 from High 10 to High.
      2. *nvenc bitrate (d8516aa).* `-b:v` at the channel's bitrate, no
         `-crf`, no `-sc_threshold`. Batman TAS, 40s: the encoder target went
         from 2000 to 5000 kb/s and the stream from 11.7 to 20.7 MB (2.3 to
         4.1 Mbit/s with audio and mux). Both "option not used" warnings are
         gone.
      3. *Always encode (a42a9c6).* Under h264_nvenc **and libx264** nothing
         is copied any more; mpeg2video still copies what is already MPEG-2,
         and "normalize video codec" off still copies. **A libx264 channel
         therefore stops copying H.264 too**, at the cost of that CPU. Ron
         chose this without the TiviMate comparison, "for the smoothest
         playback" and "one uniform stream" for TV-box players. The evidence,
         from two scratch servers streamed over the LAN (copy as today against
         always encode), five minutes of a clip loop alternating copied and
         encoded items from each:
         - *The copy-as-today stream changes codec settings at every join*:
           the copied clips are High@4.0 and High@5.1, the encoded items
           Main@4.0, with different reference frames and timing metadata each
           time (104 parameter sets across High@4.0, High@5.1 and Main@4.0,
           against 38, all Main@4.0, when always encoding; the 4.2 in both is
           the loading screen). A TV box's hardware decoder may reconfigure at
           each of those; that is what a TiviMate test was to show, and what
           was skipped.
         - *Not a difference on a PC:* no backward timestamps in 8,230 and
           8,213 frames, no gap over 0.5s, and VLC (150s on each) never
           re-created its decoder at a join. PotPlayer could not be observed.
         - *A mid-episode tune-in on copy starts early*: at the keyframe
           before the point (595.8s for a 600s tune-in on Attack on Titan
           S01E01; keyframes there are up to 8.5s apart). Encoding is exact.
         - *Cost:* about 0.3 core per NVENC stream.
         - **Correction to the findings above: far less was copied than
           "526 files, 10.7% of airtime".** `plexTranscoder.js` rounds the
           frame rate (`Math.round`, line 260), so a 29.97fps source reads as
           30, is over `maxFPS` and takes the fps filter, which encodes. Only
           24 and 25fps 1080p H.264 was ever copied: 30 of 2,588 filler clips,
           and mostly episodes. The 526 counted ffprobe's unrounded rate.
      4. *libx264 fallback (411d471).* If an h264_nvenc ffmpeg exits non-zero
         before sending a byte, the same item is run again with libx264, in
         `FFMPEG.spawnWithFallback`, so items and every screen get it.
         Only nvenc items go through it; mpeg2video, libx264 and the concat
         process keep returning their ffmpeg's own stdout, as before. Once
         libx264 has rescued an item, the next ones skip nvenc for five
         minutes (process-wide, not per channel), then nvenc is tried again.
         A failed rescue does not start the window. Not retried: nvenc dying
         after data has gone out (it would repeat what was sent) and a kill.
         The command is the nvenc one with the encoder swapped: `-preset
         superfast`, `-profile:v main` (what the nvenc items come out as, so
         a mid-session switch doesn't reconfigure a TV box), `-crf 22`, no
         `-b:v`, no `-sc_threshold`. **The preset**, Samurai Jack at `-re`,
         High QoS, 60s, with the other streaming server's three streams, OBS and the live server
         running (realtime is 0.995 and up; about 0.998 is the ceiling
         because of start-up):

         | preset | 1 stream | 3 streams | 6 streams | cores each (3) |
         |---|---|---|---|---|
         | today's libx264 (medium) | 0.987 | 0.915 | | 5.1 |
         | faster | 0.987 | 0.989 | | 3.0 |
         | veryfast | 0.998 | 0.995 | 0.990 | 2.1 |
         | **superfast** | 0.999 | **0.997** | 0.993 | 1.7 |
         | ultrafast | | 0.999 | 0.997 | 1.1 |

         superfast is the slowest that holds realtime for three with margin.
         It does not hold six (0.993); ultrafast does, at lower quality, since
         it sits on the 5000k cap. If NVENC is ever down for good and more
         than three people watch, that is the one to try. **Forced failure,
         end to end**, on a scratch server whose environment hid the GPU
         (`CUDA_VISIBLE_DEVICES=-1`, a genuine `CUDA_ERROR_NO_DEVICE`; it
         exited 171 in a bare ffmpeg and 2981409195 through the server, and
         any non-zero exit with no data counts): the two items that started
         before anything was remembered were rescued, every later one went
         straight to libx264, zero error screens, 10 items played, the stream
         Main@4.0 throughout. The 10-bit episode played through that server
         too. The same `CUDA_VISIBLE_DEVICES=-1` is the way to repeat it,
         with nothing faked.

      **Not tested:** TiviMate and a real TV box on the always-encode stream
      (skipped by Ron's decision), and PotPlayer. An NVENC death after data
      has gone out still ends in the error screen, as before.

      **Two traps found on the way.** (1) A scratch server on a copy of the
      data reads `xmltv-settings.json`'s `file`, which is a path relative to
      the working directory (`./.dizquetv-dev/xmltv.xml`): started from the
      main checkout it would overwrite the live `xmltv.xml`. These ran from a
      worktree, where that folder doesn't exist and the write just failed;
      the copies' setting was then made absolute. (2) `vlc -I dummy
      --run-time=150 ... vlc://quit` does not exit. Two of them kept two
      streams alive and, with their ffmpegs, ate enough CPU that the first
      preset measurement came out wrong; the nvenc reference row in the same
      run (0.79-0.93 where 0.997 had been measured) is what gave it away.
      Always keep one reference row in a measurement, and look at what else
      is running.
- [x] Let the viewer's IPTV player (TiviMate, ImPlayer) stretch 4:3 to fill
      the screen with its own aspect setting, with "normalize resolution"
      still on

      **The goal, restated Sep 27, 2026:** Syndicast should not decide to
      stretch; the viewer's player should be able to. Today it can't,
      because normalize resolution paints the black bars into the
      1920x1080 frame, so to the player the bars are picture. The first
      plan below (Syndicast stretches) is kept as the fallback.

      **Primary plan: mark the shape instead of painting bars. Not built;
      waiting on the player tests below.** Keep the constant frame size,
      but scale the 4:3 picture to fill all of it and mark it with a
      sample aspect ratio so it *displays* 4:3: `scale=W:H` then
      `setsar=(cw*H)/(ch*W)` in place of `scale=cw:ch`, `pad`, `setsar=1`.
      For 4:3 in 1920x1080 that is `setsar=3/4` - pixels three-quarters
      as wide as they are tall. A player that honours it shows bars of its
      own, which its stretch setting can then remove. `cw`/`ch` already
      account for anamorphic sources, so the same formula holds for them.

      - *The encoder carries it.* Checked on the real encoder settings
        (`mpeg2video`, 1920x1080): the marked pieces come out 1920x1080 at
        SAR 3:4, display 4:3. MPEG-2 can only label a picture square, 4:3,
        16:9 or 2.21:1, so anything else is rounded to the nearest -
        harmless for real 4:3 (Dexter's Lab DVDs at 15:11 would show a hair
        narrow). H.264 encoders, `h264_nvenc` included, store any ratio.
      - *The concat and stream path keeps it, item by item.* Each item's
        ffmpeg writes mpegts; the `/video` concat process joins them with
        `-c copy` and sends mpegts to the player. The shape lives in the
        video data itself (the MPEG-2 sequence header, or H.264's SPS),
        which a copy never touches, and mpegts has no container-level
        shape to override it. Measured by running Syndicast's own concat
        command, recorded from `src/ffmpeg.js`, over loading screen ->
        Batman TAS (marked) -> Attack on Titan (16:9) -> Cow and Chicken
        (marked) -> Attack on Titan -> Batman TAS: the decoded shape
        switches on the first frame of every item - square at 0.02s,
        3:4 at 0.47s, square at 30.56s, 3:4 at 60.57s, and so on.
      - *The catch is at tune-in, and it decides whether this works.* The
        stream-wide description a player reads when it opens the stream
        comes from the first item, and the first item is always the
        loading screen: square pixels, 16:9. A player that follows the
        shape as it changes reshapes at every item boundary. A player
        that reads the shape once and keeps it will treat every later
        4:3 item as 16:9: full width, stretched, with no bars it could
        add - the same result as the fallback, but uncontrollable - and
        if it ever latched onto a 4:3 item instead, every 16:9 item after
        it would be squeezed. From memory of ExoPlayer's MPEG-TS readers,
        which TiviMate is built on, they take the format from the first
        sequence header and don't update it; unconfirmed, and it is
        exactly what test stream C checks. With preludes on (they are
        off in `.dizquetv-dev`), a square black interlude also sits
        between every item, so the shape changes twice per seam - black,
        so invisible either way.
      - *A watermark can't be right both ways.* The logo is overlaid on
        the stored frame, so on a marked 4:3 item a player honouring the
        mark squeezes it to three-quarters width, and a player stretching
        to fill shows it true. Pre-widening the logo would reverse which
        case is wrong. It also sits relative to the 4:3 picture, not the
        screen corner. No dev channel has the watermark on today.
      - *Nothing else changes.* Filler gets the same per-item treatment.
        The still-image screens (offline, loading, interlude, music) and
        the generated screens stay square and padded.

      **Player tests, built Sep 27, 2026 from the real `src/ffmpeg.js`.**
      A scratch script swaps `child_process.spawn` for a recorder before
      requiring the module unmodified, records the exact commands for the
      loading screen, each item and the concat, renders the items with
      the real ffmpeg 7.1 on the real files, and applies the one filter
      change above for the marked ones. A small server on the home network
      runs Syndicast's recorded concat command, `-re` included, once per
      viewer, the way `/video` does. Four streams in one M3U:
      A - today's painted bars (loading screen, Batman TAS 90s);
      B - marked (the same, marked); B2 - marked with no loading screen,
      to tell "ignores the marking" apart from "reads the shape once";
      C - marked, switching 4:3 / 16:9 every 30 seconds (Batman TAS,
      Attack on Titan, Cow and Chicken, Attack on Titan, Batman TAS).
      **TiviMate, stream C, Sep 27, 2026: the goal works.** With TiviMate's
      16:9 setting the marked 4:3 shows fill the screen - which today's
      painted bars make impossible - and with its 4:3 setting they get
      bars. Attack on Titan played full screen, and the stream switched by
      itself at every item change, with nothing to reset or retune. Under
      the 4:3 setting Attack on Titan went into a 4:3 box with bars, so
      TiviMate's 16:9 and 4:3 settings *force* a shape on everything:
      they tell us nothing about whether it reads the marking. That is
      decided by its default setting, "Normal", and on Normal every show
      on stream C looked stretched to 16:9, the 4:3 ones included. So
      TiviMate does *not* follow the marking as it changes. Stream B2 (the
      same marked 4:3, no loading screen) on Normal shows bars, so of the
      two explanations **"reads the shape once" held** and "ignores the
      marking" is ruled out: TiviMate honours the shape of the first
      thing it sees after tuning in and keeps it until it is retuned. On a
      real channel that first thing is always the loading screen, square
      16:9, so on Normal every show fills the width - consistently, not by
      chance. What a TiviMate viewer gets on a marked channel, then: 4:3
      shows full width on Normal and 16:9; bars on 4:3 shows only by
      forcing 4:3, which also boxes every 16:9 show. Stretch-by-choice
      works; the right shape per show, automatically, does not, and no
      change to the marking can fix that - the player would have to be
      made to start over at each item.

      For the build, that makes the loading screen load-bearing: `/playlist`
      only sends it when all five normalize settings are on. Without it, a
      TiviMate viewer tuning in during a 4:3 show would latch 4:3 and see
      every later 16:9 show boxed until retuning. ImPlayer couldn't be
      tried: its free version allows only one playlist.

      **Build plan, for Sonnet 5. Written Sep 27, 2026; not started -
      waiting on OK.** A per-channel option, off by default, that sends
      narrow shows marked instead of with painted bars.

      1. *The setting.* `channel.transcoding.aspect`: absent, `''` or
         `'fit'` all mean today's painted bars; `'mark'` turns this on.
         (`'stretch'` stays reserved for the fallback below, unbuilt.)
         Nothing migrates, and a channel without the field must get a
         byte-identical ffmpeg command.
      2. *One condition, shared with the loading screen.* Marking is only
         safe when the loading screen is guaranteed to open the stream,
         and `/playlist` in `src/video.js` sends it only when transcoding
         and all four normalize settings (video codec, audio codec,
         resolution, audio) are on - its inline `transcodingEnabled`. Move
         that test into one exported function - a static
         `FFMPEG.isFullyNormalized(opts)` in `src/ffmpeg.js` - and have
         both `/playlist` and the marking call it, so the two can't drift
         apart. When it's false the channel gets painted bars, whatever
         the setting says. `/playlist` must make exactly the same decision
         as today. This also covers the HLS path for free:
         `program-player.js` turns `normalizeResolution` off there.
      3. *The ffmpeg change,* in `spawn()`'s scaler block in
         `src/ffmpeg.js`, after `cw`/`ch` are computed. When the channel is
         `'mark'`, the condition in step 2 holds, `ensureResolution` is
         set, and the source is *narrower* than the frame (`ch ==
         wantedH` and `cw < wantedW`): scale to `wantedW:wantedH`, then
         `setsar=` the reduced fraction `(cw*wantedH)/(ch*wantedW)`,
         labelled `[siz]` exactly as the padded path is. No `pad`.
         Everything else in the command stays as it is. Letterboxed
         sources wider than the frame keep their painted bars: MPEG-2 can't
         mark 2.39:1 (it would round to 2.21:1), and TiviMate on Normal
         would show such a film stretched tall with no way back.
      4. *What stays as it is:* the still-image screens (offline, loading,
         interlude, music), the generated screens, the concat process,
         and the watermark. The logo is overlaid on the full stored frame,
         so it looks right in TiviMate on Normal (which shows the frame
         as stored) and squeezed to three-quarters width in a player that
         honours the marking - accepted, and said in the editor's help
         text. Filler gets marked like any other item, since it goes
         through the same `spawnStream`.
      5. *The editor,* under "Transcoding settings" in
         `web/public/templates/channel-config.html` /
         `web/directives/channel-config.js`: a select, "Shows narrower
         than the channel", with "Black bars (default)" and "Let the
         viewer's player decide". Initialise a missing value to `''` on
         load, the same way `targetResolution` is. Help text in plain
         words: TiviMate shows these shows full width on Normal and 16:9,
         and with bars on 4:3, which also boxes 16:9 shows. When the
         global FFmpeg settings don't meet step 2, the channel editor
         already has them loaded for its resolution list - show beside
         the select that the option has no effect until they're all on.
      6. *Save-time check:* `validateChannelJson` in
         `src/dao/channel-db.js` warns on an unknown `transcoding.aspect`
         value, rewriting nothing, the same way `warnAboutBlocks` does.
      7. *Tests,* `test/aspect-mark.js`, added to `test/run.js`, plain
         Node: swap `child_process.spawn` for a recorder before requiring
         the real `src/ffmpeg.js`, as the scratch test-stream builder did.
         Check that:
         - with the field absent, Batman TAS (1440x1080, 1:1) gets
           exactly today's command;
         - `'mark'` gives Batman TAS `scale=1920:1080`, `setsar=3/4` and
           no pad, and does the same for Cow and Chicken (720x576,
           pixelP/Q 16:15);
         - a 1920x1080 source gets no scaler;
         - a 1920x800 source still pads;
         - `'mark'` with any one normalize setting off pads;
         - the offline and loading screens are unchanged;
         - the watermark still overlays after `[siz]`;
         - `isFullyNormalized` matches the old inline test in every
           combination of the five flags.

         The "absent means unchanged" check is also proved once against
         `git show` of the pre-change `ffmpeg.js` and `video.js`, the way
         the filler change was, then kept as the shape assertions above.
      8. *Live check,* on a **copy** of `.dizquetv-dev` on its own port
         (never the live folder, and not 18000 - another session's dev
         server uses this folder). Set up a scratch channel whose lineup
         is Batman TAS, Attack on Titan and Cow and Chicken, set to
         `'mark'`:
         - capture `/video` for three minutes, and ffprobe the per-frame
           shape: square for the loading screen, 3:4 on the 4:3 items,
           square on Attack on Titan;
         - set it back to black bars, and the painted bars return;
         - channel 1, untouched, gets byte-identical item commands;
         - in the editor, the option saves, reloads and shows its
           no-effect note when a normalize setting is off.

         Then the user adds that server's M3U to TiviMate and confirms
         what stream C showed: Normal fills, 4:3 gives bars.

      Out of scope: the right shape per show, automatically, in TiviMate -
      that needs the player to start over at each item, which no marking
      can make it do. And the unrelated `stepNumber={step}` bug in
      `video.js`, flagged as its own task - since fixed in 1634bef, which
      leaves one thing to test for this feature (see "A concat restart
      replayed the tune-in" under Resolved).

      **Built and verified Sep 27, 2026 (Sonnet 5), against this plan.**
      All eight steps as written, with two findings along the way:

      - `isFullyNormalized(opts)` is a small static function on `FFMPEG`
        (`src/ffmpeg.js`), exported as `FFMPEG.isFullyNormalized`, and
        `/playlist` in `src/video.js` now calls it instead of carrying its
        own copy of the five-flag check. `channel.transcoding.aspect`
        reads the same way `targetResolution` etc. already do - absent or
        anything other than `'mark'` behaves as `'fit'`.
      - The scaler block in `spawn()` now branches: `doMark` (the four
        conditions from step 3) picks `scale=wantedW:wantedH` +
        `setsar=(cw*wantedH)/(ch*wantedW)`, everything else keeps the
        original scale-then-pad-then-`setsar=1` code exactly as it was,
        moved into an `else`. No line inside either branch changed
        behaviour from before this change.
      - `test/aspect-mark.js` (10 checks) drives the real `src/ffmpeg.js`
        the same way the investigation's scratch test-stream builder did -
        `child_process.spawn` swapped for a recorder before requiring the
        module, real probed shapes for Batman TAS and Cow and Chicken.
        Added to `test/run.js`; `npm test` is 187/187.
      - The one-time `git show` comparison the plan calls for (step 7):
        pre-change `ffmpeg.js`, `helperFuncs.js` and `image-url.js`
        extracted to a scratch directory and run side by side with the
        current code across all four fixture sources, with and without a
        watermark, plus the offline screen and the concat command - every
        pair byte-identical. Not kept as an automated test, the same
        reasoning `blocks-unchanged.js` gives for not keeping its own
        git-show diff.
      - **Finding: the editor changes needed `npm run build`.** The UI
        lives in `web/directives/channel-config.js`, browserified into
        `web/public/bundle.js` (gitignored, not source), which the running
        server actually serves. The first live check showed the new
        select's own two options and the no-effect note missing from the
        rendered page - not a code bug, `scope.aspectOptions` and
        `scope.ffmpegSettingsFullyNormalized` simply weren't in the bundle
        the browser had loaded. Rebuilding and hard-reloading fixed it;
        worth remembering for the next UI change, since nothing in the dev
        workflow rebuilds this automatically.
      - **Live check**, on a copy of `.dizquetv-dev` on port 18099 (never
        the live folder, never 18000 - another session had it). A scratch
        channel 900, Batman TAS / Attack on Titan / Cow and Chicken,
        direct-play from the real files. The originally planned single
        three-minute `/video` capture turned out not to isolate an item
        boundary reliably - raw concatenated mpegts has independent PTS
        per segment, which confused ffprobe/ffmpeg's own frame-level
        decode across the join (the concat itself is fine; real players,
        TiviMate included, are built to tolerate exactly this and proved
        it live earlier in this investigation). Fetching `/stream`
        directly instead - one item at a time, the same route the concat
        process itself calls - decoded cleanly and, going through the
        real Plex decision API rather than synthetic stats, confirmed all
        of it: Batman TAS 1920x1080 SAR 3:4 no bars (`crop=1916:1080:2:0`),
        Attack on Titan 1920x1080 SAR 1:1, Cow and Chicken (anamorphic)
        1920x1080 SAR 3:4, switching the channel back to Fit brings the
        painted bars back (`crop=1436:1080:242:0`, matching the pre-change
        shape exactly), and turning off Normalize Audio live falls back to
        the same padded shape even with the channel set to `'mark'`. In
        the browser: the select saves through a real `Update Channel`,
        survives a hard reload, and the no-effect note appears and clears
        with the global setting. Channel 1, never touched, continued
        serving its guide and lineup unaffected throughout.

      The enumeration of where scaling happens, and the per-channel
      mechanism, below serve both plans. From "What changes in the ffmpeg
      command" on is the fallback.

      **Where scaling and padding are decided - all of it is in
      `src/ffmpeg.js`, and only one place needs to change.**

      - *The main scaler*, in `spawn()` from "Resolution fix" on. Every
        real video goes through it: episodes, movies and filler alike,
        since `PlexPlayer` plays filler with the same `spawnStream` call.
        It works out the largest picture of the source's *display* shape
        (storage size times `pixelP`/`pixelQ`, so anamorphic DVDs come out
        right) that fits the channel's frame - `cw` x `ch` - scales to
        that, pads with black to the full frame when the two differ, and
        ends with `setsar=1`. It runs whenever `ensureResolution` is set
        (normalize resolution on) and the source's size or pixel shape
        differs; with normalize off it only shrinks sources larger than
        the target, and never pads except by a pixel to make a size even.
      - *The watermark* forces `ensureResolution` on, even with normalize
        resolution off, so a watermarked channel always gets the full
        frame. The logo is scaled on its own (`scale=w:-1`, its own shape
        kept) and overlaid *after* the scaler, positioned by percentages
        of the full frame. So it needs no change: stretched or not, it
        lands in the same corner at the same size.
      - *Still images* - the offline picture, the error screen's picture,
        the loading screen, the black interlude between items, and the
        album art or music placeholder behind audio-only items - have
        their own `scale=...:force_original_aspect_ratio=1` then `pad`,
        in the error/offline branch.
      - *Generated screens* - testsrc, the text error screen, blank,
        static, and `src/ffmpegText.js`'s no-channels screen - are drawn
        at the frame size to begin with. Nothing to decide.
      - *The concat process* in `video.js` copies, never scales.
      - *Plex's own transcode*, when Plex transcodes rather than direct
        plays, only ever shrinks to `maxTranscodeResolution` keeping the
        shape, and reports the result's size, which is what the main
        scaler then works from. No padding happens there.
      - *NVIDIA.* There is no hardware filter path anywhere - no
        `hwaccel`, `scale_cuda` or `scale_npp`. Choosing `h264_nvenc`
        only changes the `-c:v` encoder; scaling and padding run on the
        CPU the same as for every other encoder, and the only
        NVIDIA-specific line is skipping `-tune stillimage`. So stretch
        works identically there. If the "Fix NVIDIA" item later moves
        scaling onto the GPU, it must keep taking the size from the same
        `cw`/`ch` decision rather than rebuilding it, or stretch will
        silently stop applying on that path.

      **It can be per-channel without the per-channel transcoding
      configs.** Every channel already carries a small `channel.transcoding`
      block - resolution, video bitrate and buffer size, edited under
      "Transcoding settings" in the channel editor - and `FFMPEG` already
      reads it from the channel it is given. A new field there,
      `channel.transcoding.aspect` (`'fit'` or `'stretch'`), rides the same
      way with no plumbing: `transcoding` is already in `helperFuncs.js`'s
      `CHANNEL_CONTEXT_KEYS`, and `video.js` already copies it from the
      channel being watched (not a redirect's target, the same as the
      resolution it stretches to). Absent means `'fit'`, so nothing
      migrates and every saved channel gets exactly the command it gets
      today. The primary plan adds `'mark'` as a third value.

      **Fallback: Syndicast stretches, if players ignore the marking.**
      The original plan, from before the goal was restated. Kept whole.

      **What changes in the ffmpeg command.** One decision: when the
      channel says stretch and `ensureResolution` is on, `cw` x `ch` is the
      channel's full frame instead of the fitted size. The existing "pad
      only if the size differs from the frame" check then drops the `pad`
      on its own, and the existing `setsar=1` is what makes the stretched
      frame display as full width - it already had to be there. Nothing
      else in the command moves: encoder, bitrate, audio, watermark, the
      `-map`s. The shapes, worked through the code for a 1920x1080 channel
      using each file's ffprobed size (step 1 of the verification below
      confirms them by building the real command):

          Batman TAS 1440x1080 (square pixels, 4:3):
            fit     [video]scale=1440:1080:flags=bicubic[scaled];
                    [scaled]pad=1920:1080:(ow-iw)/2:(oh-ih)/2[blackpadded];
                    [blackpadded]setsar=1[siz]
            stretch [video]scale=1920:1080:flags=bicubic[scaled];
                    [scaled]setsar=1[siz]

          Cow and Chicken 720x576, pixel shape 16:15 (anamorphic, 4:3):
            fit     scale=1440:1080, pad to 1920:1080, setsar=1
            stretch scale=1920:1080, setsar=1

      A 16:9 source already at 1920x1080 takes no scaler at all either way.
      With normalize resolution off and no watermark, the setting does
      nothing - there is no fixed frame to fill - and the editor should say
      so beside it.

      **Recommended answers to the three open choices, pending OK:**

      - *Stretch only sources narrower than the channel.* 4:3 on a 16:9
        channel fills the frame; a 2.39:1 film keeps its letterbox rather
        than being pulled tall. "Narrower" is judged on the display
        shape, so anamorphic files are judged correctly.
      - *Filler follows the same setting.* One rule per channel, so a 4:3
        commercial between two stretched 4:3 episodes doesn't suddenly
        pillarbox. `spawnStream` gets the item's `type`, so excluding
        filler later is one condition if it's wanted.
      - *Still images stay fitted.* Stretching square album art or a 4:3
        offline card to 16:9 distorts artwork the user drew; the offline
        picture can simply be made at the channel's shape.

      **Not covered, by design.** A file with black bars *burned into* a
      16:9 frame is already the channel's shape, so stretch can't touch it
      - that would be cropping, a different feature. None of the 4:3-era
      files checked have this: Batman TAS, Superman TAS and Powerpuff Girls
      1080p are all clean 1440x1080 (cropdetect reports the full picture).

      **Verification, on real episodes from the library.**

      1. `test/aspect-stretch.js`, plain Node like the rest of `test/`:
         swap `child_process.spawn` for a recorder before requiring
         `src/ffmpeg.js`, build the command for Batman TAS 1440x1080, Cow
         and Chicken 720x576 at 16:15, a 1920x1080 source, a 1920x800
         film, a watermarked channel with normalize off, the offline
         screen and an audio-only item. Asserts the stretch shapes above,
         and that with the field absent the full argument list is
         *identical* to what the code before the change builds - proved
         once against `git show` of the pre-change `ffmpeg.js`, then kept
         as shape assertions, the way the filler change was compared.
      2. The real ffmpeg on the real file: run the recorded command for
         Batman TAS S01E09 "Pretty Poison" through
         `ffmpeg-7.1-full_build` for 10 seconds from 5:00, fit and
         stretch, into the scratchpad. ffprobe both: 1920x1080, square
         pixels. cropdetect: fit reports `crop=1440:1080:240:0` (240px
         black each side), stretch reports the full `1920:1080`. A frame
         from each, side by side, for the eye. Repeat with Cow and
         Chicken S01E19 for the anamorphic path, first confirming Plex
         reports it anamorphic with `pixelAspectRatio` 16:15 (a read of
         its own metadata) - if Plex doesn't, the fit path is already
         wrong today and that's a separate finding.
      3. End to end, on a **copy** of `.dizquetv-dev`, never the live
         folder: a scratch channel whose lineup is Batman TAS, a 4:3
         commercial and Futurama 1080p (16:9), set to stretch with the
         watermark on. Capture `/video?channel=N` with ffmpeg across all
         three items; cropdetect every second - full width throughout,
         logo in its corner, Futurama's segment built with no scale
         filter. Flip the channel to fit and the pillarbox comes back.
         Then channel 1, untouched, still resolves to the unchanged
         command.
      4. One look on the real client (Plex Live TV) - the stream is the
         same bytes either way, but the client is what the viewer sees.

- [x] Fix very short items repeating or being skipped next to Flex

      Items under roughly 20 seconds, placed adjacent to Flex in the lineup,
      either play about three times over or get skipped entirely. This is a
      playback problem, not a filler-selection one: the 1.6.0 filler algorithm
      does not touch it, and it happens to items already placed in the
      programming rather than to items being chosen. Most likely in the concat
      or transition handling, where a very short item interacts badly with the
      black-frame interlude and the buffer boundaries. **Corrected Oct 1,
      2026: it is none of those - see below.** Reproduce with a
      deliberately short item next to Flex before attempting any fix -
      guessing at the layer here would be expensive.

      **Investigated Oct 1, 2026 (Opus 5.5). It still happens with items
      encoding at full speed and the concat restart fixed. The layer is how
      `/stream` chooses each item: from the wall clock, with no memory of
      what this stream just played. Not fixed yet; the fix below waits on
      Ron's OK.**

      **Reproduced, with Ron's own clips.** Channel 1 itself opens with the
      pattern: ATHF, "[as] SGC2C NEXT promo" (15.0s), a 184s Flex, "[As]
      NEXT - SGC2C [2003]" (10.0s), Space Ghost; then later "[As] NEXT - Home
      Movies (2001) (2)" (15.1s), a 418s Flex, "[As] NEXT - Home Movies
      (2003)" (10.1s), Home Movies. Those aired once, on Sep 30, so they were
      copied onto scratch channels on a copy of `.dizquetv-dev`, timed so the
      episode before each ended 90s after tuning in:
      - *ATHF to Space Ghost:* the 10s NEXT after the break played **twice**,
        back to back, and Space Ghost then started 7.4s late.
      - *Space Ghost to Home Movies:* the same - the 10.1s NEXT after the
        break played twice, and Home Movies started 9.2s late.
      - *A compressed copy* (the same four NEXT clips around two 60s breaks,
        two promos of about a minute standing in for the shows), 25
        minutes, 10 breaks: the 10s item after the break played twice after
        2 of them, once after the other 8.
      - *Ron's 5-8s bumpers* ("CN City Bumper (2)" 5.1s, "AcTN - Bumps Now!"
        8.1s, "[Adult Swim] Bumper - Collective Building" 7.5s) on both sides
        of a 60s and a 45s break, 20 minutes, 10 breaks: every one played
        once - all ten breaks happened to end late.
      - *Skipped:* once, at tune-in. Tuning in 23s into a program plays it
        from the start (see the 30-second rule below), so the stream ran 23s
        behind, and the 15s promo after it was never asked for.
      - Every item *before* a break played once: the 15s promos 1.2-9.1s
        late, the 5-8s bumpers 0.0-6.3s late.

      So 4 of 22 breaks repeated the item after them, and nothing was
      skipped mid-stream in this sample. Encoding wasn't a factor: every
      item's next request came within about half a second of its length
      (first byte usually 0.1-0.8s after the request, five outliers of
      2.1-5.5s while the machine was busy), and the concat played exactly
      what each request handed it.

      **Why, in plain English.** The concat asks for the next item the
      moment the last one finishes. `/stream` doesn't know what that last
      item was. It looks at the clock, works out what the lineup says is on
      right now, and plays that. That would be fine if the stream were
      always exactly on the clock, but by design it isn't - three rules let
      it drift by several seconds either way:
      1. *A break ends early.* `getCurrentProgramAndTimeElapsed`
         (`src/helperFuncs.js`) hands over to the next item as soon as the
         clock is within 10 seconds (`SLACK`) of the end of anything longer
         than 20 seconds - including a Flex break. So when the last clip of
         a break finishes with up to 10s of the break left, the next item
         starts up to 10s early.
      2. *A break ends late.* A filler clip may be up to 10s longer than the
         time left in its break (`pickRandomWithMaxDuration` and
         `createLineup`, `remaining + SLACK`).
      3. *A program asked for in its first 30 seconds plays from the
         start* (`createLineup`), so the stream can fall up to 30s behind.
      A long item absorbs that drift. A short one can't:
      - *Repeat.* The stream reaches the short item early (rule 1), plays
        all 10 seconds of it, and asks again. The clock is now only 7
        seconds into that same item. Nothing hands an item of 20 seconds or
        less over early (rule 1 needs more than 20), so the same item comes
        back, and rule 3 plays it from the start again. If the item is
        shorter than how early the stream was, the next request lands back
        in the break, which hands over to the item again, and the one after
        that lands inside it once more: three plays. That is the "about
        three times". It can also repeat when the stream is within a few
        hundred milliseconds of exactly on time, since the next request
        comes up to about 0.4s either side of an item's nominal end.
      - *Skip.* The stream reaches the short item late by more than its
        length (rule 2 or 3, or a slow machine). By then the clock is past
        it, so it is never asked for.
      - *The two chain.* After a repeat the stream is about 9 seconds
        behind, and stays that way through the next show, so a short item
        before the next break that is under 9 seconds would then be skipped.
        Seen: Space Ghost and Home Movies 7.4s and 9.2s late after their
        repeats, and the compressed channel 9.0s late into its next 15s
        item.
      - *Long items aren't immune, just harder to hit.* Rule 1's window is
        10 seconds, so a stream more than 10s ahead repeats the *end* of
        anything. Seen once: handed into a 58.6s promo 9.85s early, the
        next request came 58.3s later, 48.4s into it - just short of the
        window - so its last 10.2s played twice. Equally, a stream more than
        30s behind starts a program partway (rule 3 no longer applies), so
        its opening is skipped.

      **Every place that decides what plays next, or for how long.** Only
      the three rules above produce this; the rest were read and, where it
      applies, ruled out by measurement.
      - `/playlist` (`src/video.js`): the 100-entry list - loading screen,
        `first=1`, then plain and `between=1` entries. Order only; it never
        names an item. The concat restart (`step+1`) is 200 items apart
        here and asks for nothing twice (see "A concat restart replayed the
        tune-in" under Resolved). None happened in these runs.
      - *The concat* (`spawnConcat`, `-re`, `-c copy`): reads each
        `/stream` response to its end, in order. It can't repeat or drop an
        item; every repeat above was two separate requests, each a fresh
        decision.
      - *The black-frame interlude* (`between=1`, 420ms): **switched off on
        Ron's channels** (`disablePreludes: true`), so `/stream` serves every
        `between=1` entry as an ordinary item. With preludes on it would add
        about half a second of lag per item, untracked by the lineup, which
        makes skips a little likelier and repeats a little rarer. It can't
        cause either by itself.
      - *Buffer boundaries:* item timing measured within ~0.5s of each
        item's length, as above. Slow encoding used to make the stream fall
        behind within long items, which is the lead from "Heavy buffering
        during playback" - a cause of skips back then, not now.
      - `channelCache.getCurrentLineupItem` (`src/channel-cache.js`): the
        "closed and opened it again" replay. Only when a request comes
        within 10s of the last one *and* more than 10s of that item is left,
        so it never fires between items here - logged as expired every time.
        A client that reconnects mid-item gets it again from the same start;
        not seen in this sample.
      - `getCurrentProgramAndTimeElapsed`: rule 1, and where the position
        comes from.
      - *The skip-ahead* in `streamFunction` (`video.js`, "Too little time
        before the filler ends"): a break with 10s or less left hands over
        to the next program. Only reachable for breaks of 20s or less,
        since rule 1 hands over first for anything longer - channel 1 has 6
        such breaks. Same effect as rule 1 when it fires.
      - `createLineup` (`helperFuncs.js`): rules 2 and 3; also how long the
        offline screen and the fallback clip run.
      - The upper bounds loop in `streamFunction`: caps `streamDuration` at
        what's left plus `SLACK`. Never shortened an item here.
      - `PlexPlayer` (`src/plex-player.js`): passes `-t` only when the item
        is cut more than 10s short of its end, so a whole item always plays
        to its file's real end. An error before any data plays the error
        screen for at most 60s instead.
      - `takeResumeHint`, `wereThereTooManyAttempts` (the throttler), the
        redirect loop and the on-demand resume: only after a save, within a
        second of the same item, or on channels Ron doesn't have.
      - `dayParts.findNextProgram`: which mix, not which item - see the
        look-ahead below.

      **How often.** The real `getCurrentProgramAndTimeElapsed` and
      `createLineup`, unmodified, driven through 2,000 breaks of each
      length with Ron's CCN mix, 0-3s late into the break and 0.3s between
      clips, as measured. The share of breaks after which a short item
      plays:

      | break | item | skipped | once | twice | three times |
      |---|---|---|---|---|---|
      | 60s | 5.1s | 3.6% | 85.5% | 9.2% | 1.6% |
      | 60s | 10.0s | 0.4% | 91.3% | 8.3% | |
      | 60s | 15.0s | | 89.2% | 10.8% | |
      | 150s | 5.1s | 8.4% | 72.0% | 13.7% | 5.8% |
      | 150s | 10.0s | 0.5% | 79.5% | 20.1% | |
      | 150s | 15.0s | | 79.8% | 20.2% | |
      | 300s | 5.1s | 16.0% | 48.5% | 20.3% | 15.2% |
      | 300s | 10.0s | 1.0% | 65.0% | 34.0% | |
      | 300s | 15.0s | | 68.2% | 31.9% | |

      Longer breaks end early more often: 12% of 60s breaks, 22% of 150s
      and 35% of 300s in the same runs. Channel 1's breaks run 150-500s, and
      stage 5's transitions are exactly these 5-15s clips, so this has to
      be fixed before them.

      **The fix, proposed: give each viewer's stream a lineup cursor.**
      Remember, per stream, which lineup entry it just finished. The next
      request then plays the *next entry in the lineup*, not whatever the
      clock lands on, and only breaks stretch or shrink to bring the stream
      back to the clock - as on real TV, where programmes air whole and
      in order and the commercials absorb the slack.
      - *A program follows a program:* it plays from the start, whether the
        stream is a few seconds early or late. Never the same one again,
        never one skipped.
      - *Into or within a break:* filler as today, but the time left is
        measured from the clock to the break's real end. A stream that is
        behind gets a shorter break, one that is ahead a longer one. When
        too little is left for a clip, the program after the break plays
        from the start - there is no "skip ahead in time and look again",
        which is what lands back inside the short item.
      - *Behind by more than a whole break:* the break is dropped and the
        lateness carries to the next one.
      - *Unchanged:* tuning in (no cursor yet), the 30-second rule at
        tune-in, a stream further than a minute off the clock (falls back
        to today's path), redirects and on-demand channels.
      - *Where:* a small pure module (say `src/lineup-cursor.js`) that
        `streamFunction` asks first; cursors in memory in
        `channel-cache.js`, keyed by stream, dropped for a channel when it
        is saved (a save can renumber the lineup). `concat()` mints one
        stream id at tune-in and passes it to `/playlist`, which puts it on
        every `/stream` URL - today's `session` is re-minted at every
        concat restart, so it can't carry the cursor across one.
      - *Saved channels:* nothing stored changes, so every existing channel
        keeps working unchanged, as the 1.0 rule requires. `video.js`,
        `helperFuncs.js` and `channel-cache.js` are in the 1.7.0 merge's
        conflict set.
      - *Tests:* a simulated viewer like the one above, driving the new
        decision against 5, 10 and 15s items on both sides of 60-300s
        breaks - every program plays exactly once, in order - plus a day of
        channel 1's real lineup. Then the same scratch channels live, and a
        real channel 1 break.

      **Considered and not recommended:** cutting `SLACK`, or exempting
      short items from rules 1 and 3. From the clock alone, "about to play
      this item" and "just played it" look the same - the stream reaches a
      10s item 2.6s late and plays it once, or 2.8s early, plays it, and
      asks again 7s into it - so any stateless threshold trades repeats
      for skips somewhere else.

      **How it was measured.** A scratch server on port 18095, run from a
      git worktree (`.claude/worktrees/stage4`, branch `stage4`) so the
      repo-relative paths and the web bundle were its own, on a copy of
      `.dizquetv-dev` in the session scratchpad: the copy's
      `xmltv-settings.json` path made absolute (the trap in the NVENC entry
      above) and its HDHR auto-discovery switched off, so it never
      advertised itself on the LAN. A `node -r` preload wrapped
      `getCurrentProgramAndTimeElapsed`, `createLineup`,
      `getCurrentLineupItem` and `recordPlayback`, `child_process.spawn` and
      each `/stream` response, and logged every decision next to where the
      lineup really was at that instant; the repo's code ran unmodified. A
      plain HTTP client played each viewer, reading `/video` for 7-25
      minutes. The other streaming server, OBS and port 18000 kept running
      throughout.

      **A trap.** A server started as a Claude Code background task is
      stopped when the task's time limit runs out - 30 minutes unless one is
      given - with nothing in the server's own log. The first scratch server
      died that way 3 minutes into a channel 1 break. Give a long-running
      scratch server an explicit two-hour limit, or start it outside the
      session. For the TiviMate preview below it was started with
      PowerShell's `Start-Process -WindowStyle Hidden`, which outlives the
      tool call and runs until stopped by its pid.

      **Built Oct 1, 2026 (Opus 5.5), on branch `stage4`, three commits as
      proposed. Confirmed in TiviMate by Ron: on 900, 903 and 905 every bumper played once and every show started from its beginning.** 312
      tests -> 364.
      1. *The look-ahead (62262f8)*, first, since the cursor needs the same
         number: `getCurrentProgramAndTimeElapsed` also returns `startsIn`,
         and a new `helperFuncs.timeLeft(obj)` (duration - elapsed +
         startsIn) is what `createLineup`, `findNextProgram` and `video.js`'s
         upper bound and short-break skip now count from. See the Stage 4
         line on the 1.0 list.
      2. *The cursor (31253d4)*, `src/lineup-cursor.js`, pure, as proposed.
         The rule that drops a break is the one that already ended every
         break: when no more than `SLACK` + 1ms (about 11s) of it is left at
         the stream's position. So a stream drops a break once it is later
         than the break less about 11 seconds, not only once it is later than
         all of it. Two things beyond the proposal:
         - *A viewer tuning in on the channel's replay cache inherits the
           cursor.* `getCurrentLineupItem` hands a new viewer the item the
           channel's last viewer was given, continued - right, they should
           see the same thing - but that viewer then had no cursor, and with
           the other viewer up to 10s ahead of the clock it would have taken
           the old path at its next request. The item recorded in the cache
           now carries the cursor it leaves its stream at.
         - *`lineupItem` in `streamFunction` is declared.* It was never
           declared, so it was one global shared by every `/stream` request
           in flight: a second viewer's request could replace it across an
           await. In practice only the active-channel bookkeeping after
           `player.play` read it late; the cursor reads it too, so it is a
           local now.
         **Known limitation: `/m3u8`** (the HLS "fast" playlist) mints no stream
         id, so it still picks every item from the clock and can still repeat
         or skip a very short item next to Flex. Ron's channels use `/video`.
         Fixing it means a stream id on that playlist's entries, which a
         player that fetches them as separate segments may not keep to one
         viewer; not attempted.
      3. *The stage 5 note (5f02782)* in `docs/blocks-spec.md`: shrinking or
         dropping a break cuts filler first and keeps the transition steps.

      **Live, on a fresh copy of `.dizquetv-dev`** (port 18095, from the
      worktree, the same preload):
      - *Channel 1's real opening* (905): the 15s promo once, 3.3s late; the
        184s break; "[As] NEXT - SGC2C [2003]" once, 7.0s late - the break's
        last clip overran - then Space Ghost from its start, 6.8s late.
        Before the fix, this exact sequence played the NEXT twice.
      - *The look-ahead* (904, tuning in 5s before a show ends into a break
        before a day-part boundary): the first clip came from the incoming
        Checkerboard mix. The break then ended 6.8s early and the next show
        started early, from its start; the request after it went on to the
        next break, where the old path would have been back inside the show.
      - *The compressed NEXT and 5-8s bumper channels* (900, 903), 12
        minutes each at once: 34 programs, 0 repeated, 0 skipped, every one
        from its start; 53 decisions from cursors and not one fallback to
        the clock, through one item that took 10.3s to start. Both faults
        came up and were avoided: "AcTN - Bumps Now!" (8s) after a break
        that ended 7.2s early, where the clock was still 1s inside it when
        it finished, and "CN City Bumper (2)" (5s) reached 13.9s late,
        when the clock was already 8.9s into the show after it. That 13.9s
        was gone by the next break.

### Library management

- [ ] Swap out episodes of a show, and plug library items in anywhere

      Includes inserting individual items from a custom show into the
      programming lineup. Designed in the same Opus 5.5 session as swap
      episodes and the Flex auto-adjust line below.
- [x] Program rows show the episode title, with a slot-fit gauge

      A slot-fit gauge built around how Ron schedules, in place of a plain
      duration bar, since what matters when building a lineup isn't a program's raw
      length but how much of a real broadcast slot it leaves for breaks. Ships
      in the custom show editor - `web/directives/program-list-row.js`, one
      shared two-line row: line 1 is the color square (now a plain identity
      swatch, no longer width-scaled by duration - that encoding moved to the
      gauge), the show/album name, a compact `S1 · E2` or `Track 2` /
      `Disc 1 · Track 2` tag, and the exact duration as `m:ss` (`h:mm:ss` at an
      hour or more) pinned right - never rounded to a minute, since slots are
      built to the second. Line 2 is the episode/track title, a movie's year,
      or blank for anything else (a redirect, a plain clip) - its title
      already said everything it has on line 1.

      The gauge itself picks the smallest standard slot the item fits: 15 and
      30 minutes for split half-episodes (an `S01E02a` airs two to a
      half-hour), then every half hour above that with no ceiling, so a 2h15m
      movie reads "150-min slot · 15:00 for breaks" rather than being forced
      into a fixed 30/60/90/120 list - matching how a real broadcast day
      actually schedules movies. `commonProgramTools.slotFitGauge` computes it
      from `program.duration` alone; `exactDurationString` and
      `longDurationString` (the list header's coarse total, moved here from
      `channel-detail.js`'s own copy) are its siblings. Info and delete
      buttons stay; the header adds total runtime beside the existing item
      count.

      Tracks get the album on line 1, not the artist - `plex.js`'s track
      import only ever copies the album (`showTitle`) and disc/track numbers,
      never `grandparentTitle` (the artist), so there's nothing to show yet.
      Left as a follow-up alongside the library page's own artist/music-video
      gap, in its note under Interface's Channel detail page entry - both need
      the same kind of Plex field saved on import that isn't today, so do them
      together rather than as two separate changes. Not exercised live: no
      custom show in the dev data actually contains a track-typed clip, so the
      tag/line-1 logic for tracks was verified by reading the code path, not
      by a real render.

      Two real bugs found building this, both in how `angular-vs-repeat`
      (the virtual-scroll list the custom show editor, filler lists and the
      channel programming list all already used) reacts to a taller,
      multi-line row replacing the old single-line one:

      - **Every row rendered at a uniform 24px and visually overlapped the
        next one**, even though each row's own line 1/line 2/gauge measured
        correctly inside it. `vs-repeat`'s scroll container turned out to be
        `display: flex; flex-direction: column` - a flex item's default
        `flex-shrink: 1` was squashing every row down to fit the visible
        viewport, bottoming out exactly at the pre-existing
        `min-height: 1.5em` floor (`.show-list .list-group-item`) once
        content exceeded it, with the clipped remainder painted over by the
        next row's own opaque background rather than visibly spilling out.
        The single-line rows this replaces never hit it, since their fixed
        height was already smaller than their fair share. Fixed with
        `flex-shrink: 0` on `.program-list-row`.
      - **Reopening the editor - the same custom show again, or a different
        one - could render zero rows**, even though `vsRepeat.sizesCumulative`
        was correct throughout. `ng-show="visible"` only hides the modal with
        CSS; the list never leaves the DOM, so `vs-repeat` can compute its
        visible row window from a container that still reads zero height,
        and nothing after that prompts it to recompute once the modal is
        actually shown. Confirmed by hand (`scope.$broadcast('vsRepeatTrigger')`
        fixed a stuck list immediately) and fixed properly with a
        `ResizeObserver` on the editor's root in `show-config.js`, broadcasting
        `vsRepeatTrigger` whenever the modal's real size changes - reacting to
        the actual condition instead of guessing a `$timeout` delay, which
        measurably still left it flaky under fast, scripted open/close cycles.
        Reproduced and fixed only for the custom show editor; filler lists and
        the channel programming list use the same library and the same
        `ng-show` pattern; whether they need the same fix is part of what
        reusing `program-list-row` there would take.

      Verified on a copy of `.dizquetv-dev`, port 18098 (never 18000, never
      the live folder), against the real custom shows: the mixed movie/track
      "My Gym Partner's a Monkey" (all `S01E01a`-style movie-typed segments,
      confirmed by the grouping fix in 05ac006) for line-1/line-2 fallback
      behaviour, and the 107-episode "Batman/New Batman Adventures" for the
      `S1 · E1` tag and episode-title line 2. Gauge math checked against the
      slot-tier table by hand (15m -> 30m -> every half hour) and against a
      literal 2h15m case, which produces exactly "150-min slot · 15:00 for
      breaks". Info panel, row delete (with a live count/runtime update), and
      an unrelated no-op open-then-Done save (diffed byte-for-byte against
      the file beforehand) all confirmed against "Silly Symphony". Eight
      rapid open/cancel cycles across three different shows after the
      `ResizeObserver` fix, all rendering the right row count and content
      every time. Not exercised: an actual drag-to-reorder gesture (browser
      automation can't drive native HTML5 drag-and-drop); the `dnd-draggable`
      attribute is confirmed present and correctly merged onto the rendered
      row by `replace: true`, the same mechanism every other directive in
      this file already relies on.

      The filler-list follow-up landed and stayed: filler lists reuse the row
      with the gauge off (clips aren't scheduled into slots), verified at a
      1900x900 window.

      **The channel programming list follow-up shipped once, then was pulled
      back out - it broke scrolling on Ron's real window, not just the
      shared-checkout incident's window (see Resolved below for that separate
      incident).** It briefly reused the row with two extra modes -
      show-start-time (the program's absolute scheduled time, not a
      duration, leads line 1) and break-after-mode (the gauge shows the real
      Flex/redirect time already following the item - "break after: 4:46" -
      rather than a theoretical slot) - and looked right in every test run
      here: virtualization held, full-list scroll jumps landed in 15-75ms, a
      delete-triggered full recompute took ~126ms, five tab-switch cycles all
      rendered correctly, and sustained real scrolling a week into channel
      1's real 40,000-program lineup showed no stuck window. None of that
      reproduced Ron's report - a stuck 6-row list that wouldn't scroll
      further, on his real window (~1900x900).

      **Root cause found and verified.** Flex and redirect rows rendered
      53.39px tall against every other row's 65.39px - `vs-repeat` was told
      every row is a fixed 66px (`vs-repeat="{size: 66}"`), so its scroll
      math assumed a uniform height that a whole class of real rows never
      had. Traced to `.plr-gauge-label`: `gauge()` returns `null` for any
      `isOffline` item (Flex and redirect never get a slot-fit or
      break-after gauge), so the label's interpolation renders a genuinely
      empty string - and a `<span>` with zero content collapses to 0px
      height in this flex layout, not the "phantom" line-box height a
      populated label gets. `.plr-gauge`'s own height then falls back to its
      other child, the gauge bar - 6px, `visibility:hidden` and rendered
      unconditionally, but far shorter than a real label's line height -
      instead of the 18px a non-empty label would have given it. Confirmed
      by hand: setting that one label's content to `&nbsp;` on a live Flex
      row changed its measured height from 53.39px to exactly 65.39px, with
      nothing else touched. The custom show editor and filler lists never
      hit this, since neither ever contains an `isOffline` item - it's
      specific to the programming list reusing the row with `show-gauge`
      on for rows that can't have one.

      What that mismatch does to `vs-repeat`: `sizesCumulative` (and the
      `totalSize` it derives, which sizes the before/after spacer elements
      that stand in for off-screen rows) is built entirely from the fixed
      66px assumption, never the real DOM. Every Flex or redirect row -
      roughly half of a real channel's rows, breaks alternating with
      programs - reserves 12.6px more virtual scroll space than it actually
      occupies. That drift compounds with every one of them scrolled past,
      throwing off which slice of `channel.programs` the real scroll
      position should show; how far into a run of thousands of alternating
      program/Flex rows that has to compound before the visible window
      stops advancing usefully is exactly the kind of thing that depends on
      how many rows are visible at once (window size) and where playback
      already was in the lineup (scroll starting position) - both of which
      differ between a 1900x900 real window mid-lineup and this test
      environment's narrower one starting from the top. That difference is
      the leading explanation for why this reproduced on Ron's machine and
      not here, though it wasn't reproduced directly - see below.

      **The other two things asked to check, answered as far as they can be
      from here:**
      - `localStorage`'s `channel-programming-list-height` sets
        `scope.programming.maxHeight` (rem, clamped 1-64, default 30),
        which becomes the `max-height` on both `.programming-panes` and the
        vs-repeat container itself (`programmingHeight()` in
        `channel-config.js`) - the zoom in/out buttons on the Programming
        tab write it. A small persisted value legitimately shows fewer rows
        at once (correct behavior, not this bug), but a smaller visible
        window also means each scroll tick advances through relatively more
        rows for the same wheel movement, so it would reach the point where
        the row-height drift matters *sooner* - consistent with, though not
        proof of, this being where Ron's session sat. Could not be read
        directly - it lives in Ron's own browser's `localStorage` for his
        real server's origin, not anything captured in a log or a file.
      - Window size: confirmed real (not scaled) 1900x900 renders and
        scrolls both the custom show editor and filler lists correctly here.
        Not tested at that exact size against the programming list's
        show-start-time/break-after-mode variant specifically, since it was
        reverted before that combination could be tried under Ron's
        conditions - see below.

      **Reverted back to the pre-session rows** (05ac006's `vs-repeat="options"`,
      the single-line `.program-row` markup, `dateForGuide`, and the matching
      `div.programming-programs div.list-group-item` CSS with no override) in
      a fresh worktree, immediately, per Ron's instruction to restore a
      working list before anything else. Custom shows and filler lists were
      untouched by this - `program-list-row.js` and its CSS stay in the
      tree, just no longer wired into the channel programming list. Verified
      after reverting: both the custom show editor and filler lists still
      scroll correctly at a real 1900x900 window.

      **Not retrying the programming list until it can be tested under Ron's
      actual conditions**, per instruction. The fix itself is narrow once
      found - reserve real height for an empty gauge label, most simply by
      giving `.plr-gauge-label` (or `.plr-gauge`) a `min-height` matching a
      populated label's own line height, so every row is uniformly 66px
      regardless of whether that row has a gauge to show - but confirming it
      actually stays smooth on Ron's window, not just here, is the real gate
      before it goes back in.

      **Retried Sep 28, 2026 (Sonnet 5), in a fresh worktree
      (`programming-list-row`, `node_modules` junction-linked), with a
      different row design rather than the `program-list-row` two-line
      layout above.** The earlier bug's real cause - a gauge label that goes
      empty for `isOffline` rows collapses to 0px in a flex layout, so
      `vs-repeat`'s one fixed size stops matching every row's real height -
      is a whole *class* of bug that a two-line row with an optional gauge
      line stays exposed to indefinitely, even after the specific fix. This
      pass changes the shape of the row instead: one line, no gauge line to
      go missing, and its own height set inline from the exact same scope
      value handed to `vs-repeat="{size: ...}"`
      (`commonProgramTools.programScheduleRowHeight`, currently 26) plus
      `flex-shrink: 0` - so a row's rendered height cannot disagree with
      what `vs-repeat` was told, by construction, not by remembering to
      keep two numbers in sync.

      The row (inline in `channel-config.html`, not a directive - only one
      list wants this exact layout, and program-list-row's own comment about
      inline-vs-templateUrl timing doesn't apply here since this row doesn't
      rely on `vs-repeat` auto-measuring it): start time in a compact form
      (`commonProgramTools.shortStartTimeString`, "9/28 2:00:00a" - no
      leading zeros, am/pm as one trailing letter), the show/album name, a
      `S1 · E2` tag, the episode/track title or a movie's year (CSS
      ellipsis, not JS truncation), the exact duration, and - new here -
      "break after 4:46" as a small tag at the right end, computed once per
      `updateChannelDuration()` pass into `program.$breakAfterMs` (stripped
      before save, like `$index`) the same way the reverted attempt did it.
      Flex and redirect rows collapse to start time, "Flex" or "Redirect to
      channel: N", and the length, on the same one line - no separate
      gauge, so there's nothing left to go missing. All the row-field
      functions (`rowStartTime`, `rowShow`, `rowTag`, `rowTitle`,
      `rowOfflineLabel`, `rowBreakAfter`) live in `common-program-tools.js`
      as pure functions of a program object, not closures in
      `channel-config.js`, specifically so a test can call them directly
      instead of guessing at their output.

      **A second real bug, found live rather than guessed at.** `.psr-show`
      and `.psr-title` both need `overflow: hidden` for the ellipsis rule to
      work - but per the flexbox spec, `overflow` other than `visible` makes
      a flex item's *automatic* minimum width 0 instead of its content size.
      With no explicit `min-width`, a row too narrow for every field at once
      (an 800px test viewport; the real Tools pane open beside the list at
      1900px did not trigger it, but came close) shrank both fields to
      literally 0px - the text was correct in the DOM
      (`getBoundingClientRect().width === 0` while `textContent` held the
      full title) but nothing was visible, the same invisible-not-missing
      failure shape as the original gauge-label bug, on a different property.
      Fixed with `min-width: 4em` on `.psr-show`, `.psr-title` and
      `.psr-flex-label` - a real floor, so a too-narrow row truncates
      further (including, at the extreme, clipping the row's own
      right-hand fields via `.psr-row`'s `overflow: hidden`) rather than
      dropping a field to nothing.

      **`test/program-row-heights.js`, added to `npm test`.** Renders the
      real row - extracted from `channel-config.html` by `<div>` tag-balance
      matching, the same reasoning `test/support.js`'s `liftSource` gives for
      pulling JS function bodies instead of transcribing them - inside the
      real `style.css`, in a real headless Chrome via `puppeteer-core`
      (a new devDependency; Chromium itself isn't vendored, so the test
      searches common Chrome/Edge install paths and *skips*, rather than
      failing, when none is found - keeps `npm test` runnable on a machine
      without either). Three fixtures (a program row with every field
      populated, a Flex row, a redirect row) are resolved against the real
      row template - each top-level `ng-if` evaluated and each `{{ }}`
      filled from the real `common-program-tools.js` functions, both via a
      small fixed lookup that throws if the template grows an expression it
      doesn't recognize, rather than silently rendering a stale fixture -
      then measured with `getBoundingClientRect()` inside a
      `flex-direction: column` container shorter than the fixtures combined,
      the same shape `vs-repeat`'s real scroll container has. Confirmed the
      check actually catches the bug class it guards, not just its own
      fixtures: temporarily removing `flex-shrink: 0` from `.psr-row`
      dropped all three measured heights to 13px against the 26px `npm test`
      expects, restoring it passed again. A small Bootstrap 4.4.1
      `box-sizing: border-box` + base `.list-group-item` border shim is
      hand-written in the test, not vendored - `web/public/bootstrap-4.4.1-
      dist` isn't checked into this repo - since `box-sizing: border-box` is
      exactly what keeps that base border from silently adding to a row's
      declared height in the real page.

      **Live-verified** on a copy of `.dizquetv-dev`, a fresh port (never
      18000, never the live folder - this session's copy lives in Claude's
      own scratchpad directory, outside the repo), against channel 1's real
      40,001-program lineup, at a real 1900x900 window (Ron's own, per the
      note above) and, for the width-collapse bug specifically, an 800x450
      one that reproduced and then confirmed the fix. `el.scrollTop` driven
      by script from 0% to 100% of a `1,040,026`px scroll height landed on
      19-20 rendered rows every time, every one measuring exactly 26px,
      including deep into the list (past 8/9, a week-plus from the 9/28
      start) where real show variety (Boondocks, Harvey Birdman, Robot
      Chicken, Space Ghost Coast to Coast) confirmed rendering wasn't
      somehow specific to the first few rows. No redirect row exists in the
      real dev data, so one was injected into the live scope to confirm its
      rendering and height directly, then discarded (Cancel, never saved).
      A real `Update Channel` save round-tripped 40,001 programs with
      `$breakAfterMs` and `$index` both absent from the written file
      afterward. Not yet confirmed: Ron scrolling it himself, a week ahead,
      on his own window - the actual gate, same as last time, before this
      merges.

      **Custom shows and filler lists got the same one-line row (Oct 1,
      2026, Sonnet 5.5, worktree `list-rows`).** The two-line
      `program-list-row` directive these two lists still used had the same
      exposure the programming list's first attempt did - a second line and
      a gauge line that a row's height depended on - so they now use the
      programming list's design instead, and the directive, its CSS and its
      registration in `app.js` are deleted (nothing else used it). One line
      per row, and every row exactly `commonProgramTools.contentListRowHeight`
      (26) tall: the row's own `style="height: {{ contentRowHeight }}px"` and
      `vs-repeat="{size: contentRowHeight}"` both read that one scope value,
      with `flex-shrink: 0`. Inline in `show-config.html` and
      `filler-config.html`, like the programming list's, with the row's
      fields as pure functions in `common-program-tools.js` (`rowShow`,
      `rowTag`, `rowTitle` and `rowDuration` are shared with the programming
      list; `rowSlotLabel`, `rowSlotFillPercent` and `rowFillerName` are
      new).

      - **Custom shows** keep the slot-fit gauge, redrawn as a 3px bar along
        the row's bottom edge (`position: absolute`, so it has no way to
        change the row's height) filled to the item's slot-fit percentage,
        with its "30-min slot · 7:31 for breaks" text as a small tag at the
        right end, after the duration. Line: color square, show/album, `S1 ·
        E2` tag, episode title or a movie's year, duration, tag. The tag is
        the one field allowed to shrink (with an ellipsis) before the info
        and delete buttons would be pushed out of a narrow row.
      - **Filler lists**: the name and the exact duration, nothing else - an
        episode or track reads `Show · Title`, anything else is its title.
      - Long names end in "…" (CSS `text-overflow`, with the same real
        `min-width` floors as `.psr-show`, so a narrow row truncates instead
        of collapsing a field to nothing).

      `test/program-row-heights.js` now covers all three lists - the same
      real-template, real-CSS, real-Chrome measurement, with fixtures for
      each list's row types. Beyond height it checks that the gauge bar sits
      flush on the bottom edge at 3px and fills the right share of the row,
      that a row with no usable duration draws none, and that long names
      keep real width and end in an ellipsis in a 700px-wide row. Dropping
      `flex-shrink: 0` from `.lr-row` fails every custom show and filler row
      at 24px against 26, confirmed by doing it. Verified live on a copy of
      `.dizquetv-dev` (port 18123, from the worktree, never 18000): Batman's
      107 episodes and CN Powerhouse's 548 clips rendered 18-22 rows at a
      time at 1900x900, every one 26px, with a scroll height of exactly rows
      x 26 plus the list's padding, and rows landing correctly at 0%, 25%,
      50%, 75% and 100%; delete removed the right row (including from a
      filtered view), the info panel opened, and a 900px window kept both
      buttons visible with the names ellipsised. Not exercised from here:
      drag to reorder (browser automation can't drive native HTML5 drag and
      drop; `dnd-draggable` is on the same row element, as in the
      programming list). **Confirmed by Ron in his own browser before this
      merged:** one-line rows, the gauge, scrolling to the bottom of both
      lists, drag to reorder, and a narrow window all right.
- [ ] Flex adjusts itself when lineup items are added, swapped or deleted.

      Swapping an item for one of a different length makes the Flex right
      after it grow or shrink so the next show still starts on time.
      Deleting an item turns its time into Flex so everything after stays on
      time. Adding an item takes its time from the Flex after where it's
      inserted, and if there isn't enough, the following shows move later to
      the next clean start time (:00 or :30).
- [x] Info panel and thumbnail per item - an "i" button, wherever

      a program is picked or reviewed. Shipped in c75cdf7: one shared
      `program-info-panel` directive mounted in the channel's programming
      list, filler lists and custom shows, showing thumbnail, show name (for
      episodes), title, season/episode, year, duration, summary and which
      Plex library the item is from. Display only - never touches how
      anything is saved or played. Everything but the library name was
      already stored on the program object; the library name is the one
      live Plex request, fired once per click of the button, never for the
      list. See the commit for what a scope-shadowing bug in the first pass
      looked like and how it was found.
- [ ] Jellyfin as a media source

### Interface

- [ ] Profiles for specific looks
- [ ] Custom TV guides
- [ ] UI customization and cosmetic theming
- [x] Channel detail page: now playing with progress, total runtime, program count,
      stream mode and transcode config, plus a library browsable by type - movies,
      shows, artists, music videos, other - with durations and artwork

      The channel detail page is mostly display layer over data the API already returns,
      so it carries little risk to existing behaviour. The one real constraint is scale:
      a channel here already holds 9712 programs, so artwork needs lazy loading rather
      than rendering every tile up front. It should be drawn to Syndicast's own identity
      rather than copying the layout of other projects.

      Shipped in e30a891: `/channels/:number`, reached from a small chart icon on
      each channels-list row. Now playing is computed server-side and polled every
      5 seconds, from the same `getCurrentProgramAndTimeElapsed` video.js streams
      from, rather than the viewing device's clock. A break never claims to know
      the filler clip on (that's chosen live, per viewer, and never stored) - it
      shows the day-part or block's mix in effect and the time to the next real
      program instead. A new Filler tab lists every filler list the channel can
      reach, grouped by where it applies (channel-wide, each day-part, each
      block), with clip count and total length.

      The library groups programs into Movies / Shows / Music / Other, not the
      five categories above: there is no "artist" or "music video" field on a
      program object anywhere in this codebase (checked `web/services/plex.js`'s
      Plex-to-program mapping) - telling them apart would mean saving Plex's own
      item type onto new programs, out of scope for a display-only page, and is
      left for later. Same gap, same fix: a track's `showTitle` is its album,
      never its artist (`plex.js` only ever copies `grandparentTitle` for
      episodes) - program-list-row's line 1 uses the album for now rather than
      guessing at an artist that isn't stored. Both need Plex fields saved on
      import that aren't today, so do them together, once, rather than as two
      separate imports.

      Artwork at 40,000 programs (channel 1's real size) stays
      cheap because programs are grouped into a few dozen show/movie/album tiles
      first (reusing `getShowData`'s existing show grouping) - `vs-repeat` and
      `lazy-img`, the same mechanisms the programming list and Plex library
      browser already use at this scale, are what actually render each tile.

      **Movies inside custom shows, Oct 7, 2026 (Sonnet 5.5), on branch `names-seasons-anyof`.** The
      Movies tab also lists the movies that sit inside custom shows, 40 minutes or longer, each
      labelled with its custom show ("Halloweentown in Friday DCOM Movies"). A custom show's tile
      stays under Shows and still counts the movies it holds: the movie is in both places. Before,
      a movie in a custom show was reachable only by opening the custom show's tile.

      - **The same rule as the names picker, by sharing it.** The length (`clipNames.MOVIE_MIN_MS`,
        40 minutes) and the test (`clipNames.isListableMovie`) are one definition that `show-match.js`
        and the library both read, and a test checks the two lists name the same movies. Shorts and
        episodes that a custom show holds as movies (603 on channel 1, 646 on channel 3 on the dev
        copy) stay out; a movie of its own is still listed at any length, as it was.
      - **What it lists on the dev copy:** channel 1 14 movies (Cartoon Theatre Movies 12, My Gym
        Partner's a Monkey 2), channel 3 15 (AfterToon, Friday DCOM, SATurday and Sunday Disney
        Movies), channel 2 none. A movie in two custom shows is listed once for each; the same item
        airing twice is one row with its count.
      - **`buildLibrary` moved** from the controller into `src/channel-library.js` (pure, taking
        `getShowData`), unchanged but for the new branch, so `test/channel-library.js` can drive it
        with a lineup. Verified in the browser on a copy: channel 3's Movies tab reads "Movies (15)"
        with the labels.

### Infrastructure

- [ ] Public channel sharing without exposing an IP

      Also covers livestreaming straight from the UI. In the 1.0 must list
      below, not after 1.0 - see "Public channel sharing without exposing my
      IP address" there, and "The XMLTV guide can hand a viewer your Plex
      access token" under Known issues, which the design has to close.
- [ ] Easier version updates
- [ ] Fix random crashes during streaming
- [x] Fix time slots breaking across daylight savings (fixed in 8d72c52 -
      each slot occurrence now resolves its own offset instead of one offset
      covering the whole schedule; the repeated autumn hour in 784ae47)
- [ ] Per-channel timezone. Slots, day-parts and blocks all read the *host
      machine's* local clock (`new Date(instant)`'s own fields and
      `getTimezoneOffset()`, in `time-slots-service.js` and `day-parts.js`
      alike) - fine for one operator running their own channels, but if
      Syndicast ever gets users, this is what would let someone in London run
      a London channel on a server anywhere.
- [ ] Keep a safer version of editing the ffmpeg path in the UI

## 1.0 release

1.0 is a solid foundation for building real channels on - slowly, starting
around Halloween 2026. **The must list below still sets the date, not the
other way round:** 1.0 ships once everything on it is done, whenever that
lands relative to Halloween. Moving viewers onto Syndicast happens after that,
one channel at a time, each only once it is ready - 1.0 is a foundation, not
a cutover.

**From now on, every feature must leave existing saved channels working
unchanged.** A channel built before a feature lands keeps working unchanged
and never has to be rebuilt. Stage 5 already follows this - every transition
sequence defaults to empty, so a channel with none configured just plays
commercials through its breaks (see
[docs/blocks-spec.md](docs/blocks-spec.md)'s Stage 5). Stage 6 doesn't
exist yet and has to be designed to the same rule; per-position stored
progress was (see Known issues below) - a channel saved before it carries
over on its first regeneration, with nothing to migrate.

Must-haves, each tagged with the model doing the work, in the order they'll
be built:

- [x] Build indicator in the UI (Sonnet 5). Shipped in eee8ac1 - the Version
      page and a footer on every page now show the running version, git
      commit and server start time, so a long-running process no longer looks
      identical to one just started; if git isn't available at startup it
      shows "unknown" rather than failing. See "A long-running server keeps
      serving the build it started with" under Known issues below.
- [x] Verify slots, day-parts, blocks and the guide through the Nov 1, 2026
      fall-back night (Opus 5.5). Slots' own DST handling is the ticked
      Infrastructure line above; day-parts and blocks have their own DST
      option (blocks-spec.md's Decisions table and Stage 1 acceptance table).
      This confirms all three, and the guide built from them, against the
      real transition instead of a simulated clock.

      Done against this machine's real America/Chicago transition (07:00Z)
      with the clock moved, not waited for - the night itself is still
      ahead. Walked 11pm Oct 31 to 4am Nov 1 on copies of the four dev
      channels: playback decisions clip by clip, the guide build, the real
      XMLTV writer and weeklySegments. Nothing crashes. XMLTV writes UTC, so
      the two 1:00-2:00ams come out as distinct times, and guide and
      playback agree every minute on all four channels. Channels 2-4 have no
      slots, day-parts or blocks and simply run through. Channel 1's
      day-parts resolve as intended - CN City (Night) to midnight, Toonami
      AcTN after, through both passes - and shifted starts and airings, which
      none of the real ones use, land on the right instant exactly once.
      What holds is pinned in `test/dst-fall-back.js`.

      Four findings, and what became of each:

      - **Channel 1's saved lineup predated 8d72c52 - regenerated Sep 27,
        2026.** It was laid out on one fixed UTC-5 offset, and ignored
        per-slot season exclusions (258 programs aired a season their slot
        excludes), so from the change until March 14 every slot would have
        aired an hour early - the 2:00 show at 1:00am CST, the 8pm show at
        7pm. Measured over the whole saved lineup: every program in its own
        slot in October and April to July, 0.2-1.2% November to February.
        No code to change: Time Slots was re-run on a server at 7191d8d
        and the channel saved with Update Channel - two earlier attempts
        never reached the data folder, most likely because the dialog's
        Create Lineup only changes the editor's copy. The new lineup, from a
        fresh copy of the data folder: every program in its own slot in
        every month to August 2027, custom-show slots included; no program
        airs a season its slot excludes (0 of 1,107); and the fall-back
        night airs Cowboy Bebop and InuYasha again at 1:00 and 1:30am CST,
        with Attack on Titan back at 2:00. It runs out on Aug 3, 2027 - see
        "Channel 1's lineup runs out on Aug 3, 2027" under Known issues.
      - **The repeated hour did not re-air - fixed in 784ae47.** The drift
        correction measured the time to the next slot boundary in real
        time, and 2:00am comes round only once, so the slot on air when the
        clock fell back (1:30) ran on through the whole second pass - three
        InuYasha in a row on channel 1. The 1:00 and 1:30 slots now each
        air again; see "Time slots have no daylight-saving toggle" under
        Known issues.
      - **A shifted day-part start could lose its place after a change -
        fixed in d9d91ae, spring and autumn.** Every start was placed using
        the offset at the instant being resolved, including starts that had
        already happened under the other one, so a shifted start could drop
        behind an ordinary start it had followed, and the older day-part
        came back at 1:00am CST with nothing starting there. The day-part in
        effect is now the one whose start happened last in real time: a
        shifted start happens once, at its standard time; an ordinary one
        whenever the wall clock reaches it, so it replays in the repeated
        hour like the slots and block airings around it. No channel had the
        combination that showed it.
      - **Not daylight saving: a boundary break often opens with a clip
        from the outgoing mix.** Moved to the Stage 4 item below, which
        takes it.
- [x] Let the viewer's IPTV player stretch 4:3 with "normalize resolution"
      still on (Opus 5.5 plans, Sonnet 5 builds). See its Media handling
      roadmap line above.
- [x] Info panel and thumbnail per item (Sonnet 5). See its Library
      management roadmap line above.
- [x] Channel detail page (Sonnet 5). See the Interface roadmap line and its
      note above.
- [x] Program rows show the episode title, with a slot-fit gauge (Sonnet 5 ·
      High). See the Library management roadmap line above.
- [x] Buffering, tested with three streams at once and the other streaming server stopped
      (manual test; Opus 5.5 investigates and fixes if it turns out not to be
      the other server). See the Known issues entry below.

      It wasn't the other server. Both causes fixed Sep 27, 2026 (fecfd2f, f8f4dc7),
      and measured on the real server path with Claude minimized and
      the other streaming server *running*: three `/video` streams at 0.98-1.00x realtime,
      including every short clip in a whole break. Confirmed Sep 28, 2026 on
      Ron's real client - the manual test this was left unticked for.
- [x] Fix NVIDIA / h264_nvenc encoder issues (Opus 5.5 investigates, Sonnet 5
      builds). Built Oct 1, 2026: 8-bit for every H.264 encoder, the channel's
      bitrate for nvenc, every source encoded under an H.264 encoder, and a
      libx264 fallback. See its Media handling roadmap line above.
- [x] Stage 4, short items next to Flex (Opus 5.5, investigate and fix). See
      "Fix very short items repeating or being skipped next to Flex" under
      Media handling above, and Stage 4 in
      [docs/blocks-spec.md](docs/blocks-spec.md).

      Also take, since it comes from the same look-ahead at the edge of a
      break: **a boundary break often opens with one clip from the outgoing
      mix.** Found walking the fall-back night, but not a daylight-saving
      problem - it happens every day. `getCurrentProgramAndTimeElapsed` in
      `src/helperFuncs.js` hands the stream to the next item when it is
      within `SLACK` (10 seconds) of the current one's end, reporting 0
      elapsed. `findNextProgram` in `src/day-parts.js` then works out the
      next show's start as `t0 - obj.timeElapsed + duration` - up to 10
      seconds early, which is just before a boundary set at that show's
      start, exactly as the spec says to set one. So the first clip of the
      break resolves in the outgoing context and the rest in the incoming
      one. Measured on channel 1 regenerated by the current generator, Oct
      18-25: 15 of 28 boundary breaks opened with one outgoing clip, never
      more than one; e.g. the break before Saturday's midnight Dragon Ball
      GT opened with a CN City [NIGHT] clip, then Toonami AcTN. The guide
      is unaffected - it resolves from exact starts. Likely shape: resolve
      from the break's real start in the lineup rather than from the
      hand-off instant, and check against the same week.

      **Investigated with stage 4, Oct 1, 2026: the same cause, and
      confirmed.** It is rule 1 in the stage 4 entry under Media handling:
      a stream that reaches the end of a show early is handed the break at
      0 elapsed, and `findNextProgram` counts the next show's start from
      that instant. A stream reaches a show early whenever the break before
      it ended early - 12-35% of breaks in that entry's simulation, more the
      longer the break, and 15 of 28 in the week measured above - and at
      tune-in within 10s of a show's end.
      - *With the real functions at a real boundary:* channel 1's Friday
        12:30am Adult Swim start, where Family Guy begins 0.92s after the
        minute. Reaching the break 0 or 0.5s early, every clip is Adult
        Swim; 2, 5 or 9.9s early, the first clip is CCN and a clip 30s in
        is Adult Swim.
      - *Live, through `/video`*, on scratch channel 904 on the copy: a
        59s promo, a 120s break, a 59s promo starting on the minute, with a
        day-part (Checkerboard mix) starting at that minute. Tuning in 5s
        before the first promo ended, the break opened with "Comm Break
        (Sept 2006) (1)" from CN City [NIGHT], the outgoing mix, then two
        Checkerboard clips.
      - *Channel 1's own breaks on the copy*, with test day-part starts
        added at 6:00pm (CN City [NIGHT]) and 7:00pm (Checkerboard): tuned
        in 51s into the 6:21:39-6:30 break (501s), whose 9 clips were all
        CN City [NIGHT]. It ended 1.2s late, so Grim started 1.2s late and
        played once, and the 6:52 break before the 7:00 boundary began 1.7s
        late and was Checkerboard from its first clip - right, as expected
        for a stream that arrives late.

      **Fix, proposed, to go in with stage 4's as its own commit, first:**
      have the hand-off say how early it is - a new field, say `startsIn`,
      rather than a negative `timeElapsed`, which the channel detail page
      shows as is (`channel-status-service.js`) - and have
      `findNextProgram`, and the break's time left in `createLineup`, count
      from the break's real start. Tested at that Friday boundary for 0-10s
      early, every clip from the incoming mix. The lineup cursor needs the
      same number, which is why they go together.

      **Built Oct 1, 2026 in 62262f8, with the cursor in 31253d4**, and
      confirmed live on a scratch channel (the first clip from the incoming
      mix). See "Built" in the stage 4 entry under Media handling.

      Two leads from fixing the concat restart (Sep 27, 2026). The restart
      is ruled out as the "plays three times" symptom, and can only start
      a clip partway about four times a day. Items encoding below realtime
      are a stronger lead for the skipping. See "A concat restart replayed
      the tune-in" under Resolved, and "Heavy buffering during playback"
      under Known issues.
- [x] Stage 5 transition bumpers (designed Oct 1, 2026 on Fable 5.1; Sonnet
      5 builds). See Stage 5 in [docs/blocks-spec.md](docs/blocks-spec.md)
      for the design and the eight-step build order. The design pass decided
      that slot filler positions (HEAD/PRE/MID/POST/TAIL) and sign-ons and
      sign-offs are covered by stage 5's own sequences - see those two
      roadmap lines under Blocks system and Scheduling above - with one small
      item left over, an off-air look overnight, recorded there. All eight
      steps are built; step 8 has its own line under Blocks system.
- [x] Generated Next Time cards for Cartoon Theatre (stage 5 step 9, Sonnet 5).
      The first piece of the Generated Up Next bumpers roadmap item, pulled
      into 1.0: when step 8's real "Next Time" clip has none for next week's
      movie, a card Syndicast renders itself stands in. See "Generated Next
      Time cards for Cartoon Theatre" under Blocks system above and
      docs/blocks-spec.md, Stage 5, "Generated cards". **Built Oct 9, 2026.**
- [x] Per-position stored progress, then shuffle, rerun, repeat a slot and
      ordered shuffle, with multi-part stories kept together (Opus 5.5 · Xhigh
      throughout - see "Work that stays on Opus 5 end to end" in the Model
      guide below). Designed Oct 9, 2026: see "Per-position stored progress,
      and the shuffles built on it" under Known issues, and
      [docs/stored-progress-plan.md](docs/stored-progress-plan.md) for the
      build order. **Built Oct 9-10, 2026** on the `stored-progress` branch,
      all seven steps, each proven on copies of Ron's data; merged into
      `blocks` when Ron says. Channels saved before it carry over on their
      first regeneration, with nothing to migrate.
- [ ] Full catalogs and the never-air list: every slot draws on its show's or
      custom show's whole episode list once reviewed, and episodes Ron left
      out - holidays he places himself, and ones never to air - stay out
      (Opus 5.5). On the `full-catalog` branch, on top of `stored-progress`,
      so the two merge together. See "Full catalogs, and a never-air list"
      under Known issues and [docs/full-catalog-plan.md](docs/full-catalog-plan.md).
- [ ] Episode start: start a show or custom show at a specific episode, not
      just a season (Opus 5.5 designs, Sonnet 5 builds). See its Scheduling
      roadmap line above.
- [ ] Swap out episodes of a show, and plug library items in anywhere
      (including individual items from a custom show), and Flex adjusts
      itself when lineup items are added, swapped or deleted - designed
      together in the same Opus 5.5 design session, built by Sonnet 5.
- [ ] Chapter and segment detector, then Stage 6 midrolls (Opus 5.5 designs,
      Sonnet 5 builds). See the Scheduling and Blocks system roadmap lines
      above and Stage 6 in [docs/blocks-spec.md](docs/blocks-spec.md).
- [ ] Profiles for specific looks, custom TV guides, and UI customization and
      cosmetic theming - each defined together before Sonnet 5 builds it.
- [ ] Jellyfin as a media source (Opus 5.5 investigates and designs, Sonnet 5
      builds).
- [ ] A live install separate from dev, where real channels get built: own
      folder and data folder, auto-start after reboot, a port Windows won't
      reserve, logs to files, daily backups tested by one restore, and a
      written routine for updating it to a new release (Sonnet 5).

      Should reuse the backup tooling built for `.dizquetv-dev` -
      `scripts/backup.js`, `scripts/backup-register-task.js` and
      `scripts/test-restore.js` - pointed at the live install's own data
      folder and its own backup destination via `--source`/`--dest`, rather
      than writing new scheduling, copy or restore-check logic.

      Needs `browserify` present in `node_modules` (it's a devDependency, not
      a dependency) - `src/web-bundle.js`'s startup/request-time rebuild
      `require`s it lazily, only when a rebuild is actually attempted. Set up
      with `npm install --production` or `npm ci --omit=dev`, that `require`
      fails every time a rebuild is needed, which the same code path treats as
      any other build failure: logged once, the previous `web/public/bundle.js`
      keeps being served, and the footer warns it may be out of date. If
      `bundle.js` was never built at all (a fresh clone with no prior
      `npm run build`), there is no previous copy to fall back to and the
      editor page fails to load it - so a live install still needs a real
      `npm run build` (dev dependencies installed) at least once, even if it
      never rebuilds automatically again after that.

      **How to restore a backup**, in plain English: stop the server,
      rename the current data folder out of the way (don't delete it until
      the restored one is confirmed good), copy the dated folder you want
      from the backups location to where the data folder was, then start
      the server pointed at it exactly as usual. `npm run
      backup:test-restore` proves a given backup actually boots - and that
      its channels match what's on disk - before you trust it for this.
- [ ] Random crashes during streaming, caught by a 48-hour soak and fixed if
      seen (Opus 5.5). See the Infrastructure roadmap line above and the
      Model guide below.
- [ ] Public channel sharing without exposing my IP address (Opus 5.5 · Xhigh
      to design, Sonnet 5 · High to build). Moved into 1.0 from after it; now
      also covers livestreaming straight from the UI. See its Infrastructure
      roadmap line above and "The XMLTV guide can hand a viewer your Plex
      access token" under Known issues below - a channel shared publicly is
      exactly the case where that leaked token stops being theoretical, so
      the design has to close it, not just the public-sharing mechanism
      itself.
- [ ] Release: version 1.0.0, README current, merge blocks into main, tag
      v1.0.0 (Sonnet 5).

Everything else unticked stays in the roadmap as it is.

## Known issues / future work

### Channel 1's lineup runs out on Aug 3, 2027

Regenerate it before then: re-run Time Slots on channel 1 and click Update
Channel. Nothing renews a lineup on its own.

The lineup generated on Sep 27, 2026 is 40,000 programs - the generator's
cap, hit before its 365-day limit - and one 315-day cycle, from Thu Sep 24,
2026 12:00am CDT to Thu Aug 5, 2027 12:00am CDT. Its last real program ends
**Tue Aug 3, 2027 at 1:20pm CDT**; the 35 hours after that are the flex that
pads the cycle out to whole weeks. Then the cycle loops, and a lineup starts
with flex from the start of its week to the moment it was generated - 72
hours here. So from Aug 3 to Sun Aug 8, 2027 12:10am CDT channel 1 plays
filler only, about four and a half days, and after that the same episodes
from Sep 27, 2026 come round again in the same order.

The cycle is a whole number of weeks and both ends fall in daylight time, so
if it did loop the slots would still be on their clock times - the problem
is the dead stretch and the reruns, not the schedule. Regenerating any time
before Aug 3 continues each show from where it has got to - every slot and
range exactly, since per-position stored progress was built (see that entry
below; before it, a show with several ranges, or with both Play Next and
Shuffle slots, resumed only its first-airing one exactly). A lineup
generated in winter and looping in summer, or the other way round, would
also be an hour off after the loop; regenerating inside the cycle avoids
that too.

### Rebrand artwork does not reach existing installs

The branding kit replaces the images in `resources/`, but the app copies those
into the data folder (`.syndicast` / `.dizquetv`) on startup and only when the
file is missing. An existing install therefore keeps showing the old artwork
after a rebrand: the header logo and the on-air screens for error, offline,
music, and loading.

Affects `initDB()` in `index.js`. Workaround is to delete the stale files from
`<data folder>/images/` and restart, which recreates them from `resources/`.
Worth deciding whether the app should overwrite these on version change, or
leave it manual so users keep any artwork they replaced themselves.

### Branding script counts the same file more than once

`syndicast-branding/apply-branding.js` tracks written files in a `Set`, but
builds paths two different ways: some edits use literals such as
`src/hdhr.js`, while `walk()` uses `path.join()`, which produces `src\hdhr.js`
on Windows. The two spellings are distinct set members, so the final report
double-counts. It printed "46 files written" for 42 actual files and listed
four of them twice.

Cosmetic only, and the edits themselves are applied correctly. Fix is to
normalise separators before adding to the set.

### ffmpegPathLockDate reads backwards, and clearing it locks harder

`isLocked()` in `src/services/ffmpeg-settings-service.js` treats a date in the
**past** as locked and a date in the **future** as unlocked, which is the
opposite of how the field name reads. `unlock()` correspondingly sets the date
to `now + 24h`.

The trap: clearing the field does not unlock it. `isNaN(undefined)` is true, so
a missing value takes the locked branch. Same for `null`. The only supported
way to unlock is starting with the `--unlock` flag, which is easy to miss since
nothing in the UI mentions it.

Worth renaming to something like `ffmpegPathUnlockedUntil`, and surfacing the
unlock route in the settings page instead of leaving it a CLI-only affordance.

### Windows NAT can grab port 18000, giving EACCES with nothing listening

`node index.js -p 18000` fails with `EACCES` while the port looks completely
free: nothing is listening, it is absent from
`netsh int ipv4 show excludedportrange protocol=tcp` (which lists only
50000-50059), and it sits outside the dynamic range of 1024 plus 13977.

The cause is the Windows NAT service reserving port ranges for Hyper-V, WSL
and Docker. Those reservations do not appear in the usual places, which is why
every check says the port is available. Restarting the service releases them,
from an elevated prompt:

```
net stop winnat
net start winnat
```

It can reclaim the range again later, so this may need repeating. 18080,
19000, 17000, 8123 and 9500 were all free when 18000 was not; development
moved to 18080 for a while and has since moved back to 18000.
`.claude/launch.json` still says 18000 deliberately, since the reservation is
transient. Confirm with a bind test rather than assuming:

```js
require('net').createServer().listen(18000, '0.0.0.0')
```

### A long-running server keeps serving the build it started with

Found investigating "channel 1 plays no filler during breaks - not wrong
filler, none at all." Every check on the code came back clean:
`createLineup` reached, `resolveContext` resolving to the right block, every
list loading real content, clips fitting the actual break lengths (13.2s
minimum measured, none under 10s at all). Instrumenting the live process
directly - patching `helperFuncs.createLineup` and
`FillerService#getFillersFromCollections` at load, no edits to the repo -
confirmed all of it end to end: a real clip picked, and Plex accepting it for
direct play.

The gap was never in the request path. A `node index.js` process that had
been running since before `466c96b` (day-part filler resolution,
2026-09-23) was still the one serving channel 1. That commit changed what
`video.js` reads for filler: previously
`fillerService.getFillersFromChannel` mapped over `channel.fillerCollections`
- the Flex tab. Once a channel's filler moves into day-parts and blocks, as
channel 1's has, `fillerCollections` is `[]`, and the old code's picker
returns null on every break. `offlineMode: 'pic'` with no fallback turns
that into the offline screen - indistinguishable, from the stream, from "the
picker chose to play nothing." The play-cache confirmed it: an
`!unknown!|!unknownProgram!` entry (the offline screen) recorded repeatedly,
and not one `!fillerList!` entry, ever.

**Nothing in the running app says which build is live.** There is no
version, commit or start-time indicator anywhere a channel is edited or
played, so a process up for days looks identical to one started five minutes
ago. This was only found by correlating `git log` timestamps against actual
process start times by hand.

**Two servers on one data folder is its own hazard, found the same way.**
Development moving from 18000 to 18080 (previous entry) makes it easy to end
up with both running against `./.dizquetv-dev` at once - one old, one
current, both willing to read and write the same channel files. `942da90`'s
config-cache invalidation and `channel-save.js`'s retry-on-torn-read make a
second reader/writer survivable, but neither process can detect or warn
about the other; each believes it is the only one running.

Worth doing: surface the running build's commit, or at least its start time,
somewhere in the UI - the footer, the Version page, anywhere - so "is this
the process I think it is" is answerable without shelling out to compare
timestamps.

### Per-position stored progress, and the shuffles built on it

Designed Oct 9, 2026 (Opus 5.5) and agreed with Ron the same day; **all
seven steps built Oct 9-10, on the `stored-progress` branch, unmerged until
Ron says** - Play Next continues from stored progress, Shuffle plays rounds
kept by episode, with season settings and multi-part stories, Rerun replays
only what its show's Play Next has aired, Repeat a slot re-airs a chosen
earlier slot, and Ordered shuffle interleaves a custom show's series; every
step's proof re-run on the final code (step 7), and the final review's fixes
in, with Ron's rule for narrowing one slot of a shared Shuffle (Oct 10). "Full
catalogs, and a never-air list", the next entry, is designed and being built on
its own branch. See "Build record" at the end of
this entry, and the build plan in
[docs/stored-progress-plan.md](docs/stored-progress-plan.md). Replaces two
earlier entries, "Shuffle progress is stored, and it is seeded over the
candidate count" and "Per-position stored progress, which fixes two things at
once"; what they established is folded in below. Measured on copies of
`.dizquetv-dev` taken Oct 9, 2026 at 4:54am Central (unchanged at 5:06am), and
on a copy of channel 1 from the Sep 29 3am backup, the last one that still
carried Johnny Bravo's season ranges - channel 1 was reprogrammed before the
Sep 30 backup (308 of 336 slots changed show) and has had no ranges since.

#### How progress was kept

*Play Next stores nothing.* Each run of Time Slots or Random Slots is handed the
channel's lineup rotated so the program on air comes first, then thinned by
`removeDuplicates`, and `show.founder` is the first program of each show in it
(`time-slots-service.js`, `random-slots-service.js`). `resumePosition` in
`show-orderers.js` starts every Play Next position of that show at the
founder's episode, or at the nearest later one its seasons allow. So Play
Next's place *is* the lineup's order, and everything that writes
`channel.programs` writes it: the two generators, the editor's
`adjustStartTimeToCurrentProgram`, some 25 programming tools in
`channel-config.js` (sort, add, remove, replace an airing, block shuffle,
equalize...), `cleanUpProgram` on save, the database migrations and on-demand.
`removeDuplicates` decides which occurrence of an episode survives.

*Shuffle stores a number on each airing.* `getShowShuffler` writes
`prog.shuffleOrder = position` on every program it emits and reads
`show.founder.shuffleOrder` on the next run. The number indexes a permutation
seeded over the candidate count `n`, so it means nothing once `n` changes -
with twelve episodes and a saved 7, removing season 2 turned S3E4, S1E1, S3E2
into S3E3, S3E4, S3E2 - which is why season settings were Play Next only. It
also has two writers nobody meant: Play Next's candidates are copies of the
previous lineup's programs, numbers included, so Play Next airings carry stale
Shuffle numbers (channel 2's Hey Arnold, Wed Nov 11 6:30pm, Play Next S2E9,
carries pick 4); and replacing an airing by hand drops it (Ron replaced Hey
Arnold's Fri Oct 9 4pm S3E19, pick 0, with S5E5 at 3:52am that day).

*Season start* is a one-time seek: set in the season panel, part of
`constraintKey`, applied by `resumePosition`, cleared by `clearStartSeasons`
after each run.

The only readers are the two generators, through the founder. Playback, the
guide, filler, transitions and cards read the lineup and nothing else.

#### What a regeneration lost, measured

The editor's path driven directly - rotate the lineup at a moment,
`removeDuplicates`, the real `time-slots-service` with the clock frozen at that
moment - and each position's next episodes in the saved lineup compared with
the regenerated one. At Fri Oct 9, 10am:

- **Channel 1 as saved: nothing.** All 138 positions continue. One range per
  show and no Shuffle, so there is nothing for the founder to get wrong.
- **Channel 1 as of Sep 29:** 5 of 50 positions jump, four of them Johnny
  Bravo's (all seasons Thu 9pm, no S1 Fri-Sat, no S2 Sun-Mon, no S3 Tue-Wed).
  The founder was Friday's no-S1 airing, S02E07, so three ranges collapsed onto
  it: S02E07-S02E12 air Fri-Sat, again Tue-Wed, and S02E07-09 a third time on
  Thursday.
- **Channel 2: 5 of 164.** **Channel 3: 8 of 155** at Friday 10am, and 18 of
  155 at Monday 10am - which positions break depends on the day you regenerate.

| Position | Next in saved lineup | Regenerated | Why |
|---|---|---|---|
| Ch 1 (Sep 29) Johnny Bravo, all seasons, Thu | S01E28 | S02E07 | founder is Friday's range |
| Johnny Bravo, no S1, Fri-Sat | S02E07 | S02E07 | is the founder |
| Johnny Bravo, no S2, Sun-Mon | S01E34 | S03E01 | nearest after S02E07 its range allows |
| Johnny Bravo, no S3, Tue-Wed | S01E34 | S02E07 | third airing of S02E07 that week |
| Ch 2 All That, S1-6, Mon-Thu | S01E05 | S01E01 | founder is Friday's S7-10 range |
| Ch 2 Rugrats, all seasons, weekdays | S01E05 | S06E01 | founder is Friday's S6+ range |
| Ch 2 Hey Arnold, Play Next, weekdays | S01E09 | S05E05 | founder is Friday's Shuffle airing |
| Ch 2 Hey Arnold, Shuffle, Fri | S05E05 | S03E19 | founder has no number: round restarts |
| Ch 2 Kenan & Kel, Play Next | S01E05 | S03E10 | founder is Saturday's Shuffle airing |
| Ch 3 Boy Meets World, Play Next | S02E05 | S07E23, then S01E01 | founder is Friday's Shuffle airing |
| Ch 3 Kim Possible, Shuffle (Monday) | S04E04, S02E03 | S01E19, S02E20, S04E04 | founder is a Play Next airing with a stale number |

Channel 3's eight Friday breaks are all weekday Play Next strips whose weekend
Shuffle airs first from Friday morning (Bill Nye, Boy Meets World, Honey I
Shrunk the Kids, Sister Sister, So Weird, The Famous Jett Jackson, The Jersey,
Winnie the Pooh). On Monday it is the other way round: all 18 weekend Shuffles
re-air the weekend that has just aired - Doug S07E18 again, Kim Possible
S01E19 and S02E20 again.

So three causes, and they compound: one founder per show, so only the range
that airs first resumes; Play Next and Shuffle share that founder; and
Shuffle's numbers are unreliable for the two reasons above.

Not a progress defect, recorded because it looks like one: in the Sep 27
lineup Johnny Bravo's no-S2 and no-S3 ranges were already airing the same
Season 1 episodes two days apart, because both were started from one founder.
Stored progress keeps them where they are; separating them is Episode start's
job.

#### The design

**A position is one show, one mode and one range** - "Johnny Bravo, Play Next,
no Season 2" - keyed by show id, mode and the sorted excluded seasons. Slots
sharing all three share a place, as now, so a weekday strip still advances as
one thread and Saturday's and Sunday's Shuffle slots of a show share a round.
Season start leaves the key: it is a one-time move of the position's place,
which is how Episode start will work too. Its old place in `constraintKey`
made a position's key change the moment `clearStartSeasons` ran.
`season-constraints.js` takes the key from the shared module instead of
keeping a copy that has to agree.

**Every airing records its position.** The generators label each program they
emit with `slotPosition` (shape below) and copy programs clean, so no
`shuffleOrder` or old label rides along on a Play Next airing. An airing placed
or replaced by hand has no label and never moves a position; one moved by hand
keeps its label and is read where it now sits.

**A position's place is read at the moment Create Lineup runs**, by the editor,
from the lineup it has loaded. In order, the first that applies:

1. **A seek on one of its slots** - season start today, Episode start later. If
   two of its slots ask for different seeks, the one airing first from now
   wins.
2. **Its first airing on air or ahead** in the lineup. The airing on air counts
   as not yet aired, as today, so nothing is skipped. Lineups without labels -
   every channel saved before this - are read by matching each airing to the
   slot it starts in, with the same `findSlot` arithmetic the generator uses:
   3,450 of 3,450 airings over three weeks on channels 1-3 (and 1,362 of 1,362
   on Sep 29's channel 1) matched a slot of their own show. For a Shuffle
   position the old airing's `shuffleOrder` gives the rest of its current round
   in the old order, reproduced from the old permutation (checked 40 of 40 on
   Hey Arnold, Kenan & Kel and Kim Possible), so the carried round finishes
   exactly as the saved lineup would have aired it.
3. **Its record in the schedule**, for a position that has no airing ahead - a
   range taken out at an earlier run and now put back.
4. **The slot's old place** (Ron's decision): a position nobody used before
   takes the place of the position the same slot - same time, same show -
   belonged to in the schedule the lineup was made from, moved forward to the
   nearest episode the new range allows; for the shuffle family the rest of the
   old round, with what the new range excludes taken out - but only when no
   slot still plays the old position; otherwise a round of its own (Ron, Oct
   10: two positions finishing one round air the same episodes days apart). If its slots came
   from several old positions, the one airing first from now wins. Not across
   a change of mode.
5. **Otherwise the first episode of its range**, or a fresh round.

Random Slots lineups without labels can't be matched (their slots have no
times), so for that one run step 2 falls back to today's founder rule.

**A place is an episode, never a count.** A reference is
`{ key: serverKey + '|' + key, order }`, `order` being `getShowData`'s
(`season * 1000000 + episode`, or a custom show's `customOrder`). It is
resolved by key, falling back to order when the file has gone, and "the next
episode" is the first candidate at or after that order, wrapping - so adding
episodes, changing a range or a custom show gaining an item can't silently
move a place. If the episode itself is gone or now excluded, the position goes
to the next one after it.

**Records are saved with the schedule**, one per position (about 150 a
channel), in `scheduleBackup.progress` and `randomScheduleBackup.progress`.
They are written only on the Create Lineup path, as of that moment, and reach
disk with Update Channel like the rest of the schedule. A position that stops
being used keeps its record.

**Why labels and records, not records alone.** The earlier entry proposed
storing the last episode each position emitted. A lineup runs about ten months
ahead, so that record would describe where the lineup *ends*, not where it is
today, and regenerating mid-way would skip months of episodes. Only the
airings know which of them have happened; the record covers the positions with
none ahead. And because the editor reads the whole lineup rather than the
`removeDuplicates` pool, the earlier worry about one range's tags being thinned
away does not arise.

**Additive.** Nothing to migrate and nothing to rebuild. Both new fields are
optional; a channel without them generates exactly as described above on its
first run, and anything that can't be read falls back to the next rule down,
never below today's. Playback, the guide, filler, transitions and cards never
read either field. `shuffleOrder` is read for the carry-over and no longer
written. Channel files grow by about 4% for the labels.

**Room for Episode start.** Episode start becomes a seek like season start: set
a position's next episode. Because places are stored, the editor can show each
position's place ("no S2: next is S01E34, Sun Oct 11 9:00pm"), which is where
that item's preview of the first airing comes from.

#### Shuffle, Rerun, Repeat a slot and Ordered shuffle

How Ron programs them now: on channels 2 and 3, 23 shows run a Play Next strip
on weekdays and a Shuffle at the weekend; several custom shows join series
(Tom & Jerry 4, Yogi Bear 4, Gundam 8, Spider-Man 3); and "Double Dare Series
(Shuffle)" was shuffled by hand into its custom-show order and plays as Play
Next.

- **Shuffle.** A random episode of the slot's range each airing, none repeated
  until every one has aired - a round - and none back within half a round of
  its last airing, as the old shuffler's two halves guaranteed. A round's order
  is the range sorted by a hash of the position key, the round number and the
  episode's key, which doesn't depend on how many episodes there are: adding
  episodes or changing the range leaves the rest of the round where it was. A
  new episode whose turn has already passed waits for the next round. At a
  round boundary, whatever aired in the later half of the old round goes after
  everything else. Season settings open up for Shuffle slots.
- **Rerun.** A Shuffle that only picks episodes the show's Play Next has
  already aired, so a weekend never airs an episode before its weekday strip
  does. "Aired" is the union over the show's Play Next positions - the live
  ones as the generator advances them, plus the records of ones no longer in
  the schedule - of every episode before each one's place, and its whole range
  once it has gone round. A strip carried over from before this counts
  everything before its place as aired, since nothing earlier is known. The
  pool grows as the strip moves on through the lineup; it is cut to the Rerun
  slot's own range; rounds work as Shuffle's.
- **Repeat a slot.** Re-airs whatever a chosen earlier slot aired, on the same
  day or another day of the week. On channel 3, That's So Raven airs Thursday
  to Sunday; Saturday's 6:30pm slot repeats Thursday's 6:30pm and Sunday's
  5:00pm repeats Friday's 6:00pm, and 9pm's episode again at 1am is the same
  option with a slot from the same day. (Ron's change of Oct 9 to the Encore
  first proposed, which looked back one day only; Rerun stays the option that
  replays any episode Play Next has already aired.) The slot names its source
  (`repeatOf`, the source slot's time) and takes its show; it airs the
  episodes of that show that started in the source's latest occurrence before
  it - up to one period back, so last Thursday's for a Saturday - as many as
  fit. A source may be any slot that isn't itself a Repeat, which rules out a
  slot repeating itself or two repeating each other forever. For a repeat whose
  source aired before now, the editor passes the period of the lineup on air
  before now, read back round its loop: Saturday Oct 10's source is Thursday
  Oct 8, which sits at the end of channel 3's stored cycle. Previewed on the
  Oct 9 copy, before building: Saturday Oct 10 would repeat Thursday's S01E01
  "Mother Dearest" and Sunday Oct 11 Friday's S01E02 "Test of Friendship", then
  S01E03 and S01E04 the next weekend, where the lineup has random Shuffle picks
  (S02E03, S04E16, S03E35, S01E14); each Thursday and Friday occurrence airs
  exactly one episode. Before the lineup on air was generated - its
  `progress.asOf` - that lineup holds the generator's opening flex, so each
  run keeps the period it read, for the shows Repeats repeat, in
  `progress.history`, and the next run reads back through that: running
  Create Lineup twice in a row keeps the weekend's repeats (found by the final
  review, fixed with step 7). A source older than both isn't known and falls
  back as below. Repeat airings are
  labelled `repeat`, so they never move a position - a repeat carrying its
  source's label would make that strip look one episode behind. Time Slots
  only; the editor keeps `repeatOf` in step when the source is retimed and
  flags a repeat whose source is gone.
- **Ordered shuffle.** Picks a series at random and plays that series' next
  episode in order - for custom shows holding two or more series, a series
  being the items' show title and its order the custom show's list order. Each
  round is a random interleaving of the series, each series keeping its order,
  so a series airs in proportion to its size and every item airs once per
  round. It uses Shuffle's hash order: the k-th pick of a series in a round
  plays that series' k-th item, so the round number and next episode are again
  the whole record.
- **Multi-part stories stay together, in all three.** An episode marked part n
  (n of 2 or more) belongs with the one right before it in its show's order
  when that one is marked n-1 - or, for part 2, when it has the same title
  without a marker. Markers: `(2)`, `(II)`, `Part 2`, `Part Two`, `Pt. 2`.
  Titles are not compared otherwise: "Stewie Kills Lois (1)" is followed by
  "Lois Kills Stewie (2)", Xiaolin Showdown by "Judging Omi (1)", "Saving Omi
  (2)", "Finding Omi (3)". The one exception is an arc a title names beside its
  part, "(Origins, Part 2)": two such titles join only when they name the same
  arc. A story is picked as one, and its parts are that position's next airings
  until it is done; Rerun takes a story only once every part has aired. Across
  all three channels the rule finds 430 stories (1,020 episodes; Harvey Birdman's "Deadomutt (1)" and "(2)" among them, and Attack
  on Titan's nine-part "The Struggle for Trost"), 13 of them in shows with a
  Shuffle slot today. 24 parts stay single, as now: crossovers whose other
  parts belong to another show ("That's So Suite Life of Hannah Montana
  (II)"), parts whose part 1 isn't next to them or isn't in the library
  (Histeria!'s, Totally Spies' "A Spy Is Born (2)"), and Sonic Underground's
  two interleaved arcs. Movies outside custom shows are left alone. A round
  carried over from the old shuffler finishes in the old order, parts and all;
  stories stay together from the first new round.

Rerun and Ordered shuffle work in both generators, but only the Time Slots
editor offers the new modes; Random Slots keeps Play Next and Shuffle, and none
of the dev channels uses it.

#### Shapes

```js
// on each airing a slot generator emits; the show comes from getShowData
program.slotPosition = "next|2";        // mode | excluded seasons, comma-joined
program.slotPosition = "shuffle||3";    // shuffle family: ... | round
program.slotPosition = "repeat";

// on the schedule, saved as scheduleBackup / randomScheduleBackup
schedule.progress = {
  asOf: "2026-10-09T15:00:00.000Z",
  positions: {
    '["tv.Johnny Bravo","next",[2]]':  { next: { key, order }, wrapped: false },
    '["tv.Kim Possible","shuffle",[]]': { round: 2, next: { key, order } },
    '["tv.Doug","shuffle",[]]':        { round: 0, queue: [ { key, order } ] },  // a carried round
  },
  // what aired in the period before asOf, of every show a Repeat repeats,
  // for the next run's Repeats (repeatHistory)
  history: [ { start: 1791325800000, program: { ... } } ],
};

// slots
slot.order = 'next' | 'shuffle' | 'rerun' | 'repeat' | 'ordered';
slot.repeatOf = 75600000;               // a repeat's source, by the source slot's time
```

Pure modules hold the rules: `src/slot-progress.js` keys, labels, references
and the reading of places; `src/shuffle-rounds.js` the hash order and rounds;
`src/multi-part.js` the part markers and stories.
The editor reaches both through browserify, as the channel detail page already
does with `src/channel-library.js`, so the editor and the generators can't
disagree.

#### Fallbacks, as Ron decided them on Oct 9

- A Rerun whose show's Play Next hasn't aired anything yet plays as a Shuffle
  over its range, and the editor shows why under the slot. A whole slot of
  Flex is worse than an early episode, and this only happens right after a
  show is set up.
- A Rerun of a show with no Play Next anywhere plays as a Shuffle over its
  range, since there is nothing to get ahead of.
- A Repeat whose source aired nothing - lateness turned it to Flex, or it aired
  before the lineup on air existed - airs a Rerun of the same show.
- Ordered shuffle shares airings by series size, as above, rather than equally
  between series.

#### What this doesn't change

- The candidates are still the episodes in the lineup the editor loaded, so a
  season no slot plays drops out after a run, as before - and, measured while
  building step 6, so does every episode a sparse slot didn't reach. See "Full
  catalogs, and a never-air list" below.
- Ranges already in step stay in step (Johnny Bravo above).
- A lineup rearranged by the programming tools still reads, but a position's
  place is wherever its labelled airings were moved to.

#### Build record

**Steps 1-2, Oct 9, 2026** (`stored-progress` branch, 01b7da4..). Proofs on a
copy of `.dizquetv-dev` taken Fri Oct 9, 7:40pm Central (re-checked unchanged
at 7:58pm, and re-copied whole at 8:01pm for the preview), and on Sep 29's
channel 1.

- **What shipped.** `src/slot-progress.js` (keys, labels, references, reading
  places, the planner); `show-orderers.js`'s `createPositions` in both
  generators, which label every airing and copy it clean; the editors read
  places when Create Lineup runs and send them as `schedule.progress`, saved
  with the schedule; season start is a seek, not part of a position's key
  (`season-constraints.js` takes the key from the shared module); and
  `scripts/progress-check.js`, the before-and-after report used below.
- **Today's losses, reproduced first.** With the planner off (`--today`),
  the tool gives NOTES' numbers exactly - Fri 10am channel 1 138/138, Sep 29
  45/50, channel 2 159/164, channel 3 147/155; Mon 10am channel 3 137/155 -
  and every airing over three weeks matches a position (3,449 of 3,450 at
  Friday; the one left is Ron's hand-placed Hey Arnold S05E05, which a
  position rightly ignores).
- **Every position continues exactly**, at Fri 10am, Sat 11pm and Mon 10am:
  channel 1 138/138, channel 2 164/164, channel 3 155/155, Sep 29's channel 1
  50/50. Johnny Bravo's four ranges stay at S01E28, S02E07, S01E34, S01E34;
  All That S01E05 and S07E01, Rugrats S01E05 and S06E01, Hey Arnold S01E09,
  Kenan & Kel S01E05, channel 3's eight weekday strips on their own places,
  and Monday's 18 weekend Shuffles on their own numbers. Hey Arnold's Friday
  Shuffle resumes at pick 1, S01E09, not at the hand-placed S05E05.
- **Nothing changes where nothing was wrong.** Channel 1 regenerated with the
  planner matches `blocks`' generator program for program (0 of 39,999
  differ, ignoring the label). With no progress at all, channels 1-3 match it
  too (0 differ); `blocks` leaked a Shuffle number onto 0, 55 and 598 Play
  Next airings there, which no longer happens.
- **Twice in a row**, Friday's output regenerated again at Monday, read from
  its labels: 138/138, 164/164, 155/155, 50/50.
- **The slot's old place.** All That's Fri-Sun range narrowed to no S1-7
  continues at S08E01; Rugrats' Friday range narrowed to no S1-6 goes to
  S07E04, the first Season 7 episode channel 2's lineup has - S07E01-03 are
  not in it, the lineup-is-the-pool limit above. Sep 29's no-S2 Johnny Bravo
  slots taken out at Friday's run kept their record (S01E34), and put back at
  Monday's resumed there.
- **Live**, on a preview of the worktree (port 18200, the copy; HDHomeRun
  discovery turned off in the copy): channel 2, Time Slots, Create Lineup,
  Update Channel at 8:04pm. The saved file has 164 records and all 17,670
  airings labelled, no Play Next airing carries a Shuffle number, all 164
  positions continue from what the old lineup would have aired at 8:04pm, and
  regenerating from the saved file continues 164/164. No console or server
  errors. The preview had to be started from the worktree by hand: the preview
  tool reads the main checkout's `launch.json`, whose working folder would have
  let the preview's live bundle rebuild write the live server's bundle.
- Channel files grow about 2.6% (channel 2, 23.7 to 24.3 MB).

**Step 3, Oct 9, 2026** (64af61b..). Proofs on a fresh copy taken 8:23pm
Central.

- **What shipped.** `src/multi-part.js` (stories), `src/shuffle-rounds.js`
  (hash rounds, the half-round rule, carried rounds, the old shuffler's
  arithmetic kept for carrying over), Shuffle positions playing rounds in both
  generators, the planner writing round records, season settings for Shuffle
  slots in the editor ("Start from season" stays Play Next's), and
  `scripts/progress-audit.js`, which checks a whole saved lineup against the
  round rules.
- **Multi-part stories:** 430 stories (1,020 episodes) on channels 1-3, 24
  parts single. The arc rule - two titles naming an arc beside the part,
  "(Origins, Part 2)", join only when the arcs match - was added while
  building: the rule as first measured joined Sonic Underground's Origins
  Part 2 with Chaos Emerald Crisis Part 3, which is why the count is one under
  the 431 first recorded.
- **The old shuffler had a second way of building an order.** Started in
  generation 0, it shuffled its base list twice, so every later generation
  came out unlike one built by a shuffler started there: 153 of channel 3's
  1,172 Shuffle-slot airings are of that kind. Carrying over builds the round
  whichever way reproduces the airing it starts from: every Shuffle-slot
  airing on channels 2 (102) and 3 (1,172) carries over from itself.
- **Channel 3's 18 weekend Shuffles continue exactly** at Monday and Friday
  (155/155), and each carried round finishes in exactly the saved lineup's
  order: 994 airings compared, from Monday's regeneration, none different.
- **The audit**, on Monday's regenerated year of channel 3: 18 positions, 0
  violations - no story twice in a round, none back within half a round,
  every story's parts in a row in the position's own rounds. Most weekend
  Shuffles spend the whole year finishing their carried round at one or two
  airings a week, so on a copy Boy Meets World's Shuffle also took the 2:30am
  slot Monday to Friday: its carried round ended, it played one whole round of
  its own and part of another, five multi-part stories aired with their parts
  in a row, and nothing came back sooner than 74 stories, the minimum (half
  of 148) - 78 before step 4 changed the round hash. 0 violations.
- **A range change mid-round**, on a copy: Kim Possible's weekend Shuffle set
  to no Season 1 continues the rest of its old round without Season 1 (63 of
  the 82 left), none of its 106 airings is Season 1, and none of the 63 had
  aired earlier in the round.
- **Live**, on the preview: channel 3, Saturday's Kim Possible Shuffle slot
  set to no Season 1 in the season panel, Create Lineup, Update Channel at
  8:29pm. The schedule saved the range and 156 records; Kim Possible's no-S1
  record is the rest of its old round (64); none of its 54 airings is Season
  1; no airing carries a Shuffle number; the audit finds 0 violations over all
  19 shuffle positions; regenerating from the saved file continues 156/156.
  The first attempt ran on a preview started before rounds existed - its
  generator was still step 2's, and the lineup it saved had Season 1 airings
  in the no-S1 position and 1,197 Shuffle numbers. A server keeps the code it
  started with (see "A long-running server keeps serving the build it started
  with"); rebuilding the bundle only refreshes the editor. The preview was
  restarted and its copy of channel 3 restored before the run above.

**Step 4, Oct 9, 2026** (33d070e..). Proofs on the fresh copy of 8:23pm
Central.

- **What shipped.** Rerun positions in both generators: Shuffle's rounds over
  the slot's range, passing over any story not every part of which the show's
  Play Next has aired - asked afresh at each pick from the live Play Next
  positions and the records of ones no longer in the schedule. With nothing of
  its range aired, or no Play Next at all, it plays as a Shuffle (Ron's
  fallback), and the editor says why under the slot. The Time Slots editor
  offers Rerun, with season settings.
- **Two defects found and fixed while building it.** The round hash first
  ordered by FNV-1a alone, which follows a key's last characters: Plex keys
  run in sequence, so a round came out close to the files' own order (rank
  correlation 0.8), Shuffle's included - murmur3's 32-bit finaliser on top
  brings it to -0.07. And what goes last in a Rerun's next round is now the
  later half of what it actually aired, as the design says, rather than of its
  round's whole order: with a pool smaller than the show, the two differ, and
  over 50 seeds the first let a story return too soon 97 times. A Rerun's
  record therefore also carries what it has aired this round.
- **On a copy of channel 3 with Kim Possible's, Lizzie McGuire's, Even
  Stevens' and The Proud Family's weekend Shuffles set to Rerun**, regenerated
  Monday Oct 12 for a year: no Rerun airing is ahead of its strip (0 of 409),
  and the pools grow through the year - Kim Possible 4 to 84 episodes, Lizzie
  McGuire 4 to 63, The Proud Family 4 to 50, Even Stevens 24 to 63. The audit
  finds 0 violations over all 18 shuffle-family positions, a Rerun's round
  measured by what it aired. Regenerated again from that output at Jan 11,
  2027: every position continues exactly (155/155), and every Play Next and
  Rerun position airs exactly what the October lineup had from then on - 141
  positions, 13,369 airings, none different.
- **Live**, on the preview restarted with this code: the editor offers Rerun;
  Kim Possible's Saturday slot set to Rerun with only Season 4 shows "Plays as
  a Shuffle for now: this show's Play Next hasn't aired any of these seasons
  yet" under the slot, and no note with all seasons. Saved with Yin Yang Yo!'s
  only slot also switched from Play Next to Rerun: 157 records, Kim Possible's
  Rerun 0 ahead of its strip (pool 2 to 84 episodes), 0 violations over 20
  positions, no console or server errors. Yin Yang Yo! has a single episode in
  channel 3's lineup, so its Rerun - with its old strip's record saying
  nothing has aired - plays that one episode as a Shuffle every week. The
  "no Play Next" wording is pinned by test/slot-progress.js: every show on
  channel 3 has Play Next history, kept in records after its slots go.

**Step 5, Oct 9, 2026** (3adb5d4..). Proofs on the fresh copy of 8:23pm
Central.

- **What shipped.** Repeat slots in Time Slots: a slot names its source by
  time, takes its show, and re-airs the episodes that started in the source's
  latest occurrence before it - found by wall-clock time, so the Nov 1 change
  in between moves nothing - labelled `repeat`, so it never moves a position.
  A source that aired before the new lineup comes from the lineup on air: the
  editor passes the last period of it (`slotProgress.recentAirings`, read back
  round the loop, never from before that lineup was made). A source with
  nothing in it plays a Rerun of the show. In the editor: "Repeat a slot" in
  the Order menu, a picker listing every slot that isn't itself a Repeat with
  how far back it is ("Thursday 6:30pm That's So Raven - 2 days earlier",
  "earlier the same day, 30 minutes before"), retiming a source moves its
  Repeats with it, and a Repeat with no source - or one gone or turned into a
  Repeat - is marked at once and holds up Create Lineup, saying why.
  `progress-audit` checks every Repeat occurrence against its source.
- **Channel 3's That's So Raven**, Saturday 6:30pm repeating Thursday 6:30pm
  and Sunday 5:00pm repeating Friday 6:00pm, regenerated at Fri Oct 9 10am:
  Saturday Oct 10 airs S01E01 "Mother Dearest" - Thursday Oct 8's, read from
  the lineup on air round its loop - and Sunday Oct 11 S01E02 "Test of
  Friendship", Friday's from the new lineup, then S01E03 and S01E04 the next
  weekend, as previewed above. Over the year, 103 of 104 Repeat occurrences
  equal their source and the 104th is that first Saturday: 0 mismatches.
  Regenerated again from that output at Monday Oct 12, the Thursday-Friday
  strip continues exactly (S01E03 next, 154/154 positions) and all 102 Repeat
  occurrences equal their source.
- **Same day, channel 1:** Friday 1:00am repeating Thursday 9:00pm (Pokémon):
  45 of 45 occurrences equal their source; 138/138 positions continue.
- **The fall-back night:** a 1:00am Repeat of Saturday's 9pm airs at 1:00 CDT
  and again at 1:00 CST, both times Saturday's episode
  (test/dst-fall-back.js).
- **Live**, on the preview restarted with this code: That's So Raven's
  weekend slots set to Repeat through the picker and saved at 11:45pm - the
  first weekend from history ("Mother Dearest", "Test of Friendship"), 102 of
  the other occurrences equal their source, 0 mismatches, no errors.
  Retiming Thursday to 6:15pm moved Saturday's source to "Thursday 6:15pm";
  deleting Thursday marked Saturday "The slot this repeated is gone - choose
  another" and Create Lineup was refused with that reason. Three editor bugs
  found that way and fixed: deleting a slot didn't refresh its Repeats until
  Create Lineup; a gone source dropped out of the picker, so the select cleared
  the slot and the message changed to "Choose the slot this repeats"; and a
  reopened schedule drew its Repeat pickers before their options existed, so
  saved sources showed blank - and could have been cleared - until an edit.

**Step 6, Oct 9, 2026** (e51f0d1..). Proofs on the fresh copy of 8:23pm
Central.

- **What shipped.** Ordered shuffle positions in both generators: a round is
  Shuffle's hash order over the stories of every series - a series being an
  item's show title, its order the custom show's list, its multi-part stories
  grouped within it - and the k-th slot falling to a series plays that
  series' k-th story. The record is Shuffle's. The Time Slots editor offers
  "Ordered shuffle (N series)" only for a show whose items join two or more
  series; `progress-audit` checks each series' list order and each whole
  round's counts. A range change starts its rounds afresh rather than
  carrying the old round.
- **Channel 1's Tom & Jerry**, its nine slots set to Ordered shuffle on a copy
  and generated for a year: 990 airings in five rounds, three of them whole,
  each whole round airing exactly the four series' sizes - Tom and Jerry 164,
  The New Tom & Jerry Show 48, the stray "The New Tom & Jerry Show 15 - Cosmic
  Cat and Meteor Mouse (1975)" 1, The Tom and Jerry Comedy Show 14 - each in
  list order; 0 violations. Regenerated three months in from that output: the
  707 Tom & Jerry airings to the lineup's end are identical.
- **Channel 2's Double Dare Series (Shuffle)**, one weekly slot: its 465 items
  would take about nine years to air one round, so a year shows the shares,
  not whole rounds. With the custom show's items added on the copy (see the
  next entry for why the lineup alone doesn't hold them), the four series
  interleave at random and each stays in list order; their airings over the
  year (17, 14, 11 and 10) track their sizes (an expected 20.8, 13.2, 10.5
  and 7.5 of 52).
- **Live**, on the preview restarted with this code: the Order menu offers
  "Ordered shuffle (4 series)" on Tom & Jerry's slots and not on Johnny
  Bravo's; all nine Tom & Jerry slots saved as Ordered shuffle through it -
  995 airings, three whole rounds of exactly 164/48/1/14, 0 violations, no
  console or server errors.

**Step 7, Oct 10, 2026** (d67c6e1..). Every step's proof again, with the
final code, on the proof copy of Oct 9 8:23pm Central - diffed against
`.dizquetv-dev` at 11:59pm Central and identical (its channel files were last
written at 4:18am), so the copy is current - and on Sep 29's channel 1. Suite
1860/1860.

- **Steps 1-2.** Every position continues exactly at Fri 10am, Sat 11pm and
  Mon 10am - channel 1 138/138, channel 2 164/164, channel 3 155/155, Sep 29's
  channel 1 50/50 - and again from each regenerated file. All That's range
  moved to no S1-7 starts at S08E01, Rugrats' to no S1-6 at S07E04 (the pool's
  first Season 7 episode), and Johnny Bravo's no-S2 slots taken out of Sep 29's
  channel 1 and put back start at S01E34.
- **`--today` no longer reproduces step 1's "before" numbers for Shuffle
  slots.** With no records, this code's Shuffle positions start rounds of
  their own instead of carrying the old shuffler's numbers on, so channels 2
  and 3 lose different positions (Fri 10am 158/164 and 129/155) from the ones
  blocks lost (159 and 147). Play Next falls back to blocks' founder rule
  either way. The table under "What a regeneration lost" was measured on
  blocks' generator and stands; the tool's usage now says what `--today` is.
- **Step 3.** Channel 3's 18 carried rounds are identical to the saved lineup
  through their ends (994 airings), and the audit of Monday's year finds 0
  violations in 18 positions. Boy Meets World's daily copy: five multi-part
  stories in a row in its own rounds, closest return 74 stories, the minimum.
  Kim Possible's no-S1 range: its queue is exactly the rest of its old round
  without Season 1 (63 of 82), in the same order; 0 of its 105 airings is
  Season 1.
- **Step 4.** The four weekend Reruns: 0 airings ahead of their strip, pools
  Kim Possible 4 -> 84, Lizzie McGuire 4 -> 63, The Proud Family 4 -> 50, Even
  Stevens 24 -> 63, 0 violations. Regenerated Jan 11 from that output: 155/155,
  and 141 Play Next and Rerun positions identical airing for airing (13,369
  airings) to where the October lineup's last ten days begin, which are flex
  - Ron's own lineups of Oct 9, made by blocks, end the same way, in 4 to 10
  days of flex.
- **Step 5.** That's So Raven: Sat Oct 10 repeats Thursday's "Mother Dearest",
  from the lineup on air, and Sun Oct 11 Friday's "Test of Friendship"; 103 of
  104 occurrences equal their source and the other is the one from history, 0
  mismatches; Monday's regeneration 154/154 and 102/102 equal. Channel 1's Fri
  1am repeat of Thu 9pm: 45/45 equal, 138/138.
- **Step 6.** Tom & Jerry: three whole rounds of exactly 164/48/1/14, 0
  violations, and the 707 airings regenerated Jan 11 identical. Double Dare:
  the four series interleave, each in list order, 17/14/11/10 airings against
  an expected 20.8/13.2/10.5/7.5.
- **Live checks** weren't repeated. Each ran on the preview with its own
  step's code; what later steps changed under them - the round hash in step 4
  above all - is what the scripted proofs above re-measure.

**The final review, Oct 10, 2026** (7279f2b..). A fresh review of the whole
branch (Opus 5.5) re-ran the headline proofs (all exact) and found four
things worth fixing; three are fixed, each with a test that failed first,
suite 1867/1867.

- **Create Lineup twice in a row lost the weekend's repeats.** The second
  run's history started at the first run's `asOf`, so Saturday's source,
  Thursday 6:30pm, was gone and Saturday became a Rerun - S01E02 then aired
  Friday, Saturday and Sunday. Now each run keeps what it read for the shows
  Repeats repeat (`repeatHistory`, `progress.history`). On the copy, That's
  So Raven regenerated at 10am, 10:30 and 11am Friday: Saturday repeats
  "Mother Dearest" every time, 0 mismatches. Live on the preview, Ron's
  channel 3 with the two weekend Repeats, Create Lineup and Update Channel
  twice at 12:46 and 12:47am Saturday: the first run kept Thursday's and
  Friday's airings, and the second, both sources now before the last run,
  still repeats "Mother Dearest" and "Test of Friendship"; 102 occurrences
  equal their source and 2 come from the kept history, 0 mismatches, no
  errors. That history is genuine: channel 3's lineup was generated Wednesday
  Oct 7 at 2:48am and only re-saved Friday at 4:18am, so Thursday's airing is
  in its cycle.
- **Changing a schedule from daily to weekly moved its Repeats' sources.**
  The clones kept `repeatOf` as it was, so a daily "1am repeats 9pm" became
  seven Repeats of Thursday's 9pm, six of them the wrong evening, unflagged.
  Now each keeps its distance back (`movedRepeatOf`): every day's 1am repeats
  the 9pm four hours before it; going back to daily keeps a distance a day can
  hold and marks one it can't ("gone - choose another").
- **The planner slowed with time since the last run** - every Play Next and
  Rerun position walked the whole lineup since then, twice per regeneration in
  the browser: channel 1 took 265 ms at 30 days, 886 at 120, 2,313 at 250.
  One walk now serves every position: 22, 26 and 47 ms. The January Rerun
  regeneration is identical program for program (37,253) and record for
  record, and every position on the four copies still continues exactly.
- **Narrowing one slot of a shared Shuffle** was the fourth - Ron's to decide,
  decided and built Oct 10; see the next section.
- **At merge, rebuild the bundle and restart the server together.** An old
  server's generator has no case for the Rerun, Repeat and Ordered shuffle
  slots a new editor sends - it picks nothing and Create Lineup fails with an
  error (found by the review, checked in blocks' code) - and a server keeps the
  code it started with (see "A long-running server keeps serving the build it started
  with"). The server on port 18000 is Ron's to restart.

#### Narrowing one slot of a shared Shuffle

Kim Possible's Saturday 3:30pm and Sunday 6pm Shuffles are one position. Set
Saturday alone to no Season 1 and, by rule 4 as decided, the new no-S1
position takes the rest of the old round without Season 1 - while Sunday,
still in the old position, plays that same round. The two then air the same
episodes in the same order days apart all year. Measured on the copy,
regenerated at Monday Oct 12: 39 of the 106 Kim Possible airings repeat an
episode the other position aired in the previous 120 days, 7 within 30 -
S04E04 on Saturday Oct 17 and again on Sunday Oct 18 - where the unsplit
lineup, or both slots narrowed together, has none. `progress-audit` checks each position on
its own, so it doesn't see it. Play Next does the same - both ranges step
through the same episodes from the same place - which is what two ranges of
one show sharing seasons already do, but a Shuffle is meant to look random.

**Ron's rule, Oct 10, built:** a narrowed Shuffle or Rerun slot inherits the
old round only when no slot still plays the old position; when the old one
carries on, the new one starts a round of its own. Play Next is unchanged.
Tested ("narrowing one slot of a shared Shuffle starts a round of its own",
"...and so does a Rerun"), suite 1869/1869. On the copy, Saturday narrowed
alone: the no-S1 position starts round 0 of its own and Sunday finishes the
old round; 17 of the 104 airings repeat an episode the other slot aired in the
previous 120 days (was 39), 8 within 30 (was 7) - now chance, two independent
shuffles of mostly the same episodes, not one order played twice. Both
weekend slots narrowed together still carry the rest of the old round (63 of
82) with none, and every position on channels 1-3 continues exactly.

### Full catalogs, and a never-air list

Designed Oct 10, 2026 (Opus 5.5) from Ron's brief and his decisions the same
day; **not built yet**. Replaces "A regeneration only draws from what the
lineup on air holds", whose finding is the first section below. Branch
`full-catalog`, from `stored-progress`, so the two merge together; build plan
in [docs/full-catalog-plan.md](docs/full-catalog-plan.md).

#### What was wrong

Regenerating Time Slots or Random Slots only draws on episodes already in the
lineup, so a show in a sparse slot shrinks to a loop: Double Dare has 51 of
its 465 items in channel 2's lineup, and its weekly Play Next loops items 2-52
forever. Every source of the generators' pool, traced Oct 10:

- **The channel page** hands the slot editors
  `commonProgramTools.removeDuplicates(scope.channel.programs)` - one copy of
  each episode in the lineup on air - from six places in
  `web/directives/channel-config.js`: the Time Slots button and its re-roll,
  the calendar's slot and day clicks, and the Random Slots button and its
  re-roll.
- **The editors** use that list for the Program menu, for stored progress
  (places, rounds, carried rounds, Rerun notes), for Ordered shuffle's series
  count, and send it to the server (`POST /api/channel-tools/time-slots` and
  `random-slots`) as the episodes the generator may use.
- **The generators** (`time-slots-service.js`, `random-slots-service.js`, via
  `show-orderers.js`) build every position from that list alone.
- **`channel.programs`** holds a whole show only between adding it from the
  library - `plex-library.js` walks show, seasons, episodes; a custom show is
  copied whole, each item stamped with `customShowId` and `customOrder` - and
  the first Create Lineup, which replaces it with the lineup. The Library tab
  (`src/channel-library.js`) is built from the lineup too.
- **A full catalog exists only** in the data folder's `custom-shows` (custom
  shows) and in Plex (Plex shows). The daily backups don't hold it: of the 226
  short shows below, a backup since Sep 27 held all of 19; the rest were
  thinned before backups began.

Measured on the copy of Oct 9 8:23pm Central, still identical to
`.dizquetv-dev` at 2:48am Oct 10, reading Plex read-only with the token the
app stores (sent as a header, never printed or saved):

| Channel | Plex shows short | Regular episodes in lineup / in Plex | Custom shows short | Custom items in lineup / in show |
|---|---|---|---|---|
| 1 | 58 of 123 | 7,845 / 9,863 (20% missing) | 5 of 15 | 1,585 / 2,055 |
| 2 | 107 of 152 | 9,775 / 14,029 (30%) | 5 of 8 | 469 / 1,053 |
| 3 | 61 of 123 | 6,026 / 6,879 (12%) | 4 of 14 | 713 / 872 |

Almost all of it inside the seasons the slots play. The worst: Double Dare
51/465, Married... with Children 51/259, Bleach 46/294, Mobile Suit Gundam
Series 45/223, Naruto 45/219, Beyblade 51/154, Phineas and Ferb 51/140. Also:

- **Whole shows were added.** Channel 2's short shows each hold exactly one
  year from S2E1 (Married... S2E1-S4E8, Wings S2E1-S4E9): a whole show,
  started with "Start from season 2", then everything but that first year lost
  - Season 1 included.
- **Every aired episode is still in Plex under the same key** - 0 exceptions
  on channels 1-3 - so stored progress finds every place unchanged.
- **Each aired episode names its show:** `showIcon` is the show's thumbnail,
  `/library/metadata/<show>/thumb`. The one without (Good Morning, Mickey!) is
  found through its episode's own metadata (`grandparentRatingKey`).
- **Reading every slotted show from Plex takes 2.3-3.9 s a channel** (8 at a
  time). The request to the server would grow from 9-13 MB to 10-20 MB (the
  limit is 50).
- **No custom show was edited since it was added.**
- **Specials:** Plex holds 81, 67 and 8 for the slotted shows of channels 1-3;
  the lineups air 11, 6 and 0 of them - ThunderCats 5 of 6, Pete & Pete 3 of 5,
  The Brak Show 2 of 4, and a few others keep theirs.

#### What Ron decided, Oct 10

1. Episodes he removed by hand must never come back.
2. A per-channel **never-air list** of episodes; the full catalog always
   leaves them out, for Plex shows and custom shows.
3. Before a show starts drawing on its full catalog, a **one-time review**
   lists exactly which episodes would be added, grouped by season, with
   checkboxes and add all / add none. Anything he unticks goes on the
   never-air list. Until a show is reviewed it behaves exactly as today. Only
   shows with something to add are listed, most missing first.
4. **Deleting an episode** in the programming list asks: "remove this airing
   only" or "never air this episode on this channel".
5. A **page** to see and restore never-air episodes.
6. **Specials** count only when the lineup already airs one of that show's
   specials.
7. **New episodes** added to Plex later join automatically, but the Create
   Lineup dialog names them, with a one-click "never air" for each.

And, the same day, after reading the design (the episodes he deleted were
mostly holiday episodes, which he places himself when their time comes, and
specials, mainly ones longer than 30 minutes):

8. Each left-out episode has a **reason**: "Holiday: I'll place it myself" or
   "Never air". Both stay out of the rotation. The Catalog page shows holiday
   episodes in their own section, grouped by holiday (Christmas, Halloween,
   Thanksgiving, Easter, Valentine's and so on), to find them when it's time.
9. The review **pre-unticks** likely holiday episodes by title (Christmas,
   Halloween, Thanksgiving, Easter, Valentine, Santa, New Year and similar),
   marked Holiday, and episodes longer than 30 minutes, the limit adjustable
   on the page; it shows why each was pre-unticked, and nothing is saved until
   he confirms.
10. After 1.0, beside date-aware promos: "Seasonal episodes air themselves in
    their season", with the same date logic.
11. On the 1.0 must list, right after stored progress.

#### The design

**A show's catalog** is read in the editor with the library's own code -
`web/services/plex.js`'s `getNested` on `/library/metadata/<show>/allLeaves`,
so episodes are made exactly as the library makes them (no duration skipped, a
file holding several episodes listed once, `server` removed and `serverKey`
set as `plex-library.js`'s `selectItem` does). A custom show's catalog is its
current item list (`dizquetv.getShow`), stamped as `addCustomShow` stamps it.
Every item takes the show title the channel already uses, so a show renamed in
Plex stays matched to its slots. Season 0 counts only for a show whose lineup
already airs one of its specials - decided once, at its review.

**A show on a channel is either unreviewed or reviewed.**

- *Unreviewed* - every show on every channel saved today. It draws on the
  lineup's own episodes, exactly as now, less anything on the never-air list.
- *Reviewed* - it draws on its full catalog, less the never-air list, from
  every Create Lineup on. Its record keeps where its catalog comes from (the
  Plex server and show key, or the custom show) and the episodes its catalog
  held when last read, so newcomers can be named.
- A show whose catalog has **nothing to add** - every episode already in the
  lineup or on the never-air list - becomes reviewed the first time Create
  Lineup reads it, since there is nothing to decide; from then on it takes new
  episodes too, named as below.

**The review** is on the channel's new Catalog page. It lists every show on
the channel with something to add - catalog episodes the lineup doesn't hold
and the never-air list doesn't name - most to add first. Each opens to its
episodes grouped by season (`S04E09 Title 22:30`), with a checkbox per
episode and per season, and add all / add none. Two kinds start unticked, each
saying why:

- **a likely holiday**, by a word in its title - Christmas (also Xmas, Santa,
  Noel, Yule, reindeer, mistletoe, nutcracker), Halloween (trick or treat,
  jack-o'-lantern), Thanksgiving (pilgrim, turkey day), Easter, Valentine's
  (Valentine, Cupid), New Year, Hanukkah, St. Patrick's (leprechaun), Fourth of
  July (Independence Day), Mother's Day, Father's Day, April Fools', Groundhog
  Day - marked Holiday, with its holiday;
- **longer than the limit** - 30 minutes to start, set on the page - marked
  Never air.

An unticked episode keeps a reason Ron can switch - "Holiday: I'll place it
myself" (with its holiday, which he can change) or "Never air". Saving marks
the show reviewed: ticked episodes join, unticked ones go on the list with
their reasons. Nothing is saved before that click.
A show with nothing to add isn't listed.

**The never-air list** is per channel, one entry per file (`server|key`, the
key stored progress already uses), so an episode stays out of that channel's
rotation through any show - Plex or custom - until restored on the Catalog
page. Each entry has its reason - `holiday` (with the holiday) or `never` -
and keeps the show, season, episode, title, length, when, and how it got
there (review, deleted, new in Plex). Holiday episodes are only out of the
rotation: Ron still places them by hand, and a slot or tool he uses to do it
is untouched by the list. It binds everything that picks an
episode: the pool for every slot (movie slots too), a Repeat - whose source
aired an episode since marked never-air plays the Rerun fallback - and Rerun.
A Play Next place on a never-air episode moves to the next one, as for any
episode that has gone.

**Create Lineup.** When the Time Slots or Random Slots dialog opens it reads
the channel's catalog state and, in the background, the catalogs of every
show with a slot (8 at a time; 2.3-3.9 s measured, usually done before the
click).
The dialog says what it is doing and what it found:

- "New in Plex since the last run" - catalog episodes of a reviewed show it
  had never seen, by show and season, each with **Holiday** and **Never
  air**, which take it out of this run at once (Holiday pre-chosen for a
  likely holiday title);
- shows it couldn't read (Plex off, a show gone, a custom show deleted), which
  fall back to the lineup's own episodes, as today, for this run - it never
  blocks Create Lineup;
- "N shows have episodes to review", linking to the Catalog page.

The pool the generator gets: for a reviewed Plex show, the lineup's own copies
of the episodes it already airs - so what airs now keeps its exact data - and
its catalog's other episodes; for a reviewed custom show, its current item
list in its own order; for every other show, the lineup's own episodes; and
the never-air list taken out of all of it.
Stored progress reads places from the lineup as now; a carried round from the
old shuffler is still rebuilt from the lineup's own list, since that is what
the old shuffler shuffled, and everything else - new rounds, ranges, notes -
uses the catalog. Nothing on the server's generators changes.

**Saving.** The catalog state lives in the channel file, as
`channel.catalog`, but only the new catalog API writes it: a channel save from
the channel page keeps the stored one whatever the page sends, so an editor
open in another tab can't undo a review. Changes made while editing a channel
- a never-air from deleting an airing or from the dialog, each reviewed show's
catalog as Create Lineup read it, and shows found to have nothing to add - are held with the channel's other
unsaved changes and sent after Update Channel; Cancel drops them with the
rest. The Catalog page saves at once. Renaming a Plex server renames its keys
in the catalog state, as it already does in the lineup.

**Deleting an airing** in the programming list asks, for an episode,
custom-show item or movie: "Remove this airing only" (as today), "Holiday:
I'll place it myself" (the holiday guessed from its title, changeable) or
"Never air this episode on this channel". Either of the last two removes this
airing, adds the episode to the list, and says how many other airings it
still has: the next Create Lineup leaves them out. Flex and redirects delete as now; the bulk tools
(Duplicates, Specials, Show(s), All) don't ask.

**The Catalog page**, `/channels/<n>/catalog`, linked from the channel page
and the Time Slots dialog: "To review" as above; "Holiday episodes", grouped by
holiday and then show, each with its length - for finding them when it's time
to place them; and "Never air", grouped by show. Every entry shows how it got
there, can switch reason, and has **Restore**. A restored episode of a
reviewed show joins at the next Create Lineup; of an unreviewed one, when the
show is reviewed or the library adds it again.

**What it does to Ron's channels:** nothing until a show is reviewed. Then,
for that show, Play Next carries on from its place through the whole show -
Double Dare past item 52, Married... with Children past S4E8 and round to
Season 1 at the end - and Shuffle rounds take in every episode: one that falls
after a Shuffle's place in this round joins it, the rest wait for the next.

#### Shapes

```js
channel.catalog = {                         // absent on every channel saved today
  shows: {
    "tv.Married... with Children": {
      reviewedAt: "2026-10-10T15:00:00.000Z",
      by: "review",                         // or "complete": nothing to add when first read
      specials: false,                      // season 0 counts (decided at review)
      source: { plex: "Thats So Disney/Nick Picks", shows: ["112167"] },
      known: ["Thats So Disney/Nick Picks|/library/metadata/112176", ...],
    },
    "custom.5c8285f1-4235-4fe0-99dd-5a6f50092641": {
      reviewedAt, specials: false, source: { custom: "5c8285f1-..." }, known: [...],
    },
  },
  neverAir: {
    "Thats So Disney/Nick Picks|/library/metadata/112180": {
      showId: "tv.Married... with Children", season: 2, episode: 5,
      title: "...", duration: 1414464, at: "2026-10-10T15:02:00.000Z",
      how: "review",                        // "review" | "deleted" | "new"
      reason: "holiday", holiday: "Christmas",   // or reason: "never"
    },
  },
};
```

```
GET  /api/channel/:number/catalog          -> channel.catalog, or { shows: {}, neverAir: {} }
POST /api/channel/:number/catalog  { ops }  -> applied in order, saved once
  { review:  { showId, source, specials, known, neverAir: [entries] } }
  { neverAir: [entries] }   { restore: [keys] }   { known: { showId: [keys] } }
  { reason: { key, reason, holiday } }
```

`src/show-catalog.js` holds the rules, pure, shared by the editor
(browserify), the Catalog page, the server's ops and the proof scripts: what a
review lists, the pool for a run, what's new, and applying ops.
`web/services/show-catalog.js` does the reading.

#### What this doesn't change

- Channels saved today: no `channel.catalog`, nothing reviewed, and Create
  Lineup gives the same lineup it gives now, program for program.
- The server's generators and the channel file's other fields.
- Movie slots still draw on the lineup's movies - there is no movie catalog -
  less the never-air list. None of Ron's channels has one.
- The Library tab still shows the lineup; the Program menu still lists the
  channel's shows.
- Swapping episodes, plugging library items in anywhere and Flex adjusting
  itself stay the 1.0 item they are; the never-air list is only the "never
  again" half of removing one.

#### Found while designing

- Renaming a Plex server (`fixupAllChannels`) renames every program's
  `serverKey` but not stored progress's references, which carry the server
  name too; a place then falls back to matching by order (season and episode,
  or a custom show's item number). Minor - not fixed here.

### Slot times count from the epoch week, day-parts from the calendar week

Fixed, and documented here because the two systems still coexist and anything
that compares them has to convert.

A weekly schedule's `slot.time` is milliseconds into the **epoch** week.
`localMsIntoPeriod` in `time-slots-service.js` resolves it as
`local % schedule.period`, and 1 January 1970 was a Thursday, so **slot day 0
is Thursday**. That is the whole reason both slot editors list their days
Thursday-first - `time-slots-schedule-editor.js`'s row labels and
`time-slots-time-editor.js`'s day picker are correct, not quirky.

Day-parts and blocks count **calendar** days: an airing's `days` are 0 (Sunday)
to 6, and `day-parts.js` resolves against `Date#getDay`. So the same Saturday
is slot day 2 and calendar day 6.

`src/slot-week.js` is the one place that knows the offset -
`calendarDayOf(slotDay)` and `calendarWeekMs(slotTime)` - and all three
day-name copies now read their labels from its `DAY_NAMES`. Anything drawing
slots on a Sunday-first calendar, or testing a slot's time against an airing
span, goes through it.

**The trap is that getting it wrong looks like a data problem, not a code
one.** The Schedule tab shipped with the two conflated: bands landed on the
right day, slots landed three days off, and the result reads as "this block
isn't lined up with its programming" or "the filler isn't playing" - which
sends you to the channel config and the resolver, both of which measure
perfectly clean. Two checks in `test/blocks-schedule-view.js` pin it now, and
the important one lifts `localMsIntoPeriod` straight out of
`time-slots-service.js` by brace-matching (`liftSource`, now shared from
`test/support.js`) rather than transcribing the formula: what is being pinned
is the *agreement* between that function and the conversion, so a copy that
drifted would keep the test passing while the real thing broke.

### Editing slots when there are hundreds of them

Two decisions in the slot editors are worth stating, because both look
arbitrary until the alternative is spelled out.

**The day picker groups by time of day, not by show.** A weekly schedule is
built by cloning each slot across the seven days, so the rows that mean "this
show, at this time" are the ones sharing a time of day. Grouping by show
instead would sweep in a second, unrelated airing - a show at 08:00 and again
at 20:00 - and there is no way to tell from the data which of those the user
meant. Same time of day is the set the clone actually created, so it is the one
that can be explained in a sentence.

The group opens holding the days that already ask for the same seasons, which
for untouched clones is all seven. Joining a day copies the current range onto
it immediately, so the selection and the stored data never disagree. Leaving a
day is deliberately not destructive: it keeps whatever range it has and just
stops following.

**Rows are addressed by the slot object, never by a template `$index`.** Under
a filter, `$index` is a position in the visible subset, so `deleteSlot($index)`
on the second visible row of a filtered list would delete the second row of the
*full* list. Measured before the change: filtering to the three Friday Aqua
Teen rows and deleting the second would have removed Thursday's 12:30 Futurama
slot instead.

The awkward case is the time editor, which serialises the object it is handed
(`onDone(JSON.parse(angular.toJson(slot)))`), so a slot reference cannot
survive the round trip. `editTime` therefore resolves the real index from the
slot and sends that number, rather than letting the template supply one.

### Time slots have no daylight-saving toggle, and won't

Day-parts and blocks each carry a per-start "shift with daylight saving"
option (see docs/blocks-spec.md's Decisions table); slots deliberately don't
get one. A slot's wall-clock time is meant to stay fixed everywhere, so there
is no boundary case that should shift and nothing to make opt-in.

`localMsIntoPeriod` in `src/services/time-slots-service.js` resolves the UTC
offset per instant rather than once for the whole schedule, which is what
keeps a slot on the wall-clock time it was set to across a change. Following
local time honestly instead of special-casing it has two consequences, both
accepted rather than treated as bugs:

- **Spring forward:** the skipped local hour never occurs, so a slot inside
  it does not air that day.
- **Fall back:** the repeated hour occurs twice, so each slot inside it airs
  twice - on Nov 1, 2026 channel 1's 1:00 slot airs at 1:00am CDT and again
  at 1:00am CST, the 1:30 slot likewise, and the 2:00 slot at 2:00am CST, so
  every later show keeps its clock time. "Twice" means the slot runs again,
  so a Play Next slot airs its next episode, not a rerun. A slot that spans
  the change instead - say one running 12:00-3:00am - has nothing to air
  again, and runs on through the repeat as one block - four real hours for
  the wall clock's three.

The autumn half was not true until 784ae47. The drift correction that stops
a slot overshooting its boundary in spring measured the time to the next
boundary in real time, and 2:00am comes round only once, so the slot on air
when the clock fell back ran on through the whole second pass - three
InuYasha in a row on channel 1. It now stops at the moment the clock falls
back whenever the repeated time belongs to an earlier slot, and the loop airs
that slot again; slot search is one function, `findSlot`, so the loop and
this check cannot disagree about who owns a moment. Stopping there
unconditionally would be wrong for the spanning slot: it would be re-entered
an hour "late", and with lateness at 0 the rest of it would turn to flex
(measured: 128 minutes). `test/dst-fall-back.js` pins both.

Day-parts and block airings replay the repeated hour the same way, so the
filler rules and the programming under them stay paired on the second pass;
a day-part start marked "shift with daylight saving" is the exception, since
it is fixed in standard time and happens once. See the fall-back item in the
1.0 must list.

### The play-time cache is loaded without being awaited

`index.js` calls `initializeProgramPlayTimeDB()` at line 130 without awaiting
it, and the express app is wired up immediately after. A stream that starts
before the load finishes reads an empty cache, so a clip or a filler list looks
like it has never played and its cooldown is ignored for that pick.

Pre-existing, never observed, and the window is the time it takes to read one
small JSON file per remembered program. Worth knowing because per-list cooldowns
now come out of the same store, so the race covers them too - it just widens
what a badly-timed first pick can forget, rather than introducing anything new.

Left alone deliberately. Awaiting it delays server start behind a directory
walk that scales with the number of remembered programs, which on this install
is most of a 39,999 program channel, and the failure it prevents is one slightly
wrong filler pick in the first moments after a restart.

### cleanUpProgram is the one save-path change that can desync the rotation

Also found during the live-edit investigation, and the one real trap in what is
otherwise a safe round trip.

The channel editor's `adjustStartTimeToCurrentProgram` rotates
`channel.programs` so the program playing now sits at index 0 and moves
`startTime` back by the offset into it. Those two cancel exactly **as long as the
cycle length does not change**, which is what makes a reload-and-resave harmless
despite visibly rewriting `startTime` - see the Resolved entry below.

`cleanUpProgram` in `src/services/channel-service.js` runs after that, on the
save, and can change the cycle length two ways:

```js
// a program with no duration, or a non-positive one, is dropped entirely
if (typeof(program.duration) === 'undefined' || program.duration <= 0) return [];
// a fractional one is rounded up
if (! Number.isInteger(program.duration) ) program.duration = Math.ceil(program.duration);
```

Either one moves the cycle after the rotation was computed against the old one,
so `startTime` no longer means what the rotated array needs it to mean and the
whole lineup shifts by the difference. A dropped program shifts it by that
program's duration; a ceil shifts it by under a millisecond per program, which
is harmless in practice but is the same failure in miniature.

Neither fires on any channel in the dev data folder - all four resave with a
byte-identical cycle length, and `test/startTime-rotation.js` checks that,
including a deliberate fractional duration so the trap is visible as a passing
check rather than a paragraph here. Worth knowing because the compensation is
invisible: nothing in the editor or the save path states that the two fields are
a pair, so a future change that drops or rewrites a duration on this path will
look local and will not be.

### Comparators that only work by accident

Left alone deliberately, but worth knowing about if any of this is touched.

Three comparators never return 0 for equal elements, so `cmp(a,b)` and
`cmp(b,a)` both return 1 when two items tie:

- `src/api.js`, channels by number
- `src/services/m3u-service.js`, channels by number
- `web/directives/channel-config.js`, the `a.c` branch

That is formally an inconsistent comparator, but all three sort on values that
are unique in practice, so nothing misbehaves today.

Worse, and more interesting: the one in `src/api.js` runs on the result of
`getAllChannelNumbers()`, which is an array of plain integers, not objects. It
compares `a.number` against `b.number`, both of which are `undefined` on a
number primitive, so it is a complete no-op and always has been. `/api/channels`
is correctly ordered only because the DAO now sorts before it returns. If
someone ever removes that DAO sort believing the endpoint sorts for itself, the
ordering silently breaks again.

### Heavy buffering during playback: `-qscale:v 1` and Windows throttling

Happens on real channels. **Diagnosed Sep 27, 2026, and both causes fixed
the same day - see "Both fixes built and verified" at the end of this entry.
Two causes multiply, and the other streaming server isn't one of them:**

1. **`-qscale:v 1` makes every mpeg2video item 4-8x the work it needs to
   be.** One stream needs 4-5 cores to keep up, and three at once fall
   behind even with the whole CPU free.
2. **Windows at times throttles Syndicast's ffmpegs onto the four E-cores**,
   at most about 1.4 cores for all of them together while the P-cores sit
   idle. A stream then gets 0.13-0.45x realtime.

The other streaming server, the leading suspect before this, measured minor (below). The first
reports, for the record: through `/video` with the dev settings
(`mpeg2video`, 1920x1080, 5000k), about 40 seconds of video in 200 seconds,
twice; the exact command for a 15.1s clip took 66.9s with `-re` and 41.5s
flat out, 2.1s without `-qscale:v 1`; under `libx264` a 14.6s bumper took
17.2s flat out and 38.5s with `-re`. The 100-entry concat restart is not the
cause - its gap is about the size of an ordinary item change.

Each viewer connection spawns its own ffmpegs, not shared ones: `concat()`
in `src/video.js`, behind `/video` and `/radio`, runs one concat ffmpeg per
connection, which pulls its segments back from this server's `/stream`,
where `PlexPlayer` and `OfflinePlayer` spawn one more ffmpeg per program or
filler item. Three viewers are three separate encodes of whatever is on.

**How it was measured.** Scratch servers on copies of `.dizquetv-dev`
(18097-18099), `child_process.spawn` recorded by a `node -r` preload for
the exact commands, and those commands re-run from node the way `spawn()`
runs them, stdout piped and drained, with `-benchmark` added for CPU time.
`/video` delivery counted from the AAC packets that arrived (1024 samples
at 48 kHz, normalized for every item) against wall time. Where runs are
compared, the content is fixed: the same stretch of the same file each
time. Where scheduling had to be held still, each ffmpeg was forced one
way: High QoS (`SetProcessInformation`, execution-speed throttling
explicitly off), EcoQoS, or affinity pinned to the E-cores; `auto` leaves
it to Windows. The i7-12700 has 8 P-cores (logical 0-15) and 4 E-cores
(16-19). Everything ran on `ffmpeg 7.1` (gyan full build), the dev path.

**Each flag removed on its own**, at High QoS so scheduling stays out of it,
two rounds, as multiples of realtime flat out. Sources: Cowboy Bebop S01E09
(1080p Hi10p, pillarboxed) and CN City Bumper (30) (720p) under mpeg2video,
the Adult Swim bumper under libx264:

- Exact command: Bebop 1.47-1.80, CN bumper 2.66-3.43, AS bumper 2.13-2.55.
- **Without `-qscale:v 1`: Bebop 7.18-7.31, CN bumper 7.49-9.68.** The
  whole of the mpeg2 cost - 12s of Bebop is about 60 core-seconds with it
  and 15 without. It asks for quantizer 1 inside a 5000k/10000k rate
  buffer, and still logs `rc buffer underflow` 24 times in those 12s.
- Without `-flags cgop+ilme`: Bebop 2.15-2.33, CN bumper 4.11-5.12, about
  30% (`ilme` is interlaced motion estimation, on progressive sources);
  nothing on libx264. `cgop` can't lose its partner: without
  `-sc_threshold 1000000000` mpeg2video refuses closed GOPs and exits -22.
- `-threads` sits before `-i`, so it sets the decoder's threads; the
  encoder uses ffmpeg's automatic count either way. Removing it changes
  nothing measurable. Moving it to the output side slows libx264
  (1.73 against 2.13-2.55), since that caps x264 at 10 threads.
- `-fflags +genpts+discardcorrupt+igndts`, and `-crf 22` (which mpeg2video
  ignores): nothing.
- **`-re` isn't slow.** Held at High QoS, every `-re` run kept realtime
  (0.96-1.03, the shortfall being startup). The libx264 bumper's "slower
  with `-re` than without" was scheduling changing between the two runs:
  unthrottled it runs 2.5x flat out, throttled 0.99x flat out and 0.93x
  with `-re`.
- Not the buffering, but found along the way: under libx264,
  `-sc_threshold 1000000000` - there to switch mpeg2's scene detection off -
  is x264's scenecut threshold, where larger means more sensitive. The
  bumper comes out with no B-frames at all (1 I, 435 P), and without the
  flag it encodes at 3.5-3.6x instead of 2.1-2.5x.

**Quality with and without `-qscale:v 1`**, VMAF and SSIM against a
lossless reference made by the same exact command with the encoder swapped
for FFV1, so both encodes are scored against exactly the frames the encoder
was given, aligned by frame index. (A first pass against the source file
misaligned every fourth frame and was thrown away.) With, then without:

- Bebop: VMAF 84.88 / 86.06, worst 5% of frames 67.2 / 80.2, worst frame
  55.8 / 77.7, SSIM 0.9844 / 0.9893.
- CN bumper: 96.93 / 96.35, worst 5% 93.0 / 92.9, worst frame 78.3 / 90.7.
- AS bumper (as `spawn()` builds it for mpeg2video): 97.00 / 96.98, and
  within 0.2 on every other measure.

As good on average without it, and better at the worst frames: at Bebop's
frame 35 the `-qscale` encode breaks into visible macroblocks (VMAF 55.8)
where the other stays close to the reference (90.3). The files are smaller
too (Bebop 8.2 against 9.6 MB, CN bumper 4.9 against 6.3), because every
underflow is a frame over budget. What fixed upstream's blocky mpeg2 in
56a4f3f was `-b:v`, added in the same commit, as its own comment says.
Without either flag mpeg2video targets its 200 kb/s default, and scores
61.1 (Bebop) and 79.4 (CN bumper).

**Windows throttling.** Throttled, an item's ffmpeg runs on the E-cores
only. The first `/video` capture on the scratch server showed it plainly:
the item got 2.4 cores for its first few seconds, then 0.5-0.8 for the
rest of 150s, with the E-cores at 100% and the P-cores mostly 5-20% busy.
It reproduces on demand by marking an ffmpeg EcoQoS (0.14-0.17x on Bebop) or
pinning it to the E-cores (0.11-0.26x), and marking it High QoS undid it
every time it was tried, including while an `auto` run beside it was being
throttled (1.52-1.83x against 0.34-0.76x).

When `auto` gets throttled isn't fully pinned down. Where the window state
was recorded, it happened whenever the Claude app's window was minimized or
covered by a maximized one (VSDC Video Editor, Edge), and never while
Claude's window was visible, in front or partly behind a terminal; it also
happened with PotPlayer in front, Claude's state unrecorded. One monitor.
But it is **not** limited to processes started from the Claude app: a
server started through WMI - parent `WmiPrvSE`, no window, outside Claude's
process tree - was throttled just the same, on the same item, a minute
apart. A benchmark started through WMI looked unaffected, probably because
it finished in about 5s, before throttling set in (it lands a few seconds
into a process's life). So the trigger may be the foreground app being
maximized, or the user being away, rather than Claude as such.
Established: it happens here in ordinary use, to a server started either
way, and explicit High QoS prevents it for a single benchmarked command.
Not yet tried: High QoS on the server's own ffmpegs while throttled.

The E-cores are busy before Syndicast starts: 75-79% in an idle sample
with the other streaming server running, 54% with it stopped. By elimination most of the rest
is two minimized OBS Studio windows and Streamlabs, about 2.3 cores by
their counters, which Windows treats as background too. But crowding isn't
the whole of it: with the other streaming server stopped and E-cores to spare, throttled
streams still got about 1.2 cores for one and 1.4 in total for three.

**The other server didn't hold.** Stopping it took idle E-core load from 75-79% to
54%, about one E-core's worth. Same content, same placement, the other streaming server on then
off:

- One stream, High QoS: 0.996 / 0.994.
- Three streams, High QoS: 0.755 / 0.813.
- One stream pinned to the E-cores: 0.345 / 0.422.
- Three streams without `-qscale`, High QoS: 0.995 / 0.993.

Stopping it helped by about a fifth at most, where streams were already
failing, and never turned a failing case into one that kept up. With it
stopped and Claude minimized, one `/video` stream still got 0.26x (12.9s of
video in 49s), and three at once 0.13x each.

**The planned test, one `/video` stream then three**, on channel 1's real
lineup, so what was on is noted:

- Current code, Claude visible, the other streaming server on: one stream 0.96, three 0.99
  each (Attack on Titan S01E09, 932s and 1037s in). Forced High QoS,
  three again, minutes later: 0.72-0.74 each (the same episode at 1190s).
- Current code, Claude minimized, the other streaming server off: one stream 0.26, three 0.13
  each. The WMI-started server a minute after each: 0.34, then 0.18-0.19.
  All four on the same HEVC Main 10 1080p episode.
- Pinned to the E-cores, the other streaming server on, one stream: current code 0.45 (a CN
  Groovies clip), a scratch copy without `-qscale:v 1` 0.98 (an X-Men
  Evolution episode) - different items, so see the fixed-content numbers
  below for the comparison.
- That copy, Claude visible, three streams: 0.99 each.

What's on matters, so the same 20s of Attack on Titan, three copies of the
exact command at once: with `-qscale:v 1` and the P-cores free, 0.75-0.81
each (about 4.3 cores each); without it, 0.99 each (0.7-1.3 cores each).
One copy pinned to the E-cores, the other streaming server on: 0.35 with it, 0.99 without.
Three pinned, the other streaming server off: 0.14 each with it, 0.78 each without. Dropping
the flag alone carries three streams on a free CPU and one stream even
throttled, but not three throttled - that needs both fixes.

**Fix directions, as proposed:**

1. Drop `-qscale:v 1` from `spawn()`'s mpeg2video flags and keep `-b:v`.
   Nothing about it is stored per channel, so no saved channel changes or
   needs rebuilding; every mpeg2 channel's encode gets cheaper, smaller and
   no worse, with the worst frames better.
2. Mark every ffmpeg Syndicast spawns High QoS on Windows. Node has no call
   for it, and how to do it is untested: a small helper per spawn, a mark
   on the server process if children inherit it, or `os.setPriority` if
   priority alone is enough. Needs another run with Claude minimized, which
   can happen with the other streaming server running.
3. Optional: `ilme` costs about 30% on mpeg2 for progressive sources.

There is also a lead for Stage 4 here. A `/stream` item works out where the
channel is from the wall clock. When an item takes longer to deliver than
it lasts, the clock gets ahead of the stream, so the next entry starts
later in the lineup. A short item right after a slow one can then be
skipped entirely. With both fixes in, no item measured below realtime (see
below), so this lead is weaker now - but a machine busy with something
else can still delay an item's start by a second or so.

**Both fixes built and verified, Sep 27, 2026.** 1 and 2 are built, as
separate commits; 3 and the libx264 `-sc_threshold` finding stay notes,
since three streams keep up without them.

1. **`-qscale:v 1` dropped, `-b:v` kept** (fecfd2f). Changed outright, not
   behind a setting. `test/ffmpeg-encoder-flags.js` checks the mpeg2 item
   and offline-screen commands carry `-b:v` and no `-qscale:v`, and that
   libx264 gets neither.
2. **Every ffmpeg marked High QoS** (f8f4dc7), by `src/ffmpeg-qos.js`: one
   PowerShell helper, started with the first ffmpeg and kept for the life
   of the server, is sent each ffmpeg's pid on stdin and calls
   `SetProcessInformation(ProcessPowerThrottling)` with execution-speed
   throttling explicitly off. Called at every spawn - items, filler,
   screens and the concat in `ffmpeg.js`, `ffmpegText.js`, and the
   `-version` check in `ffmpeg-info.js`, which now uses `execFile` so the
   child is ffmpeg and not the `cmd.exe` around it. Off Windows it does
   nothing; if the helper can't start, dies, or a mark is refused, it logs
   one line and stops trying. `test/ffmpeg-qos.js`.

**How the mark was chosen.** Two findings first. A child does *not* inherit
its parent's mark: node marked High QoS, then an ffmpeg it spawned, read
back `control=0` - so marking the server process alone does nothing.
And Microsoft's QoS documentation classifies a process by the window state
of the app it descends from (in focus High, visible Medium, minimized or
covered Low) before anything else; priority only feeds the fallback
heuristic for what that leaves unclassified. Then five candidates, taking
turns in one throttled window (Claude minimized, VSDC in front), each
30s of the Bebop stretch with the *pre-fix* command at `-re`, so a
throttled run falls far behind; realtime is 1.00:

- Unmarked: 0.54, 0.13 - throttling was on.
- `os.setPriority` above normal: 0.78 (its other run had Claude in front
  and doesn't count), about 0.64x for its first 20s.
- `os.setPriority` high: 0.89, 0.97 - about 0.7x for the first 10-15s
  both times, then racing to catch up.
- High QoS (`SetProcessInformation`): 0.98, 0.98. One run was about 0.7x
  for its first 10s and caught up.
- `powercfg /powerthrottling disable /path`, on a byte-identical copy of
  ffmpeg.exe so it could take turns with the unmarked one: 0.88 (the video
  kept up; the process took 3.6s to exit), 0.98 - realtime in every 5s
  sample from the first.

So priority isn't enough, as the documentation predicts. `powercfg` works
as well as the helper, and was smoother at the start in those two rounds,
but it needs an administrator prompt, it is keyed to one exe path - and
the gyan builds unpack to a new versioned folder on every update - and
reading it back also needs administrator rights, so Syndicast could never
notice it had silently stopped applying. The helper follows whatever path
the FFmpeg settings name, travels with the code, and needs no admin.

What the helper costs and how it behaves, measured: about 78 MB for one
PowerShell process, about 1s to start, 12-182ms from an ffmpeg's spawn to
its mark landing (median 40, 71 marks). The first ffmpeg after a server
start waits for the helper to start: 1.4-1.7s in the smoke run, and a
420ms loading screen had finished before its mark arrived (error 87,
deliberately not logged). The script is passed as plain `-Command` text:
this machine's execution policy blocks `.ps1` files, and base64
`-EncodedCommand` is the pattern security tools look for. It reads stdin
until it closes, so it exits with node - checked by calling
`process.abort()` in node, after which the helper was gone. Windows
Security (real-time protection, behaviour monitoring and tamper protection
on, no ASR rules) recorded no detection before, during or after, and
blocked nothing. One thing does get recorded: PowerShell's own automatic
suspicious-script logging writes the helper's script to the
`Microsoft-Windows-PowerShell/Operational` log as a Warning (event 4104)
once per server start, as it does for any `Add-Type` with `DllImport`. It
is a log entry, not a block; avoiding it would take a compiled helper
binary, which is a build step this project doesn't have.

**The live test**, on the real server path: the working tree with both
fixes, on a copy of `.dizquetv-dev` on port 18096, channel 1's real
lineup, Claude minimized throughout (every 5s sample), the other streaming server running - and
itself streaming, its ffmpeg using 0.1-0.7 cores. A `node -r` preload
recorded each ffmpeg's spawn time, the helper's reply for it, and each
item's output with arrival times, so every item's own pace could be
measured from its own start; Syndicast's code ran unmodified.

- *One stream, 150s:* 1.00 (Pokémon S01E08 throughout). *Three at once,
  150s:* 0.997, 0.999, 0.997 - against 0.26 and 0.13 each in the same
  conditions before the fixes. An unmarked control right after: 0.27.
- *Three streams across a whole break*, 5:21:30-5:31:00 - the end of the
  same Pokémon, channel 1's 5:22:45-5:30:00 break, and the start of the
  Powerpuff Girls: 0.998, 0.983, 0.995. Control after: 0.14. 54 items, 17
  of them clips of 5.1-15.7s. Every item delivered its first 10 seconds -
  or all of itself, for the short ones - at 1.01x realtime or better;
  median 306ms from spawn to first audio. 679 of 680 samples of the
  server's running ffmpegs read High QoS. The odd one was a 5.1s bumper
  whose mark the helper had confirmed 71ms after its spawn, read 2.5s later
  during the stall below: most likely read after the clip ended and its
  pid was reused. It ran at 1.36x.
- *The dips were the machine, not throttling.* Twice - 5:28:12-5:28:35 and
  5:30:32-5:30:57, while VSDC, Streamlabs and Explorer were being switched
  between - something outside Syndicast took 10 or more logical processors:
  P-cores 76-93% busy while Syndicast's ffmpegs used 0-6 cores and
  the other streaming server's 0.3, and the per-second sampler itself stalled for 12s and 25s.
  The three items starting in the first window took 1.2-1.5s to first
  audio instead of about 0.3s; in the second, all three copies of Powerpuff
  slipped together by up to 2.2s at 41s in and caught up within about 10s.
  Throttling looks the other way round - E-cores full, P-cores idle - and
  `powercfg` wouldn't have helped with either. One stream ended the 9.5
  minutes 9.6s behind, the other two 1.2s and 2.8s.

So `powercfg` is not added as a second layer: item starts were slow only
while the whole machine was busy, never while marked ffmpegs waited on a
mark.

A measurement trap worth keeping: **Windows reuses a pid within a minute**.
Two items a minute apart both got pid 40368 here, so per-process records
keyed on pid alone mixed them up. Key them on pid plus spawn time.

### A failed generated-card render never falls back to the poster card

Found in the whole-branch review of stage 5 step 9 (NOTES.md, "Generated Next
Time cards for Cartoon Theatre"), Oct 9, 2026. `card-service.js`'s `render`
picks footage or poster mode once, in `sourcesFor`, purely from whether the
movie's own file (or its Plex stream) can be read - never revisited if the
footage-mode ffmpeg render itself then fails for some other reason (a decode
glitch on that particular stretch, say). Such a card stays "failed" on the
Cards page and is retried unchanged every half hour, rather than falling back
to the poster-and-art card the way an unreadable movie already does. Likely
shape: on a footage-mode failure, retry once in poster mode within the same
`render()` call before giving up.

### No save-time check that a card template's ending or music file has a picture

Found in the same review. The Cards page's "Check" button already reports
whether an ending or music file has sound and a picture (`/api/cards/probe`),
but nothing stops a template being saved without using it - and a silent
ending (no video stream) fails every card rendered from that template, not
just a warning. Likely shape: `card-templates.js`'s `templateProblems` (or a
save-time probe in `card-api.js`) rejects an ending or music file confirmed to
have no video stream, the way a missing name already is.

### ffmpeg, ffprobe and the Plex image fetch have no timeout

Found in the same review. `card-service.js`'s `defaultRunner` (ffmpeg/ffprobe)
and its `request()` call for Plex's poster, art and clear logo have no read
timeout. A stalled Plex connection mid-analysis, or a wedged ffmpeg process,
would hang that render forever - and since `scan()` only runs one scan at a
time, no future scan starts either, until the server is restarted. Not fixed
in the review's fix pass: a real fix needs either a hanging process/server to
verify against or new mocking infrastructure, and an unverified change to a
reliability-critical path is a worse risk than the gap it would close. **Part
of 1.0's crash-soak hardening** (the "Random crashes during streaming, caught
by a 48-hour soak" item in the 1.0 list above) - a card-service hang during
the soak should surface this the same way a streaming crash would, and the
fix (bounded timeouts on both) belongs with whatever else that soak turns up.

## Testing notes

### `npm test` runs the blocks suite

`test/` holds the stage 1 verification for day-parts.

```
npm test
```

runs every file in the directory and prints one combined pass/fail count (123
checks as of the fall-back fixes). Nine files:

- `blocks-acceptance.js` - the stage 1 **and** stage 2 rows from
  [docs/blocks-spec.md](docs/blocks-spec.md)'s acceptance tables, transcribed
  into one array, `ROWS`, stage 2's tagged `row(2, ...)` and appended rather
  than started as a parallel file - see the comment at the end of `ROWS` for
  where a future stage's fixtures and helpers go. Stage 2's own fixture
  (`ccn.blocks`) is layered onto the same `ccn` channel object stage 1's rows
  already use, which is exactly what caught the one fixture collision noted
  above: adding a block can change what an *existing* row resolves to, if
  that row's neighbour happens to land inside the new block's airing.
- `blocks-unchanged.js` - the guarantee that a channel with neither day-parts
  nor blocks is unaffected, as self-contained assertions rather than a diff
  against a historical commit (see below), extended for stage 2 to check
  blocks alone and day-parts alone don't intervene on each other.
- `blocks-persistence.js` - the long-break and cooldown-persistence findings
  from the Resolved section below, plus the filler attribution regression.
- `blocks-guide.js` - per-context guide names, driven directly against
  `TVGuideService#getChannelPrograms` rather than `createLineup`, since the
  guide doesn't run through the picker at all (see the Blocks with airings
  roadmap entry above). Its own file because the fixture shape doesn't travel:
  a guide build's program list is a windowed `{start, program}` array it
  builds itself, not the cyclic `channel.programs` the other three files
  drive through `createLineup`.

- `transitions.js` - stage 5 step 1: show keys (a custom show is one show, a
  movie is its own title), finding a break across a run of Flex entries and
  across the lineup's wrap, the four situations and the order a boundary
  assembles in, a missing neighbour contributing nothing, defaults reading as
  empty without writing anything, and `warnAboutTransitions` through
  `validateChannelJson`. Fixtures only; the real-data check is the script
  `scripts/transitions-week.js`.

- `show-match.js` - stage 5 step 2: folding and the vocabulary (episodes,
  custom shows, movies and slot-only shows; Flex and redirects add nothing),
  longest title first, whole words only, one show or a pair in title order,
  aliases, the optional leading "The", which words are and are not learned as
  aliases, the `names` shape and its save-time warning, the alias store's
  reader and writer on throwaway folders under the OS temp directory (reading
  creates nothing and never rewrites an unreadable file; merging never changes
  a word that already means a show), and the service and the real router:
  proposals only, nothing saved, and no POST route. Mutation-checked: a
  reversed sort, a learning rule with its guards removed and an overwriting
  merge each fail it.

- `names-review.js` - stage 5 step 6: phrase nicknames in the matcher, `checkNickname`
  and `nicknameSuggestions`, the screen's grouping, marks, accept-all and save payload, the
  save against real files under the OS temp directory (only the clips named are written, a
  refused save writes nothing, the alias file and other lists are untouched, an empty
  `names` is "reviewed, names no show"), the routes, the overview's order and counts, the
  Plex refresh carrying names, and the preview's "would fit once accepted" hints.
  `test/program-row-heights.js` also checks the filler rows' Names tag (three lengths).

- `names-movies-seasons.js` - movies and seasons in clip names: the name shapes and how each fits a
  program (`src/clip-names.js`), the vocabulary (movies of 40 minutes or more, specials, seasons), the
  matcher's movie, special, season and flag rules, season nicknames and their checks, plan rows on a
  Dragon Ball Z lineup (the most specific clip wins, from the list or its fallback), the screen's logic,
  folder hints and Plex's seasons through a fake client, and the service and routes against real files
  under the OS temp directory. Fixtures only.

- `blocks-schedule-view.js` - `dayParts.weeklySegments`, the function the
  Schedule tab and the Day-Parts strip both draw from: a hand-derived Saturday
  timeline covering every kind of day-part/block handoff, the
  Thursday-has-no-Toonami row, and the January/July daylight-saving
  difference. Also the epoch-week/calendar-week conversion the Schedule tab
  got wrong on first build - see the Known issues entry. That check lifts
  `localMsIntoPeriod` out of `time-slots-service.js` rather than transcribing
  it, so it pins the real agreement and not a copy.

- `startTime-rotation.js` - that the editor's load-time rotation of
  `channel.programs` and its rewrite of `startTime` keep cancelling, so a
  reload-and-resave does not move what is playing. Lifts
  `adjustStartTimeToCurrentProgram` and `updateChannelDuration` out of
  `web/directives/channel-config.js`, and `cleanUpProgram`/`cleanUpChannel` out
  of `src/services/channel-service.js`, by name and brace-matching rather than
  transcribing them - a transcription of the functions whose *agreement* is the
  point would go stale silently, and extraction failing is a loud FAIL. Ends with
  the `cleanUpProgram` trap from Known issues as a check.
- `save-resume.js` - that saving a channel that is playing does not move the
  stream. Drives `channelCache.takeResumeHint` through a `startStream` helper
  that mirrors the sequence `video.js` runs, the same arrangement
  `blocks-guide.js` has with the guide, because the sequence lives inside an
  express handler with no seam to call. It therefore does not prove the wiring in
  `video.js`, only the behaviour that wiring relies on; keep the two in step.

- `channel-save.js` - the save path where the in-memory view and the on-disk view
  could disagree: that a rejected save leaves the committed channel being served,
  and that a read during a write never reports the channel missing. **The one
  file here that touches a data folder**, because both of those are about what is
  on disk and a fixture in memory cannot show either. It makes its own folder
  under the OS temp directory and removes it again, so it still needs no data
  folder of the user's and no running server. Carries a raw-read control, logged
  rather than checked, so a reader can tell whether the concurrency checks had
  teeth on that run without the suite becoming timing-flaky.

- `dst-fall-back.js` - the Nov 1, 2026 fall-back night for everything that
  reads the wall clock: the real slot generator with the clock frozen, the
  guide against playback minute by minute, the XMLTV date format, channel 1's
  own day-parts and airings, shifted and unshifted starts, and weeklySegments.
  **The one file here pinned to a named zone** rather than the machine's own,
  since the instants it tests are US Central's: it re-runs itself in a child
  with `TZ=America/Chicago` when the machine is anywhere else. Covers the
  repeated hour airing its slots again, a slot spanning the change running on
  as one block, and shifted and ordinary day-part starts keeping their real
  order across both the autumn and the spring change.

- `ffmpeg-encoder-flags.js` - that mpeg2video gets `-b:v` and no
  `-qscale:v 1`. Drives the real `src/ffmpeg.js` with `spawn` swapped for a
  recorder, like `aspect-mark.js`; it loads its own copy of the module and
  takes it back out of the require cache, since `ffmpeg.js` keeps whichever
  `spawn` it saw when first required.

- `ffmpeg-qos.js` - the High QoS helper: nothing done off Windows, one log
  line when it can't mark, a helper that exits when its stdin closes.
  **The one file here that starts a real process**: on Windows its last
  check runs the real PowerShell helper against a real child, which is
  what proves the C# in the script compiles.

- `lookahead.js` - a break handed over early is counted from its real
  start: the hand-off's `startsIn`, the first clip's mix at a boundary for a
  stream 0.5-9.9s early (with the next show 0 and 920ms after the minute, as
  channel 1's real Friday 12:30am one is), and the break's honest length.

- `lineup-cursor.js` - the cursor's rules, then a simulated viewer making
  the same calls as `/stream` (keep it in step with `video.js`, as
  `save-resume.js` is) over 18 hours of 5, 10 and 15s items around 60-300s
  and 15s breaks: every program once, in order, from its start. Its control
  - the same viewers without the cursor - must show repeats, or the check
  proves nothing; it shows about 140 repeats and 57 skips a run. Item
  lengths jitter from a seeded generator, but the picker's own randomness
  isn't seeded, so the counts in its log line vary a little run to run.

- `stream-cursor.js` - the cursor's wiring through the real `video.js`
  router, with `ProgramPlayer` and the concat's `FFMPEG` swapped for
  recorders in the require cache: the stream id on every playlist entry,
  kept across a restart and different per connection, cursors dropped on
  close and on save, a viewer tuning in on the replay cache inheriting its
  item's cursor, and `/stream` following a cursor. It puts the require cache
  back for everything under `src/` it loaded - `aspect-mark.js` failed when
  the real `ffmpeg.js` was left cached with the real `spawn` - and unrefs
  the timers `video.js` arms per item, so `npm test` doesn't wait on them.

- `shared-breaks.js` - the fixes for two viewers taking turns with the offline
  screen (see Resolved): a list on the air not cooling down, on `createLineup`;
  `shared-breaks.js`'s `decide` rules; and viewers on a fake clock through the
  real router (two 3s and 25s apart, a tune-in joining partway, a break with
  steps, a save dropping the lists, a lone viewer, and leftovers under and over
  30 seconds). A trap: the cursor store sweeps cursors idle for an hour by the
  clock it reads, so set the fake clock before setting a cursor by hand, or the
  next request sweeps it away and the viewer silently takes the replay cache.

- `transitions-editor.js` - stage 5 step 5, the logic behind the card editor
  (`src/transitions-editor.js`): the four ways a step chooses and the stored fields
  each is, the days / chance / "only when" rules the form keeps, deleting a watched
  step, the one-sentence summary and the chip word for word, what is wrong with a
  step, the draft-to-stored round trip (an untouched context unchanged, no key added
  for no step, form-only fields stripped, what is stored passes the save-time
  warning), the Flex tag (first row out, last row in, days, "?" and brackets, nothing
  for a channel without steps, every assembled step named once across a break's rows),
  the preview (grouped as the card sees its situations, equal to `buildPlan` for every
  break, flex arithmetic, left-out steps and why, chance rolled as playback rolls it),
  and the suggested-names overlay. Fixtures only.

`lineup-cursor.js`, `stream-cursor.js`, `transitions.js` and the stage 5 rows
of `blocks-acceptance.js` also cover step 4: phases, tune-in placement, one
plan per break through the real router, `hasSteps`, and the three stream
timing rows. See the Step 4 entry in the Blocks system roadmap.

The first two of those also take channel JSON paths on the command line and
re-run their measurements against real channels, which is where they were
developed:

```
node test/startTime-rotation.js .dizquetv-dev/channels/2.json
node test/save-resume.js .dizquetv-dev/channels/2.json
```

The committed checks run on fixtures only, so `npm test` stays self-contained on
an install with no data folder.

`test/support.js` holds the shared fixtures, builders, the `Suite`
check/report harness, and `liftSource` - the brace-matching extractor two
files now use to drive real production functions instead of transcriptions of
them. `test/run.js` is what `npm test` calls; it requires each
file above and aggregates their results. Nothing here runs ffmpeg or a
server (`ffmpeg-qos.js` starts PowerShell and a node child on Windows, and
nothing else does), nothing reads the data folder this install actually uses - `channel-save.js`
makes and removes its own under the OS temp directory, and is the only one that
touches a disk at all - and there is no test runner dependency to install: it is
plain Node, in keeping with the rest of the project having none either. Each file also runs standalone, e.g. `node
test/blocks-acceptance.js`, while developing just that piece.

### Checking a regeneration on a copy: `progress-check` and `progress-audit`

Two scripts prove a scheduling change on real data without a browser or a
server; every stored-progress proof under Known issues was made with them.
Both read only the files they are given and write only `--save`: run them on
a copy of the data folder, never on `.dizquetv-dev` itself.

- `node scripts/progress-check.js --data <copy> --channel <n> --at <ISO>` runs
  the editor's Create Lineup path directly - the lineup rotated to `--at` as
  the editor rotates it, `removeDuplicates`, the planner (the records the
  editor would send), the Repeat history, and the real Time Slots generator
  with `Date` frozen at `--at` - then compares, per position, the saved
  lineup's next episodes over three weeks with the regenerated one's:
  `continue exactly: N of M`, listing the positions that jump.
  - `--edit <module.js>` changes the schedule first, as an edit in the dialog
    would: a module exporting `(schedule) => void`.
  - `--save <out.json>` writes the regenerated channel and `--from <out.json>`
    reads one back - how "twice in a row" and "three months in" are run.
  - `--show <regex>`, `--airings <regex> --days <n>` and `--all` list more.
  - `--add-custom <id>` adds a custom show's whole item list first, as adding
    it from the library does - the lineup alone holds only what it aired (see
    "Full catalogs, and a never-air list").
  - `--today` skips the planner. With no records Play Next falls back to the
    founder rule, as blocks did, but Shuffle starts rounds of its own, so it
    reproduces blocks' Play Next losses and not its Shuffle ones; those need
    blocks' code (`git show blocks:<file>` into a scratch directory).
- `node scripts/progress-audit.js --channel <saved.json> [--show <regex>]`
  checks a whole saved lineup against the shuffle rules, for every Shuffle,
  Rerun and Ordered shuffle position: each whole round has each story once;
  nothing comes back within half a round (for a Rerun, half of what it aired;
  Ordered shuffle makes no such promise); a multi-part story's parts air in a
  row; a Rerun is never ahead of its strip; each Ordered shuffle series airs
  in list order. It also checks every Repeat a slot occurrence against its
  source. `audit()` is exported for other scripts.
- A round carried over from the old shuffler finishes in the old order, so the
  audit doesn't measure the gap between two parts of one story inside it. A
  whole round needs both its ends inside the lineup, so a big show in a weekly
  slot (Double Dare's 465 items) shows its shares in a year, not its rounds.
- Comparing two lineups airing for airing - a regeneration three months in
  against the first - is a few lines over `slotProgress.airings` grouped by
  position, and isn't committed. Compare up to where the shorter list ends: a
  year's lineup ends in days of flex, blocks' lineups as much as these.
- A preview server keeps the code it started with: restart it after a change
  to server code before a live check, or the check runs the old generator (the
  first step 3 live check did).

### createLineup can be exercised directly

`helperFuncs.createLineup(programPlayTime, obj, channel, fillers, isFirst, t0)`
is exported and has no I/O of its own, so filler selection can be tested without
playback, ffmpeg or a real channel. Pass a stub for `programPlayTime` exposing
`getProgramLastPlayTime(channelId, programKey)` and `update(channelId,
programKey, t)`, an `obj` of `{timeElapsed, program, programIndex}` where the
program is `{isOffline: true, duration}`, and fillers shaped
`{id, content, weight, cooldown}`.

`t0` is the instant the decision is being made at, and `programIndex` addresses
`channel.programs`. Both only matter on a channel with day-parts: the resolver
uses `programIndex` to find the program after the break and takes its context.
Omit `t0` and it defaults to now.

Two things make measuring proportions awkward, and both have a way round.
Passing `isFirst` true disables the longest-idle branch, which leaves the list
weights governing on their own - that is how the 70/30 and 95/5 mixes in the
stage 1 acceptance table were confirmed to land on exactly 70/30 and 95/5. And
naming every clip after the list it belongs to makes a pick's true owner
unambiguous, which is what caught the attribution defect below.

These builders - `clip`, `show`, `flex`, `mix`, `freshStore` - are not just
prose convention any more; they are the literal functions in
`test/support.js`, shared by every file in the suite above.

### Comparing a filler change against the version before it

The picker is auto-seeded, so old and new cannot be compared call for call.
Three things together are enough to show a change did not disturb channels it
was not meant to touch, and all three were used for day-parts:

- An **exact-equality** case. One list, one clip shorter than the break, and
  `isFirst` false leaves nothing random in the pick, so the emitted item must
  match field for field.
- A **distribution** comparison at large N. 40,000 picks against the previous
  commit's `helperFuncs.js` and `channel-cache.js`, extracted with `git show`
  into a scratch directory, agreed within 0.22 points on every clip.
- An **identity** check on the input. `dayParts.allFillerCollections` returns
  the channel's own array by reference when there are no day-parts, so the
  picker provably runs on the same object it always did.

Running it a few hundred times and counting titles is enough to characterise
the picker statistically. That is how the 1.6.0 filler algorithm was verified:
600 lineups showed every pick going to never-played clips, and once all had
played, the longest idle took 67 percent against 33 for the next.

The committed `test/blocks-unchanged.js` proves the same three guarantees but
does not keep the git-show comparison itself. Pinned to a commit, it would
either go stale as history moves past it or break outright if that commit
were ever rewritten, to reprove something that only needs proving once per
change to this code path, not replayed on every future `npm test`. It keeps
the exact-equality and identity checks as they were, and replaces the
distribution diff against old code with a tolerance-banded check against the
configured weights instead - a smoke test that day-parts hasn't disturbed the
picker, not a restatement of the picker's own statistical behaviour, which the
acceptance suite's weight rows already cover.

## Model guide

Which model to hand a piece of work to. This is a cost and quality split, not a
statement that one model cannot do the other's job.

**Opus 5.5 is now used wherever this guide says Opus 5.** The split and the
reasoning below are unchanged; only the specific model behind the "Opus" half
moved forward a version.

### The default split: investigate on Opus 5, implement on Sonnet 5

Investigation is where a wrong answer is expensive, because everything built on
top of it inherits the mistake. The season work is the example: its value was
almost entirely in the reading - finding that `getShowOrderer` cached the
orderer on the show and silently ignored the constraint after the first call,
and that Play Next has no stored cursor to preserve. Once that was written
down, the change itself was mechanical. A wrong read would have produced a
confident, working implementation of the wrong thing.

So: **Opus 5 to investigate and to decide the shape. Sonnet 5 to build it once
the shape is settled and written down.** The handover point is a design that
names the files, the data shape and the verification - roughly the level of
detail the reports in this file carry.

**Haiku is not used on this project.**

### Work that stays on Opus 5 end to end

Some items cannot be split, because the implementation *is* the design - the
first real decision is made in the code, and there is no settled shape to hand
over. These stay on Opus 5 for both halves:

- **Per-position stored progress.** The representation is the whole problem.
  See its entry above: the key, the labels and the records are one decision,
  made once for every mode.
- **Shuffle, rerun, repeat a slot and ordered shuffle.** They depend on stored
  progress and inherit the same decision.
- **Very short items repeating or being skipped next to Flex.** A diagnosis
  problem in the concat or transition handling, with no reproduction yet. The
  roadmap entry already says guessing at the layer here would be expensive.
  Reproduced and diagnosed Oct 1, 2026: it is how `/stream` picks each item,
  not the concat. The fix, a per-stream lineup cursor, is itself the design
  decision, so it still stays here.
- **Random crashes during streaming.** Intermittent, no reproduction, so it is
  diagnosis all the way down.
- **The Blocks scheduling core.** The original reason for the fork, and it has
  to attach to the existing lineup pipeline without disturbing slots, filler or
  the orderers. The surrounding UI is ordinary work and can go to Sonnet 5 once
  the core is settled.

The common thread: reach for Opus when the risk is *choosing wrong*, not when
the work is merely large.

### Fable 5.1

Fable costs extra on the Pro plan, so it is not part of the normal rotation.
Reserve it for at most a single Blocks design pass - the one session where the
shape of the whole system is being decided and a better answer pays for itself
across everything built on it afterwards. Not for implementation, not for
investigation that Opus 5 already handles well.

## Resolved

Kept here rather than deleted because every file involved is in the conflict
set for the pending 1.7.0 merge, and this will need re-applying.

### Two viewers of a channel took turns with the offline screen

Reported Oct 7, 2026: with channel 1 on TiviMate and on OBS (a VLC media
source) at once, only one of them got commercials during a break and the other
showed the fallback picture, the two swapping back and forth; shows played
normally on both. Even with "one viewer" the fallback picture played far too
often. Fixed on branch `shared-breaks` in three commits, Oct 7, 2026 (Opus 5.5).

**The cause, and the only one.** A play time is recorded as the moment the item
will *end* (`recordProgramPlayTime`: `t0 + remaining`). The picker's list check
measured "time since this list last played" from there, so while a clip from a
list was on the air for one viewer the time was negative, and
`timeSince + SLACK >= cooldown` refused the list - even at cooldown 0 - until 10
seconds before that clip ended. Most of channel 1's mixes are one list with no
cooldown, so the second viewer found nothing, got the offline screen for exactly
the rest of the first viewer's clip (`minimumWait`), then both asked again at
the same moment and whoever was first had the list. That is the swap.

**Measured before changing anything.** Every Flex pick and every fallback logged
with its reason, by a `node -r` preload on a scratch server from the worktree
(port 18140, on a copy of `.dizquetv-dev`; the repo's code ran unmodified), and by
a fake-clock simulation through the real `video.js` router on the same copy
(channel 1 and its real lists, seeded picks, 0.3-2.0s start-up latency less up to
0.4s of read-ahead per item, the spread stage 4 measured). Both instruments are
investigation scripts in the session scratchpad, not in the repo.
- *Live, two `/video` streams of channel 1, one 8-minute Adult Swim break:* V1 6
  fallbacks (169s of fallback picture), V2 9 (233s), every one "the only list is
  on the air for the other viewer"; the lead changed 8 times; 0 of 12 commercials
  shared. Both played the same stage 5 steps, because plans were already shared.
- *Simulated days, two viewers 23s apart:* Wednesday 43% and 39% of Flex picks
  were fallbacks (2.4h and 2.1h of fallback picture), Saturday 21% each (2.2h and
  1.9h); 0 of 337 and 0 of 557 commercials shared.
- *One viewer:* 0 fallbacks in a simulated Wednesday and Saturday (three seeds),
  and 0 with a dropped connection about once an hour (the replay cache absorbs a
  quick reconnect). Live, real items ended 0.3-0.5s after their recorded end, at
  worst 0.27s early, nowhere near the 10s that would block a list.

**The suspects, ruled out with counts.** Clip cooldowns: with
`fillerRepeatCooldown` 0 they only stop the other viewer's current clip being
picked twice; 0 fallbacks. The replay cache: once a day, at the second viewer's
tune-in, handing over the show; 0 fallbacks. The stage 4 cursor: 0 times it gave
up, 0 breaks passed over, and it keeps two viewers 3-6s apart at each break (15s
at most). Stage 5 steps: their own lists, a shared plan; 0 fallbacks. A gap
shorter than any clip: never on its own on channel 1 (its shortest clips are
4-10s and under ~10s left is already skipped), 7-12 a day only where cause 1 also
held the other list. CN Groovies' 20-minute cooldown showed up beside it in
Powerhouse Era and never caused a fallback alone.

**"One viewer" was two, as far as the server could tell.** At 4:33am that day the
live server on 18000 had two `/video` streams of channel 1 open (concat ffmpegs
started 3:28am and 3:53am), with OBS connected; read from the process list, nothing
touched. An OBS media source can keep pulling a stream from a scene that is not
showing. So count the viewers before trusting a description of them: the concat
ffmpegs' `-i .../playlist?channel=N&...&stream=<id>` arguments say how many there are.

**The fix, three commits.**
1. *A list whose clip is still on the air is not cooling down* (d511032,
   `helperFuncs.js`). A last-played time in the future counts as now in the list
   check, so a list with no cooldown is never refused for another viewer's clip;
   a configured cooldown still runs from the clip's end, and the wait the offline
   screen is given is still measured from there. The clip check is unchanged, so
   the clip on the air is still never picked twice at once (`timeSince <= 0`
   excludes it). On its own this removed every simulated fallback (488 and 289 a
   day to 0); it is the net under the next one.
2. *One list of Flex picks per break, per channel* (3be308f,
   `src/shared-breaks.js`, `channel-cache.js`, `lineup-cursor.js`, `video.js`), the
   way stage 5 shares a break's plan. Each Flex entry of the lineup, each time
   round the cycle (keyed by its index and where it starts), keeps its picks: the
   first viewer to need pick k makes it with the picker as before and its play
   times are recorded then, once; every other viewer plays pick k next, from its
   start, marked `sharedPick` so `recordPlayback` records nothing again. The
   cursor carries `pick`, how far into the list the stream is (0 on entering a
   Flex entry). A viewer for whom a shared pick no longer fits what is left (it is
   later than whoever made it by more than SLACK) picks its own for the rest of
   that entry. A stream with no cursor (tune-in, `/m3u8`) joins the pick on the air
   partway, as the replay cache already did, and a tune-in's own random-start
   clip is never shared. The decision is taken after the last `await` in
   `streamFunction`, so a second viewer's request cannot slip in between reading
   the list and adding to it. Dropped on save and an hour after the entry, like
   plans. A commercial continued from the replay cache is also marked as already
   counted, for the same reason.
3. *A leftover under 30 seconds with nothing to fill it ends the break*
   (4dab300, `video.js`, `TINY_LEFTOVER` in `constants.js`): a Flex request that
   would show the offline screen with under 30s left - no clip short enough, or
   the short ones on their cooldown (one step wider than proposed, matching "no
   fallback picture at all" for a tiny gap) - takes the same route as the old
   short-break skip: the show after the break, or its in steps, start from their
   beginning that much early and the next break absorbs it. A longer gap with
   nothing to play keeps the offline screen, since a stream a minute early falls
   off the cursor. Channels with a fallback clip are unaffected: they never get
   the offline screen from the picker.

**Verified.**
- *Simulated days, final code, two viewers:* 0 fallbacks on Wednesday and
  Saturday. Every break had the same commercials in the same order for both; none
  differed before its last clip, and 29 of 69 (Wednesday) and 19 of 52 (Saturday)
  differed only there - the viewers are a few seconds apart, so one has time for
  one more clip, or its last shared pick no longer fits and it picks its own.
- *One viewer, old (98a252d) against new, same seed:* identical item for item on
  channels 1, 2 and 3, a Wednesday and a Saturday each (497 to 835 items a day).
  Control: another seed differs from item 3.
- *Live, final code (4dab300), scratch server on a fresh copy:* two `/video`
  viewers 23s apart from 5:52am, a second pair 17s apart from 6:06am. The 5:56
  break (Adult Swim leaving into Powerhouse Era, with its sign-off step): the same
  step and the same 8 commercials for both, in order. The 6:22 break opened with
  all four on the same commercial; the second pair then matched clip for clip
  through all 13, though real Plex start-up put one of them 9s behind for a clip.
  No offline screen in any break; both pairs started the next show within 2s of
  each other.
- *Tests:* `test/shared-breaks.js`, 40 checks: B on `createLineup`, the `decide`
  rules, and viewers on a fake clock through the real router (3s apart, 25s
  apart, a tune-in joining partway, a break with steps, a save dropping the lists,
  a lone viewer, and the three leftover cases). 1,253 to 1,293 tests.
  Mutation-checked: the clamp, the wait from the clip's end, replaying at all, the
  fit check, the join, recording shared picks again, the cursor losing its pick
  in three places, ignoring the shared item, the leftover rule and its limit each
  fail checks. One line is unobservable and kept as intent: after a new pick finds
  nothing, the cursor stays at that index, which `decide` would arrive at anyway
  since it treats a pick past the end as "make the next one".
- *Writers enumerated* (the rule for this kind of change). Play times:
  `recordProgramPlayTime` (now skipped for a `sharedPick` item) and the redirect
  error record in `video.js`. `sharedPick`: `decide` (replay and join) and
  `getCurrentLineupItem` (commercials). `cursor.pick`: `cursorAfter`, from the
  `pickNext` that only `video.js` sets; `withPick` in `nextEntry`/`flexFrom` carries
  it. The lists: `addFlexPick` only, cleared by `saveChannelConfig` and `clear`.

### A concat restart replayed the tune-in, loading screen included

Fixed in 1634bef. `/video` and `/radio` run one concat ffmpeg per viewer over
a 100-entry `/playlist`. When it runs out, `concat()` in `src/video.js` calls
itself with `step+1` to fetch the next one - an upstream workaround (92cd5ec)
whose own commit message calls the seam "sort of glitchy". The URL it built
ended `stepNumber={step}`, with no `$`, so `/playlist` parsed the literal
text, got NaN, and fell back to 0. Every restart was built as a tune-in.

What that did, measured on a copy of `.dizquetv-dev` running a scratch copy
of the code with the playlist cut to one entry, so a restart came every
minute or so:

- **The loading screen played again at every restart** - 420ms of the
  loading card, mid-channel. The log showed `raw={step} parsed=0` and then
  `Title: Loading Screen` at each one.
- **The next entry was `first=1`.** For a program that changes nothing. In a
  break, `createLineup` then takes a clip of any length, skips the
  longest-idle preference, and starts the clip partway in, so a tune-in
  doesn't always open on the start of a commercial. Seen live: a restart
  started Star Fox Command 3.65 seconds into the clip.

With the fix the restarts asked for steps 1, 2 and 3 and played neither.
`/playlist` itself is unchanged. On channel 1 and on the scratch channel,
step 0 and the literal `{step}` give byte-identical text (loading screen,
`first=1`, 99 plain entries, 100 `between=1`), and steps 1 and 2 give 100
plain entries and 100 `between=1`. Step 0 is every tune-in, so tuning in is
exactly as before.

**How often a real channel hits it.** Each `/stream` is one entry: a program
or a single filler clip. Channel 1's saved lineup, walked through the real
`createLineup` for Oct 19-25, is 811 entries a day - 454 programs in the
week against 5,226 filler clips (28.8s mean). With preludes off, as in
`.dizquetv-dev`, `/stream` serves every `between=1` entry as a real item, so
one playlist is 200 items: a restart every 6.4 hours per viewer (3.5 to
7.9), about four a day. With preludes on it would be 100 items, every ~3
hours. 26 of that week's 28 restarts landed on a filler clip, because most
entries are filler, so the `first=1` pick was the usual case.

**Whether it looks like buffering.** The fix takes the loading card out of
the seam, not the seam itself. A restart is a new ffmpeg process, so the
stream's timestamps start over (29.1s back to 0.03s in the capture), and
nothing flows while it starts up: about 1.3 seconds at each restart unfixed
and 0.4 to 4.1 seconds fixed, against 0.3 to 2.3 seconds at ordinary item
changes in the same captures. Within the noise. So about four times a day a
viewer's player gets a short gap and a timestamp reset. Whether that shows
as a stall depends on the player, and it hasn't been tried on TiviMate. It
isn't the heavy buffering: see "Heavy buffering during playback" under
Known issues, where measuring this turned up items encoding below realtime.

**Stage 4.** At most a small, rare part. A restart can start a clip partway
(the `first=1` pick above), which could read as "skipped", but only about
four times a day. Nothing in a restart plays an item again, so it can't
explain the "plays about three times" symptom.

**Still to check, for the aspect marking.** That build leans on the loading
screen opening the stream, so TiviMate latches square 16:9. Before this fix
every restart opened with it too; now a restart opens with whatever is on,
usually a filler clip. If TiviMate re-reads the shape at a restart's
timestamp reset, a `'mark'` channel could latch 4:3 there and box every
16:9 show until the viewer retunes. Untested: stream C never ran long
enough to restart. No saved channel uses `'mark'` yet. Test it with a
playlist cut short, as here, before one does.

### The config cache is invalidated on save, not repopulated

`ChannelService#saveChannel` wrote the channel into `channelCache`'s
`configCache` **before** the DAO validated it, so a save the DAO went on to
reject left `configCache[number]` serving a channel that never committed while
the disk still held the old one. `api.js` catches and returns 500, and the
`channel-update` event never fires, so nothing stopped the stream or told
anything else to re-read: the streamer, the guide and the M3U service all served
the rejected channel until the process restarted, and a later successful save of
a *different* channel would not clear it, since `clear()` only runs on delete.

It now does `delete configCache[number]`, and `getChannelConfig`'s existing lazy
load refills from disk on the next read. Invalidating is correct whether the
write succeeds or fails, which is what let the call stay where it is, ahead of
the write, with the playback flush and the resume hints in the same function
untouched.

**The caller enumeration is the part worth keeping.** `saveChannelConfig` has
exactly one production caller, `saveChannel`, so the question was really which
callers of *that* depend on the cache being repopulated. Five: both
`/api/channel` handlers (neither reads back), `fixupAllChannels` in
`plex-server-db.js`, `deleteFiller` in `filler-service.js`, and
`updateChannelSync` in `on-demand-service.js`. None needs the new value handed
back to it, and two of them turned out to be arguments *for* invalidating rather
than against:

- `getChannel` returns the cached object **by reference**, not a copy. So
  `fixupAllChannels` and `deleteFiller`, which read a channel, mutate it and save
  it, had already mutated the cached channel in place before the save was even
  attempted. Reordering the `saveChannelConfig` call would not have fixed those;
  only dropping the entry does.
- `activateChannelIfNeeded` on the on-demand path saves fire-and-forget
  (`updateChannelAsync` does not await) but *returns* the resumed channel to its
  one caller, `programming-service.js`, which uses it directly. So nothing there
  re-reads expecting the new version either.

**What the enumeration did turn up, and it is not small.** Repopulating was
shielding every concurrent reader from the write itself. `fs.writeFile`
truncates the target first, so a read landing mid-write gets a partial file -
and with repopulation those readers got a cache hit and never reached the file.
Measured against the 27MB channel in the dev data folder, **26 of 72** concurrent
raw reads came back unparseable; `getChannel` returned `null` for each, and every
consumer reads `null` as "channel doesn't exist", which surfaces as a 404 on a
live stream rather than as anything traceable. So invalidating alone would have
traded a rare poisoning bug for a plausible torn read.

The usual answer is to write a temporary file and rename it over the target.
**That does not work here.** On Windows `rename` fails with `EPERM` while any
reader holds the destination open, and under a steady stream of readers it never
gets a gap: measured at **0 of 10** renames succeeding with retries out to 200ms.
Attempted, measured, reverted.

So the window stays and the reader waits it out: `ChannelDB#getChannel` retries
an unparseable read on a ladder out to about 1.6 seconds
(`READ_RETRY_DELAYS`), bailing immediately on `ENOENT` so a channel that simply
is not there still costs nothing. A file that really is corrupt costs the whole
ladder before returning `null`, which is what it returned immediately before.
`test/channel-save.js` covers both halves, and carries a raw-read control so a
reader can tell whether the concurrency checks proved anything on that run - on
this machine the control tears 15 of 15 while the DAO returns a correct channel
every time.

Cost of the lazy reload: one cold read per save of that channel, measured at
117ms for the 39,999 program one and 3ms for the others, against a guide rebuild
that the save already triggers and that does considerably more.

One thing left alone, noted because it is the same looseness: `saveChannel` and
`deleteChannel` read a bare `channelDB` rather than `this.channelDB`, which
resolves to the implicit global `index.js` creates at line 105 with
`channelDB = new ChannelDB(...)` - no declaration, so it lands on `globalThis`.
It works only because of that leak. `test/channel-save.js` sets the global to
construct a service, and says why, so the wart fails loudly if anyone tightens
it.

### Saving a live channel jumped the stream, and startTime was not why

The symptom: updating a channel while it is playing pauses the stream and then
moves it. The suspect was `adjustStartTimeToCurrentProgram` in
`web/directives/channel-config.js`, because a plain reload-and-resave with no
edits visibly rewrites `channel.startTime` and `startTime` is what decides which
program is playing now. That was noted during the day-parts work and dismissed as
harmless; it is worth writing down *why* the dismissal was right, since the field
really does change and will look suspicious again.

**It is a rotation, not a nudge.** The function moves the program playing now to
index 0 and sets `startTime = t - offsetIntoIt` in the same breath. On a cyclic
lineup those cancel: the value changes, the meaning does not. Measured on all
four channels in the dev data folder, at 2000 instants spanning a full cycle
each - including the 39,999 program one, whose cycle is 313 days - the pre-save
and post-save channel resolve to the same program at the same offset every time,
0ms drift, with the array rotated by 653, 84 and 122 positions respectively.
Nothing else on the path touches the field: the editor load is an exact
`new Date(string)`, `cleanUpChannel` recomputes only `duration` and by the same
sum the editor uses, `validateChannelJson` rewrites only `number`,
`fixupChannelBeforeSave` only *reads* `startTime` and only for on-demand
channels, and the DAO stringifies. `programs` and `startTime` also travel in one
`angular.toJson(channel)` PUT, so they cannot desync in flight. The one way to
break the cancellation is `cleanUpProgram` changing the cycle length - see Known
issues.

**The pause is deliberate.** The per-session `channel-update` listener in
`src/video.js` stops the stream 100ms after any save to the channel it is
playing, so an edit can take effect. `CHANNEL_STOP_SHIELD` says as much.

**The jump was the playback cache being flushed.** `saveChannelConfig` in
`src/channel-cache.js` deleted `cache[number]`, which is what
`getCurrentLineupItem` needs for its *"closed the stream and opened it again
let's not lose seconds for no reason"* branch. Without it the reconnect worked
its position out from the wall clock instead, and that recompute is right about
*what* to play - the point of flushing - but does not know a stream was already
in flight. Two consequences, both measured:

- It skipped the reconnect gap that an unflushed reconnect replays. A few hundred
  milliseconds to a few seconds, every save.
- Where the stream was sitting inside `createLineup`'s 30 second tune-in rewind,
  it snapped forward to the true wall-clock position: +30,896ms and +32,396ms in
  the worst samples on channel 2.

The flush still happens, so edits still take effect; what it now keeps is the
*position*, as a one-shot `resumeHints` entry that `takeResumeHint` hands back
only when the recompute landed on the same program anyway. It reproduces
`getCurrentLineupItem`'s answer including the replay branch, so the guarantee is
that a save costs the viewer no more than an ordinary quick reconnect. A save
that changed what plays now gets no hint and takes the path it always did, and
filler deliberately gets none - the mix is exactly the kind of thing the save may
have changed.

**What the fix does not cover, and cannot from here.** All three code-level
mechanisms above are strictly forward: a cached position is behind the wall clock
or equal to it, never ahead, and no negative drift appears at any reconnect gap.
So a *backward* jump is not in this code. `-ss` is pushed before `-i` in
`src/ffmpeg.js`, an input seek, so the resume lands on the keyframe at or before
the position asked for - a few seconds back on a typical GOP, and the reason the
forward case reads as "a few seconds" rather than as the exact gap. Whatever the
client does with the buffer it had at the moment of the stop is likewise outside
this. Roughly one save in ten also lands during a commercial break (7.8% and
11.3% of instants on channels 2 and 4), which restarts the break with a
different clip; that is the intended re-pick, not drift.

`test/startTime-rotation.js` and `test/save-resume.js` keep both halves honest.

### Filler list cooldowns are persisted, and were being credited to the wrong list

Per-clip last-played times have always been persisted, to
`<data folder>/play-cache/<channel>/<base64 key>.json`, and loaded at boot.
Per-**list** times were not: they sat in a plain object in `channel-cache.js`
and were forgotten on every restart. CN Groovies' 3000 second cooldown never
survived one. Day-parts lean on list cooldowns, so that had to stop being true.

They now go into the same store, under `!fillerList!|<id>`. That key cannot
collide with a program: `getProgramKey` always opens with `!unknown!` or `plex`,
which the real data folder confirms - the keys on disk look like
`plex|Thats So Disney/Nick Picks|/library/metadata/171404`. Reusing the store
means no new DAO, no new folder, no migration, and one source of truth instead
of two.

**The interesting part is what persisting it exposed.** Which list a clip is
credited to was assigned twice:

```js
pick.fillerId = minPickFillerId;   // the longest-idle clip's real list
...
pick.fillerId = fillerId;          // the list that won the weighted draw
```

The second overwrote the first unconditionally, so every clip chosen by the
longest-idle branch was credited to whichever list happened to win the draw.
Measured over 596 picks: 183 went through that branch, 54 were credited to a
list the clip does not belong to. Nine percent. The first assignment also wrote
onto the clip sitting in the filler list itself, before the clone.

This was invisible precisely *because* list cooldowns were forgotten on restart -
a wrong credit had no lasting consequence. Persisting them would have made it
permanent: a list held in cooldown having never played, another free to play
again having just played. So it is not a cleanup that happened to be nearby, it
is a prerequisite. Re-measured after the fix: 0 wrong out of 1,983.

It does change filler behaviour on channels with no day-parts, which is the one
thing stage 1 was otherwise careful not to do. Worth stating plainly rather than
leaving it to be discovered.

Finding it was the enumerate-the-writers habit paying off again - the one the
image URL fix learned the hard way, further down this section. One grep for the
per-list play time turned up exactly one writer and one reader, which is what
made it safe to move the storage; the same grep for `fillerId` turned up the two
assignments sitting one line apart.

### Guide requested an unresolved Angular binding

Resolved, and worth keeping because the first diagnosis was wrong.

The symptom was a 404 for the literal string `{{channels[channelNumber].icon}}`
on the guide page. That was written up here as an empty-guide problem - no
channel to bind to, so the placeholder gets used as an image URL - with an
`ng-if` guard suggested as the fix.

The real cause has nothing to do with there being no channels. A plain `src`
carrying an interpolation is resolved by the browser *before* Angular runs, so
the request for the literal text fires on every load whether or not a channel
exists. `ng-src` exists precisely for this: it holds the attribute back until
the expression has a value.

Enumerating the class rather than the reported symptom turned up three, not
one:

- `web/public/views/guide.html`, the channel icon - the reported 404
- `web/public/templates/channel-config.html`, the watermark preview, requesting
  `/%7B%7B%20getWatermarkSrc()%20%7D%7D` on every visit to a channel's
  properties
- `web/public/views/guide.html`, the play-channel button's `href`. An anchor
  does not fetch, so it produced no 404 and would never have been noticed from
  the network log, but a click landing before interpolation navigates to the
  literal. Converted to `ng-href` for the same reason.

Everything else under `web/public` already used `ng-src` or `ng-href`. The
check that settles it:

```
grep -rnP "(?<!ng-)(src|href)=['\"][^'\"]*\{\{" --include=*.html web/public
```

### Channel images no longer depend on the host and port that created them

Previously the UI and two server paths wrote absolute URLs built from whatever
address happened to be in use, so a channel created on port 18000 stored
`http://localhost:18000/images/dizquetv.png` and broke as soon as the server
moved. XMLTV and M3U then handed that dead URL to Plex.

`icon`, `offlinePicture` and `watermark.url` now store a path such as
`/images/dizquetv.png`. The awkward part is that consumers need different
things from the same stored value, so `src/image-url.js` offers two resolvers:

- `forClient()` prefixes `{{host}}`, which `src/api.js` substitutes per request
  from `req.protocol` and `req.get('host')`. Used by `xmltv.js` and
  `m3u-service.js`, so each client gets an address it can actually reach.
- `forLocalFfmpeg()` prefixes `http://localhost:${process.env.PORT}`, because
  ffmpeg runs on this machine and cannot resolve a client's hostname. Used by
  `ffmpeg.js` for the offline picture and the watermark.

Anything not starting with `/` passes through untouched, which is what keeps
Plex thumbnail URLs working.

Migration step 805 to 806 rewrites existing channels. It only touches a URL
when the path starts with `/images/` **and** that file exists in the data
folder, leaving anything else exactly as it was. That conservatism is
deliberate: a channel carried 110 Plex thumbnail URLs with auth tokens, and a
blanket rewrite would have destroyed them. Verified after migrating: the two
fields changed, all 110 Plex URLs and the other 212 programs were byte
identical.

Note that the `http://localhost:${process.env.PORT}` strings still present in
`video.js`, `offline-player.js` and `plexTranscoder.js` are not part of this
problem. They are built per request for a local ffmpeg process and never
outlive the port they were built for.

**That fix missed two writers, and the miss is the interesting part.** It
searched for the bad *construction* - `${location.protocol()}://${location.host}`
- and corrected all four places that matched. But `/api/upload/image` returned

```js
fileUrl: `${req.protocol}://${req.get('host')}/images/uploads/${logo.name}`
```

and `channel-config.js` stored that verbatim into `channel.icon` and
`watermark.url`. Those two writers build no URL of their own, so no search for
one could have found them. A logo uploaded after 805 to 806 had run was stored
absolute all over again, and the resolvers passed it straight through - the
same dead URL handed to Plex that the whole change existed to prevent. It was
found by noticing a stale `localhost:18080` request in the browser console,
four months of wall-clock luck after the fact.

The endpoint returns `filePath`, a path, and is renamed from `fileUrl` so an
unconverted caller fails loudly rather than storing a path under a name that
says URL. The filename is URL-encoded, which matters because uploads really do
carry spaces. Migration 807 to 808 re-runs `relativizeChannelImages` for
channels already carrying one - same rule, same fields, so it calls the same
function rather than keeping a second copy of it, and it is idempotent.

The lesson, which generalises past this bug: **when fixing a class of bug,
enumerate every writer of the data, not every construction of the bad value.**
There were six writers of these three fields. Listing them takes one grep and
would have caught all six in the first pass.

A read-time safety net in the resolvers was considered and rejected. See the
next entry.

### A read-time net in the image resolvers is not worth it

Tempting, since the migration's rule is right there: on output, if a value is
an absolute URL whose path is under `/images/` and the file exists locally,
rewrite it. Any future writer that slips through would be corrected before
anything saw it.

It should not be added.

The rule cannot tell a stale local URL from a legitimate remote one. It looks
at the pathname and at whether some local file happens to share the name.
Measured against the real data folder:

    http://localhost:18080/images/uploads/dizquetv.png  -> rewritten   (wanted)
    http://plex.local:32400/images/uploads/dizquetv.png -> rewritten   (wrong)
    http://cdn.example.com/images/dizquetv.png          -> rewritten   (wrong)

The last two are remote images silently replaced by whatever this machine has
under that name. The migration accepts that risk deliberately, but it accepts
it *once*, under supervision, on a pass whose output can be diffed - which is
exactly what was done, both times. Running it on every read makes it permanent,
silent and unreviewable.

Three smaller objections on top. It puts a filesystem stat inside what is now a
pure string function, which is the property that makes the resolvers testable
without a data folder. It fixes the output while leaving the stored value
wrong, and only four call sites go through the resolvers - the UI preview and
the channel list read `channel.icon` directly and would still get the bad
value. And it hides the defect, so the next writer that slips through looks
like it works.

The net that was added instead sits at the write boundary.
`validateChannelJson` in `src/dao/channel-db.js` is called by both
`saveChannel` and `saveChannelSync`, which makes it the one place every channel
write passes through. It warns when `icon`, `offlinePicture` or
`watermark.url` is saved as an absolute URL whose path is under `/images/`,
naming the channel, the field and the path it should have been.

It rewrites nothing, deliberately. Correcting the value would mean guessing
whether a remote URL under `/images/` is stale or intended, and a wrong guess
silently serves the wrong image - the same objection that rules out doing it on
read. Being loud is the whole job. It costs one `new URL()` per image field per
save and touches no disk, so it is safe in a way the read-time version is not.

It does not fire on anything in the data folder today, which is the point: it
exists for the third writer, whenever that turns up.

### Small things in the upload path, left alone deliberately

Found while tracing the stale icon URL. None of them are the bug, and none are
fixed.

`web/services/dizquetv.js` defines `addChannelWatermark`, which POSTs to
`/api/channel/watermark`. That route does not exist in `src/api.js`, and
nothing calls the function. Dead code aimed at a missing endpoint.

`index.js` mounts `/images` twice over the same directory, at lines 299 and
301. Harmless, and predates the fork.

`/api/upload/image` calls `logo.mv(...)` without a callback and without
awaiting it, then sends a success response regardless. express-fileupload
returns a promise when given no callback, so a failed move is an unhandled
rejection and the client is told the upload worked. Never observed in practice,
but the success response is not evidence of a successful write.

### Channel order is consistent across every consumer

`getAllChannelNumbers()` enumerated the channels folder with `fs.readdir` and
returned whatever order that gave. Channel files are named `<number>.json`, so
that order is lexicographic: with channels 1, 2, 3, 10, 11, 20 and 100 on disk,
readdir yields 1, 10, 100, 11, 2, 20, 3.

The M3U and the API happened to sort afterwards, but two consumers did not: the
HDHomeRun lineup in `src/hdhr.js`, which is what Plex, Jellyfin and Emby read,
and the XMLTV guide build in `index.js`. So the same install advertised
channels in one order over M3U and a different one to a tuner client.

The DAO now sorts numerically, which is the one place every consumer passes
through. Verified against a folder of seven channels spanning single, double
and triple digits.

### M3U placeholder entry points at a path that is served

The no-channels entry in `m3u-service.js` pointed at `{{host}}/resources/...`,
which 404s since nothing mounts `/resources` as static - `index.js` maps only
`/favicon.svg` into that folder. It now uses `/images/dizquetv.png`, which
`initDB` guarantees exists on every start.

### validURL rejected the paths the icon change introduced

Storing channel images as paths broke saving any channel through the UI.
`validURL` in `channel-config.js` requires a scheme, so `/images/dizquetv.png`
failed with "Please enter a valid image URL" and the save never ran. It now
accepts a root-relative path as well.

The cause is worth more than the fix. The icon change was verified through
XMLTV output, M3U output and the browser rendering the image, all of which
read the value. Nothing exercised the path that *writes* it, so a validation
sitting directly in front of the save went unnoticed for two commits.

It also survived a first test attempt, because that test called a
`scope.saveChannel()` that does not exist. The optional-call guard meant
nothing ran and no error was raised, which read as a pass. The real entry
point is `scope._onDone(channel)`, bound to the Save button in
`channel-config.html`. When testing through a scope, confirm the function
being called actually exists.

### The XMLTV guide can hand a viewer your Plex access token

Investigated, not fixed, ahead of "Public channel sharing without exposing an
IP" under Infrastructure above - a channel shared publicly is exactly the
case where a leaked token stops being theoretical.

`program.icon` (and `episodeIcon`/`seasonIcon`/`showIcon`) is stored as the
raw Plex thumbnail URL, `X-Plex-Token` included - confirmed by "Channel
images no longer depend on the host and port that created them" above
("Anything not starting with `/` passes through untouched, which is what
keeps Plex thumbnail URLs working"). `src/xmltv.js`'s `_writeProgramme` only
rewrites that URL through the safe `/cache/images/<hash>` proxy - which
strips the token, since the proxy fetches the image itself and only ever
hands the client a hash - when `xmltvSettings.enableImageCache === true`.
That setting defaults to `false` (`src/database-migration.js`'s
`initializeDb`, step introducing `xmltv-settings`), and this real dev
install is still at that default. Measured against channel 1's actual saved
file: 20,017 of its 40,000 programs carry a token-bearing `icon` URL, so with
image caching off - the out-of-the-box state - roughly half its guide
entries would hand a real viewer that token today.

A second, narrower path has no gate at all. The channel's own icon (XMLTV's
`<channel><icon>` and the M3U's `tvg-logo`) goes through `imageUrl.forClient`
in both `xmltv.js` and `m3u-service.js`, which passes anything not starting
with `/` through unchanged regardless of `enableImageCache` - there is no
cache option for it to check. `channel-config.js`'s `validURL` accepts any
URL with a scheme, not only an uploaded `/images/uploads/...` path, so
nothing stops a channel icon from being set to a Plex thumbnail URL directly.
None of the four dev channels do this today (channel 1's icon is
`/images/uploads/syndicast-icon-512.png`), so this one is a real gap in the
mechanism rather than a measured leak.

HDHomeRun's `lineup.json` (`src/hdhr.js`) carries no icon field at all, so
that path is clean.

Not fixed here, per plan: the likely shape is turning `enableImageCache` on
by default (or removing it as an option) for the program-icon path, and
routing the channel icon through the same proxy regardless of that setting
for the second path - but that's a decision for whoever builds public
sharing, not a drive-by change now.

### The program-list-row work broke the live dev server, without touching it

Ron's real server on port 18000 (`node index.js -p 18000 -d ./.dizquetv-dev`)
started showing a stuck 6-row, non-scrolling programming list, and reported
it before anything else. Root cause: `index.js` rebuilds
`web/public/bundle.js` on the next `/bundle.js` request whenever any file
under `web/` has a newer mtime than the bundle
(`src/web-bundle.js`'s `BundleFreshnessChecker`), from whatever is on disk at
that moment - and that bundle file, its manifest, and the watched `web/`
directory are the same physical files regardless of which port asks. The
program-list-row work (this file's "Program rows show the episode title"
entries above) was built and iterated on directly in this checkout rather
than an isolated worktree - only the *data* was copied to a spare port, never
the code - so every edit made while debugging it was a candidate for port
18000's own next live rebuild, triggered by an ordinary page load or reload
on that server, independent of anything run against the copy on 18098.
`.dizquetv-dev` itself was never written to - confirmed against both the
newest backup and a copy taken at the very start of that session, both
already showing the same `channel.fillerCollections: []` Ron separately
flagged, ruling that specific change out as unrelated.

Fixed in two steps: an immediate revert of `web/` to the commit before that
work (`05ac006`) and a rebuild, to get a known-good bundle served again
without restarting port 18000; then the actual feature was rebuilt and
re-verified in a real `git worktree` this time (`blocks-scroll-fix`, node_modules
junction-linked rather than reinstalled) - its own bundle, manifest and
`web/` tree, so no further iteration could touch the live checkout. No
scrolling bug reproduced there even under sustained real mouse-wheel
scrolling a week-plus into channel 1's real 40,000-program lineup (63 scroll
actions, 09/28 to 10/05, no stuck window, no console errors) - the live
server's actual symptom is believed to have been one of the mid-debugging
intermediate states (the flex-shrink squash or the vs-repeat reopen bug, both
documented under the "Program rows show the episode title" entries above)
getting served live partway through that work, not a defect in the code that
shipped.

**Lesson kept for next time:** a data-only copy on a spare port is not
enough isolation when the *code* itself is what's being changed in this
checkout - `index.js`'s live rebuild makes every running server, on any
port, a consumer of whatever's on disk in `web/`. Any future work that edits
`web/` or `src/` belongs in a worktree from the start, not just a spare-port
data copy.

**Running `npm install` inside a worktree breaks the link.** A worktree's
`node_modules` is a junction to the main checkout's, so both share one set
of packages; `npm install` run in the worktree replaces that junction with a
real folder of its own, and from then on the worktree and the main checkout
have separate packages that can drift apart. So a new dependency is
installed in the main checkout (`C:\Projects\dizquetv`), where the junction
points, and the worktree sees it through the link.

### Deleting a filler list could silently fail instead of completing

Found by accident during the incident above, confirmed as pre-existing and
unrelated to it. `web/controllers/filler.js`'s `deleteFiller(index)` stored
the clicked row's plain array index (`$scope.deleteFillerIndex`); if
`$scope.fillers` was reassigned before the confirmation dialog closed - a
reorder, another delete, any refresh - that index could land past the end of
the new array or on the wrong row. `onFillerDelete` dereferenced it directly
as its first line, so a miss threw *before* the real
`dizquetv.deleteFiller(id)` call one line later - the delete never ran, the
filler list itself was never touched, and the visible symptom was a console
error ("Cannot set properties of undefined (setting 'pending')") and a row
stuck showing as pending. No orphaned channel/day-part/block reference is
possible from this failure mode specifically, since the delete request never
reached the server when it triggered.

Fixed by keying both sides on the filler's own `id` (`findFillerById`)
instead of a stored index, which stays correct regardless of what else
changed the array in between. Verified on a copy of `.dizquetv-dev`: opened
a delete confirmation, spliced an earlier row out of `$scope.fillers` from
the console to reproduce the exact stale-index condition, confirmed the
delete completed correctly (checked against the API afterward), and
confirmed an ordinary delete with no race still works as before.

### The names review search box didn't filter

`web/public/templates/names-review.html`'s `nr-toolbar` (the "Search
clips..." input) sits inside the `ng-if="list && !loading"` block, which
Angular compiles onto a new child scope. `ng-model="search"` wrote into a
`search` property on that child scope, while `web/directives/names-review.js`
read and filtered on `scope.search` of the outer (directive) scope -
`rebuild()` never saw a keystroke. Every other `ng-model` in the same
template already binds through an object path (`picker.filter`, `slot.key`,
`teach.text`, and the rest), which this same `ng-if` nesting does not break:
a dotted path writes into a property of an object the child scope inherits
by reference, not a new property shadowing the parent's own. `search` was
the one bare, non-dotted binding, so it was the only one affected.

Fixed by renaming the field to `ui.search`, both in the template and in the
directive's three uses of it (initial value, `rebuild()`'s read, and the
reset in `open()`), so the write lands on the `ui` object the child scope
already holds a reference to.

No test drives the compiled template: `test/names-review.js` and its
siblings exercise `src/names-review.js`'s grouping/accept-all/save logic
directly, and nothing in `test/` compiles Angular directives (no
`angular-mocks`, no jsdom). Checked by hand instead, on a copy of
`.dizquetv-dev` on a spare port: opened Library > Filler > "Which clips name
a show?" > a list with 138 saved clips, typed "Batman" into Search clips,
confirmed it narrowed to the 4 matching rows, then cleared the box and
confirmed all 138 came back.
