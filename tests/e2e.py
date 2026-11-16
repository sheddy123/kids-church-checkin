"""
End-to-end test on a phone-sized screen, using the local mock database.

Setup (once):
    pip install playwright
    python -m playwright install chromium
Run (from the project folder):
    python tests/e2e.py
Screenshots are saved to tests/screenshots/.
Set CHROME_PATH to use an installed Chrome instead of Playwright's Chromium.
"""
import os, pathlib, socket, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = ROOT / 'tests' / 'screenshots'
SHOTS.mkdir(exist_ok=True)


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


PORT = free_port()
BASE = f'http://localhost:{PORT}/'
server = subprocess.Popen(['node', str(ROOT / 'dev' / 'server.js')], env={**os.environ, 'PORT': str(PORT)},
                          stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
for _ in range(50):
    try:
        socket.create_connection(('127.0.0.1', PORT), timeout=0.2).close(); break
    except OSError:
        time.sleep(0.1)

errors, passed = [], []


def check(cond, label):
    if not cond:
        raise AssertionError(label)
    passed.append(label); print('  ✓', label)


def add_family(pg, parent, phone, pickups, kids, save=True, mode='checkin'):
    pg.fill('[name=parentName]', parent)
    pg.fill('[name=phone]', phone)
    pg.fill('[name=pickups]', pickups)
    for i, (name, group, notes) in enumerate(kids):
        if i:
            pg.click('[data-act=add-kid]')
        row = pg.locator('.kidrow').nth(i)
        row.locator('[name=kname]').fill(name)
        row.locator('[name=kgroup]').select_option(group)
        row.locator('[name=knotes]').fill(notes)
    if not save:
        pg.uncheck('[name=save]')
    pg.click(f'button[data-mode={mode}]')


try:
    with sync_playwright() as p:
        kw = {'args': ['--no-sandbox']}
        if os.environ.get('CHROME_PATH'):
            kw['executable_path'] = os.environ['CHROME_PATH']
        browser = p.chromium.launch(**kw)
        ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        ctx.route('**/fonts.googleapis.com/**', lambda r: r.abort())
        ctx.route('**/fonts.gstatic.com/**', lambda r: r.abort())
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.goto(BASE + '?reset#checkin'); pg.wait_for_timeout(400)
        pg.screenshot(path=str(SHOTS / '01_empty.png'))

        print('Check-in')
        pg.click('[data-act=new-family]'); pg.click('button[data-mode=checkin]')
        check('Add at least one child' in pg.inner_text('#form-err'), 'empty form shows errors')
        pg.click('[data-act=close]')

        pg.click('[data-act=new-family]')
        add_family(pg, 'Chioma Okafor', '07700 900123', 'Grandma Ada, Uncle Emeka',
                   [('Tolu', '6-7', 'Peanut allergy'), ('Femi', '1-5', '')])
        pg.wait_for_selector('.bigcode'); code1 = pg.inner_text('.bigcode').strip()
        pg.screenshot(path=str(SHOTS / '02_checked_in.png'))
        check(len(code1) == 4, f'code issued ({code1})')
        check(pg.get_attribute('a.btn.wa', 'href').startswith('https://wa.me/447700900123'), 'WhatsApp link uses +44 number')
        pg.click('[data-act=close]')

        pg.click('[data-act=new-family]')
        add_family(pg, 'James Smith', '+44 7700 900456', '', [('Lily', '8-9', '')])
        pg.wait_for_selector('.bigcode'); code2 = pg.inner_text('.bigcode').strip(); pg.click('[data-act=close]')
        check(code1 != code2, 'different families get different codes')

        print('Two phones stay in sync')
        pg2 = ctx.new_page(); pg2.goto(BASE + '#rooms'); pg2.wait_for_timeout(400)
        check('Lily' in pg2.inner_text('#rooms-body'), 'second tab sees check-ins')

        print('Pickup')
        pg.click('nav a[href="#pickup"]')
        pg.fill('#pu-code', 'aaaa'); pg.wait_for_timeout(100)
        check('No match' in pg.inner_text('#pu-result'), 'wrong code is refused')
        pg.screenshot(path=str(SHOTS / '03_no_match.png'))
        pg.fill('#pu-code', code1.lower()); pg.wait_for_timeout(100)
        check('Code matches' in pg.inner_text('#pu-result'), 'right code matches (lower case ok)')
        pg.screenshot(path=str(SHOTS / '04_match.png'))
        pg.locator('#pu-result input[type=checkbox]').nth(1).uncheck(); pg.wait_for_timeout(100)
        pg.select_option('#pu-who', 'Grandma Ada')
        pg.click('[data-act=release]'); pg.wait_for_timeout(300)
        check('Tolu to Grandma Ada' in pg.inner_text('#pu-result'), 'release one child to approved adult')
        pg.fill('#pu-code', code1); pg.wait_for_timeout(100)
        t = pg.inner_text('#pu-result')
        check('Femi' in t and 'Collected at' in t, 'sibling still in, first shows collected')

        print('Leader release (lost code)')
        pg.fill('#pu-code', '')
        pg.click('[data-act=lost-code]'); pg.fill('#lc-q', 'lil'); pg.wait_for_timeout(100)
        pg.click('#lc-results .card >> nth=0')
        pg.click('form[data-form=override] button[type=submit]')
        check('Fill in all three' in pg.inner_text('#form-err'), 'leader release needs all details')
        pg.fill('[name=who]', 'Mary Smith'); pg.fill('[name=leader]', 'Pastor John'); pg.select_option('[name=how]', index=2)
        pg.click('form[data-form=override] button[type=submit]'); pg.wait_for_timeout(300)

        pg.click('nav a[href="#rooms"]'); pg.wait_for_timeout(300); pg.click('details summary')
        rooms = pg.inner_text('#rooms-body')
        check('Approved by Pastor John' in rooms, 'leader release is recorded')
        pg.screenshot(path=str(SHOTS / '05_rooms.png'), full_page=True)

        print('Siblings share a code')
        pg.click('nav a[href="#checkin"]'); pg.click('[data-act=new-family]')
        add_family(pg, 'Ada Bello', '07123 456789', '', [('Zara', '10-12', ''), ('Bayo', '8-9', '')], mode='save')
        pg.wait_for_timeout(200); pg.fill('#ci-q', 'bello'); pg.wait_for_timeout(100)
        pg.click('#ci-results .card >> nth=0'); pg.locator('.sheet input[name=kid]').nth(1).uncheck()
        pg.click('.sheet button[type=submit]'); pg.wait_for_selector('.bigcode'); a = pg.inner_text('.bigcode'); pg.click('[data-act=close]')
        pg.click('#ci-results .card >> nth=0'); pg.click('.sheet button[type=submit]'); pg.wait_for_selector('.bigcode'); b = pg.inner_text('.bigcode')
        check(a == b, 'late sibling gets the same code'); pg.click('[data-act=close]')

        print('Visitor not saved')
        pg.fill('#ci-q', ''); pg.click('[data-act=new-family]')
        add_family(pg, 'Visitor Mum', '07999 111222', '', [('Kemi', '1-5', '')], save=False)
        pg.wait_for_selector('.bigcode'); pg.click('[data-act=close]')
        pg.click('nav a[href="#families"]'); pg.wait_for_timeout(200)
        check('Visitor Mum' not in pg.inner_text('#fam-list'), 'unsaved visitor not in Families')

        print('Edit and delete a family')
        pg.fill('#fam-q', 'bello'); pg.wait_for_timeout(100); pg.click('#fam-list .card >> nth=0')
        pg.click('[data-act=delete-family]'); pg.click('[data-act=delete-family]'); pg.wait_for_timeout(300)
        pg.fill('#fam-q', '')
        check('Ada Bello' not in pg.inner_text('#fam-list'), 'family deleted after two taps')

        print('Setup')
        pg.click('a[href="#setup"]'); pg.fill('[name=churchName]', 'Grace Chapel')
        pg.click('form[data-form=settings] button[type=submit]'); pg.wait_for_timeout(300)
        check(pg.inner_text('#church') == 'Grace Chapel', 'church name saved')

        print('Read-only volunteer')
        pv = ctx.new_page(); pv.on('pageerror', lambda e: errors.append(str(e)))
        pv.goto(BASE + '?as=viewer#checkin'); pv.wait_for_timeout(400)
        check('View only' in pv.inner_text('#banner'), 'viewer sees view-only banner')
        pv.click('[data-act=new-family]'); pv.wait_for_timeout(100)
        check(not pv.is_visible('#overlay.open'), 'viewer cannot add families')

        print('Signed out')
        ps = ctx.new_page(); ps.goto(BASE + '?as=signedout'); ps.wait_for_timeout(500)
        check('Sign in to open the register' in ps.inner_text('#view'), 'signed-out screen')
        browser.close()
finally:
    server.terminate()

if errors:
    print('Page errors:', errors); sys.exit(1)
print(f'\nAll {len(passed)} checks passed. Screenshots in {SHOTS}')
