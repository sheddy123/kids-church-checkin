/*
 * End-to-end test of the phone app (www/) on a phone-sized screen.
 *
 *   npm run test:app
 *
 * Uses the Chrome or Edge already installed on this computer (set BROWSER=chrome
 * or BROWSER=msedge to choose). The browser's built-in fake camera stands in for
 * the phone camera; for the scan test it is fed a picture of the real pickup pass.
 * Screenshots are saved to tests/screenshots/.
 */
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'tests', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-e2e-'));
const FEED = path.join(TMP, 'camera.mjpeg');

const passed = [], errors = [];
function check(cond, label) { if (!cond) throw new Error('FAILED: ' + label); passed.push(label); console.log('  ✓ ' + label); }
function freePort() { return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
function waitPort(port) { return new Promise((res, rej) => { let n = 0; (function go() { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.end(); res(); }); c.on('error', () => (++n > 80 ? rej(new Error('server did not start')) : setTimeout(go, 100))); })(); }); }

(async () => {
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(ROOT, 'dev', 'app-server.js')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  let browser;
  try {
    await waitPort(port);
    const BASE = 'http://localhost:' + port + '/';
    // A plain frame so the fake camera has something to show before the pass exists.
    const blank = await chromium.launch({ channel: process.env.BROWSER || 'msedge' });
    const bp = await blank.newPage({ viewport: { width: 640, height: 480 } });
    await bp.setContent('<body style="margin:0;background:#8fa3c7"><div style="font:700 60px sans-serif;padding:160px 0;text-align:center">CAMERA</div>');
    fs.writeFileSync(FEED, await bp.screenshot({ type: 'jpeg', quality: 90 }));
    await blank.close();

    browser = await chromium.launch({
      channel: process.env.BROWSER || 'msedge',
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + FEED],
    });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const pg = await ctx.newPage();
    pg.on('pageerror', e => errors.push(String(e)));
    pg.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    const shot = (name, full) => pg.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: !!full });
    const dump = () => pg.evaluate(() => window.__kc.backend().debug.dump());
    const photosOf = async kind => Object.entries(await dump()).filter(([k, v]) => k.startsWith('photos/') && (!kind || v.kind === kind));
    const snap = async () => { await pg.waitForSelector('.cam video'); await pg.waitForFunction(() => { const v = document.querySelector('.cam video'); return v && v.videoWidth > 0; }); await pg.click('[data-cam=shoot]'); await pg.waitForSelector('.cam', { state: 'detached' }); };

    await pg.goto(BASE + '#checkin'); await pg.waitForSelector('.empty');
    await shot('01_empty');

    console.log('New family with photos');
    await pg.click('[data-act=new-family]'); await pg.click('button[data-mode=checkin]');
    check((await pg.innerText('#form-err')).includes('Add at least one child'), 'empty form shows errors');
    await pg.fill('[name=parentName]', 'Chioma Okafor'); await pg.fill('[name=phone]', '07700 900123');
    check(await pg.locator('form.nophoto').count() === 1, 'camera is off until the parent agrees to photos');
    await pg.click('[data-act=show-notice]'); await pg.waitForSelector('#notice:not([hidden])');
    check((await pg.innerText('#notice-text')).includes('WHAT WE KEEP'), 'privacy notice can be shown to the parent'); await shot('02a_notice');
    await pg.keyboard.press('Escape'); check(await pg.isHidden('#notice') && await pg.isVisible('form[data-form=family]'), 'back closes the notice and keeps the form');
    await pg.check('[name=photoOk]');
    await pg.click('.withph .phslot'); await snap();
    check(await pg.locator('.withph .phslot.has img').count() === 1, 'parent photo taken with the in-app camera');
    await pg.click('[data-act=add-adult]'); await pg.fill('.adultrow [name=aname]', 'Grandma Ada');
    await pg.fill('[name=blocked]', 'Uncle Emeka');
    await pg.locator('.kidrow').nth(0).locator('[name=kname]').fill('Tolu');
    await pg.locator('.kidrow').nth(0).locator('[name=kgroup]').selectOption('6-7');
    await pg.locator('.kidrow').nth(0).locator('[name=knotes]').fill('Peanut allergy');
    await pg.locator('.kidrow').nth(0).locator('.phslot').click(); await snap();
    await pg.click('[data-act=add-kid]');
    await pg.locator('.kidrow').nth(1).locator('[name=kname]').fill('Femi');
    await pg.locator('.kidrow').nth(1).locator('[name=kgroup]').selectOption('1-5');
    await shot('02_family_form', true);
    await pg.click('button[data-mode=checkin]');
    check((await pg.innerText('#form-err')).includes('privacy notice'), 'cannot save a family until the privacy notice has been shown');
    await pg.check('[name=noticeOk]');
    await pg.click('button[data-mode=checkin]');

    console.log('Check in');
    await pg.waitForSelector('form[data-form=checkin]');
    check(await pg.locator('input[name=dropper]').count() === 2, 'asks who is dropping off');
    check((await pg.innerText('#sheet')).includes('Uncle Emeka'), 'check-in shows who must not collect');
    await pg.click('[data-act=drop-photo]'); await snap();
    check(await pg.locator('.dropslot.has').count() === 1, 'drop-off safety photo taken');
    await shot('03_checkin_sheet', true);
    await pg.click('form[data-form=checkin] button[type=submit]');
    await pg.waitForSelector('.bigcode');
    const code1 = (await pg.innerText('.bigcode')).trim();
    check(code1.length === 4, 'code issued (' + code1 + ')');
    check(await pg.locator('.pass .qr svg').count() === 1, 'pickup pass shows a QR code');
    check((await pg.getAttribute('a.btn.wa', 'href')).startsWith('https://wa.me/447700900123'), 'WhatsApp link uses +44 number');
    await shot('04_pass', true);
    // Feed the fake camera a picture of this pass for the scan test later on.
    const passShot = await pg.locator('.pass .qr').screenshot({ type: 'jpeg', quality: 95 });
    await pg.click('.sheet [data-act=close]');
    check((await photosOf('profile')).length === 2 && (await photosOf('drop')).length === 1, 'two saved photos and one drop-off photo stored');
    await shot('05_checkin_list');

    console.log('Pickup by code');
    await pg.click('nav a[href="#pickup"]');
    await shot('06_pickup');
    await pg.fill('#pu-code', 'aaaa'); await pg.waitForSelector('.match.bad');
    check((await pg.innerText('#pu-result')).includes('Do not release'), 'wrong code is refused');
    await shot('07_no_match');
    await pg.fill('#pu-code', code1.toLowerCase()); await pg.waitForSelector('.match.ok');
    let t = await pg.innerText('#pu-result');
    check(t.includes('Pass found') && t.includes('Uncle Emeka'), 'right code opens the family and warns who must not collect');
    check(await pg.locator('#pu-result .face').count() === 2, 'shows the drop-off photo and the adult’s saved photo');
    check(await pg.isDisabled('[data-act=release]'), 'release is locked until both checks are ticked');
    await shot('08_verify', true);
    await pg.click('#pu-result .face >> nth=0'); await pg.waitForSelector('#zoom:not([hidden])'); await shot('09_zoom'); await pg.click('#zoom');
    await pg.locator('input[name=pu-who][value="Grandma Ada"]').check({ force: true });
    t = await pg.innerText('#pu-result');
    check(t.includes('did not drop off today') && t.includes('No photo of Grandma Ada'), 'different adult with no photo is flagged');
    await pg.locator('input[name=pu-who][value="__other"]').check({ force: true });
    check((await pg.innerText('[data-act=release]')).includes('Leader release'), 'someone not on the list needs a leader');
    await pg.locator('input[name=pu-who][value="Chioma Okafor"]').check({ force: true });
    await pg.locator('#pu-result label.kid', { hasText: 'Femi' }).locator('input').uncheck();
    await pg.check('[data-tick=c1]');
    check(await pg.isDisabled('[data-act=release]'), 'one tick is not enough');
    await pg.check('[data-tick=c2]');
    await pg.click('[data-act=release]'); await pg.waitForSelector('.donebox');
    check((await pg.innerText('#pu-result')).includes('Tolu to Chioma Okafor'), 'released one child after both checks');
    await shot('10_released');
    check((await photosOf('drop')).length === 1, 'drop-off photo kept while a sibling is still in');

    console.log('Pickup by scanning the pass');
    fs.writeFileSync(FEED, passShot);
    await pg.click('[data-act=scan]');
    await pg.waitForSelector('.cam'); await shot('11_scanner');
    await pg.waitForSelector('.match.ok', { timeout: 15000 });
    t = await pg.innerText('#pu-result');
    check(t.includes('Femi') && t.includes('Collected at'), 'scanned pass opens the family: sibling still in, first shows collected');
    await pg.check('[data-tick=c1]'); await pg.check('[data-tick=c2]');
    await pg.click('[data-act=release]'); await pg.waitForSelector('.donebox');
    check((await photosOf('drop')).length === 0, 'drop-off photo deleted once everyone is collected');
    check((await photosOf('profile')).length === 2, 'saved family photos are kept');

    console.log('Leader PIN and release without a pass');
    await pg.click('nav a[href="#setup"]');
    await pg.fill('form[data-form=pin] [name=pin]', '12'); await pg.click('form[data-form=pin] button[type=submit]');
    check((await pg.innerText('#pin-err')).includes('4 to 8 digits'), 'short PIN refused');
    await pg.fill('form[data-form=pin] [name=pin]', '2468'); await pg.click('form[data-form=pin] button[type=submit]');
    await pg.waitForSelector('form[data-form=pin] [name=old]');
    await pg.fill('[name=churchName]', 'Grace Chapel'); await pg.fill('[name=me]', 'Ruth');
    await pg.click('form[data-form=settings] button[type=submit]');
    await pg.waitForFunction(() => document.querySelector('#church').textContent === 'Grace Chapel');
    check(true, 'church name saved');
    await shot('12_setup', true);

    await pg.click('nav a[href="#checkin"]'); await pg.click('[data-act=new-family]');
    await pg.fill('[name=parentName]', 'James Smith'); await pg.fill('[name=phone]', '+44 7700 900456');
    await pg.locator('.kidrow [name=kname]').fill('Lily'); await pg.locator('.kidrow [name=kgroup]').selectOption('8-9');
    await pg.check('[name=noticeOk]'); await pg.click('button[data-mode=checkin]'); await pg.waitForSelector('form[data-form=checkin]');
    check(await pg.locator('[data-act=drop-photo]').count() === 0, 'no drop-off photo is asked for when the parent has not agreed to photos');
    check(await pg.locator('input[name=dropper]').count() === 0, 'single adult: no “who is dropping off” question');
    await pg.click('form[data-form=checkin] button[type=submit]'); await pg.waitForSelector('.bigcode');
    const code2 = (await pg.innerText('.bigcode')).trim(); await pg.click('.sheet [data-act=close]');
    check(code2 !== code1, 'different families get different codes');

    await pg.click('nav a[href="#pickup"]'); await pg.fill('#pu-code', code2); await pg.waitForSelector('.match.ok');
    check((await pg.innerText('#pu-result')).includes('I know this is James Smith'), 'no photos: volunteer must vouch for the adult instead');
    await pg.click('[data-act=clear-pickup]');
    await pg.click('[data-act=lost-code]'); await pg.fill('#lc-q', 'lil'); await pg.click('#lc-results .card >> nth=0');
    await pg.click('form[data-form=override] button[type=submit]');
    check((await pg.innerText('#form-err')).includes('Fill in all three'), 'leader release needs all details');
    await pg.fill('[name=who]', 'Mary Smith'); await pg.fill('[name=leader]', 'Pastor John'); await pg.selectOption('[name=how]', { index: 2 });
    await pg.fill('form[data-form=override] [name=pin]', '0000'); await pg.click('form[data-form=override] button[type=submit]');
    check((await pg.innerText('#form-err')).includes('PIN is not right'), 'wrong leader PIN is refused');
    await shot('13_leader_release', true);
    await pg.fill('form[data-form=override] [name=pin]', '2468'); await pg.click('form[data-form=override] button[type=submit]');
    await pg.waitForSelector('.donebox');
    await pg.click('nav a[href="#rooms"]'); await pg.click('details summary');
    t = await pg.innerText('#rooms-body');
    check(t.includes('Approved by Pastor John') && t.includes('released by Ruth'), 'leader release and volunteer name are recorded');

    console.log('Siblings, visitors, deleting');
    await pg.click('nav a[href="#checkin"]'); await pg.click('[data-act=new-family]');
    await pg.fill('[name=parentName]', 'Ada Bello'); await pg.fill('[name=phone]', '07123 456789');
    await pg.locator('.kidrow').nth(0).locator('[name=kname]').fill('Zara'); await pg.locator('.kidrow').nth(0).locator('[name=kgroup]').selectOption('10-12');
    await pg.click('[data-act=add-kid]');
    await pg.locator('.kidrow').nth(1).locator('[name=kname]').fill('Bayo'); await pg.locator('.kidrow').nth(1).locator('[name=kgroup]').selectOption('8-9');
    await pg.check('[name=noticeOk]'); await pg.click('button[data-mode=save]'); await pg.waitForSelector('#overlay:not(.open)', { state: 'attached' });
    await pg.fill('#ci-q', 'bello'); await pg.click('#ci-results .card >> nth=0');
    await pg.locator('.sheet input[name=kid]').nth(1).uncheck();
    await pg.click('.sheet button[type=submit]'); await pg.waitForSelector('.bigcode'); const a = await pg.innerText('.bigcode'); await pg.click('.sheet [data-act=close]');
    await pg.click('#ci-results .card >> nth=0'); await pg.click('.sheet button[type=submit]'); await pg.waitForSelector('.bigcode'); const b = await pg.innerText('.bigcode');
    check(a === b, 'late sibling gets the same pass and code'); await pg.click('.sheet [data-act=close]');

    await pg.fill('#ci-q', ''); await pg.click('[data-act=new-family]');
    await pg.fill('[name=parentName]', 'Visitor Mum'); await pg.fill('[name=phone]', '07999 111222');
    await pg.locator('.kidrow [name=kname]').fill('Kemi'); await pg.locator('.kidrow [name=kgroup]').selectOption('1-5');
    await pg.check('[name=noticeOk]'); await pg.uncheck('[name=save]'); await pg.click('button[data-mode=checkin]');
    await pg.waitForSelector('form[data-form=checkin]'); await pg.click('form[data-form=checkin] button[type=submit]');
    await pg.waitForSelector('.bigcode'); await pg.click('.sheet [data-act=close]');
    await pg.click('nav a[href="#rooms"]'); await pg.waitForSelector('#rooms-body .card');
    check((await pg.innerText('#rooms-body')).includes('Kemi'), 'visitor is checked in');
    await shot('14_rooms', true);
    await pg.click('nav a[href="#families"]'); await pg.waitForSelector('#fam-list .card');
    check(!(await pg.innerText('#fam-list')).includes('Visitor Mum'), 'unsaved visitor not in Families');
    await shot('15_families', true);
    await pg.fill('#fam-q', 'bello'); await pg.click('#fam-list .card >> nth=0');
    await pg.click('[data-act=delete-family]');
    check((await pg.innerText('#toast')).includes('still checked in'), 'cannot delete a family while their children are in');
    await pg.click('.sheet [data-act=close]');
    await pg.fill('#fam-q', 'okafor'); await pg.click('#fam-list .card >> nth=0');
    await pg.click('[data-act=delete-family]'); await pg.click('[data-act=delete-family]'); await pg.waitForSelector('#overlay:not(.open)', { state: 'attached' });
    await pg.fill('#fam-q', '');
    check(!(await pg.innerText('#fam-list')).includes('Chioma Okafor'), 'family deleted after two taps');
    check((await photosOf('profile')).length === 0, 'their photos are deleted with them');

    console.log('Privacy tools');
    await pg.fill('#fam-q', 'smith'); await pg.click('#fam-list .card >> nth=0'); await pg.click('[data-act=export-family]'); await pg.waitForSelector('#export-text');
    let ex = await pg.inputValue('#export-text');
    check(ex.includes('James Smith') && ex.includes('Lily') && ex.includes('Mary Smith') && ex.includes('Privacy notice shown'), 'a family can be given everything held about them');
    await shot('16_export', true); await pg.keyboard.press('Escape');
    await pg.evaluate(async () => { const db = window.__kc.state.db; await db.doc('checkins/old1').set({ date: '2020-01-05', familyId: 'x', childName: 'Old', status: 'out' }); await db.doc('photos/oldp').set({ d: 'data:image/jpeg;base64,AAAA', kind: 'drop', date: '2020-01-05' }); });
    await pg.click('nav a[href="#setup"]'); await pg.click('[data-act=purge]'); await pg.click('[data-act=purge]');
    await pg.waitForFunction(() => document.querySelector('#toast').textContent.includes('Deleted 1 old record'));
    let d = await dump(); check(!d['checkins/old1'] && !d['photos/oldp'], 'old registers and leftover photos are deleted');
    await pg.fill('[name=contact]', 'Ruth Adams'); await pg.selectOption('[name=retainDays]', '30'); await pg.click('form[data-form=privacy] button[type=submit]');
    await pg.waitForFunction(() => document.querySelector('#toast').textContent.includes('Privacy settings saved'));
    await pg.click('form[data-form=privacy] [data-act=show-notice]'); let nt = await pg.innerText('#notice-text'); await pg.click('#notice [data-act=close-notice] >> nth=0');
    check(nt.includes('Ruth Adams') && nt.includes('after 30 days') && nt.includes('Grace Chapel'), 'privacy notice follows the church’s own settings');

    console.log('Age groups');
    check(await pg.locator('.grouprow').count() === 4, 'four age groups to start with');
    await pg.locator('.grouprow').nth(0).locator('[name=gages]').fill('0–5');
    await pg.click('[data-act=add-group]'); await pg.click('form[data-form=groups] button[type=submit]');
    check((await pg.innerText('#groups-err')).includes('Fill in the ages'), 'a new group needs its ages');
    await pg.locator('.grouprow').nth(4).locator('[name=gages]').fill('13–15'); await pg.locator('.grouprow').nth(4).locator('[name=gname]').fill('Teens');
    await pg.click('form[data-form=groups] button[type=submit]');
    await pg.waitForFunction(() => document.querySelector('#toast').textContent.includes('Age groups saved'));
    await pg.locator('.grouprow').nth(2).locator('[data-act=remove-group]').click();
    check((await pg.innerText('#toast')).includes('in this group') && await pg.locator('.grouprow').count() === 5, 'a group with children in it cannot be removed');
    await shot('16a_age_groups', true);
    await pg.click('nav a[href="#families"]'); await pg.fill('#fam-q', 'smith'); await pg.click('#fam-list .card >> nth=0');
    const opts = await pg.locator('.kidrow [name=kgroup] option').allInnerTexts();
    check(opts.some(o => o.includes('13–15') && o.includes('Teens')) && opts.some(o => o.includes('0–5')), 'new and renamed groups can be chosen for a child');
    await pg.locator('.kidrow [name=kgroup]').selectOption({ index: 5 }); await pg.click('button[data-mode=save]'); await pg.waitForSelector('#overlay:not(.open)', { state: 'attached' });
    check((await pg.innerText('#fam-list')).includes('13–15'), 'child moved into the new group');
    await pg.click('nav a[href="#rooms"]'); await pg.waitForSelector('.stats');
    check(await pg.locator('.stat').count() === 5 && (await pg.innerText('.stats')).includes('Teens'), 'Rooms shows the new group');
    await shot('16b_rooms_groups', true);
    await pg.click('nav a[href="#setup"]');

    console.log('Theme');
    await pg.locator('input[name=theme][value="#0F766E"]').evaluate(e => e.scrollIntoView({ block: 'center' }));
    await pg.locator('input[name=theme][value="#0F766E"]').check({ force: true });
    await pg.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').includes('hsl(175'));
    check(true, 'theme colour changes the whole app'); await shot('17_theme_teal', true);
    await pg.click('nav a[href="#pickup"]'); await shot('18_theme_pickup');

    console.log('App passcode and back button');
    await pg.click('nav a[href="#setup"]'); await pg.fill('form[data-form=lock] [name=code]', '1357'); await pg.click('form[data-form=lock] button[type=submit]');
    await pg.click('nav a[href="#rooms"]'); await pg.keyboard.press('Escape');
    check(new URL(pg.url()).hash === '#checkin', 'back returns to Check in');
    await pg.reload(); await pg.waitForSelector('#lock:not([hidden])'); await shot('19_locked');
    check((await pg.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand'))).includes('hsl(175'), 'theme is remembered after a restart');
    await pg.fill('#lock input', '0000'); await pg.click('#lock button');
    check((await pg.innerText('#lock-err')).includes('not right') && await pg.isVisible('#lock'), 'wrong passcode keeps the register locked');
    await pg.fill('#lock input', '1357'); await pg.click('#lock button'); await pg.waitForSelector('#lock', { state: 'hidden' });
    check(true, 'right passcode opens it');

    console.log('Data survives closing the app');
    await pg.click('nav a[href="#checkin"]'); await pg.reload(); await pg.waitForSelector('.today');
    check((await pg.innerText('#church')) === 'Grace Chapel' && (await pg.innerText('.today')).includes('3'), 'register is still there after a restart');

    await browser.close(); browser = null;
    if (errors.length) { console.log('Page errors:', errors); process.exitCode = 1; }
    else console.log('\nAll ' + passed.length + ' checks passed. Screenshots in ' + SHOTS);
  } catch (e) {
    console.error('\n' + (e && e.message || e));
    if (errors.length) console.log('Page errors:', errors);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})();
