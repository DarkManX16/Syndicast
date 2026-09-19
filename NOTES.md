# Notes

## Known issues / future work

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

### Guide requests an unresolved Angular binding when no channels exist

With no channels configured, the browser issues a request for the literal
string `{{channels[channelNumber].icon}}` and gets a 404. The binding in
`web/public/views/guide.html` is never resolved because there is no channel to
bind to, so the placeholder is used as an image URL.

Pre-existing dizqueTV behaviour, not introduced by the rebrand. Harmless today
(one failed request on an empty guide) but it pollutes the network log and
would confuse anyone debugging a real image problem. Needs an `ng-if` or
equivalent guard.

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

### Channel icon URLs bake in the host and port that created them

When a channel is created, the UI stores an absolute URL for its icon and
offline picture, built from whatever address the browser happened to be using:

```js
// web/directives/channel-config.js:63, 72, 116
scope.channel.icon = `${$location.protocol()}://${location.host}/images/dizquetv.png`
```

`location.host` includes the port, so the value is correct when written and
rots afterwards. Serving on a different port, renaming the host, or moving
between `localhost` and a LAN address all break it. The server does the same
thing in `src/database-migration.js:335` and `src/dao/plex-server-db.js:38`,
using `process.env.PORT`.

This is not theoretical. A channel created while the server ran on port 18000
stores:

    icon = http://localhost:18000/images/dizquetv.png

and that URL no longer resolves once the server moves.

Note that the many other `http://localhost:${process.env.PORT}` strings, in
`video.js`, `ffmpeg.js`, `offline-player.js` and `plexTranscoder.js`, are fine.
They are built fresh at request time and handed to a local ffmpeg process, so
they never outlive the port they were built for. The bug is specifically about
values written into stored channel data.

Fixing it properly means storing a relative path and resolving it per request,
the way the M3U already does. It cannot simply become relative everywhere,
because Plex and other clients fetch these URLs and need something absolute.

### XMLTV and M3U leak those stale URLs to clients

Both outputs use a `{{host}}` placeholder substituted per request from
`req.protocol` and `req.get('host')` (`src/api.js:969` and `:1020`), so they
correctly follow whatever address the client used. Channel icons bypass that:
`src/xmltv.js:71` writes the stored `channel.icon` verbatim, and
`src/services/m3u-service.js:55` interpolates it directly.

Fetched from a server running on 18080, a single M3U line shows both
behaviours at once:

    url-tvg="http://localhost:18080/api/xmltv.xml"        <- correct
    tvg-logo="http://localhost:18000/images/dizquetv.png" <- stale
    http://localhost:18080/video?channel=1                <- correct

So Plex gets a working guide and stream URL but a broken channel logo. Routing
`channel.icon` through the same `{{host}}` mechanism would fix the output side,
but only once the stored value is relative.

### M3U fallback entry points at a path that is not served

`src/services/m3u-service.js:60`, the placeholder entry emitted when no
channels exist, uses `tvg-logo="{{host}}/resources/dizquetv.png"`. Nothing
mounts `/resources` as static - `index.js` maps only `/favicon.svg` into that
folder - so the URL 404s. `/images/dizquetv.png` is the served equivalent.

Minor, since it only appears on a fresh install with no channels, but it is the
first thing a new user's IPTV client would try to load.
