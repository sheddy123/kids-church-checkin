(function () {
'use strict';

/* ---------- Config ---------- */
// Age groups a new register starts with. Each church edits its own in Setup → Age groups.
const DEFAULT_GROUPS = [
  { id: '1-5',   ages: '1–5',   name: 'Yellow', color: '#F2B705' },
  { id: '6-7',   ages: '6–7',   name: 'Green',  color: '#2E9E5B' },
  { id: '8-9',   ages: '8–9',   name: 'Blue',   color: '#2F6FD6' },
  { id: '10-12', ages: '10–12', name: 'Red',    color: '#D64545' },
];
const MAX_GROUPS = 12;
let GROUPS = [], G = {};
const CODE_CHARS = 'ACDEFHJKMNPRTUVWXY3479'; // no look-alikes (0/O, 1/I/L, 2/Z, 5/S, 6/G, 8/B)
const PASS_PREFIX = 'KC1:';                  // what the QR code on a pickup pass starts with
const PROFILE_DATE = '9999-12-31';           // saved family photos never expire with old registers
const VIEWS = ['checkin', 'pickup', 'rooms', 'families', 'setup'];
const THEMES = [['Indigo', '#4F46E5'], ['Blue', '#1D6FD6'], ['Teal', '#0F766E'], ['Green', '#15803D'], ['Orange', '#C2410C'], ['Berry', '#BE185D'], ['Purple', '#7C3AED'], ['Slate', '#334155']];
const HEX = /^#[0-9a-f]{6}$/i;
const LOCK_KEY = 'kc.lock', THEME_KEY = 'kc.theme';
function cleanGroups(list) {
  const seen = new Set(), out = [];
  (Array.isArray(list) ? list : []).forEach(g => {
    if (!g || typeof g !== 'object' || out.length >= MAX_GROUPS) return;
    const id = String(g.id || '').slice(0, 40), ages = String(g.ages || '').trim().slice(0, 16);
    if (!id || !ages || seen.has(id)) return;
    seen.add(id); out.push({ id, ages, name: String(g.name || '').trim().slice(0, 20), color: HEX.test(g.color) ? g.color : '#8A8AA0' });
  });
  return out.length ? out : DEFAULT_GROUPS.map(g => Object.assign({}, g));
}
// Works out the text colour and the pale background that go with each group's colour.
function setGroups(list) {
  GROUPS = cleanGroups(list).map(g => {
    const hsl = hexToHsl(g.color), n = parseInt(g.color.slice(1), 16);
    const lum = luminance([(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]);
    return Object.assign({}, g, { ink: lum > 0.4 ? '#2B2200' : '#FFFFFF', soft: 'hsl(' + hsl[0].toFixed(0) + ' ' + Math.min(hsl[1], 80).toFixed(0) + '% 92%)' });
  });
  G = Object.fromEntries(GROUPS.map(g => [g.id, g]));
}
setGroups(DEFAULT_GROUPS);

/* ---------- State ---------- */
const S = {
  be: null, db: null, mode: 'local', me: null,
  status: 'connecting', liveF: false, liveC: false, loadTimer: null,
  unsubs: [], unsubToday: null,
  families: new Map(), familiesLoaded: false,
  checkins: [], checkinsLoaded: false,
  settings: defaultSettings(), settingsLoaded: false, retentionRan: '',
  today: todayStr(),
  view: 'checkin',
  q: { checkin: '', families: '', lost: '' },
  pu: newPickup(null), puDone: null,
  sheetFam: null, sheetVisitor: false, drop: '',
  pending: new Map(),          // photos taken but not yet saved: id -> data URL
  roomFilter: 'all',
  busy: false, submitMode: '',
};
function defaultSettings() {
  const B = window.BRAND || {};
  return { churchName: '', countryCode: '44', dropPhoto: true, pinHash: '', pinSalt: '', themeColor: B.color || '#4F46E5', logo: '', contact: '', notice: '', retainDays: 90, familyMonths: 0, groups: DEFAULT_GROUPS.map(g => Object.assign({}, g)) };
}
function newPickup(key) { return { key, skip: new Set(), who: '', c1: false, c2: false }; }

/* ---------- Icons ---------- */
const svg = p => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
const ICON = {
  search: svg('<circle cx="11" cy="11" r="7.5"/><path d="m21 21-4.3-4.3"/>'),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>'),
  scan: svg('<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M8 8h3v3H8zM13 13h3v3h-3zM13 8h3M8 13v3h2"/>'),
  stop: svg('<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
};

/* ---------- Helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const str = v => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function todayStr(d = new Date()) { const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
function randomFrom(chars, n) { const a = new Uint32Array(n); crypto.getRandomValues(a); return Array.from(a, x => chars[x % chars.length]).join(''); }
function rid() { return randomFrom('abcdefghijklmnopqrstuvwxyz0123456789', 12); }
function fmtTime(ms) { if (!ms) return ''; try { return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
function first(name) { return str(name).trim().split(/\s+/)[0] || ''; }
function initials(name) { const p = str(name).trim().split(/\s+/).filter(Boolean); return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
function hue(s) { let h = 7; for (const ch of str(s)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }
function joinNames(a) { a = a.filter(Boolean); if (a.length <= 1) return a[0] || ''; return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
function splitNames(s) { return str(s).split(/[,;\n]+|\s+&\s+|\s+and\s+/i).map(x => x.trim()).filter(Boolean); }
function digitsOnly(p) { return str(p).replace(/\D/g, ''); }
function maskPhone(p) { const d = digitsOnly(p); return d ? '••• ' + d.slice(-3) : ''; }
function intlNumber(p) {
  let s = str(p).trim().replace(/[^\d+]/g, '');
  if (s.startsWith('+')) return s.slice(1);
  if (s.startsWith('00')) return s.slice(2);
  const cc = digitsOnly(S.settings.countryCode) || '44';
  if (s.startsWith('0')) return cc + s.slice(1);
  return s;
}
function smsHref(phone, body) { return 'sms:' + str(phone).replace(/[^\d+]/g, '') + '?&body=' + encodeURIComponent(body); }
function waHref(phone, body) { return 'https://wa.me/' + intlNumber(phone) + '?text=' + encodeURIComponent(body); }
function telHref(phone) { return 'tel:' + str(phone).replace(/[^\d+]/g, ''); }
function grpBadge(id) { const g = G[id]; return g ? '<span class="grp" style="background:' + g.color + ';color:' + g.ink + '">' + esc(g.ages) + '</span>' : ''; }
function gdot(id) { const g = G[id]; return '<span class="gdot" style="background:' + (g ? g.color : '#BBB') + '"></span>'; }
function notesHtml(n) { return n ? '<span class="alert">⚠ ' + esc(n) + '</span>' : ''; }
function emptyHtml(t, s) { return '<div class="empty"><div class="empty-t">' + esc(t) + '</div><div class="muted">' + esc(s) + '</div></div>'; }
function skelHtml(n = 3) { return '<div class="list">' + '<div class="skel"></div>'.repeat(n) + '</div>'; }
function av(name, photo, cls) {
  return '<span class="av ' + (cls || '') + '" style="--h:' + hue(name) + '">' + esc(initials(name)) + (photo ? '<img data-ph="' + esc(photo) + '" alt="">' : '') + '</span>';
}
function buzz(pattern) { if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) {} } }
// A leader PIN is a speed bump for volunteers, not bank-grade security: it stops a casual override.
function scramble(pin, salt) {
  let a = 0x811c9dc5, b = 0x1b873593; const t = salt + ':' + pin;
  for (let r = 0; r < 600; r++) for (let i = 0; i < t.length; i++) { a = Math.imul(a ^ t.charCodeAt(i), 16777619); b = Math.imul(b + a + r, 2246822519) ^ (b >>> 13); }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}
function pickupMessage(parentName, names, code) {
  const hi = first(parentName) ? 'Hi ' + first(parentName) + ', ' : '';
  const where = churchName() ? ' at ' + churchName() : '';
  return hi + joinNames(names) + (names.length > 1 ? ' are' : ' is') + ' checked in to Kids Church' + where + '. Your pickup code is ' + code + '. Please show this code when you collect.';
}
function genCode() {
  const used = new Set(S.checkins.map(c => c.code));
  for (let t = 0; t < 60; t++) { const c = randomFrom(CODE_CHARS, 4); if (!used.has(c)) return c; }
  return randomFrom(CODE_CHARS, 5);
}
function qrSvg(text) {
  try { const q = window.qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); }
  catch (e) { return ''; }
}

/* ---------- Theme ---------- */
function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; let h = 0, s = 0;
  if (mx !== mn) { const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn); h = (mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60; }
  return [h, s * 100, l * 100];
}
function hslToRgb(h, s, l) { s /= 100; l /= 100; const k = n => (n + h / 30) % 12, x = s * Math.min(l, 1 - l), f = n => l - x * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return [f(0), f(8), f(4)]; }
function luminance(rgb) { const c = v => (v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4)); return .2126 * c(rgb[0]) + .7152 * c(rgb[1]) + .0722 * c(rgb[2]); }
function rgbHex(rgb) { return '#' + rgb.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join(''); }
// One chosen colour drives the whole theme. It is darkened if needed so white text on it stays readable.
function applyTheme() {
  const hex = HEX.test(S.settings.themeColor) ? S.settings.themeColor : '#4F46E5';
  let [h, s, l] = hexToHsl(hex);
  l = Math.min(l, 52);
  const ok = (hh, ll) => 1.05 / (luminance(hslToRgb(hh, s, ll)) + .05) >= 4.6;
  while (l > 10 && !(ok(h, l) && ok((h + 24) % 360, l))) l -= 1;
  const dark = rgbHex(hslToRgb(h, s, Math.max(l - 6, 6)));
  const st = document.documentElement.style, f = n => n.toFixed(0);
  st.setProperty('--brand', 'hsl(' + f(h) + ' ' + f(s) + '% ' + f(l) + '%)');
  st.setProperty('--brand-d', dark);
  st.setProperty('--brand-2', 'hsl(' + f((h + 24) % 360) + ' ' + f(s) + '% ' + f(l) + '%)');
  st.setProperty('--brand-soft', 'hsl(' + f(h) + ' ' + f(Math.max(s * .8, 14)) + '% 95%)');
  st.setProperty('--brand-glow', 'hsl(' + f(h) + ' ' + f(s) + '% ' + f(l) + '% / .3)');
  const meta = $('meta[name=theme-color]'); if (meta) meta.content = dark;
  try { localStorage.setItem(THEME_KEY, hex); } catch (e) {}
  try { const C = window.Capacitor; if (C && C.isNativePlatform && C.isNativePlatform() && C.Plugins && C.Plugins.StatusBar) C.Plugins.StatusBar.setBackgroundColor({ color: dark }).catch(() => {}); } catch (e) {}
}

/* ---------- Privacy ---------- */
function fmtDate(ms) { if (!ms) return ''; try { return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } }
function churchName() { return S.settings.churchName || (window.BRAND || {}).churchName || ''; }
function getLock() { try { const v = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null'); return v && v.hash ? v : null; } catch (e) { return null; } }
function defaultNotice() {
  const s = S.settings, keep = { 30: '30 days', 90: '3 months', 365: '1 year' }[s.retainDays] || '3 months';
  return (churchName() ? churchName() + ' ' : '') + 'Kids Church: how we look after your family’s information\n\n' +
    'WHAT WE KEEP\nYour name and mobile number. Your children’s first names, age group, and any allergies or medical needs you tell us about. The names of adults you allow to collect them, and anyone who must not. A record of when each child was signed in and out, and who collected them.\n\n' +
    'PHOTOS (ONLY IF YOU AGREE)\nA photo of you, your children and the adults who may collect, plus one photo at drop-off. They are shown only to our volunteers at pickup, so that each child goes home with the right adult. No facial recognition is used. Drop-off photos are deleted as soon as your children are collected.\n\n' +
    'WHY\nTo keep children safe while they are in our care, and to reach you quickly if we need to.\n\n' +
    'WHERE\nOn one church phone' + (getLock() ? ', protected by a passcode' : '') + '. We do not pass it to anyone outside the children’s team, unless the law requires it or a child is at risk.\n\n' +
    'HOW LONG\nAttendance records are deleted automatically after ' + keep + '. Your family’s details are kept while you attend' + (s.familyMonths ? ', and deleted automatically after ' + s.familyMonths + ' months without a visit' : '') + '.\n\n' +
    'YOUR CHOICES\nYou can ask to see what we hold, have it corrected or deleted, or withdraw your agreement to photos at any time. Speak to ' + (s.contact || 'the children’s ministry leader') + '.';
}
function noticeText() { return S.settings.notice || defaultNotice(); }
function showNotice() { const ta = $('form[data-form=privacy] [name=notice]'); $('#notice-text').textContent = (ta && ta.value.trim()) || noticeText(); $('#notice').hidden = false; $('#notice').scrollTop = 0; }
let hiddenAt = 0;
function showLock() { if (!getLock()) return; const l = $('#lock'); l.hidden = false; $('#lock-err').textContent = ''; const i = l.querySelector('input'); i.value = ''; setTimeout(() => i.focus(), 50); }
document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenAt = Date.now(); else if (hiddenAt && Date.now() - hiddenAt > 60000) showLock(); });
async function eraseFamily(f) {
  await write(() => S.db.collection('families').doc(f.id).delete());
  dropPhotos(famPhotoIds(f));
  const snap = await S.db.collection('checkins').where('familyId', '==', f.id).get();
  for (const x of snap.docs) await write(() => S.db.collection('checkins').doc(x.id).delete());
}
// Storage limitation: old registers, leftover photos and (optionally) families who have stopped coming are removed without anyone having to remember.
async function runRetention(force) {
  if (!S.db || !S.familiesLoaded || !S.settingsLoaded || !S.checkinsLoaded) return;
  if (!force && S.retentionRan === S.today) return;
  S.retentionRan = S.today;
  let n = 0;
  const sweep = async (col, cutoff) => {
    for (let r = 0; r < 30; r++) {
      const snap = await S.db.collection(col).where('date', '<', cutoff).limit(200).get();
      const docs = snap.docs.filter(x => x.exists); if (!docs.length) break;
      for (const x of docs) { photoCache.delete(x.id); await write(() => S.db.collection(col).doc(x.id).delete()); if (col === 'checkins') n++; }
    }
  };
  try {
    const d = new Date(); d.setDate(d.getDate() - S.settings.retainDays);
    await sweep('checkins', todayStr(d));
    await sweep('photos', S.today); // drop-off and visitor photos left over from earlier days
    if (S.settings.familyMonths) {
      const m = new Date(); m.setMonth(m.getMonth() - S.settings.familyMonths); const cut = todayStr(m);
      for (const f of [...S.families.values()]) {
        const last = f.lastSeen || (f.createdAt ? todayStr(new Date(f.createdAt)) : S.today);
        if (last < cut && !S.checkins.some(c => c.familyId === f.id && c.status === 'in')) { await eraseFamily(f); n++; }
      }
    }
  } catch (e) { if (window.console) console.warn(e); }
  if (force) toast(n ? 'Deleted ' + n + ' old record' + (n > 1 ? 's' : '') : 'Nothing old enough to delete');
}
async function exportFamily(id) {
  const f = S.families.get(id); if (!f) return;
  const snap = await S.db.collection('checkins').where('familyId', '==', id).get();
  const rows = snap.docs.filter(x => x.exists).map(x => normCheckin(x.id, x.data())).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.inAt - y.inAt));
  const L = [];
  L.push('Information held about the family of ' + f.parentName, (churchName() ? churchName() + ' ' : '') + 'Kids Church · exported ' + fmtDate(Date.now()), '');
  L.push('Parent or carer: ' + f.parentName, 'Mobile: ' + f.phone, 'Other adults allowed to collect: ' + (f.adults.map(x => x.name).join(', ') || 'none'), 'Must not collect: ' + (f.blocked || 'none'), '');
  L.push('Children:'); f.children.forEach(k => L.push('  ' + k.name + ' · group ' + (G[k.group] ? G[k.group].ages : '?') + (k.notes ? ' · ' + k.notes : '')));
  L.push('', 'Privacy notice shown: ' + (f.noticeAt ? fmtDate(f.noticeAt) + (f.noticeBy ? ' by ' + f.noticeBy : '') : 'not recorded'));
  L.push('Agreed to photos: ' + (f.photoConsent ? 'yes' + (f.photoConsentAt ? ', ' + fmtDate(f.photoConsentAt) : '') : 'no'), 'Photos held: ' + famPhotoIds(f).length + ' (can be viewed on the church phone)', '');
  L.push('Attendance on record (' + rows.length + '):');
  rows.forEach(c => L.push('  ' + c.date + ' · ' + c.childName + ' · in ' + fmtTime(c.inAt) + (c.droppedBy ? ' with ' + c.droppedBy : '') + (c.outAt ? ' · out ' + fmtTime(c.outAt) + ' to ' + (c.collectedBy || '?') : ' · not signed out') + (c.override ? ' · leader release: ' + c.overrideNote : '')));
  const text = L.join('\n');
  openModal(sheetHead('Family’s information') + '<p class="muted small">Everything held about this family, to give to the parent if they ask.</p><textarea class="input" id="export-text" style="min-height:300px" readonly>' + esc(text) + '</textarea><button class="btn wide mt" data-act="copy" data-text="' + esc(text) + '">Copy</button>');
}

/* ---------- Back button ---------- */
// Closes whatever is on top first; returns false when there is nothing left to go back from.
function goBack() {
  const cam = document.querySelector('.cam [data-cam=close]'); if (cam) { cam.click(); return true; }
  if (!$('#lock').hidden) return false;
  if (!$('#zoom').hidden) { $('#zoom').hidden = true; return true; }
  if (!$('#notice').hidden) { $('#notice').hidden = true; return true; }
  if (modalOpen()) { closeModal(); return true; }
  if (S.view === 'pickup' && S.pu.key) { setPickup(null); return true; }
  if (S.view !== 'checkin' && S.status !== 'signedout') { location.hash = '#checkin'; return true; }
  return false;
}

/* ---------- Photos ---------- */
const photoCache = new Map(), photoReq = new Map();
const isPhoto = v => /^data:image\/(jpeg|png|webp);base64,/.test(v);
function getPhoto(id) {
  if (photoCache.has(id)) return Promise.resolve(photoCache.get(id));
  if (photoReq.has(id)) return photoReq.get(id);
  if (!S.db) return Promise.resolve('');
  const p = S.db.doc('photos/' + id).get()
    .then(d => { const v = d.exists ? str((d.data() || {}).d) : ''; const ok = isPhoto(v) ? v : ''; photoCache.set(id, ok); photoReq.delete(id); return ok; })
    .catch(() => { photoReq.delete(id); return ''; });
  photoReq.set(id, p); return p;
}
function hydrate() {
  document.querySelectorAll('img[data-ph]:not([data-ok])').forEach(img => {
    img.dataset.ok = '1';
    getPhoto(img.dataset.ph).then(v => { if (v) img.src = v; else img.remove(); });
  });
}
new MutationObserver(hydrate).observe(document.body, { childList: true, subtree: true });
async function savePending(ids, kind) {
  for (const id of ids) {
    if (!S.pending.has(id)) continue;
    const d = S.pending.get(id);
    await write(() => S.db.doc('photos/' + id).set({ d, kind, date: kind === 'profile' ? PROFILE_DATE : S.today, at: Date.now() }));
    S.pending.delete(id);
  }
}
function dropPhotos(ids) { ids.forEach(id => { photoCache.delete(id); write(() => S.db.doc('photos/' + id).delete()).catch(() => {}); }); }
function famPhotoIds(f) { return [f.parentPhoto, ...f.adults.map(a => a.photo), ...f.children.map(k => k.photo)].filter(Boolean); }

/* ---------- Normalise stored data ---------- */
function normFamily(id, d) {
  d = d || {};
  const kids = Array.isArray(d.children) ? d.children.filter(k => k && typeof k === 'object').map((k, i) => ({
    id: str(k.id).slice(0, 40) || ('k' + i), name: str(k.name).slice(0, 60), group: str(k.group).slice(0, 40), notes: str(k.notes).slice(0, 200), photo: str(k.photo).slice(0, 40)
  })) : [];
  // Older records kept the extra adults as one line of text ("Grandma Joy, Uncle Sam").
  const adults = Array.isArray(d.adults)
    ? d.adults.filter(a => a && typeof a === 'object').map((a, i) => ({ id: str(a.id).slice(0, 40) || ('a' + i), name: str(a.name).slice(0, 80), photo: str(a.photo).slice(0, 40) }))
    : splitNames(d.pickups).map((n, i) => ({ id: 'a' + i, name: n.slice(0, 80), photo: '' }));
  return { id, parentName: str(d.parentName).slice(0, 80), phone: str(d.phone).slice(0, 30), parentPhoto: str(d.parentPhoto).slice(0, 40),
    adults: adults.filter(a => a.name), blocked: str(d.blocked).slice(0, 200), children: kids, createdAt: +d.createdAt || 0,
    noticeAt: +d.noticeAt || 0, noticeBy: str(d.noticeBy).slice(0, 60), photoConsent: d.photoConsent === true, photoConsentAt: +d.photoConsentAt || 0, lastSeen: str(d.lastSeen).slice(0, 10) };
}
function allowedAdults(f) {
  const out = [], seen = new Set();
  [{ name: f.parentName, photo: f.parentPhoto }, ...f.adults].forEach(a => { const k = a.name.trim().toLowerCase(); if (k && !seen.has(k)) { seen.add(k); out.push({ name: a.name.trim(), photo: a.photo || '' }); } });
  return out;
}
function normCheckin(id, d) {
  d = d || {};
  let adults = Array.isArray(d.adults) ? d.adults.filter(a => a && typeof a === 'object').map(a => ({ name: str(a.name).slice(0, 80), photo: str(a.photo).slice(0, 40) })).filter(a => a.name) : [];
  if (!adults.length) adults = [str(d.parentName), ...splitNames(d.pickups)].filter(Boolean).map(n => ({ name: n.slice(0, 80), photo: '' }));
  return {
    id, date: str(d.date), code: str(d.code).toUpperCase().slice(0, 8), pass: str(d.pass).slice(0, 40), familyId: str(d.familyId), childId: str(d.childId),
    childName: str(d.childName).slice(0, 60) || '(no name)', childPhoto: str(d.childPhoto).slice(0, 40), group: str(d.group).slice(0, 40), notes: str(d.notes).slice(0, 200),
    parentName: str(d.parentName).slice(0, 80), phone: str(d.phone).slice(0, 30), adults, blocked: str(d.blocked).slice(0, 200),
    droppedBy: str(d.droppedBy).slice(0, 80), dropPhoto: str(d.dropPhoto).slice(0, 40),
    visitor: !!d.visitor, status: d.status === 'out' ? 'out' : 'in', inAt: +d.inAt || 0, inBy: str(d.inBy), inByName: str(d.inByName).slice(0, 60),
    outAt: +d.outAt || 0, outBy: str(d.outBy), outByName: str(d.outByName).slice(0, 60),
    collectedBy: str(d.collectedBy).slice(0, 80), override: !!d.override, overrideNote: str(d.overrideNote).slice(0, 240)
  };
}
function activeByChild() { const m = new Map(); for (const c of S.checkins) if (c.status === 'in') m.set(c.familyId + '|' + c.childId, c); return m; }

/* ---------- Writes ---------- */
// In cloud mode a write is saved on the phone at once and synced when there is signal,
// so we never make a volunteer wait for the network at the door.
function write(fn) {
  const p = Promise.resolve().then(fn);
  if (S.mode !== 'cloud') return p;
  let settled = false;
  const q = p.then(v => { settled = true; return v; }, e => { if (settled === 'late') handleErr(e); else { settled = true; throw e; } });
  return Promise.race([q, sleep(navigator.onLine === false ? 120 : 1500).then(() => { if (settled !== true) settled = 'late'; })]);
}
function handleErr(e) {
  const code = e && e.code;
  if (code === 'permission-denied') toast('This account is not allowed to change the register.');
  else if (code === 'resource-exhausted') toast('Storage is full. Delete old records in Setup.');
  else toast('Could not save. Please try again.');
  if (window.console) console.warn(e);
}
function guardWrite() {
  if (!S.db) { toast('Not connected to the register.'); return false; }
  if (S.busy) return false;
  return true;
}
async function busy(btn, label, fn) {
  S.busy = true;
  const old = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = label; }
  try { return await fn(); }
  catch (e) { handleErr(e); }
  finally { S.busy = false; if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = old; } }
}

/* ---------- UI primitives ---------- */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2800); }
function openModal(html) { $('#sheet').innerHTML = html; $('#overlay').classList.add('open'); document.body.style.overflow = 'hidden'; $('#sheet').scrollTop = 0; }
function closeModal() { $('#overlay').classList.remove('open'); $('#sheet').innerHTML = ''; document.body.style.overflow = ''; S.sheetFam = null; S.drop = ''; }
function modalOpen() { return $('#overlay').classList.contains('open'); }
function sheetHead(title) { return '<div class="sheet-head"><h2>' + esc(title) + '</h2><button class="iconbtn" data-act="close" aria-label="Close">×</button></div>'; }
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch (e) { openModal(sheetHead('Copy this') + '<p class="muted small">Press and hold to select, then copy.</p><textarea class="input" style="min-height:220px;padding:12px" readonly>' + esc(text) + '</textarea>'); }
}

/* ---------- Header / banner ---------- */
const SHIELD = $('.bar .logo').innerHTML; let shownLogo = '';
function renderHeader() {
  $('#church').textContent = churchName() || 'Kids Church';
  if (shownLogo !== S.settings.logo) { shownLogo = S.settings.logo; $('.bar .logo').innerHTML = shownLogo ? '<img src="' + shownLogo + '" alt="">' : SHIELD; }
  let d = ''; try { d = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }); } catch (e) {}
  $('#date').textContent = d;
  $('#dot').className = 'dot ' + ({ live: 'live', local: 'live', connecting: 'stale', offline: 'offline', signedout: 'offline' }[S.status] || '');
  $('#statusText').textContent = ({ connecting: 'Connecting…', live: 'Live', local: 'This phone', offline: 'Offline', signedout: 'Signed out' })[S.status] || '';
}
function renderBanner() {
  let h = '';
  if (S.status === 'offline' && S.db) h += '<div class="banner warn">No signal. You can keep working: changes are saved on this phone and shared when it’s back online.</div>';
  $('#banner').innerHTML = h;
}

/* ---------- Views ---------- */
const VIEW_HTML = {
  checkin: () =>
    '<div id="today"></div>' +
    '<h1>Check in</h1><p class="sub">Find the family, tap it, check the children in.</p>' +
    '<div class="search">' + ICON.search + '<input id="ci-q" class="input" type="search" placeholder="Parent, child or phone" autocomplete="off" autocorrect="off" spellcheck="false"></div>' +
    '<button class="btn ghost wide" data-act="new-family">' + ICON.plus + 'New family or visitor</button>' +
    '<div id="ci-results"></div>',
  pickup: () =>
    '<h1>Pickup</h1><p class="sub">Open the family’s pass, then check faces before you release.</p>' +
    '<div id="pu-counts"></div>' +
    '<button class="scanbtn" data-act="scan"><span class="ic">' + ICON.scan + '</span><span><span class="t">Scan pickup pass</span><br><span class="s">The QR code on the parent’s phone</span></span></button>' +
    '<div class="or">or type the code</div>' +
    '<input id="pu-code" class="code-input" maxlength="4" placeholder="····" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" aria-label="Pickup code">' +
    '<div id="pu-result"></div>' +
    '<button class="btn line wide mt16" data-act="lost-code">Parent has no pass or code?</button>',
  rooms: () => '<h1>Rooms</h1><p class="sub">Who is in each group right now.</p><div id="rooms-body"></div>',
  families: () =>
    '<h1>Families</h1><p class="sub">Saved families. Tap one to edit or add photos.</p>' +
    '<div class="search">' + ICON.search + '<input id="fam-q" class="input" type="search" placeholder="Search families" autocomplete="off" autocorrect="off" spellcheck="false"></div>' +
    '<button class="btn ghost wide" data-act="new-family-only">' + ICON.plus + 'Add a family</button>' +
    '<div id="fam-list"></div>',
  setup: () => setupHtml(),
};
function signInHtml() {
  return '<div class="card mt16"><h1 style="font-size:24px">Volunteer sign-in</h1><p class="muted">Use the email and password your church admin gave you.</p>' +
    '<form data-form="signin" novalidate><label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="username" autocapitalize="none"></label>' +
    '<label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="current-password"></label>' +
    '<div id="form-err" class="banner bad" hidden></div><button class="btn wide" type="submit">Sign in</button>' +
    '<button type="button" class="linkbtn" data-act="reset-pw">Forgot password?</button></form></div>';
}
function renderView() {
  document.querySelectorAll('[data-view]').forEach(a => a.classList.toggle('on', a.dataset.view === S.view));
  document.body.classList.toggle('auth', S.status === 'signedout');
  const v = $('#view');
  if (S.status === 'signedout') { v.innerHTML = signInHtml(); refreshChrome(); return; }
  v.innerHTML = VIEW_HTML[S.view]();
  if (S.view === 'checkin') $('#ci-q').value = S.q.checkin;
  if (S.view === 'pickup') $('#pu-code').value = (S.pu.key && S.pu.key.t === 'code') ? S.pu.key.v : '';
  if (S.view === 'families') $('#fam-q').value = S.q.families;
  refresh();
}
function refreshChrome() { renderHeader(); renderBanner(); }
function refresh() {
  refreshChrome();
  if (S.status === 'signedout') return;
  ({ checkin: renderCheckinResults, pickup: renderPickup, rooms: renderRooms, families: renderFamilies, setup: renderSetupDyn }[S.view] || (() => {}))();
}

/* ----- Check-in ----- */
function familyMatches(q) {
  const arr = [...S.families.values()];
  const n = q.trim().toLowerCase(); const nd = n.replace(/\D/g, '');
  let res = arr;
  if (n) res = arr.filter(f => f.parentName.toLowerCase().includes(n) || f.adults.some(a => a.name.toLowerCase().includes(n)) ||
    f.children.some(k => k.name.toLowerCase().includes(n)) || (nd.length >= 3 && digitsOnly(f.phone).includes(nd)));
  return res.sort((a, b) => a.parentName.localeCompare(b.parentName));
}
function familyCard(f, act) {
  const kids = f.children.map(k => {
    const c = act.get(f.id + '|' + k.id);
    return c ? '<span class="chip in">' + gdot(k.group) + esc(k.name) + ' · <span class="code">' + esc(c.code) + '</span></span>'
             : '<span class="chip">' + gdot(k.group) + esc(k.name) + '</span>';
  }).join('');
  const allIn = f.children.length && f.children.every(k => act.has(f.id + '|' + k.id));
  return '<button class="card" data-act="open-family" data-id="' + esc(f.id) + '"><div class="famrow">' + av(f.parentName, f.parentPhoto) +
    '<div class="grow"><div class="row between"><span class="fname">' + esc(f.parentName || '(no name)') + '</span>' +
    (allIn ? '<span class="tag ok">All in</span>' : '<span class="muted small">' + esc(maskPhone(f.phone)) + '</span>') + '</div></div></div><div class="chips">' + kids + '</div></button>';
}
function renderToday() {
  const el = $('#today'); if (!el) return;
  if (!S.checkinsLoaded) { el.innerHTML = ''; return; }
  const inN = S.checkins.filter(c => c.status === 'in').length;
  el.innerHTML = '<div class="today"><div class="in"><b>' + inN + '</b><span>In now</span></div><div><b>' + (S.checkins.length - inN) + '</b><span>Collected</span></div><div><b>' + S.families.size + '</b><span>Families</span></div></div>';
}
function renderCheckinResults() {
  renderToday();
  const el = $('#ci-results'); if (!el) return;
  if (!S.db || !S.familiesLoaded) { el.innerHTML = skelHtml(); return; }
  if (!S.families.size) { el.innerHTML = emptyHtml('No families yet', 'Tap “New family or visitor” to add the first one. Saved families are here next week, so you just search and tap.'); return; }
  const list = familyMatches(S.q.checkin);
  if (!list.length) { el.innerHTML = emptyHtml('No match', 'Check the spelling, or add them as a new family.'); return; }
  const act = activeByChild();
  el.innerHTML = '<div class="list">' + list.slice(0, 80).map(f => familyCard(f, act)).join('') + '</div>' +
    (list.length > 80 ? '<p class="muted small center">Showing 80 of ' + list.length + '. Type to narrow down.</p>' : '');
}
function blockedHtml(names) {
  return names ? '<div class="stop">' + ICON.stop + '<div><div>Must NOT collect</div><div style="font-size:18px">' + esc(names) + '</div></div></div>' : '';
}
// The check-in sheet. `fam` is a saved family, or a one-off visitor that is not stored.
function openFamilySheet(fam, visitor) {
  if (!fam) return;
  S.sheetFam = null; // closeModal() below must not clear the new one
  const act = activeByChild();
  const adults = allowedAdults(fam);
  const kids = fam.children.map(k => {
    const c = act.get(fam.id + '|' + k.id);
    return '<label class="kid' + (c ? ' done' : '') + '"><input type="checkbox" name="kid" value="' + esc(k.id) + '"' + (c ? ' disabled' : ' checked') + '>' + av(k.name, k.photo) +
      '<div class="grow"><div class="name">' + esc(k.name) + '</div><div class="row wrap">' + grpBadge(k.group) + notesHtml(k.notes) + '</div>' +
      (c ? '<div class="muted small mt8">Already in · code <span class="code">' + esc(c.code) + '</span></div>' : '') + '</div></label>';
  }).join('');
  const anyLeft = fam.children.some(k => !act.has(fam.id + '|' + k.id));
  const dropper = adults.length > 1
    ? '<div class="h3">Who is dropping off?</div><div class="choice">' + adults.map((a, i) => '<label><input type="radio" name="dropper" value="' + esc(a.name) + '"' + (i ? '' : ' checked') + '><span>' + av(a.name, a.photo, 's') + esc(a.name) + '</span></label>').join('') + '</div>'
    : '';
  const photo = (S.settings.dropPhoto && fam.photoConsent && anyLeft)
    ? '<div class="h3">Today’s safety photo</div><button type="button" class="dropslot" data-act="drop-photo"><span class="ic">' + ICON.camera + '</span><span class="grow"><span class="t">Take a photo of the adult with the children</span><br><span class="muted small">Shown at pickup so the right child goes home with the right adult. Deleted after they’re collected.</span></span></button>'
    : '';
  openModal(sheetHead(fam.parentName || 'Family') +
    '<form data-form="checkin">' +
    (fam.children.length ? kids : '<p class="muted">No children saved for this family yet.</p>') +
    blockedHtml(fam.blocked) + (fam.noticeAt ? '' : '<div class="banner warn block mt">This family has not been shown the privacy notice yet. Tap “Edit family details” to record it.</div>') + dropper + photo +
    '<button class="btn ok wide mt16" type="submit"' + (anyLeft ? '' : ' disabled') + '>' + (anyLeft ? 'Check in' : 'Everyone is checked in') + '</button>' +
    (visitor ? '' : '<button type="button" class="btn line wide mt" data-act="edit-family" data-id="' + esc(fam.id) + '">Edit family details</button>') +
    '</form>');
  S.sheetFam = fam; S.sheetVisitor = !!visitor; S.drop = '';
}
async function takeDropPhoto(btn) {
  const out = await window.Cam.photo({ title: 'Today’s safety photo', hint: 'Adult and children together, faces clear.', shape: 'wide', canRemove: !!S.drop });
  if (out === null || !btn.isConnected) return;
  S.drop = out;
  btn.classList.toggle('has', !!out);
  btn.querySelector('.ic').innerHTML = out ? '<img src="' + out + '" alt="">' : ICON.camera;
  btn.querySelector('.t').textContent = out ? 'Photo taken ✓  Tap to retake' : 'Take a photo of the adult with the children';
}
async function doCheckin(fam, kidIds, o) {
  const act = activeByChild();
  const kids = fam.children.filter(k => kidIds.includes(k.id) && !act.has(fam.id + '|' + k.id));
  if (!kids.length) { toast('Those children are already checked in.'); return; }
  const sibling = S.checkins.find(c => c.familyId === fam.id && c.status === 'in');
  const code = sibling ? sibling.code : genCode();
  const pass = (sibling && sibling.pass) ? sibling.pass : randomFrom('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 16);
  let dropPhoto = sibling ? sibling.dropPhoto : '';
  if (o.drop) { dropPhoto = rid(); photoCache.set(dropPhoto, o.drop); S.pending.set(dropPhoto, o.drop); await savePending([dropPhoto], 'drop'); }
  await savePending(famPhotoIds(fam), o.visitor ? 'day' : 'profile');
  const adults = allowedAdults(fam);
  const now = Date.now();
  for (const k of kids) {
    const ref = S.db.collection('checkins').doc();
    const body = {
      date: S.today, code, pass, familyId: fam.id, childId: k.id, childName: k.name, childPhoto: k.photo || '', group: k.group, notes: k.notes,
      parentName: fam.parentName, phone: fam.phone, adults, blocked: fam.blocked || '', droppedBy: o.droppedBy || fam.parentName, dropPhoto,
      visitor: !!o.visitor, status: 'in', inAt: now, inBy: S.me.id, inByName: S.me.name || '',
      outAt: 0, outBy: '', outByName: '', collectedBy: '', override: false, overrideNote: ''
    };
    await write(() => ref.set(body));
  }
  if (!o.visitor) write(() => S.db.collection('families').doc(fam.id).update({ lastSeen: S.today })).catch(() => {});
  showSuccess(fam, kids, code, pass, !!sibling);
}
function stickerHtml(k, code) {
  const g = G[k.group] || { color: '#BBB', ages: '' };
  return '<div class="sticker" style="border-color:' + g.color + '"><span class="sdot" style="background:' + g.color + '"></span><span class="sname">' + esc(k.name) + '</span>' +
    '<span class="sgrp">' + esc(g.ages) + '</span><span class="code scode">' + esc(code) + '</span>' + (k.notes ? '<span class="alert" title="' + esc(k.notes) + '">⚠</span>' : '') + '</div>';
}
function showSuccess(fam, kids, code, pass, reused) {
  const names = kids.map(k => k.name);
  const msg = pickupMessage(fam.parentName, names, code);
  const hasPhone = digitsOnly(fam.phone).length >= 7;
  buzz(30);
  openModal(sheetHead('Checked in ✓') +
    '<div class="pass"><div class="lbl">Pickup pass · today only</div><div class="qr">' + qrSvg(PASS_PREFIX + pass) + '</div>' +
    '<div class="bigcode">' + esc(code) + '</div><div class="who">' + esc(joinNames(names)) + '</div>' +
    (reused ? '<div class="small mt8" style="opacity:.9">Same pass as their brother or sister already here.</div>' : '') + '</div>' +
    '<div class="h3">1. Parent photographs this pass</div><p class="muted small" style="margin:0">They show the photo at pickup and you scan it. No signal needed.</p>' +
    '<div class="h3">2. Label each child</div><p class="muted small" style="margin:0">Write the name and code on a sticker and put it on the child’s back.</p>' +
    kids.map(k => stickerHtml(k, code)).join('') +
    '<div class="h3">3. Or send the code to ' + esc(first(fam.parentName) || 'the parent') + '</div>' +
    (hasPhone ? '<div class="grid2 mt8"><a class="btn wa" href="' + esc(waHref(fam.phone, msg)) + '" target="_blank" rel="noopener">WhatsApp</a><a class="btn ghost" href="' + esc(smsHref(fam.phone, msg)) + '">Text (SMS)</a></div>' : '<p class="muted small">No mobile number saved.</p>') +
    '<button class="btn line wide mt" data-act="copy" data-text="' + esc(msg) + '">Copy message</button>' +
    '<button class="btn wide mt" data-act="close">Done</button>');
}

/* ----- Family form ----- */
function phSlot(photo, title) {
  return '<button type="button" class="phslot' + (photo ? ' has' : '') + '" data-act="photo" data-photo="' + esc(photo || '') + '" data-title="' + esc(title) + '" aria-label="' + esc(title) + '">' + ICON.camera + (photo ? '<img data-ph="' + esc(photo) + '" alt="">' : '') + '</button>';
}
function kidRow(k) {
  return '<div class="kidrow" data-kid="' + esc(k.id) + '"><div class="g">' + phSlot(k.photo, 'Photo of child') +
    '<input class="input" name="kname" placeholder="Child’s first name" value="' + esc(k.name) + '" autocomplete="off" autocorrect="off" aria-label="Child’s first name">' +
    '<select class="input" name="kgroup" aria-label="Age group"><option value="">Age…</option>' + GROUPS.map(g => '<option value="' + g.id + '"' + (k.group === g.id ? ' selected' : '') + '>' + esc(g.ages) + (g.name ? ' · ' + esc(g.name) : '') + '</option>').join('') + '</select></div>' +
    '<input class="input mt8" name="knotes" placeholder="Allergies or medical needs (optional)" value="' + esc(k.notes) + '" autocomplete="off" aria-label="Allergies or medical needs">' +
    '<button type="button" class="linkbtn" data-act="remove-kid">Remove this child</button></div>';
}
function adultRow(a) {
  return '<div class="adultrow" data-adult="' + esc(a.id) + '">' + phSlot(a.photo, 'Photo of this adult') +
    '<input class="input" name="aname" placeholder="Full name, e.g. Grandma Joy" value="' + esc(a.name) + '" autocomplete="off" autocorrect="off" aria-label="Adult’s name">' +
    '<button type="button" class="iconbtn" data-act="remove-adult" aria-label="Remove this adult">×</button></div>';
}
function openFamilyForm(id, opts) {
  opts = opts || {};
  const f = id ? S.families.get(id) : null;
  const kids = f && f.children.length ? f.children : [{ id: rid(), name: '', group: '', notes: '', photo: '' }];
  openModal(sheetHead(f ? 'Edit family' : 'New family') +
    '<form data-form="family"' + (f ? ' data-id="' + esc(f.id) + '"' : '') + (f && f.photoConsent ? '' : ' class="nophoto"') + ' novalidate>' +
    '<div class="label">Parent or carer</div><div class="withph field">' + phSlot(f ? f.parentPhoto : '', 'Photo of parent or carer') +
    '<input class="input" name="parentName" value="' + esc(f ? f.parentName : '') + '" placeholder="Full name" autocomplete="off" autocorrect="off" aria-label="Parent or carer’s name"></div>' +
    '<label class="field"><span>Mobile number</span><input class="input" name="phone" type="tel" inputmode="tel" value="' + esc(f ? f.phone : '') + '" placeholder="07…" autocomplete="off"></label>' +
    '<div class="field"><span>Other adults allowed to collect <em class="muted">(optional)</em></span><div id="adultrows">' + (f ? f.adults.map(adultRow).join('') : '') + '</div>' +
    '<button type="button" class="btn ghost wide" data-act="add-adult">' + ICON.plus + 'Add an adult</button></div>' +
    '<label class="field"><span>Must NOT collect <em class="muted">(optional)</em></span><input class="input" name="blocked" value="' + esc(f ? f.blocked : '') + '" placeholder="Names of anyone who must not collect" autocomplete="off"></label>' +
    '<div class="field"><span>Children</span><div id="kidrows">' + kids.map(kidRow).join('') + '</div>' +
    '<button type="button" class="btn ghost wide" data-act="add-kid">' + ICON.plus + 'Add another child</button></div>' +
    '<div class="label">Privacy</div><div class="consent" id="consent">' +
    '<label class="checkline"><input type="checkbox" name="noticeOk"' + (f && f.noticeAt ? ' checked' : '') + '><span>Parent has been shown the privacy notice<small>' + (f && f.noticeAt ? 'Recorded ' + esc(fmtDate(f.noticeAt)) + (f.noticeBy ? ' by ' + esc(f.noticeBy) : '') : 'They need to know what we keep, and why.') + '</small></span></label>' +
    '<button type="button" class="btn small ghost" data-act="show-notice" style="margin:0 0 4px 32px">Show the notice</button>' +
    '<label class="checkline"><input type="checkbox" name="photoOk"' + (f && f.photoConsent ? ' checked' : '') + '><span>Parent agrees to photos for safe pickup<small>Optional. Tick this to use the camera circles above. Untick it at any time and the photos are deleted.</small></span></label></div>' +
    (f ? '' : '<label class="checkline"><input type="checkbox" name="save" checked> Save this family for future Sundays</label>') +
    '<div id="form-err" class="banner bad" hidden></div>' +
    (f ? '<button class="btn wide" type="submit" data-mode="save">Save changes</button><button class="btn line wide mt" type="button" data-act="export-family" data-id="' + esc(f.id) + '">See everything we hold on this family</button><button class="btn dangerline wide mt" type="button" data-act="delete-family" data-id="' + esc(f.id) + '">Delete family and all their records</button>'
       : (opts.saveOnly ? '<button class="btn wide" type="submit" data-mode="save">Save family</button>'
                        : '<button class="btn ok wide" type="submit" data-mode="checkin">Next: check in</button><button class="btn line wide mt" type="submit" data-mode="save">Save only</button>')) +
    '</form>');
}
async function takeSlotPhoto(btn) {
  const out = await window.Cam.photo({ title: btn.dataset.title || 'Take a photo', hint: 'Face in the middle, good light.', shape: 'square', canRemove: !!btn.dataset.photo });
  if (out === null || !btn.isConnected) return;
  const old = btn.querySelector('img'); if (old) old.remove();
  if (!out) { btn.dataset.photo = ''; btn.classList.remove('has'); return; }
  const id = rid(); S.pending.set(id, out); photoCache.set(id, out);
  btn.dataset.photo = id; btn.classList.add('has');
  btn.insertAdjacentHTML('beforeend', '<img src="' + out + '" data-ok="1" alt="">');
}
function readFamilyForm(form) {
  const val = n => { const el = form.elements.namedItem(n); return el ? el.value.trim() : ''; };
  const noticeOk = form.elements.namedItem('noticeOk').checked, photoOk = form.elements.namedItem('photoOk').checked;
  const slot = root => { const b = root.querySelector('.phslot'); return (photoOk && b) ? (b.dataset.photo || '') : ''; };
  form.querySelectorAll('.err').forEach(e => e.classList.remove('err'));
  const data = { parentName: val('parentName').slice(0, 80), phone: val('phone').slice(0, 30), parentPhoto: slot(form.querySelector('.withph')), adults: [], blocked: val('blocked').slice(0, 200), children: [] };
  const errs = [];
  if (!data.parentName) { errs.push('Add the parent or carer’s name.'); form.elements.namedItem('parentName').classList.add('err'); }
  if (digitsOnly(data.phone).length < 7) { errs.push('Add a mobile number.'); form.elements.namedItem('phone').classList.add('err'); }
  form.querySelectorAll('.adultrow').forEach(r => {
    const name = r.querySelector('[name=aname]').value.trim().slice(0, 80);
    if (name) data.adults.push({ id: r.dataset.adult || rid(), name, photo: slot(r) });
  });
  form.querySelectorAll('.kidrow').forEach(r => {
    const n = r.querySelector('[name=kname]'), g = r.querySelector('[name=kgroup]'), no = r.querySelector('[name=knotes]');
    const k = { id: r.dataset.kid || rid(), name: n.value.trim().slice(0, 60), group: g.value, notes: no.value.trim().slice(0, 200), photo: slot(r) };
    if (!k.name && !k.group && !k.notes && !k.photo) return;
    if (!k.name) { n.classList.add('err'); errs.push('Each child needs a first name.'); }
    if (!G[k.group]) { g.classList.add('err'); errs.push('Choose an age group for each child.'); }
    data.children.push(k);
  });
  if (!data.children.length) errs.push('Add at least one child.');
  data.photoConsent = photoOk;
  if (!noticeOk) { errs.push('Show the parent the privacy notice and tick the box.'); $('#consent').classList.add('err'); }
  return { data, errs: [...new Set(errs)] };
}
async function submitFamily(form, btn) {
  const { data, errs } = readFamilyForm(form);
  const errEl = $('#form-err');
  if (errs.length) { errEl.textContent = errs.join(' '); errEl.hidden = false; errEl.scrollIntoView({ block: 'nearest' }); return; }
  errEl.hidden = true;
  const id = form.dataset.id;
  const mode = S.submitMode || 'save';
  const now = Date.now();
  const prev = id ? S.families.get(id) : null;
  Object.assign(data, {
    noticeAt: (prev && prev.noticeAt) || now, noticeBy: (prev && prev.noticeAt) ? prev.noticeBy : ((S.me && S.me.name) || ''),
    photoConsentAt: data.photoConsent ? ((prev && prev.photoConsent && prev.photoConsentAt) || now) : 0, lastSeen: prev ? prev.lastSeen : ''
  });
  await busy(btn, 'Saving…', async () => {
    if (id) {
      const old = prev;
      await savePending(famPhotoIds(data), 'profile');
      await write(() => S.db.collection('families').doc(id).set(Object.assign({}, data, { createdAt: (old && old.createdAt) || now, updatedAt: now })));
      if (old) { const keep = new Set(famPhotoIds(data)); dropPhotos(famPhotoIds(old).filter(p => !keep.has(p))); }
      closeModal(); toast('Family saved');
      return;
    }
    const saveBox = form.elements.namedItem('save');
    const save = saveBox ? saveBox.checked : true;
    if (!save && mode !== 'checkin') { toast('Nothing saved. Tick “Save this family” or use “Next: check in”.'); return; }
    let fam;
    if (save) {
      const ref = S.db.collection('families').doc();
      await savePending(famPhotoIds(data), 'profile');
      await write(() => ref.set(Object.assign({}, data, { createdAt: now, updatedAt: now })));
      fam = normFamily(ref.id, Object.assign({ createdAt: now }, data));
      S.families.set(fam.id, fam);
    } else {
      fam = normFamily('v_' + rid(), data);
    }
    if (mode === 'checkin') openFamilySheet(fam, !save);
    else { closeModal(); toast('Family saved'); }
  });
}

/* ----- Pickup ----- */
function setPickup(key) {
  S.pu = newPickup(key); S.puDone = null;
  const inp = $('#pu-code'); if (inp && (!key || key.t !== 'code')) inp.value = '';
  renderPickup();
  if (key) { const el = $('#pu-result'); if (el && el.firstElementChild) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
}
function pickupMatches() {
  const k = S.pu.key; if (!k) return [];
  return S.checkins.filter(c => k.t === 'pass' ? (c.pass && c.pass === k.v) : c.code === k.v);
}
async function doScan() {
  const text = await window.Cam.scan();
  if (text == null) return;
  if (!text.startsWith(PASS_PREFIX)) { buzz([60, 60, 60]); toast('That QR code is not a pickup pass.'); return; }
  setPickup({ t: 'pass', v: text.slice(PASS_PREFIX.length) });
  buzz(pickupMatches().length ? 40 : [80, 60, 80]);
}
function renderPickupCounts() {
  const el = $('#pu-counts'); if (!el) return;
  if (!S.checkinsLoaded) { el.innerHTML = ''; return; }
  const inN = S.checkins.filter(c => c.status === 'in').length, outN = S.checkins.length - inN;
  el.innerHTML = '<div class="counts"><span class="tag ok">' + inN + ' still in</span><span class="tag">' + outN + ' collected</span></div>';
}
function faceTile(photo, title, sub) {
  return '<button type="button" class="face" data-act="zoom" data-photo="' + esc(photo) + '"><div class="pic"><img data-ph="' + esc(photo) + '" alt="' + esc(title) + '"></div><div class="cap">' + esc(title) + '<small>' + esc(sub) + '</small></div></button>';
}
function renderPickup() {
  renderPickupCounts();
  const el = $('#pu-result'); if (!el) return;
  const k = S.pu.key;
  if (!k) {
    el.innerHTML = S.puDone ? '<div class="donebox"><div class="t">✓ Released</div><div class="strong">' + esc(S.puDone.names) + ' to ' + esc(S.puDone.who) + ' at ' + esc(S.puDone.time) + '</div><div class="small" style="opacity:.9;margin-top:4px">Take the sticker off each child as they leave.</div></div>' : '';
    return;
  }
  if (!S.checkinsLoaded) { el.innerHTML = '<p class="muted">Loading today’s register…</p>'; return; }
  const matches = pickupMatches();
  if (!matches.length) {
    el.innerHTML = '<div class="match bad"><h2>✕ ' + (k.t === 'pass' ? 'This pass is not for today' : 'No match for <span class="code">' + esc(k.v) + '</span>') + '</h2>' +
      '<p style="margin:6px 0 12px"><strong>Do not release a child.</strong> Passes and codes change every week. Check with the parent, then fetch a leader.</p>' +
      '<button class="btn line wide" data-act="lost-code">Find the child by name (leader)</button></div>';
    return;
  }
  const inKids = matches.filter(c => c.status === 'in'), outKids = matches.filter(c => c.status !== 'in');
  const ref = inKids[0] || matches[0];
  const adults = ref.adults;
  const pu = S.pu;
  if (pu.who !== '__other' && !adults.some(a => a.name === pu.who)) pu.who = adults.some(a => a.name === ref.droppedBy) ? ref.droppedBy : (adults[0] ? adults[0].name : '__other');
  const sel = adults.find(a => a.name === pu.who) || null;
  const selected = inKids.filter(c => !pu.skip.has(c.id));
  const outHtml = outKids.map(c => '<div class="kid out">' + av(c.childName, c.childPhoto) + '<div class="grow"><div class="name">' + esc(c.childName) + '</div><div class="muted small">Collected at ' + esc(fmtTime(c.outAt)) + ' by ' + esc(c.collectedBy || 'someone') + '</div></div></div>').join('');
  let h = '<div class="match ok"><div class="row between"><h2>✓ Pass found</h2><button class="btn small line" data-act="clear-pickup">Clear</button></div>' +
    '<div class="strong">' + esc(ref.parentName) + '’s family · code <span class="code">' + esc(ref.code) + '</span></div>' + blockedHtml(ref.blocked);
  if (!inKids.length) { el.innerHTML = h + outHtml + '<div class="banner ok mt">Everyone on this pass has been collected.</div></div>'; return; }

  h += '<div class="step"><i>1</i>Who is collecting?</div><div class="choice">' +
    adults.map(a => '<label><input type="radio" name="pu-who" value="' + esc(a.name) + '"' + (pu.who === a.name ? ' checked' : '') + '><span>' + av(a.name, a.photo, 's') + esc(a.name) + '</span></label>').join('') +
    '<label><input type="radio" name="pu-who" value="__other"' + (pu.who === '__other' ? ' checked' : '') + '><span class="noav">Someone else</span></label></div>';

  const kidsHtml = inKids.map(c => '<label class="kid"><input type="checkbox" data-pu="' + esc(c.id) + '"' + (pu.skip.has(c.id) ? '' : ' checked') + '>' + av(c.childName, c.childPhoto) +
    '<div class="grow"><div class="name">' + esc(c.childName) + '</div><div class="row wrap">' + grpBadge(c.group) + '<span class="muted small">in at ' + esc(fmtTime(c.inAt)) + '</span>' + notesHtml(c.notes) + '</div></div></label>').join('');

  if (!sel) {
    h += '<div class="banner warn block mt">This adult is not on the family’s list. Only a leader can release, after confirming with the parent.</div>' +
      '<div class="step"><i>2</i>Children</div>' + kidsHtml + outHtml +
      '<button class="btn wide mt16" data-act="release"' + (selected.length ? '' : ' disabled') + '>Leader release…</button></div>';
    el.innerHTML = h; return;
  }
  const sameAsDrop = sel.name === ref.droppedBy;
  const drops = [...new Set(inKids.map(c => c.dropPhoto).filter(Boolean))];
  const tiles = drops.map(p => faceTile(p, 'Today’s drop-off', (ref.droppedBy ? 'with ' + ref.droppedBy : '') + (ref.inAt ? ' · ' + fmtTime(ref.inAt) : ''))).join('') +
    (sel.photo ? faceTile(sel.photo, sel.name, 'Saved photo') : '');
  const hasFace = !!sel.photo || (sameAsDrop && drops.length > 0);
  h += '<div class="step"><i>2</i>Check the face</div>' +
    (tiles ? '<div class="faces">' + tiles + '</div>' : '') +
    (!sameAsDrop && ref.droppedBy ? '<div class="banner warn block mt8">' + esc(sel.name) + ' did not drop off today (' + esc(ref.droppedBy) + ' did).' + (sel.photo ? ' Compare with their saved photo.' : '') + '</div>' : '') +
    (!hasFace ? '<div class="banner info block mt8">No photo of ' + esc(sel.name) + ' yet. Ask their full name. If you don’t know them, fetch a leader.</div>' : '') +
    '<div class="step"><i>3</i>Children going home</div>' + kidsHtml + outHtml +
    '<label class="tick' + (pu.c1 ? ' on' : '') + '"><input type="checkbox" data-tick="c1"' + (pu.c1 ? ' checked' : '') + '><span>' + (hasFace ? 'The adult’s face matches the photo' : 'I know this is ' + esc(sel.name)) + '<small>' + (hasFace ? 'Look at them, then at the screen.' : 'A leader or I can vouch for them.') + '</small></span></label>' +
    '<label class="tick' + (pu.c2 ? ' on' : '') + '"><input type="checkbox" data-tick="c2"' + (pu.c2 ? ' checked' : '') + '><span>Each child’s sticker says <span class="code">' + esc(ref.code) + '</span><small>Right name, right code, right child.</small></span></label>' +
    '<button class="btn ok wide mt16" data-act="release"' + (selected.length && pu.c1 && pu.c2 ? '' : ' disabled') + '>' +
    (!selected.length ? 'Tick a child to release' : (pu.c1 && pu.c2 ? 'Release ' + esc(joinNames(selected.map(c => c.childName))) : 'Tick both checks to release')) + '</button></div>';
  el.innerHTML = h;
}
async function release(ids, collectedBy, override, note, btn) {
  const cs = ids.map(id => S.checkins.find(c => c.id === id)).filter(c => c && c.status === 'in');
  if (!cs.length) { toast('Already collected.'); return; }
  const now = Date.now();
  await busy(btn, 'Releasing…', async () => {
    for (const c of cs) {
      await write(() => S.db.collection('checkins').doc(c.id).update({ status: 'out', outAt: now, outBy: S.me.id, outByName: S.me.name || '', collectedBy, override: !!override, overrideNote: note || '' }));
    }
    // The drop-off photo has done its job once nobody on it is left in the room.
    const gone = new Set(cs.map(c => c.id));
    const stale = [...new Set(cs.map(c => c.dropPhoto).filter(Boolean))].filter(p => !S.checkins.some(c => c.dropPhoto === p && c.status === 'in' && !gone.has(c.id)));
    dropPhotos(stale);
    S.puDone = { names: joinNames(cs.map(c => c.childName)), who: collectedBy, time: fmtTime(now) };
    S.pu = newPickup(null);
    if (modalOpen()) closeModal();
    buzz(30);
    if (S.view !== 'pickup') { location.hash = '#pickup'; } else { const inp = $('#pu-code'); if (inp) inp.value = ''; renderPickup(); }
    toast('Released ✓');
  });
}
function openLostCode() {
  S.q.lost = '';
  openModal(sheetHead('Find a child by name') +
    '<div class="banner warn block">Leaders only. Release only to an adult on the child’s list, or once the parent has confirmed.</div>' +
    '<div class="search">' + ICON.search + '<input id="lc-q" class="input" type="search" placeholder="Child or parent name" autocomplete="off" autocorrect="off" spellcheck="false"></div>' +
    '<div id="lc-results"></div>');
  renderLost();
}
function renderLost() {
  const el = $('#lc-results'); if (!el) return;
  const n = S.q.lost.trim().toLowerCase();
  let list = S.checkins.filter(c => c.status === 'in');
  if (n) list = list.filter(c => c.childName.toLowerCase().includes(n) || c.parentName.toLowerCase().includes(n));
  list.sort((a, b) => a.childName.localeCompare(b.childName));
  if (!list.length) { el.innerHTML = emptyHtml(n ? 'No child found' : 'No children checked in', n ? 'Only children still in the room are listed.' : 'Nobody is waiting to be collected.'); return; }
  el.innerHTML = '<div class="list">' + list.map(c => '<button class="card" data-act="override" data-id="' + esc(c.id) + '"><div class="famrow">' + av(c.childName, c.childPhoto) + '<div class="grow"><div class="row between"><span class="fname">' + esc(c.childName) + '</span>' + grpBadge(c.group) + '</div><div class="muted small">Parent: ' + esc(c.parentName) + '</div></div></div></button>').join('') + '</div>';
}
function openOverride(ids) {
  const cs = ids.map(id => S.checkins.find(c => c.id === id)).filter(c => c && c.status === 'in');
  if (!cs.length) { toast('Already collected.'); closeModal(); return; }
  const r = cs[0];
  const drops = [...new Set(cs.map(c => c.dropPhoto).filter(Boolean))];
  openModal(sheetHead('Leader release') +
    '<div class="card"><div class="fname">' + esc(joinNames(cs.map(c => c.childName))) + '</div><div class="row wrap mt8">' + cs.map(c => grpBadge(c.group)).join('') + '</div>' +
    '<div class="small mt"><strong>Allowed to collect:</strong> ' + esc(r.adults.map(a => a.name).join(', ') || '—') + '</div>' +
    (digitsOnly(r.phone).length >= 7 ? '<div class="small mt8"><strong>Parent’s number:</strong> <a href="' + esc(telHref(r.phone)) + '">' + esc(r.phone) + '</a></div>' : '') + '</div>' +
    blockedHtml(r.blocked) +
    (drops.length || r.adults.some(a => a.photo) ? '<div class="faces mt">' + drops.map(p => faceTile(p, 'Today’s drop-off', r.droppedBy ? 'with ' + r.droppedBy : '')).join('') + r.adults.filter(a => a.photo).map(a => faceTile(a.photo, a.name, 'Saved photo')).join('') + '</div>' : '') +
    '<form data-form="override" data-ids="' + esc(cs.map(c => c.id).join(',')) + '" novalidate class="mt16">' +
    '<label class="field"><span>Full name of the adult collecting</span><input class="input" name="who" autocomplete="off" autocorrect="off"></label>' +
    '<label class="field"><span>Leader approving this</span><input class="input" name="leader" autocomplete="off" autocorrect="off"></label>' +
    '<label class="field"><span>How did you confirm who they are?</span><select class="input" name="how"><option value="">Choose…</option><option>On the list and known to the leader</option><option>Photo ID checked</option><option>Phoned the parent, who confirmed</option><option>Other</option></select></label>' +
    (S.settings.pinHash ? '<label class="field"><span>Leader PIN</span><input class="input" name="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="8"></label>' : '') +
    '<div id="form-err" class="banner bad" hidden></div>' +
    '<button class="btn ok wide" type="submit">Release</button></form>');
}

/* ----- Rooms ----- */
function renderRooms() {
  const el = $('#rooms-body'); if (!el) return;
  if (!S.db || !S.checkinsLoaded) { el.innerHTML = skelHtml(4); return; }
  const ins = S.checkins.filter(c => c.status === 'in');
  const outs = S.checkins.filter(c => c.status !== 'in').sort((a, b) => b.outAt - a.outAt);
  const stats = GROUPS.map(g => {
    const n = ins.filter(c => c.group === g.id).length;
    return '<div class="stat" style="background:' + g.soft + '"><div class="n">' + n + '</div><div class="l">' + gdot(g.id) + ' ' + esc(g.ages) + (g.name ? '<small>' + esc(g.name) + '</small>' : '') + '</div></div>';
  }).join('');
  const f = S.roomFilter;
  const seg = '<div class="seg">' + ['all', ...GROUPS.map(g => g.id)].map(id => '<button data-act="room-filter" data-id="' + id + '" class="' + (f === id ? 'on' : '') + '">' + (id === 'all' ? 'All (' + ins.length + ')' : gdot(id) + ' ' + esc(G[id].ages)) + '</button>').join('') + '</div>';
  const shown = ins.filter(c => f === 'all' || c.group === f).sort((a, b) => (GROUPS.findIndex(g => g.id === a.group) - GROUPS.findIndex(g => g.id === b.group)) || a.childName.localeCompare(b.childName));
  const rows = shown.length ? '<div class="list">' + shown.map(c =>
    '<div class="card"><div class="roomrow">' + av(c.childName, c.childPhoto) + '<div class="grow"><div class="name">' + esc(c.childName) + (c.visitor ? ' <span class="tag">Visitor</span>' : '') + '</div>' +
      '<div class="row wrap mt8">' + grpBadge(c.group) + '<span class="code small">' + esc(c.code) + '</span><span class="muted small">in ' + esc(fmtTime(c.inAt)) + (c.inByName ? ' · ' + esc(c.inByName) : '') + '</span></div>' +
      (c.notes ? '<div class="mt8">' + notesHtml(c.notes) + '</div>' : '') + '</div>' +
      '<button class="btn small ghost" data-act="contact" data-id="' + esc(c.id) + '">Parent</button></div></div>').join('') + '</div>'
    : emptyHtml(ins.length ? 'Nobody in this group' : 'No children checked in yet', ins.length ? 'Pick another group above.' : 'Children appear here as soon as they’re checked in.');
  const outHtml = outs.length ? '<details class="card mt16"><summary>Collected today (' + outs.length + ')<span class="muted">▾</span></summary>' + outs.map(c =>
    '<div class="outrow"><div class="row between"><strong>' + esc(c.childName) + '</strong>' + grpBadge(c.group) + '</div><div class="muted small">' + esc(fmtTime(c.outAt)) + ' · collected by ' + esc(c.collectedBy || '—') + (c.outByName ? ' · released by ' + esc(c.outByName) : '') + '</div>' +
      (c.override ? '<div class="small" style="color:var(--warn);font-weight:800">Leader release: ' + esc(c.overrideNote) + '</div>' : '') + '</div>').join('') + '</details>' : '';
  el.innerHTML = '<div class="stats">' + stats + '</div>' + seg + rows + outHtml +
    (S.checkins.length ? '<button class="btn line wide mt16" data-act="copy-register">Copy today’s register</button>' : '');
}
function openContact(id) {
  const c = S.checkins.find(x => x.id === id); if (!c) return;
  const ok = digitsOnly(c.phone).length >= 7;
  const msg = 'Hi ' + (first(c.parentName) || '') + ', this is Kids Church. Could you come to the ' + (G[c.group] ? G[c.group].ages : 'children’s') + ' group for ' + c.childName + ', please?';
  openModal(sheetHead('Contact parent') +
    '<div class="card"><div class="fname">' + esc(c.parentName || 'Parent') + '</div><div class="muted small mt8">For ' + esc(c.childName) + '</div>' +
    (ok ? '<div class="strong mt">' + esc(c.phone) + '</div>' : '<div class="muted mt">No number saved.</div>') + '</div>' +
    (ok ? '<div class="grid2 mt16"><a class="btn" href="' + esc(telHref(c.phone)) + '">Call</a><a class="btn wa" href="' + esc(waHref(c.phone, msg)) + '" target="_blank" rel="noopener">WhatsApp</a></div>' +
      '<a class="btn ghost wide mt" href="' + esc(smsHref(c.phone, msg)) + '">Text (SMS)</a>' +
      '<button class="btn line wide mt" data-act="copy" data-text="' + esc(c.phone) + '">Copy number</button>' : '') +
    '<button class="btn line wide mt" data-act="override" data-id="' + esc(c.id) + '">Leader release (no pass)</button>');
}
function registerText() {
  const q = s => '"' + str(s).replace(/"/g, '""') + '"';
  const rows = [...S.checkins].sort((a, b) => a.inAt - b.inAt).map(c => [c.childName, G[c.group] ? G[c.group].ages : '', c.code, fmtTime(c.inAt), c.droppedBy, fmtTime(c.outAt), c.collectedBy, c.override ? c.overrideNote : '', c.notes].map(q).join(','));
  return 'Kids Church register ' + S.today + (S.settings.churchName ? ' — ' + S.settings.churchName : '') + '\n' +
    ['Child', 'Age group', 'Code', 'In', 'Dropped off by', 'Out', 'Collected by', 'Leader release', 'Notes'].join(',') + '\n' + rows.join('\n');
}

/* ----- Families ----- */
function renderFamilies() {
  const el = $('#fam-list'); if (!el) return;
  if (!S.db || !S.familiesLoaded) { el.innerHTML = skelHtml(); return; }
  if (!S.families.size) { el.innerHTML = emptyHtml('No families yet', 'Add families here before Sunday, or during check-in.'); return; }
  const list = familyMatches(S.q.families);
  const kidsN = [...S.families.values()].reduce((n, f) => n + f.children.length, 0);
  el.innerHTML = '<p class="muted small strong" style="margin:14px 0 0">' + S.families.size + ' families · ' + kidsN + ' children</p>' +
    (list.length ? '<div class="list">' + list.map(f => {
      const faces = famPhotoIds(f).length, people = 1 + f.adults.length + f.children.length;
      return '<button class="card" data-act="edit-family" data-id="' + esc(f.id) + '"><div class="famrow">' + av(f.parentName, f.parentPhoto) + '<div class="grow"><div class="row between"><span class="fname">' + esc(f.parentName || '(no name)') + '</span>' +
        (!f.noticeAt ? '<span class="tag warn">Notice needed</span>' : !f.photoConsent ? '<span class="tag">Photos off</span>' : '<span class="tag' + (faces >= people ? ' ok' : '') + '">' + faces + '/' + people + ' photos</span>') + '</div><div class="muted small">' + esc(maskPhone(f.phone)) + (f.adults.length ? ' · +' + f.adults.length + ' adult' + (f.adults.length > 1 ? 's' : '') : '') + '</div></div></div><div class="chips">' +
        f.children.map(k => '<span class="chip">' + gdot(k.group) + esc(k.name) + ' <span class="muted">' + esc(G[k.group] ? G[k.group].ages : '') + '</span></span>').join('') + '</div>' +
        (f.children.some(k => k.notes) ? '<div class="mt8">' + notesHtml(f.children.filter(k => k.notes).map(k => k.name + ': ' + k.notes).join(' · ')) + '</div>' : '') + '</button>';
    }).join('') + '</div>' : emptyHtml('No match', 'Try another name or number.'));
}

/* ----- Setup ----- */
function setupHtml() {
  const s = S.settings, lock = getLock(), cur = s.themeColor.toUpperCase();
  const opt = (v, label, sel) => '<option value="' + v + '"' + (sel ? ' selected' : '') + '>' + label + '</option>';
  return '<h1>Setup</h1><p class="sub">Settings for this register.</p>' +
    '<form class="card" data-form="settings" novalidate>' +
    '<label class="field"><span>Church name</span><input class="input" name="churchName" value="' + esc(churchName()) + '" placeholder="e.g. Grace Chapel" autocomplete="off"></label>' +
    '<label class="field"><span>Country code for WhatsApp</span><input class="input" name="countryCode" value="' + esc(s.countryCode) + '" inputmode="numeric" placeholder="44"></label>' +
    '<p class="note">Numbers that start with 0 get this code added (44 = UK, 234 = Nigeria).</p>' +
    '<label class="field"><span>Your name <em class="muted">(shown on the register)</em></span><input class="input" name="me" value="' + esc(S.me ? S.me.name : '') + '" placeholder="e.g. Ruth" autocomplete="off"></label>' +
    '<label class="switch"><input type="checkbox" name="dropPhoto"' + (s.dropPhoto ? ' checked' : '') + '><span>Take a safety photo at drop-off</span></label>' +
    '<p class="note">One photo of the adult with the children, only for families who agreed to photos. Deleted once they’ve been collected.</p>' +
    '<button class="btn wide" type="submit">Save settings</button></form>' +

    '<div class="card mt16"><div class="h3" style="margin-top:0">Look and feel</div><div class="label">Colour</div><div class="swatches">' +
    THEMES.map(t => '<label title="' + t[0] + '"><input type="radio" name="theme" value="' + t[1] + '"' + (cur === t[1] ? ' checked' : '') + ' aria-label="' + t[0] + '"><span style="background:' + t[1] + '"></span></label>').join('') +
    '<label class="custom" title="Your own colour"><input type="color" id="theme-custom" value="' + esc(s.themeColor) + '" aria-label="Your own colour"><span></span></label></div>' +
    '<div class="label">Church logo</div><div class="logorow"><button type="button" class="phslot' + (s.logo ? ' has' : '') + '" data-act="logo" aria-label="Church logo">' + ICON.camera + (s.logo ? '<img src="' + s.logo + '" data-ok="1" alt="">' : '') + '</button><span class="muted small">Shown at the top of the app. Tap to choose a picture from the phone.</span></div></div>' +

    '<form class="card mt16" data-form="groups" novalidate><div class="h3" style="margin-top:0">Age groups</div>' +
    '<p class="muted small" style="margin-top:0">Change the ages, name or colour of each group, or add more. The order here is the order used everywhere.</p>' +
    '<div class="grouphead"><span></span><span>Ages</span><span>Name (optional)</span><span></span></div>' +
    '<div id="grouprows">' + S.settings.groups.map(groupRow).join('') + '</div>' +
    '<button type="button" class="btn ghost wide" data-act="add-group">' + ICON.plus + 'Add a group</button>' +
    '<div id="groups-err" class="banner bad mt" hidden></div><button class="btn wide mt" type="submit">Save age groups</button></form>' +

    '<form class="card mt16" data-form="pin" novalidate><div class="h3" style="margin-top:0">Leader PIN</div>' +
    '<p class="muted small" style="margin-top:0">' + (s.pinHash ? 'A PIN is set. Leader releases ask for it.' : 'Set a PIN so only leaders can release a child without a pass.') + '</p>' +
    (s.pinHash ? '<label class="field"><span>Current PIN</span><input class="input" name="old" type="password" inputmode="numeric" autocomplete="off" maxlength="8"></label>' : '') +
    '<label class="field"><span>New PIN <em class="muted">(4 to 8 digits)</em></span><input class="input" name="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="8"></label>' +
    '<div id="pin-err" class="banner bad" hidden></div><button class="btn line wide" type="submit">' + (s.pinHash ? 'Change PIN' : 'Set PIN') + '</button></form>' +

    '<form class="card mt16" data-form="privacy" novalidate><div class="h3" style="margin-top:0">Privacy and data protection</div>' +
    '<div class="facts" id="facts"></div>' +
    '<label class="field"><span>Who parents can ask about their data</span><input class="input" name="contact" value="' + esc(s.contact) + '" placeholder="e.g. Ruth Adams, 07700 900000" autocomplete="off"></label>' +
    '<label class="field"><span>Delete attendance records after</span><select class="input" name="retainDays">' + opt(30, '30 days', s.retainDays === 30) + opt(90, '3 months', s.retainDays === 90) + opt(365, '1 year', s.retainDays === 365) + '</select></label>' +
    '<label class="field"><span>Delete families who have stopped coming</span><select class="input" name="familyMonths">' + opt(0, 'Never (delete by hand)', !s.familyMonths) + opt(12, 'After 12 months away', s.familyMonths === 12) + opt(24, 'After 24 months away', s.familyMonths === 24) + '</select></label>' +
    '<p class="note">Deleting happens by itself each day the app is opened.</p>' +
    '<label class="field"><span>Privacy notice shown to parents</span><textarea class="input" name="notice">' + esc(noticeText()) + '</textarea></label>' +
    '<p class="note">This is a starting point. Change it to match what your church really does, and have your data protection lead check it.</p>' +
    '<div class="grid2"><button class="btn line" type="button" data-act="show-notice">Preview</button><button class="btn" type="submit">Save</button></div>' +
    '<button class="btn dangerline wide mt" type="button" data-act="purge">Delete old records now</button></form>' +

    '<form class="card mt16" data-form="lock" novalidate><div class="h3" style="margin-top:0">App passcode</div>' +
    '<p class="muted small" style="margin-top:0">' + (lock ? 'On. The app asks for the passcode when it is opened.' : 'Off. Turn it on so the register can’t be opened by whoever picks up this phone.') + '</p>' +
    (lock ? '<label class="field"><span>Current passcode</span><input class="input" name="old" type="password" inputmode="numeric" autocomplete="off" maxlength="8"></label>' : '') +
    '<label class="field"><span>New passcode <em class="muted">(4 to 8 digits' + (lock ? ', or leave empty to turn it off' : '') + ')</em></span><input class="input" name="code" type="password" inputmode="numeric" autocomplete="off" maxlength="8"></label>' +
    '<p class="note">There is no way to recover a forgotten passcode. The only way back in is to clear the app’s data, which deletes the register.</p>' +
    '<div id="lock-form-err" class="banner bad" hidden></div><button class="btn line wide" type="submit">' + (lock ? 'Change passcode' : 'Turn on passcode') + '</button></form>' +

    '<div class="card mt16"><div class="h3" style="margin-top:0">How Sunday works</div><ol class="steps">' +
    '<li><strong>Drop-off:</strong> search the family, tap it, take the safety photo, Check in.</li>' +
    '<li>The parent photographs the <strong>pickup pass</strong>. Write the child’s name and code on a sticker.</li>' +
    '<li><strong>Pickup:</strong> scan the pass (or type the code). Choose who is collecting.</li>' +
    '<li><strong>Check the face</strong> against the photo and <strong>check the sticker</strong>. Tick both, then Release.</li>' +
    '<li>No pass, wrong face or “Must NOT collect”? <strong>Don’t release.</strong> Fetch a leader.</li></ol>' +
    '<p class="muted small">Passes and codes are new every Sunday, so an old photo or message won’t work.</p></div>' +
    '<div class="card mt16"><div class="h3" style="margin-top:0">Where the register is kept</div><div id="access" class="muted"></div></div>';
}
function groupRow(g) {
  return '<div class="grouprow" data-group="' + esc(g.id) + '"><input type="color" name="gcolor" value="' + esc(g.color) + '" aria-label="Group colour">' +
    '<input class="input" name="gages" value="' + esc(g.ages) + '" placeholder="e.g. 13–15" maxlength="16" autocomplete="off" aria-label="Ages">' +
    '<input class="input" name="gname" value="' + esc(g.name) + '" placeholder="e.g. Teens" maxlength="20" autocomplete="off" aria-label="Group name">' +
    '<button type="button" class="iconbtn" data-act="remove-group" aria-label="Remove this group">×</button></div>';
}
function groupInUse(id) {
  let n = 0;
  S.families.forEach(f => f.children.forEach(k => { if (k.group === id) n++; }));
  S.checkins.forEach(c => { if (c.group === id && c.status === 'in' && !S.families.has(c.familyId)) n++; }); // visitors here today
  return n;
}
function renderSetupDyn() {
  const el = $('#access'); if (!el) return;
  const facts = $('#facts');
  if (facts && S.db) {
    const kids = [...S.families.values()].reduce((n, f) => n + f.children.length, 0);
    const row = (k, v) => '<span>' + k + '</span><b>' + v + '</b>';
    facts.innerHTML = row('Families saved', S.families.size) + row('Children', kids) + row('Families who agreed to photos', [...S.families.values()].filter(f => f.photoConsent).length) + row('Photos held', '<span id="fact-photos">…</span>');
    S.db.collection('photos').get().then(s => { const x = $('#fact-photos'); if (x) x.textContent = s.docs.filter(d => d.exists).length; }).catch(() => {});
  }
  if (!S.db) { el.textContent = 'Not connected.'; return; }
  el.innerHTML = S.mode === 'cloud'
    ? 'Shared live between your volunteers’ phones. Signed in as <strong>' + esc((S.me && (S.me.email || S.me.name)) || '') + '</strong>.<button class="btn line wide mt" data-act="sign-out">Sign out</button>'
    : 'On <strong>this phone only</strong>. Nothing is sent to any server. Android does not include it in phone backups, so it is lost if the app is removed or the phone is lost.';
}
function saveSettings(patch) {
  const next = Object.assign({}, S.settings, patch);
  return write(() => S.db.doc('settings/main').set(Object.assign({}, next, { updatedAt: Date.now() })));
}
/* ---------- Events ---------- */
document.addEventListener('click', e => {
  const z = $('#zoom'); if (!z.hidden) { z.hidden = true; return; }
  if (e.target.closest('[data-act=close-notice]')) { $('#notice').hidden = true; return; }
  const t = e.target.closest('[data-act],[data-mode]'); if (!t) return;
  if (t.dataset.mode) { S.submitMode = t.dataset.mode; if (!t.dataset.act) return; }
  const act = t.dataset.act, id = t.dataset.id;
  switch (act) {
    case 'close': closeModal(); break;
    case 'new-family': if (guardWrite()) openFamilyForm(null); break;
    case 'new-family-only': if (guardWrite()) openFamilyForm(null, { saveOnly: true }); break;
    case 'open-family': openFamilySheet(S.families.get(id), false); break;
    case 'edit-family': openFamilyForm(id); break;
    case 'photo': takeSlotPhoto(t); break;
    case 'drop-photo': takeDropPhoto(t); break;
    case 'show-notice': showNotice(); break;
    case 'export-family': exportFamily(id).catch(handleErr); break;
    case 'logo': if (guardWrite()) window.Cam.photo({ title: 'Church logo', hint: 'Tap the picture button to choose from the phone.', shape: 'square', canRemove: !!S.settings.logo }).then(out => { if (out !== null) return saveSettings({ logo: out }).then(() => toast(out ? 'Logo saved' : 'Logo removed')); }).catch(handleErr); break;
    case 'zoom': getPhoto(t.dataset.photo).then(v => { if (v) { z.querySelector('img').src = v; z.hidden = false; } }); break;
    case 'add-kid': { const box = $('#kidrows'); box.insertAdjacentHTML('beforeend', kidRow({ id: rid(), name: '', group: '', notes: '', photo: '' })); box.lastElementChild.querySelector('input').focus(); break; }
    case 'remove-kid': { const rows = document.querySelectorAll('#kidrows .kidrow'); const row = t.closest('.kidrow'); if (rows.length > 1) row.remove(); else { row.querySelectorAll('input,select').forEach(i => { i.value = ''; }); const b = row.querySelector('.phslot'); b.dataset.photo = ''; b.classList.remove('has'); const im = b.querySelector('img'); if (im) im.remove(); } break; }
    case 'add-adult': { const box = $('#adultrows'); box.insertAdjacentHTML('beforeend', adultRow({ id: rid(), name: '', photo: '' })); box.lastElementChild.querySelector('input').focus(); break; }
    case 'remove-adult': t.closest('.adultrow').remove(); break;
    case 'add-group': {
      const box = $('#grouprows');
      if (box.children.length >= MAX_GROUPS) { toast('That’s the most groups the app can hold.'); break; }
      const spare = ['#7C3AED', '#0F766E', '#C2410C', '#BE185D', '#1D6FD6', '#15803D', '#334155', '#F2B705'];
      box.insertAdjacentHTML('beforeend', groupRow({ id: 'g' + rid(), ages: '', name: '', color: spare[box.children.length % spare.length] }));
      box.lastElementChild.querySelector('[name=gages]').focus();
      break;
    }
    case 'remove-group': {
      const row = t.closest('.grouprow'), n = groupInUse(row.dataset.group);
      if (n) { toast(n + (n > 1 ? ' children are' : ' child is') + ' in this group. Move them to another group first.'); break; }
      if ($('#grouprows').children.length <= 1) { toast('Keep at least one group.'); break; }
      row.remove();
      break;
    }
    case 'delete-family': {
      if (!guardWrite()) break;
      if (S.checkins.some(c => c.familyId === id && c.status === 'in')) { toast('Their children are still checked in. Release them first.'); break; }
      if (t.dataset.armed !== '1') { t.dataset.armed = '1'; t.textContent = 'Tap again to delete this family'; break; }
      busy(t, 'Deleting…', async () => { const f = S.families.get(id); if (f) await eraseFamily(f); closeModal(); toast('Family and their records deleted'); });
      break;
    }
    case 'copy': copyText(t.dataset.text || ''); break;
    case 'copy-register': copyText(registerText()); break;
    case 'scan': doScan(); break;
    case 'clear-pickup': setPickup(null); break;
    case 'lost-code': openLostCode(); break;
    case 'override': if (guardWrite()) openOverride([id]); break;
    case 'contact': openContact(id); break;
    case 'room-filter': S.roomFilter = id; renderRooms(); break;
    case 'purge': if (!guardWrite()) break; if (t.dataset.armed !== '1') { t.dataset.armed = '1'; t.textContent = 'Tap again to delete'; setTimeout(() => { if (t.isConnected) { t.dataset.armed = ''; t.textContent = 'Delete old records now'; } }, 5000); break; } t.dataset.armed = ''; busy(t, 'Deleting…', () => runRetention(true)); break;
    case 'sign-out': if (S.be && S.be.auth) S.be.auth.signOut(); break;
    case 'reset-pw': {
      const email = ($('form[data-form=signin] [name=email]') || {}).value || '';
      if (!email.trim()) { toast('Type your email first.'); break; }
      S.be.auth.reset(email.trim()).then(() => toast('Password reset email sent.'), () => toast('Could not send the reset email.'));
      break;
    }
    case 'release': {
      if (!guardWrite()) break;
      const ids = pickupMatches().filter(c => c.status === 'in' && !S.pu.skip.has(c.id)).map(c => c.id);
      if (!ids.length) break;
      if (S.pu.who === '__other') { openOverride(ids); break; }
      if (!S.pu.c1 || !S.pu.c2) break;
      release(ids, S.pu.who, false, '', t);
      break;
    }
  }
});
document.getElementById('overlay').addEventListener('click', e => { if (e.target.id === 'overlay') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') goBack(); });
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'ci-q') { S.q.checkin = t.value; renderCheckinResults(); }
  else if (t.id === 'fam-q') { S.q.families = t.value; renderFamilies(); }
  else if (t.id === 'lc-q') { S.q.lost = t.value; renderLost(); }
  else if (t.id === 'pu-code') {
    const v = t.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (t.value !== v) t.value = v;
    const cur = (S.pu.key && S.pu.key.t === 'code') ? S.pu.key.v : '';
    if (v.length === 4 && v !== cur) { setPickup({ t: 'code', v }); buzz(pickupMatches().length ? 40 : [80, 60, 80]); t.blur(); }
    else if (v.length < 4 && (cur || (S.puDone && v))) { S.pu = newPickup(null); S.puDone = null; renderPickup(); }
  }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset && t.dataset.pu) { if (t.checked) S.pu.skip.delete(t.dataset.pu); else S.pu.skip.add(t.dataset.pu); renderPickup(); }
  else if (t.dataset && t.dataset.tick) { S.pu[t.dataset.tick] = t.checked; renderPickup(); }
  else if (t.name === 'pu-who') { S.pu.who = t.value; S.pu.c1 = false; renderPickup(); }
  else if (t.name === 'photoOk') { t.form.classList.toggle('nophoto', !t.checked); }
  else if ((t.name === 'theme' || t.id === 'theme-custom') && HEX.test(t.value) && guardWrite()) { S.settings.themeColor = t.value; applyTheme(); saveSettings({ themeColor: t.value }).catch(handleErr); }
});
document.addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target, kind = form.dataset.form;
  const btn = (e.submitter && e.submitter.tagName === 'BUTTON') ? e.submitter : form.querySelector('button[type=submit]');
  const val = n => { const el = form.elements.namedItem(n); return el ? str(el.value).trim() : ''; };
  if (kind === 'signin') {
    const err = $('#form-err');
    busy(btn, 'Signing in…', async () => {
      try { await S.be.auth.signIn(val('email'), form.elements.namedItem('password').value); }
      catch (x) { err.textContent = 'That email and password don’t match. Check them and try again.'; err.hidden = false; }
    });
    return;
  }
  if (kind === 'unlock') {
    const lock = getLock();
    if (!lock || scramble(val('code'), lock.salt) === lock.hash) { $('#lock').hidden = true; form.reset(); }
    else { buzz([80, 60, 80]); $('#lock-err').textContent = 'That passcode is not right.'; form.reset(); }
    return;
  }
  if (kind === 'lock') {
    const err = $('#lock-form-err'), lock = getLock(), code = val('code');
    const fail = m => { err.textContent = m; err.hidden = false; };
    if (lock && scramble(val('old'), lock.salt) !== lock.hash) { fail('The current passcode is not right.'); return; }
    if (!code && lock) { try { localStorage.removeItem(LOCK_KEY); } catch (x) {} toast('Passcode turned off'); renderView(); return; }
    if (!/^\d{4,8}$/.test(code)) { fail('Use 4 to 8 digits.'); return; }
    const salt = rid();
    try { localStorage.setItem(LOCK_KEY, JSON.stringify({ salt, hash: scramble(code, salt) })); } catch (x) { fail('Could not save the passcode on this phone.'); return; }
    toast('Passcode is on'); renderView(); return;
  }
  if (!guardWrite()) return;
  if (kind === 'checkin') {
    const fam = S.sheetFam; if (!fam) return;
    const ids = [...form.querySelectorAll('input[name=kid]:checked')].map(i => i.value);
    if (!ids.length) { toast('Tick at least one child.'); return; }
    const d = form.querySelector('input[name=dropper]:checked');
    const o = { visitor: S.sheetVisitor, droppedBy: d ? d.value : fam.parentName, drop: S.drop };
    busy(btn, 'Checking in…', () => doCheckin(fam, ids, o));
  } else if (kind === 'family') {
    if (e.submitter && e.submitter.dataset.mode) S.submitMode = e.submitter.dataset.mode;
    submitFamily(form, btn);
  } else if (kind === 'override') {
    const who = val('who'), leader = val('leader'), how = val('how');
    const err = $('#form-err');
    const fail = m => { err.textContent = m; err.hidden = false; err.scrollIntoView({ block: 'nearest' }); };
    if (!who || !leader || !how) { fail('Fill in all three so there’s a record of the release.'); return; }
    if (S.settings.pinHash && scramble(val('pin'), S.settings.pinSalt) !== S.settings.pinHash) { buzz([80, 60, 80]); fail('That leader PIN is not right.'); return; }
    release(form.dataset.ids.split(','), who.slice(0, 80), true, ('Approved by ' + leader + ' — ' + how).slice(0, 240), btn);
  } else if (kind === 'settings') {
    const me = val('me').slice(0, 60);
    busy(btn, 'Saving…', async () => {
      if (S.me && me !== S.me.name) {
        S.me.name = me;
        if (S.mode === 'cloud') { try { await S.be.auth.setName(me); } catch (x) {} }
        else { try { localStorage.setItem('kc.volunteer', me); } catch (x) {} }
      }
      await saveSettings({ churchName: val('churchName').slice(0, 60), countryCode: digitsOnly(val('countryCode')).slice(0, 4) || '44', dropPhoto: form.elements.namedItem('dropPhoto').checked });
      toast('Settings saved');
    });
  } else if (kind === 'groups') {
    const err = $('#groups-err'), list = [];
    let bad = false;
    form.querySelectorAll('.grouprow').forEach(r => {
      const ages = r.querySelector('[name=gages]'), v = ages.value.trim();
      ages.classList.toggle('err', !v); if (!v) bad = true;
      list.push({ id: r.dataset.group, ages: v.slice(0, 16), name: r.querySelector('[name=gname]').value.trim().slice(0, 20), color: r.querySelector('[name=gcolor]').value });
    });
    if (bad) { err.textContent = 'Fill in the ages for every group, or remove the empty one.'; err.hidden = false; return; }
    err.hidden = true;
    busy(btn, 'Saving…', async () => { const groups = cleanGroups(list); S.settings.groups = groups; setGroups(groups); await saveSettings({ groups }); toast('Age groups saved'); renderView(); });
  } else if (kind === 'privacy') {
    const days = +val('retainDays'), months = +val('familyMonths'), contact = val('contact').slice(0, 120);
    busy(btn, 'Saving…', async () => {
      // Work out the standard wording with the new choices; only keep the text if the church has changed it.
      const ta = form.elements.namedItem('notice'), typed = ta.value.trim().slice(0, 4000), untouched = typed === ta.defaultValue.trim() && !S.settings.notice;
      Object.assign(S.settings, { contact, retainDays: [30, 90, 365].includes(days) ? days : 90, familyMonths: [0, 12, 24].includes(months) ? months : 0 });
      await saveSettings({ notice: (untouched || typed === defaultNotice()) ? '' : typed });
      toast('Privacy settings saved'); renderView();
    });
  } else if (kind === 'pin') {
    const err = $('#pin-err'), pin = val('pin');
    const fail = m => { err.textContent = m; err.hidden = false; };
    if (S.settings.pinHash && scramble(val('old'), S.settings.pinSalt) !== S.settings.pinHash) { fail('The current PIN is not right.'); return; }
    if (!/^\d{4,8}$/.test(pin)) { fail('Use 4 to 8 digits.'); return; }
    busy(btn, 'Saving…', async () => { const salt = rid(); await saveSettings({ pinSalt: salt, pinHash: scramble(pin, salt) }); toast('Leader PIN saved'); if (S.view === 'setup') renderView(); });
  }
});
function route() { const h = location.hash.replace('#', ''); S.view = VIEWS.includes(h) ? h : 'checkin'; }
window.addEventListener('hashchange', () => { route(); if (modalOpen()) closeModal(); renderView(); window.scrollTo(0, 0); });

/* ---------- Data connection ---------- */
function listen(q, next, err) { return S.mode === 'cloud' ? q.onSnapshot({ includeMetadataChanges: true }, next, err) : q.onSnapshot(next, err); }
function checkLive() {
  if (S.mode === 'local') S.status = 'local';
  else if (S.liveF && S.liveC) { S.status = 'live'; clearTimeout(S.loadTimer); }
  else if (S.status === 'live') S.status = 'offline';
  refreshChrome();
}
function onSubError(e) { if (window.console) console.warn(e); S.status = 'offline'; if (e && e.code === 'permission-denied') toast('This account is not allowed to open the register.'); refresh(); }
function subscribeToday() {
  if (S.unsubToday) { try { S.unsubToday(); } catch (e) {} }
  S.checkinsLoaded = false; S.liveC = false;
  S.unsubToday = listen(S.db.collection('checkins').where('date', '==', S.today), snap => {
    S.checkins = snap.docs.filter(d => d.exists).map(d => normCheckin(d.id, d.data()));
    S.checkins.sort((x, y) => (x.inAt - y.inAt) || x.childName.localeCompare(y.childName)); // steady order on screen
    S.checkinsLoaded = true;
    S.liveC = !snap.metadata.fromCache; checkLive();
    refresh();
    if (modalOpen() && $('#lc-results')) renderLost();
    runRetention(false);
  }, onSubError);
}
function subscribe() {
  unsubscribe();
  S.liveF = false; S.liveC = false; S.status = S.mode === 'local' ? 'local' : 'connecting';
  S.loadTimer = setTimeout(() => { if (S.status === 'connecting') { S.status = 'offline'; refreshChrome(); } }, 8000);
  S.unsubs.push(listen(S.db.collection('families'), snap => {
    const m = new Map();
    snap.docs.forEach(d => { if (d.exists) m.set(d.id, normFamily(d.id, d.data())); });
    S.families = m; S.familiesLoaded = true;
    S.liveF = !snap.metadata.fromCache; checkLive();
    refresh(); runRetention(false);
  }, onSubError));
  S.unsubs.push(listen(S.db.doc('settings/main'), d => {
    if (d.exists) {
      const x = d.data() || {}, def = defaultSettings();
      S.settings = { churchName: str(x.churchName).slice(0, 60), countryCode: digitsOnly(x.countryCode).slice(0, 4) || '44', dropPhoto: x.dropPhoto !== false, pinHash: str(x.pinHash).slice(0, 40), pinSalt: str(x.pinSalt).slice(0, 40),
        themeColor: HEX.test(str(x.themeColor)) ? x.themeColor : def.themeColor, logo: isPhoto(str(x.logo)) ? x.logo : '', contact: str(x.contact).slice(0, 120), notice: str(x.notice).slice(0, 4000),
        retainDays: [30, 90, 365].includes(+x.retainDays) ? +x.retainDays : 90, familyMonths: [0, 12, 24].includes(+x.familyMonths) ? +x.familyMonths : 0, groups: cleanGroups(x.groups) };
    }
    setGroups(S.settings.groups); if (S.roomFilter !== 'all' && !G[S.roomFilter]) S.roomFilter = 'all';
    S.settingsLoaded = true; applyTheme(); runRetention(false);
    if (S.view !== 'setup') refresh();
    renderHeader();
    const a = document.activeElement;
    if (S.view === 'setup' && !(a && a.closest && a.closest('form'))) renderView();
  }, () => {}));
  subscribeToday();
  refreshChrome();
}
function unsubscribe() {
  clearTimeout(S.loadTimer);
  S.unsubs.forEach(u => { try { u(); } catch (e) {} }); S.unsubs = [];
  if (S.unsubToday) { try { S.unsubToday(); } catch (e) {} S.unsubToday = null; }
}
setInterval(() => {
  const t = todayStr();
  if (t !== S.today && S.db) { S.today = t; S.pu = newPickup(null); S.puDone = null; subscribeToday(); renderView(); }
  renderHeader();
}, 60000);
window.addEventListener('online', () => { if (S.mode === 'cloud' && S.status === 'offline') { S.status = 'connecting'; refreshChrome(); } });
window.addEventListener('offline', () => { if (S.mode === 'cloud') { S.status = 'offline'; refreshChrome(); } });

async function init() {
  try { const t = localStorage.getItem(THEME_KEY); if (t && HEX.test(t)) S.settings.themeColor = t; } catch (e) {}
  applyTheme(); showLock();
  // Android's back button: close what is open, then go to Check in, then leave the app.
  try { const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App; if (App && App.addListener) App.addListener('backButton', () => { if (!goBack()) App.minimizeApp(); }); } catch (e) {}
  route(); renderView();
  try { S.be = await window.Backend.connect(); }
  catch (e) { if (window.console) console.error(e); $('#view').innerHTML = '<div class="banner bad block">The register could not be opened on this phone. Close the app and open it again.</div>'; return; }
  S.mode = S.be.mode;
  if (S.mode === 'cloud') {
    S.be.auth.onChange(u => {
      if (u) { S.me = u; S.db = S.be.db; subscribe(); }
      else { unsubscribe(); S.db = null; S.me = null; S.status = 'signedout'; S.families = new Map(); S.checkins = []; S.familiesLoaded = S.checkinsLoaded = false; if (modalOpen()) closeModal(); }
      renderView();
    });
  } else {
    S.db = S.be.db; S.me = S.be.user;
    subscribe(); renderView();
  }
}
window.__kc = { state: S, backend: () => S.be }; // for the browser console and the tests
init();
})();
