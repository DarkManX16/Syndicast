#!/usr/bin/env node
/*
 * Makes Syndicast's browser icons from the TV icon in assets/, and keeps the
 * TV on the four on-air screens (resources/*-screen.png) in step with it.
 *
 *   node scripts/make-brand-images.js
 *
 * Writes:
 *   web/public/icons/        favicon-16.png, favicon-32.png, apple-touch-icon.png,
 *                            icon-192.png, icon-512.png
 *   web/public/favicon.ico   16, 32 and 48 px
 *   resources/favicon.svg    the icon, switching to the cream outline in dark tabs
 *   web/public/syndicast-logo.svg   the full navy logo for the top bar
 *
 * A screen is rewritten only when the TV on it differs from assets/syndicast-icon-dark.svg
 * by more than edge noise, so a screen that already carries the icon is left byte for
 * byte as it is. The music screen draws a note in the TV's screen instead of the S.
 * Needs Chrome or Edge (PUPPETEER_EXECUTABLE_PATH to say which).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const A = (...p) => path.join(ROOT, ...p);

const CREAM = '#F4EFE6';
const SCREEN_ICON = { x: 795, size: 330 };            // the TV's box on a 1920x1080 screen
const SCREENS = [
    { file: 'loading-screen.png',        y: 332.5, note: false },
    { file: 'generic-offline-screen.png', y: 372.5, note: false },
    { file: 'generic-error-screen.png',   y: 272.5, note: false },
    { file: 'generic-music-screen.png',   y: 372.5, note: true  },
];
const REWRITE_ABOVE = 0.015;                          // share of the box's pixels

function findChrome() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
    return [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].find((p) => fs.existsSync(p)) || null;
}

// The icon with its S taken out and a music note put in.
function noteIconSvg(darkSvg) {
    const noS = darkSvg.replace(/<path d="M[^"]*A[^"]*" fill="none" stroke="#(?:FFC04D|FF7A45|F0476E)"[^>]*\/>/g, '');
    if (noS === darkSvg) throw new Error('assets/syndicast-icon-dark.svg no longer has the S paths this script removes');
    const note =
        '<rect x="252" y="232" width="16" height="140" fill="#FF7A45"/>' +
        '<path d="M268 232C306 240 328 262 326 300C316 280 296 272 268 272Z" fill="#F0476E"/>' +
        '<ellipse cx="226" cy="372" rx="37" ry="28" transform="rotate(-22 226 372)" fill="#FFC04D"/>';
    return noS.replace('</svg>', note + '</svg>');
}

// The favicon: navy outline on light tabs, cream outline on dark ones.
function faviconSvg() {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Syndicast">' +
        '<title>Syndicast</title>' +
        '<style>.o{fill:#171A3A}.a{stroke:#171A3A}.i{fill:#23275A}' +
        '@media (prefers-color-scheme:dark){.o{fill:' + CREAM + '}.a{stroke:' + CREAM + '}.i{fill:#171A3A}}</style>' +
        '<path class="a" d="M256,156L182,62M256,156L330,62" stroke-width="18" stroke-linecap="round" fill="none"/>' +
        '<circle class="o" cx="182" cy="62" r="17"/><circle class="o" cx="330" cy="62" r="17"/>' +
        '<rect class="o" x="48" y="150" width="416" height="322" rx="88"/>' +
        '<rect class="i" x="72" y="174" width="368" height="274" rx="66"/>' +
        '<path d="M271.26,260.46A18.00,18.00 0 1 0 256.00,288.00A64.00,64.00 0 1 1 201.72,385.91" fill="none" stroke="#FFC04D" stroke-width="17"/>' +
        '<path d="M290.77,248.27A41.00,41.00 0 1 0 256.00,311.00A41.00,41.00 0 1 1 221.23,373.73" fill="none" stroke="#FF7A45" stroke-width="17"/>' +
        '<path d="M310.28,236.09A64.00,64.00 0 1 0 256.00,334.00A18.00,18.00 0 1 1 240.74,361.54" fill="none" stroke="#F0476E" stroke-width="17"/>' +
        '</svg>\n';
}

// An .ico holding PNGs.
function makeIco(pngs) {
    const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
    let offset = 6 + 16 * pngs.length;
    const dir = [], data = [];
    for (const { size, png } of pngs) {
        const e = Buffer.alloc(16);
        e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size;
        e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
        e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12);
        offset += png.length; dir.push(e); data.push(png);
    }
    return Buffer.concat([head, ...dir, ...data]);
}

// 8-bit RGB PNG, no alpha: the on-air screens are RGB and the loading screen opens every stream.
function encodeRgbPng(width, height, rgb) {
    const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, body) => {
        const t = Buffer.from(type, 'ascii'), len = Buffer.alloc(4), c = Buffer.alloc(4);
        len.writeUInt32BE(body.length); c.writeUInt32BE(crc(Buffer.concat([t, body])));
        return Buffer.concat([len, t, body, c]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const dataUri = (buf, type) => `data:${type};base64,${Buffer.from(buf).toString('base64')}`;

async function main() {
    const executablePath = findChrome();
    if (!executablePath) throw new Error('No Chrome or Edge found; set PUPPETEER_EXECUTABLE_PATH');
    const iconSvg = fs.readFileSync(A('assets', 'syndicast-icon.svg'), 'utf8');
    const darkSvg = fs.readFileSync(A('assets', 'syndicast-icon-dark.svg'), 'utf8');

    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath, headless: true });
    const done = [];
    try {
        const page = await browser.newPage();
        await page.goto('about:blank');

        // --- browser icons ---
        const icons = await page.evaluate(async (svgUri, cream) => {
            const img = await new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = svgUri; });
            const png = (size, bg, inset) => {
                const c = document.createElement('canvas'); c.width = c.height = size;
                const g = c.getContext('2d');
                if (bg) { g.fillStyle = bg; g.fillRect(0, 0, size, size); }
                g.drawImage(img, inset, inset, size - 2 * inset, size - 2 * inset);
                return c.toDataURL('image/png').split(',')[1];
            };
            return {
                16: png(16, null, 0), 32: png(32, null, 0), 48: png(48, null, 0),
                192: png(192, null, 0), 512: png(512, null, 0),
                180: png(180, cream, 10),          // iOS fills transparency with black
            };
        }, dataUri(iconSvg, 'image/svg+xml'), CREAM);
        const b = (k) => Buffer.from(icons[k], 'base64');
        fs.mkdirSync(A('web', 'public', 'icons'), { recursive: true });
        const out = (rel, buf) => { fs.writeFileSync(A(rel), buf); done.push(rel); };
        out('web/public/icons/favicon-16.png', b(16));
        out('web/public/icons/favicon-32.png', b(32));
        out('web/public/icons/apple-touch-icon.png', b(180));
        out('web/public/icons/icon-192.png', b(192));
        out('web/public/icons/icon-512.png', b(512));
        out('web/public/favicon.ico', makeIco([{ size: 16, png: b(16) }, { size: 32, png: b(32) }, { size: 48, png: b(48) }]));
        out('resources/favicon.svg', Buffer.from(faviconSvg()));
        out('web/public/syndicast-logo.svg', fs.readFileSync(A('assets', 'syndicast-logo.svg')));

        // --- on-air screens ---
        for (const s of SCREENS) {
            const file = A('resources', s.file);
            const svg = s.note ? noteIconSvg(darkSvg) : darkSvg;
            const r = await page.evaluate(async (shotUri, svgUri, box, y, limit) => {
                const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
                const shot = await load(shotUri), icon = await load(svgUri);
                const W = shot.width, H = shot.height;
                const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
                const g = cv.getContext('2d');
                g.drawImage(shot, 0, 0);
                const before = g.getImageData(0, 0, W, H);
                // draw the new TV over a black box, then compare the box with what was there
                g.fillStyle = '#000'; g.fillRect(box.x - 2, Math.floor(y) - 2, box.size + 4, box.size + 4);
                g.drawImage(icon, box.x, y, box.size, box.size);
                const after = g.getImageData(0, 0, W, H);
                let bad = 0, total = 0;
                for (let yy = Math.floor(y); yy < Math.ceil(y + box.size); yy++) {
                    for (let xx = box.x; xx < box.x + box.size; xx++) {
                        const k = (yy * W + xx) * 4; total++;
                        const d = (Math.abs(before.data[k] - after.data[k]) + Math.abs(before.data[k + 1] - after.data[k + 1]) + Math.abs(before.data[k + 2] - after.data[k + 2])) / 3;
                        if (d > 40) bad++;
                    }
                }
                const share = bad / total;
                let rgb64 = '';
                if (share > limit) {
                    const rgb = new Uint8Array(W * H * 3);
                    for (let p = 0, q = 0; p < after.data.length; p += 4) { rgb[q++] = after.data[p]; rgb[q++] = after.data[p + 1]; rgb[q++] = after.data[p + 2]; }
                    for (let p = 0; p < rgb.length; p += 0x8000) rgb64 += String.fromCharCode.apply(null, rgb.subarray(p, p + 0x8000));
                    rgb64 = btoa(rgb64);
                }
                return { W, H, share, rgb64 };
            }, dataUri(fs.readFileSync(file), 'image/png'), dataUri(svg, 'image/svg+xml'), SCREEN_ICON, s.y, REWRITE_ABOVE);
            if (r.W !== 1920 || r.H !== 1080) throw new Error(`${s.file} is ${r.W}x${r.H}, expected 1920x1080`);
            const pct = (r.share * 100).toFixed(2) + '%';
            if (r.share > REWRITE_ABOVE) {
                fs.writeFileSync(file, encodeRgbPng(r.W, r.H, Buffer.from(r.rgb64, 'base64')));
                done.push(`resources/${s.file}  (rewritten: ${pct} of the TV's box differed)`);
            } else {
                console.log(`resources/${s.file}: already carries the icon (${pct} of the box differs, edge noise) - left as it is`);
            }
        }
    } finally {
        const killer = setTimeout(() => process.exit(0), 10000);
        await browser.close().catch(() => {});
        clearTimeout(killer);
    }
    console.log('wrote:\n  ' + done.join('\n  '));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
