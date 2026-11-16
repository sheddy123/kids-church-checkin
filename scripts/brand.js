#!/usr/bin/env node
/*
 * Rebrands the app for a church. Edit branding/branding.json, then run:
 *
 *   npm run brand
 *
 *   appName         Name under the icon on the phone (keep it short).
 *   appId           Unique ID for the app, e.g. "org.gracechapel.checkin".
 *                   Each church's app needs its own, or one replaces the other.
 *   churchName      Shown in the app header until changed in Setup.
 *   color           Brand colour (#RRGGBB). Starting theme, and the icon background.
 *   icon            Path to the church logo (PNG, JPG or SVG, square, 512px or more).
 *                   Leave "" for the default shield.
 *   iconBackground  Colour behind the logo on the icon. Leave "" to use `color`.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
const b = JSON.parse(fs.readFileSync(path.join(ROOT, 'branding', 'branding.json'), 'utf8'));

function fail(m) { console.error('branding.json: ' + m); process.exit(1); }
const HEX = /^#[0-9a-fA-F]{6}$/;
if (!b.appName || b.appName.length > 30) fail('appName is needed (30 characters at most).');
if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(b.appId || '')) fail('appId must look like "org.yourchurch.checkin" (lower-case letters, digits and dots).');
if (!HEX.test(b.color || '')) fail('color must look like "#4F46E5".');
if (b.iconBackground && !HEX.test(b.iconBackground)) fail('iconBackground must look like "#FFFFFF", or be "".');
const iconPath = b.icon ? path.resolve(ROOT, b.icon) : path.join(ROOT, 'branding', 'default-icon.svg');
if (!fs.existsSync(iconPath)) fail('icon file not found: ' + iconPath);
const bg = b.iconBackground || b.color;
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, "\\'").replace(/"/g, '\\"');

function edit(file, fn) { const p = path.join(ROOT, file); fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8'))); }

async function icon(size, scale, shape) {
  const inner = Math.round(size * scale);
  const logo = await sharp(iconPath, { density: 600 }).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const back = shape === 'none'
    ? { create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }
    : Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '"><rect width="' + size + '" height="' + size + '" rx="' + (shape === 'round' ? size / 2 : size * 0.22) + '" fill="' + bg + '"/></svg>');
  return sharp(back).composite([{ input: logo, gravity: 'centre' }]).png().toBuffer();
}

(async () => {
  // 1. Names and IDs
  edit('capacitor.config.json', s => { const c = JSON.parse(s); c.appName = b.appName; c.appId = b.appId; c.backgroundColor = b.color; return JSON.stringify(c, null, 2) + '\n'; });
  edit('android/app/src/main/res/values/strings.xml', () =>
    "<?xml version='1.0' encoding='utf-8'?>\n<resources>\n    <string name=\"app_name\">" + xml(b.appName) + "</string>\n    <string name=\"title_activity_main\">" + xml(b.appName) +
    "</string>\n    <string name=\"package_name\">" + b.appId + "</string>\n    <string name=\"custom_url_scheme\">" + b.appId + "</string>\n</resources>\n");
  edit('android/app/build.gradle', s => s.replace(/applicationId\s+"[^"]*"/, 'applicationId "' + b.appId + '"'));

  // 2. Colours
  edit('android/app/src/main/res/values/ic_launcher_background.xml', () =>
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">' + bg + '</color>\n    <color name="kcBrand">' + b.color + '</color>\n</resources>\n');
  fs.writeFileSync(path.join(ROOT, 'www', 'js', 'brand.js'),
    '/* Written by "npm run brand" from branding/branding.json. Do not edit by hand. */\nwindow.BRAND = ' + JSON.stringify({ appName: b.appName, churchName: b.churchName || '', color: b.color }, null, 2) + ';\n');

  // 3. Icons
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(dens)) {
    const dir = path.join(RES, 'mipmap-' + d);
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), await icon(Math.round(108 * k), 0.5, 'none')); // inside the safe zone of adaptive icons
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), await icon(Math.round(48 * k), 0.62, 'square'));
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), await icon(Math.round(48 * k), 0.58, 'round'));
  }
  fs.writeFileSync(path.join(ROOT, 'www', 'icon.png'), await icon(192, 0.62, 'square'));
  fs.writeFileSync(path.join(ROOT, 'branding', 'preview.png'), await icon(512, 0.62, 'square'));

  console.log('Branded as "' + b.appName + '" (' + b.appId + '), colour ' + b.color + ', icon ' + path.relative(ROOT, iconPath));
  console.log('Preview: branding/preview.png   Next: npm run android:apk');
})().catch(e => { console.error(e); process.exit(1); });
