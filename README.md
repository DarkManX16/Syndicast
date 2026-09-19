<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/syndicast-logo-dark.svg">
    <img src="assets/syndicast-logo.svg" alt="Syndicast" width="420">
  </picture>
</p>

<p align="center"><strong>Turn your media library into live TV.</strong></p>

Syndicast turns the movies and shows you already own into always-on
TV channels. Build a '90s sitcom channel, a Saturday-morning cartoon
block, or a 24/7 horror marathon, then tune in from Plex, Jellyfin,
Emby, or any IPTV player. No endless scrolling, no deciding what to
watch. Just turn it on and see what's playing.

## Features

- Build channels from your Plex library
- Create as many channels as you like, with custom schedules and time slots
- Add filler like commercials, trailers, and bumpers between shows
- Works as an HDHomeRun tuner in Plex, Jellyfin, and Emby
- Provides M3U playlist and XMLTV guide links for IPTV apps
- Give each channel its own logo and on-screen watermark

## Quick Start

Run Syndicast with Docker:

```bash
docker run -d --name syndicast \
  -p 8000:8000 \
  -v syndicast-data:/home/node/app/.syndicast \
  darkmannx16/syndicast:latest
```

Then open `http://localhost:8000`, connect your Plex server, and start
building channels.

### Switching from dizqueTV?

Stop dizqueTV first, then start Syndicast with your old data folder
mounted at `/home/node/app/.dizquetv` (or run it from the folder that
contains `.dizquetv`). Syndicast will find your channels and settings
and keep using them. Plex will see Syndicast as a new tuner, so add it
again under Live TV & DVR.

## Development

Run from source. Requires Node.js and a checkout of this repo.

Install dependencies:

```bash
npm install
```

Build the web UI (compiles `web/app.js` into `web/public/bundle.js`):

```bash
npm run build
```

Start the server. Passing an explicit port and data folder keeps a
development instance from colliding with a normal install:

```bash
node index.js -p 18000 -d ./.dizquetv-dev
```

Then open `http://localhost:18000`.

For live development, run these in two terminals. The first rebuilds
the web UI on save, the second restarts the server on save:

```bash
npm run dev-client
npm run dev-server
```

`dev-server` uses the default port and data folder. To point it at the
development ones, pass them through with an extra `--`, which stops
nodemon from claiming the flags as its own:

```bash
npm run dev-server -- -- -p 18000 -d ./.dizquetv-dev
```

To build distributable binaries:

```bash
npm run build
npm run compile
npm run package
```

## Roadmap

- Jellyfin as a media source

## Credits

Syndicast is a fork of [dizqueTV](https://github.com/vexorian/dizquetv)
by vexorian, which itself grew out of pseudotv-plex. Huge thanks to
everyone whose work made this project possible.

## License

Syndicast is released under the same license as dizqueTV. See
[LICENSE](LICENSE) for details.
