/*
 * The Syndicast logo, icons and on-air screens: the files the page links to are there and are
 * what they say they are, the top bar shows the logo, and a server with no channels hands the
 * guide Syndicast's own icon instead of a link to somebody else's repository.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Suite, DAY } = require('./support');
const TVGuideService = require('../src/services/tv-guide-service');
const { WriteXMLTV } = require('../src/xmltv');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'web', 'public');

// width, height and colour type from a PNG's header
function pngInfo(file) {
    const b = fs.readFileSync(file);
    const ok = b.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return { ok, width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
}

module.exports = async function run() {
    const suite = new Suite('branding');
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

    // --- the page ---
    suite.check('the tab title is Syndicast', /<title>Syndicast<\/title>/.test(html));
    const h1 = html.slice(html.indexOf('<h1>'), html.indexOf('</h1>'));
    suite.check('the top bar shows the Syndicast logo', /<img id="syndicast-logo" src="syndicast-logo\.svg"/.test(h1));
    suite.check('the top bar no longer uses the data-folder icon or spells the name out',
        !/dizquetv/i.test(h1) && !/images\/dizquetv\.png/.test(h1) && !/>\s*Syndicast\s*</.test(h1.replace(/<img[^>]*>/, '')));
    suite.check('no link to the old icon, and the icon link is not mis-typed as a png',
        !/type="image\/png"\s+href="\/favicon\.svg"/.test(html));

    // every icon the head links to exists
    const linked = [...html.matchAll(/<link rel="(?:icon|shortcut icon|apple-touch-icon|manifest)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    suite.check('the head links the svg, two png sizes, the ico, the home-screen icon and the manifest', linked.length === 6, linked.join(' '));
    for (const href of linked) {
        const file = href === '/favicon.svg' ? path.join(ROOT, 'resources', 'favicon.svg') : path.join(PUBLIC, href);
        suite.check(`${href} is served from a file in the repository`, fs.existsSync(file));
    }

    // --- the logo's size, and the wordmark's font on the menu and the tab strips ---
    const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8').replace(/\r\n/g, '\n');
    suite.check('the logo is 1.75em (70px) tall, as big as the word it replaced', /#syndicast-logo \{\s*height: 1\.75em;/.test(css));
    suite.check('the menu links sit in #top-menu', /<span id="top-menu">[\s\S]*topMenu\.guide[\s\S]*topMenu\.version[\s\S]*<\/span>\s*<span class="pull-right">/.test(html));
    suite.check('the menu and every tab strip use Bricolage Grotesque, with the system fonts behind it',
        /#top-menu,\s*\.nav-tabs \.nav-link \{\s*font-family: 'Bricolage Grotesque', -apple-system/.test(css));
    const face = css.match(/@font-face \{[^}]*Bricolage Grotesque[^}]*\}/);
    suite.check('the font is bundled, not fetched from elsewhere', !!face && /url\(fonts\/BricolageGrotesque-600\.woff2\)/.test(face[0]) && !/https?:/.test(face[0]));
    const woff = fs.readFileSync(path.join(PUBLIC, 'fonts', 'BricolageGrotesque-600.woff2'));
    suite.check('fonts/BricolageGrotesque-600.woff2 is a woff2 file', woff.slice(0, 4).toString('ascii') === 'wOF2');
    suite.check('its licence is shipped beside it', /SIL Open Font License/.test(fs.readFileSync(path.join(PUBLIC, 'fonts', 'OFL.txt'), 'utf8')));

    // --- the icons ---
    const sizes = { 'favicon-16.png': 16, 'favicon-32.png': 32, 'apple-touch-icon.png': 180, 'icon-192.png': 192, 'icon-512.png': 512 };
    for (const [name, size] of Object.entries(sizes)) {
        const i = pngInfo(path.join(PUBLIC, 'icons', name));
        suite.check(`icons/${name} is a ${size}px square png`, i.ok && i.width === size && i.height === size);
    }
    const ico = fs.readFileSync(path.join(PUBLIC, 'favicon.ico'));
    const entries = ico.readUInt16LE(4);
    const icoSizes = [];
    for (let e = 0; e < entries; e++) icoSizes.push(ico[6 + 16 * e]);
    suite.check('favicon.ico holds 16, 32 and 48', icoSizes.join() === '16,32,48', icoSizes.join());
    const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'site.webmanifest'), 'utf8'));
    suite.check('the manifest names the app Syndicast', manifest.name === 'Syndicast' && manifest.short_name === 'Syndicast');
    suite.check('the manifest icons exist', manifest.icons.length === 2 &&
        manifest.icons.every((m) => fs.existsSync(path.join(PUBLIC, m.src))));
    suite.check('the manifest asks for no colours the page does not already have', !('theme_color' in manifest) && !('background_color' in manifest));
    const fav = fs.readFileSync(path.join(ROOT, 'resources', 'favicon.svg'), 'utf8');
    suite.check('the favicon switches to the cream outline in dark tabs', fav.includes('prefers-color-scheme:dark') && fav.includes('#F4EFE6'));
    suite.check('the top-bar logo is the full navy logo from assets/',
        fs.readFileSync(path.join(PUBLIC, 'syndicast-logo.svg')).equals(fs.readFileSync(path.join(ROOT, 'assets', 'syndicast-logo.svg'))));

    // --- the on-air screens: the loading screen opens every stream, so keep them 1920x1080 RGB ---
    for (const name of ['loading-screen', 'generic-offline-screen', 'generic-error-screen', 'generic-music-screen']) {
        const i = pngInfo(path.join(ROOT, 'resources', name + '.png'));
        suite.check(`${name}.png is 1920x1080, 8-bit RGB`, i.ok && i.width === 1920 && i.height === 1080 && i.colorType === 2);
    }

    // --- a server with no channels ---
    const g = new TVGuideService(null, null, null, null, { t: (k) => k });
    g.currentUpdate = Date.now();
    g.currentLimit = g.currentUpdate + DAY;
    g.currentChannels = [];
    const guide = await g.buildItManaged();
    const placeholder = guide[1];
    suite.check('the no-channels guide carries Syndicast\'s own icon as a stored path', placeholder.channel.icon === '/icons/icon-512.png', placeholder.channel.icon);
    suite.check('the programme icon is the same file with the host filled in per request',
        placeholder.programs[0].icon === '{{host}}/icons/icon-512.png', placeholder.programs[0].icon);
    suite.check('that icon is a file the server serves', fs.existsSync(path.join(PUBLIC, 'icons', 'icon-512.png')));
    const guideSource = fs.readFileSync(path.join(ROOT, 'src', 'services', 'tv-guide-service.js'), 'utf8');
    suite.check('the guide no longer points at the original project\'s repository', !/githubusercontent|vexor/i.test(guideSource));

    // in the XMLTV file, with and without the image cache
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syndicast-branding-'));
    try {
        for (const cache of [false, true]) {
            const file = path.join(dir, `guide-${cache}.xml`);
            const registered = [];
            await WriteXMLTV(guide, { file, enableImageCache: cache, cache: 0, output: 'x' }, async () => {},
                { registerImageOnDatabase: (u) => { registered.push(u); return 'cached'; } });
            const xml = fs.readFileSync(file, 'utf8');
            const icons = [...xml.matchAll(/<icon src="([^"]*)"/g)].map((m) => m[1]);
            suite.check(`XMLTV (image cache ${cache ? 'on' : 'off'}): the channel and the programme both show {{host}}/icons/icon-512.png`,
                icons.length === 2 && icons.every((u) => u === '{{host}}/icons/icon-512.png'), icons.join(' '));
            suite.check(`XMLTV (image cache ${cache ? 'on' : 'off'}): the cache is never asked to fetch our own icon`, registered.length === 0);
        }
        // and the cache still takes everybody else's pictures
        const other = { 1: { channel: { name: 'X', number: 1, icon: '/images/x.png' }, programs: [{
            start: new Date(Date.now()).toISOString(), stop: new Date(Date.now() + 1000).toISOString(),
            icon: 'http://plex.example/thumb.png', title: 'T', summary: 's', date: '2026-11-14' }] } };
        const file = path.join(dir, 'other.xml');
        const registered = [];
        await WriteXMLTV(other, { file, enableImageCache: true }, async () => {},
            { registerImageOnDatabase: (u) => { registered.push(u); return 'cached'; } });
        suite.check('a programme picture from elsewhere still goes through the image cache', registered.join() === 'http://plex.example/thumb.png', registered.join());
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    return suite;
};
