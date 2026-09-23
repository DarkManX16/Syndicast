# Blocks — Design Spec

Syndicast · `blocks` branch · Status: stage 1 core built; stage 1 UI next

## Summary

Blocks make a channel's filler change automatically by time of day and day of week, and eventually carry their own transition bumpers — so a channel runs like a real broadcast day without anyone swapping Flex settings by hand.

The design is an **overlay**. Day-parts and blocks are a wall-clock schedule of filler rules, resolved at the moment filler is picked. They never enter the generated lineup and never change how slots schedule shows.

## Decisions

Settled. Revisit only with new evidence.

| Decision | Why |
|---|---|
| Overlay, not containers | Filler is chosen at playback, not generation. An overlay needs one call site, no migration, no regeneration, and works on existing lineups. Containers would mean rewriting slot window derivation on top of the DST fix, enforcing boundaries against overrun, and rebuilding the slot editor — a scheduling redesign nothing requires. |
| Every rule fully specifies its mix | In every real example, an "added" block also reweights or drops base lists. Inheriting the base would produce the wrong mix. |
| Two tiers: day-parts, and blocks on top | Matches how the channels are actually described — an overall Flex, with blocks over it. |
| Breaks take context from their neighbours | The lineup can't say which slot owns a gap; the programs on either side can. Unlike a clock rule, this stays correct when a show overruns. |
| 12am starts the next day | Calendar days. Saturday 1am belongs to Saturday. |
| DST shift is an option on a time field | Only rare boundaries need it. Everything else stays at the wall-clock time entered. |
| Not on on-demand channels | On-demand deliberately severs the lineup from wall clock. |
| Transitions go inside breaks | The between-items interlude seam sits outside time accounting; bumpers there would drift the channel ~7 minutes a day. |
| Transition templates are per day-part/block, default empty | Break shapes differ by block, and most breaks are one bumper or none. |

## Concepts

### Day-part

The base filler for a stretch of the week.

- **Name**, **mix** (filler lists, each with weight and cooldown), optional **guide name**, and later a **transition template**.
- **Starts**: one or more `(days, time)` entries, each with an optional *shift with daylight saving* flag. One day-part can start on several days — "Weekday Day" starts Mon–Fri at 6:00am.
- All starts across all day-parts form one continuous weekly chain. Each start runs until the next start in the week, wrapping at week's end. There are no end times, so gaps and overlaps are impossible.
- A channel with no day-parts uses its existing Flex tab exactly as today.
- Only the filler mix is time-scoped. Channel Fallback and "hide watermark during filler" stay channel-wide.

### Block

A named stretch of programming that overrides the day-part while it airs.

- **Name**, **mix**, optional **guide name**, and later a **transition template**.
- **Airings**: one or more `(days, start, end)` entries. One block can air many times — weekday Toonami and the Saturday midnight run are one Toonami block with two airings, so the mix is edited in one place.
- An airing whose end is earlier than its start crosses midnight and belongs to its start day.
- Airings of different blocks may not overlap on the same day. The editor validates this.

### Context

At any moment, the **context** is the block airing covering it; otherwise the day-part covering it; otherwise the channel's default Flex.

## Resolution rules

### A program's context

The context covering the program's **start time**. A program that overruns keeps its starting context — boundaries never cut a show short.

### Which mix fills a break

For a break between program **P** (ending) and program **N** (starting):

- **Same context** → that context's mix.
- **Different context (a boundary)** → the **incoming** context's mix.

This reproduces the real channels:

- The break before Toonami's first show plays Toonami filler — "the filler starts after the 2:30 show."
- The break after Toonami's last show plays the day-part's filler — "after the 4:30 show, the Flex switches back."
- **Set each boundary at the time the new programming actually starts.** The break before it takes the new mix automatically, so the old workaround of setting a boundary to the start of the preceding show is no longer needed.

A break with no program neighbour — the start of a lineup, or an all-Flex channel — resolves from the clock.

### Daylight saving

A time marked *shift with daylight saving* stays fixed in standard time, so it reads an hour later on the wall clock in summer. The UI never says "standard time"; it shows the result — *7:00 PM in winter, 8:00 PM in summer.* All other times stay at the wall-clock time entered, as the DST fix on `main` already guarantees.

## Stages

Each stage ships and is useful on its own. Model per the Model guide in NOTES.md.

### Stage 1 — Day-parts

Replaces the single channel Flex with a time-scoped chain. Solves Nick Picks outright, plus Adult Swim and CN City Day/Night.

- **Core (Opus 5):** the resolver. Pass `t0` and `programIndex` into `createLineup` at `video.js:306` and resolve the mix there. The neighbour-context break rule, over day-part contexts. The daylight-saving option. Persistence.
- **UI (Sonnet 5):** a day-part list in the channel editor, reusing the existing Flex list/weight/cooldown editor for each mix. A start-time editor with the daylight-saving toggle and computed times. A simple weekly strip showing which day-part covers when. A "convert to day-parts" action that turns the channel's current Flex into a single all-week day-part as a starting point.
- Channels without day-parts are untouched.

The stored shape, which the core reads and the UI writes. It is an optional field
on the channel, so there is nothing to migrate: absent or empty means the channel
uses its Flex tab exactly as before.

```js
channel.dayParts = [{
  id, name,
  guideName,                                        // stored, wired up in stage 2
  fillerCollections: [ { id, weight, cooldown } ],  // same shape as channel.fillerCollections
  starts: [ { days: [1,2,3,4,5], time: 21600000, shiftWithDst: false } ]
}]
```

`days` are 0 (Sunday) to 6 and `time` is milliseconds from local midnight.
`fillerRepeatCooldown` is **not** part of a mix: it is a per-clip cooldown, and
clip cooldowns stay channel-wide and shared across contexts.

`src/day-parts.js` is pure and does no I/O, so the editor can call
`effectiveStartTime(start, instant)` for its computed times rather than keeping a
second copy of the daylight-saving arithmetic. `src/dao/channel-db.js` warns on
malformed or colliding starts at save; it rewrites nothing.

### Stage 2 — Blocks with airings

Adds Toonami, Miguzi, Cartoon Cartoons Friday, Cartoon Theatre, and the midnight run.

- **Core (Opus 5):** block airings in the resolver, extending the neighbour-context break rule to block contexts, and per-context guide names (generalising `guideFlexPlaceholder`).
- **UI (Sonnet 5):** a block editor — name, mix, airings — with overlap validation.

### Stage 3 — Block Schedule Manager (Sonnet 5)

A weekly calendar like the one kept by hand today: day-parts as background bands, blocks as coloured regions, slots drawn inside by their times. Clicking a block edits it; clicking a slot opens the existing slot editor. Editing a block's shows goes through the slot filter scoped to the block's window. Blocks never own slots.

### Stage 4 — Short-clip bug (Opus 5)

Clips under ~20 seconds next to Flex repeat about three times or get skipped. Transitions are exactly that, so this is a hard prerequisite for stage 5. See NOTES.md.

### Stage 5 — Transitions (Opus 5 design pass first, then build)

Each day-part and block gets a transition template. **Every sequence defaults to empty**, so an unconfigured break is just commercials.

Each situation has two ordered sequences — **outgoing** (before the Flex) and **incoming** (after it). Nothing is fixed by role: any step can go in either sequence, so an Up Next can sit before the Flex or after it, whichever that block does.

| Situation | Applies to |
|---|---|
| **Leaving** | A boundary break out of this context |
| **Entering** | A boundary break into this context |
| **Between episodes** | Inside this context, the same show continues |
| **Between shows** | Inside this context, a different show starts |

Break assembly:

- Same context, same show: `between-episodes out` → Flex → `between-episodes in`
- Same context, different show: `between-shows out` → Flex → `between-shows in`
- Boundary: `P.leaving out` → `N.entering out` → Flex (N's mix) → `P.leaving in` → `N.entering in`

All four "between shows" shapes are expressible purely by where the steps sit:

```
Up Next → Flex → Ident → show
Up Next → Flex → Ident → Intro → show
Flex → Up Next → Ident → show
Flex → Up Next → Ident → Intro → show
```

Each sequence is an ordered list of steps. A step says what to play and how to pick it:

- **Fixed list** — draw from one filler list.
- **Per-show** — the user maps shows to lists themselves, with a general list as the fallback.
- **Per-pair** — for Now/Then, mapped by the pair of shows, falling back to per-show and then to general.
- **Optional** — skipped when nothing applies (Cartoon Theatre's "Next Time").

**Matching falls back rather than skipping.** A step tries its most specific mapping, then the next, then its general list. A step is only skipped when it has nothing at all to draw on, or is marked optional. The one thing never done is substituting a clip that names a *different* show — a general bumper in place of a specific one is fine; "Up Next: Dexter's Lab" before Johnny Bravo is not.

WBRB can never play after a block's last show, because at a block boundary the Leaving sequence fires instead.

### Stage 6 — Midrolls

Breaks inside a program. Depends on chapter/segment detection and gets designed once that exists.

## Acceptance tests

Built from the real channels. A stage merges only when its tests pass.

### Stage 1 — resolver, day-parts only

| Channel | When | Expected |
|---|---|---|
| Nick Picks | Mon 10:00am | 90s Nick 70% / 90s Nick IDs 30% (4 min cooldown) |
| Nick Picks | Mon, break after the last 90s Nick show | Nick at Nite |
| Nick Picks | Fri 6:00am | 2000s Nick ~80% / IDs ~20% (5 min) / music videos remainder (30 min) |
| Nick Picks | Fri, break after the last 2000s Nick show | Friday Nick at Nite |
| CCN | Mon 6:00am | Powerhouse 95% / CN Groovies 5% (3000s) |
| CCN | Tue 12:00am | Adult Swim [weekday] |
| CCN | Sat 7:00pm, January | CN City Night |
| CCN | Sat 8:00pm, July | CN City Night |
| CCN | Sun 12:00am | Toonami AcTN |
| CCN | Sat 12:00am | Powerhouse 95% / CN Groovies 5% — the weekday day-part still running from Friday |
| CCN | Sat 3:00am | Powerhouse only |
| Any channel without day-parts | Any time | Existing Flex tab, unchanged |

### Stage 2

| Channel | When | Expected |
|---|---|---|
| CCN | Wed, break between the 2:30 and 3:00 shows | Toonami — Powerhouse 30% / Toonami promos 70% |
| CCN | Thu, same break | Weekday day-part — Toonami doesn't air Thursday |
| CCN | Mon, break after the 4:30 show | Weekday day-part |
| CCN | Mon, 4:30 show overruns to 5:05, break after it | Weekday day-part |
| CCN | Sat 1:00am | Toonami (midnight run airing) |
| CCN | Sat 3:00pm | CN City Day 70% / Miguzi 30% |
| CCN | Fri, break between Toonami's last show and CCF's first | CCF |

### Stage 5

- **Fri, Toonami → CCF:** Toonami sign-off → CCF Up Next → Flex → CCF intro → CCF host intro → CCF show intro → first show
- **Inside CCF, episodes of one show:** WBRB → Flex → BTTS
- **Sat, Miguzi → Cartoon Theatre:** Miguzi ending → CN City Miguzi outro → Flex → CN Cinema bumper → Cartoon Theatre intro → movie
- **Sat, Cartoon Theatre → Grim:** Next Time (if applicable) → Cartoon Theatre closing → CN City Grim bumper → Flex → Now/Then (Grim / Foster's) → Grim
- **Now/Then when Grim is followed by anything other than Foster's:** skipped
- **CCF's last show:** no WBRB; the boundary sequences fire instead

## Open questions

1. **Per-pair bumpers** (stage 5). The lineup varies by day, so the set of adjacent pairs across a week is large — on the order of a hundred — and there are many two-show bumpers. Hand-entered pair rules won't scale. Intended shape instead: pair bumpers live in a filler list, and each clip carries the two shows it names. That mapping is proposed automatically by matching clip titles against the channel's shows, with a review screen to fix what it gets wrong — a one-time pass rather than ongoing per-pair configuration. When no pair clip matches the real neighbours, it falls back to the per-show mapping, then to a general list. Settled at the stage 5 design session.
2. **Long breaks spanning several contexts.** Settled during stage 1, by measurement rather than by reading. `createLineup` is re-invoked **once per filler clip**, each time with a fresh wall-clock `t0` — a two hour break produced 48 calls and no cache hits, because `getCurrentLineupItem` returns null as soon as a clip is exhausted. Across all of them `programIndex` never moves, so the neighbour the rule reads is the same on the first call and the last. A long break therefore plays **one** mix throughout, even where it spans a boundary, which is what "the filler starts after the 2:30 show" requires. The clock only re-enters for a break with no program neighbour, and there it should: nothing anchors it, so an all-Flex channel does change mix partway through.
3. **Per-list cooldown persistence.** Fixed in stage 1. Per-list last-played now lives in the same store as per-clip times (`<data>/play-cache/<channel>/`), under a key that cannot collide with a program key, so it is loaded at boot like everything else there. No new DAO and no migration.

   Fixing it exposed a defect underneath. Which list a clip is credited to was assigned twice, and the second assignment overwrote the first, so a clip chosen by the longest-idle branch was credited to whichever list happened to win the weighted draw — measured at 9 percent of picks. That was invisible while list cooldowns were forgotten on restart. Persisting them would have made it permanent, so it was fixed in the same pass.
4. **One-off airings.** Deferred. Adding a single-date option to an airing is small and non-breaking later, and leaving it out keeps the stage 2 editor simpler. Revisit when a one-off marathon is actually wanted.

## Notes

- **The neighbour-context break rule is stage 1, not stage 2.** It was listed under stage 2 originally, but stage 1's own acceptance rows need it: *"break after the last 90s Nick show → Nick at Nite"* only resolves that way if the break takes its context from the show that follows it. A clock rule gives the outgoing mix there. `programIndex` has no other purpose than finding that neighbour, and stage 1 is the stage that asks for it. Stage 2 extends the same rule to block contexts.
- **For the mix alone, both branches of the break rule land on the incoming context**, so stage 1 only computes that side. The branches are still written as two in this spec because stage 5 picks a different transition sequence for a boundary than for a break inside one context.
- **Saturday 12am needs no configuration.** There is no Adult Swim start on Saturday, so the weekday day-part that began Friday 6am simply runs on — which is the wanted mix. This also confirms that inheriting the previous day-part across days is the right fallback. Saturday 3am needs one start, with a Powerhouse-only mix, running until CN City Day at 6am. If Saturday overnight should carry its own name in the guide and the Block Schedule Manager, add a 12am start with the same mix purely for the label.
- **Blocks never restrict manual scheduling.** They only decide which filler plays. Inserting items anywhere in the lineup, reordering it, and building an all-day marathon by hand all keep working exactly as they do now. An overlay can't take that away, because it never touches the lineup.
- Adult Swim starts Sunday at 10pm but Monday–Thursday nights at 12am. The continuous chain expresses that irregularity with no special case — Sunday's 10pm start simply runs until Monday's 6am start.
- Clip cooldowns are persisted per channel and clip, and shared across contexts. Only CN Groovies carries a cooldown, and it lives only in the weekday day-part, so this has no effect on the current channels.
- **The daylight-saving option has no visible effect on the current Saturday schedule.** Cartoon Theatre covers 7–8pm in both seasons, which is exactly the hour that shifts. It stays in stage 1 because it's small and becomes useful the moment the schedule changes.
