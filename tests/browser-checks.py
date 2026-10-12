"""Browser checks for GovernancePro Global (needs Python 3 + `pip install playwright` + a Chromium).

    npm run dev                                   # local Worker with a FRESH local database (.dev.vars needed)
    python3 tests/browser-checks.py http://localhost:8787 [path-to-chromium]

Creates leads. Never run against production.
"""
import json, os, re, sys, urllib.request, base64
from playwright.sync_api import sync_playwright

BASE = sys.argv[1].rstrip('/')
CHROMIUM = sys.argv[2] if len(sys.argv) > 2 else None
PASSWORD = os.environ.get('ADMIN_PASSWORD', 'local-test-admin-pass')
AUTH = 'Basic ' + base64.b64encode(f'admin:{PASSWORD}'.encode()).decode()
PAGES = ['/', '/saas', '/privacy', '/terms']
results = []


def check(name, ok, detail=''):
    results.append(bool(ok))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''))


ipn = [0]


def api(method, path, body=None, auth=True):
    ipn[0] += 1
    h = {'Content-Type': 'application/json', 'cf-connecting-ip': f'198.51.100.{ipn[0] % 240 + 1}'}
    if auth:
        h['Authorization'] = AUTH
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers=h)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'null')


def leads(q=''):
    return api('GET', '/api/admin/leads' + q)[1]


with sync_playwright() as p:
    browser = p.chromium.launch(**({'executable_path': CHROMIUM} if CHROMIUM else {}))
    ctx = browser.new_context(viewport={'width': 1280, 'height': 850})
    ctx.add_init_script("window.__csp=[]; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective+' <- '+e.blockedURI));")
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'ERR_NAME_NOT_RESOLVED' not in m.text and 'Failed to load resource' not in m.text else None)

    # 1. every page: one h1, title, description, canonical, social tags, no sideways scroll, no CSP violations
    titles = set()
    for path in PAGES:
        for width in (1280, 390):
            page.set_viewport_size({'width': width, 'height': 850})
            page.goto(BASE + path, wait_until='networkidle')
            if width == 1280:
                title = page.title(); titles.add(title)
                desc = page.locator('meta[name=description]').get_attribute('content') or ''
                canon = page.locator('link[rel=canonical]').get_attribute('href') or ''
                og = page.locator('meta[property="og:title"]').count()
                check(f'{path}: one h1, a title, a description, a canonical link and social tags', page.locator('h1').count() == 1 and len(title) > 10 and len(desc) > 40 and canon.startswith('https://') and og == 1, f'h1={page.locator("h1").count()} {title!r} {canon}')
            check(f'{path}: no sideways scrolling at {width}px', not page.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth'))
    check('every page has its own distinct title', len(titles) == len(PAGES), str(titles))
    check('structured data on the home page is valid and describes only the organisation', (lambda d: d.get('@type') == 'Organization' and d.get('name') == 'GovernancePro Global')(json.loads((page.goto(BASE + '/', wait_until='networkidle'), page.locator('script[type="application/ld+json"]').inner_text())[1])))

    # 2. navigation, desktop
    page.set_viewport_size({'width': 1280, 'height': 850})
    page.goto(BASE + '/', wait_until='networkidle')
    nav = page.locator('header nav')
    check('desktop: the menu has "SaaS Solutions"', nav.locator('a', has_text='SaaS Solutions').count() == 1)
    nav.locator('a', has_text='SaaS Solutions').click(); page.wait_for_url('**/saas')
    check('  ...it opens the SaaS Solutions page', 'incident' not in page.inner_text('h1').lower() and page.title().startswith('SaaS Solutions'))
    check('  ...and the page marks itself as the current one', page.locator('header nav a[aria-current=page]').inner_text() == 'SaaS Solutions')
    page.goto(BASE + '/', wait_until='networkidle')
    check('home hero has a SaaS Solutions button', page.locator('.actions a', has_text='SaaS Solutions').count() == 1)
    foot = page.locator('footer a')
    check('footer links to SaaS Solutions, privacy and terms', all(foot.filter(has_text=t).count() >= 1 for t in ['SaaS Solutions', 'Privacy notice', 'Terms of service']))

    # 3. navigation, phone
    page.set_viewport_size({'width': 390, 'height': 844})
    for path in PAGES:
        page.goto(BASE + path, wait_until='networkidle')
        btn = page.locator('#menuBtn')
        check(f'phone {path}: a menu button is visible and the menu starts closed', btn.is_visible() and btn.get_attribute('aria-expanded') == 'false' and not page.locator('header nav a', has_text='SaaS Solutions').is_visible())
    for width in (390, 360):
        page.set_viewport_size({'width': width, 'height': 800})
        for path in PAGES:
            page.goto(BASE + path, wait_until='networkidle')
            box = page.locator('#menuBtn').bounding_box()
            check(f'phone {width}px {path}: the menu button is fully ON screen (reachable) and the page does not scroll sideways', box and box['x'] >= 0 and box['x'] + box['width'] <= width and not page.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth'), str(box))
    page.set_viewport_size({'width': 390, 'height': 844})
    page.goto(BASE + '/', wait_until='networkidle')
    btn = page.locator('#menuBtn'); btn.click()
    check('phone: the menu opens, shows SaaS Solutions, and aria-expanded is true', btn.get_attribute('aria-expanded') == 'true' and page.locator('header nav a', has_text='SaaS Solutions').is_visible())
    page.keyboard.press('Escape')
    check('phone: Escape closes the menu', btn.get_attribute('aria-expanded') == 'false')
    btn.click(); page.locator('header nav a', has_text='SaaS Solutions').click(); page.wait_for_url('**/saas')
    check('phone: choosing SaaS Solutions navigates to the SaaS page', page.title().startswith('SaaS Solutions'))
    page.goto(BASE + '/', wait_until='networkidle'); btn.click(); page.locator('header nav a', has_text='Assessment').click(); page.wait_for_timeout(500)
    check('phone: an in-page link closes the menu', btn.get_attribute('aria-expanded') == 'false')

    # 4. links
    page.set_viewport_size({'width': 1280, 'height': 850})
    dead, targets = [], set()
    for path in PAGES:
        page.goto(BASE + path, wait_until='networkidle')
        ids = set(page.evaluate("[...document.querySelectorAll('[id]')].map(e => e.id)"))
        for a in page.locator('a[href]').all():
            href = a.get_attribute('href')
            if not href or href == '#': dead.append((path, 'empty link')); continue
            if href.startswith('http') or href.startswith('mailto:'): continue
            if href.startswith('#') and href[1:] not in ids: dead.append((path, href))
            elif href.startswith('/'): targets.add(href.split('#')[0] or '/')
    for t in sorted(targets):
        r = page.request.get(BASE + t, max_redirects=0)
        if r.status != 200: dead.append((t, r.status))
    check(f'no dead, empty or mis-targeted links ({len(targets)} pages and all in-page anchors checked)', not dead, str(dead))

    # 5. SaaS page claims
    page.goto(BASE + '/saas', wait_until='networkidle')
    body = page.inner_text('body')
    cards = page.locator('#pricing article')
    check('four plan cards with the proposed prices', cards.count() == 4 and all(x in page.locator('#pricing').inner_text() for x in ['US$49', 'US$99', 'US$299', 'US$499']))
    txt = [cards.nth(i).inner_text() for i in range(4)]
    check('Starter lists what exists today and what is planned, with a waitlist button only', 'Readiness assessment tools' in txt[0] and 'planned' in txt[0].lower() and 'Join the waitlist' in txt[0])
    check('Professional and MSP/Partner are "Coming soon" with a waitlist button only', all('Coming soon' in txt[i] and 'Join the waitlist' in txt[i] for i in (1, 2)))
    check('Enterprise is enquiry-only and promises no pre-built capability', 'Enquiry only' in txt[3] and 'No capability is pre-built' in txt[3])
    check('the paid report is shown separately, from US$149, and is clearly not available', 'US$149' in body and 'cannot be bought today' in body)
    check('no purchase, checkout or invented-proof wording anywhere on the page', not re.search(r'\b(buy now|subscribe now|checkout|add to cart|pay now|testimonial|trusted by)\b', body, re.I))
    check('the page says results are not an audit, certification or guarantee', re.search(r'not an? (independent )?audit', body, re.I) and 'guarantee' in body.lower())
    check('comparison table has a caption, column headers and "Planned" labels', page.locator('table caption').count() == 1 and page.locator('thead th[scope=col]').count() == 5 and 'Planned' in page.inner_text('table'))
    page.locator('summary').first.focus(); page.keyboard.press('Enter')
    check('FAQ opens with the keyboard', page.locator('details').first.evaluate('d => d.open'))
    check('the first Tab stop is "Skip to content", and it moves focus to the main area', (lambda: (page.goto(BASE + '/saas'), page.keyboard.press('Tab'), page.evaluate('document.activeElement.textContent.trim()') == 'Skip to content' and (page.keyboard.press('Enter'), page.evaluate('document.activeElement.id') == 'main')[1])[2])())
    unlabeled = page.evaluate("""() => [...document.querySelectorAll('input:not([tabindex="-1"]), select, textarea')].filter(el => !(el.labels && el.labels.length)).map(el => el.id)""")
    check('every form control on the SaaS page has a label', not unlabeled, str(unlabeled))

    # 6. waitlist form
    page.goto(BASE + '/saas', wait_until='networkidle')
    page.locator('[data-interest=saas_msp]').click()
    check('a plan button preselects that plan in the waitlist form', page.locator('#wInterest').input_value() == 'saas_msp')
    page.locator('#wSubmit').click()
    check('waitlist: an empty form is blocked by validation', page.locator('#wName').evaluate('el => el.validity.valueMissing'))
    page.fill('#wName', 'Pat Partner'); page.fill('#wEmail', 'pat@msp.co.za'); page.fill('#wCompany', 'MSP Co'); page.fill('#wMessage', 'We run 12 client networks.')
    page.locator('#wSubmit').click()
    check('waitlist: consent is required before anything is sent', page.locator('#wConsent').evaluate('el => el.validity.valueMissing') and not leads('?q=pat%40msp')['leads'])
    page.check('#wConsent')
    page.route('**/api/leads', lambda r: r.fulfill(status=503, content_type='application/json', body='{"ok":false,"error":"We could not save your request just now."}'))
    page.locator('#wSubmit').click(); page.wait_for_timeout(500)
    check('waitlist: a database failure shows an error, never a success message', page.locator('#waitMsg .err').count() == 1 and page.locator('#waitMsg .ok').count() == 0)
    page.unroute('**/api/leads')
    page.route('**/api/leads', lambda r: r.abort())
    page.locator('#wSubmit').click(); page.wait_for_timeout(500)
    check('waitlist: a network failure shows "could not reach the server"', 'could not reach the server' in page.inner_text('#waitMsg'))
    page.unroute('**/api/leads')
    page.locator('#wSubmit').click(); page.wait_for_timeout(1000)
    check('waitlist: success is shown only after the server confirms', 'on the waitlist' in page.inner_text('#waitMsg') and page.locator('#waitMsg .ok').count() == 1)
    row = leads('?q=pat%40msp')['leads']
    check('waitlist: stored as type=waitlist, interest=saas_msp, with consent and the wording version', len(row) == 1 and row[0]['type'] == 'waitlist' and row[0]['product_interest'] == 'saas_msp' and row[0]['consent'] == 1 and row[0]['consent_version'] == '2026-10-12', str(row))
    check('the spam-trap field is hidden from people and assistive technology', page.locator('#wHp').evaluate('el => el.closest("[aria-hidden=true]") !== null && el.tabIndex === -1'))

    # 7. assessment form on the home page
    page.goto(BASE + '/', wait_until='networkidle')
    def fill_assessment(email):
        page.select_option('#framework', 'ISO 27001'); page.select_option('#docs', 'Basic'); page.select_option('#support', 'Moderate')
        page.select_option('#timeline', '12+ months'); page.select_option('#need', 'Implementation support')
        page.fill('#name', 'Ayesha Khan'); page.fill('#company', 'Khan Logistics'); page.fill('#email', email)
    fill_assessment('ayesha@khan.co.za')
    page.locator('#assessmentForm button[type=submit]').click(); page.wait_for_timeout(300)
    check('assessment: consent is required and nothing is saved without it', page.locator('#consent').evaluate('el => el.validity.valueMissing') and not leads('?q=ayesha')['leads'])
    check('the consent text links to the privacy notice', page.locator('#assessmentForm a[href="/privacy"]').count() == 1)
    page.check('#consent')
    page.route('**/api/leads', lambda r: r.fulfill(status=503, content_type='application/json', body='{"ok":false,"error":"We could not save your request just now. Please try again in a few minutes."}'))
    page.locator('#assessmentForm button[type=submit]').click(); page.wait_for_timeout(600)
    res = page.inner_text('#assessmentResult')
    check('assessment: when saving fails the visitor is told, no score is shown, and no "demo mode" message appears', 'could not save your assessment' in res and '/100' not in res and 'Demo mode' not in res)
    check('assessment: nothing is kept in the browser as a fallback', page.evaluate("Object.keys(localStorage).filter(k => /lead/i.test(k)).length") == 0)
    page.unroute('**/api/leads')
    page.locator('#assessmentForm button[type=submit]').click(); page.wait_for_timeout(1000)
    res = page.inner_text('#assessmentResult')
    check('assessment: the result shown is the SERVER\'s: (35+45+70+50)/4 = 50/100, Defined', '50/100' in res and 'Defined' in res and 'Readiness assessment + targeted improvement programme' in res, res[:120])
    check('assessment: the result says it is a self-assessment, not an audit or guarantee', re.search(r'not an audit', res) and 'guarantee' in res)
    row = leads('?q=ayesha')['leads']
    check('assessment: stored with the server score, answers, consent and wording version', len(row) == 1 and row[0]['score'] == 50 and row[0]['consent'] == 1 and row[0]['consent_version'] == '2026-10-12' and json.loads(row[0]['answers'])['docs'] == 'Basic', str(row))

    # 8. calculator: what the visitor sees must equal what the server stores
    page.locator('.actions button', has_text='Calculate Consulting Cost').click()
    page.select_option('#qframework', 'ISO 27001'); page.select_option('#qservice', 'Readiness / Gap Analysis'); page.select_option('#qsize', '51–100'); page.select_option('#qmaturity', 'Developing')
    page.select_option('#region', 'ZA'); page.locator('#quoteForm button[type=submit]').click(); page.wait_for_timeout(800)
    shown = page.inner_text('#quoteResult')
    nums = [int(x.replace(',', '')) for x in re.findall(r'R([\d,]+)', shown)]
    check('calculator (South Africa): shows R23,288 to R33,767', nums[:2] == [23288, 33767] and 'ZAR' in shown, shown[:100])
    check('calculator: explains that other currencies use fixed, indicative rates', 'fixed, indicative' in shown)
    q = [l for l in leads('?type=quote')['leads'] if l['estimate_low'] == 23288]
    check('calculator: the server independently computed and stored the SAME range, in ZAR', len(q) == 1 and q[0]['estimate_high'] == 33767 and q[0]['estimate_currency'] == 'ZAR', str(q))
    page.select_option('#region', 'US'); page.locator('#quoteForm button[type=submit]').click(); page.wait_for_timeout(800)
    shown = page.inner_text('#quoteResult')
    check('calculator (United States): shows $1,281 to $1,857 USD at the fixed indicative rate', '$1,281 USD' in shown and '$1,857 USD' in shown, shown[:100])
    q2 = [l for l in leads('?type=quote')['leads'] if l['region'] == 'US']
    check('...and stores the ZAR figures with the display currency kept separately', len(q2) == 1 and q2[0]['estimate_low'] == 23288 and q2[0]['currency'] == 'USD' and q2[0]['estimate_currency'] == 'ZAR')

    # 9. private things stay private
    ctx2 = browser.new_context(viewport={'width': 1280, 'height': 850})
    anon = ctx2.new_page()
    r = anon.goto(BASE + '/admin')
    check('admin page: an anonymous visitor gets 401, not the page', r.status == 401 and 'Dashboard' not in anon.content())
    r = anon.goto(BASE + '/.dev.vars')
    check('the local secrets file is not served', r.status in (404,) or 'ADMIN_PASSWORD' not in anon.content())
    for path in ['/', '/saas', '/privacy', '/terms', '/site.css']:
        txt = page.request.get(BASE + path).text()
        check(f'no secrets or admin credentials in {path}', 'ADMIN_PASSWORD' not in txt and PASSWORD not in txt)
    ctx2.close()

    # 10. admin screen
    for i in range(55):  # enough leads to need a second page
        api('POST', '/api/leads', {'type': 'enquiry', 'name': f'Bulk Person {i:02d}', 'email': f'bulk{i:02d}@example.co.za', 'product_interest': 'consulting', 'consent': True, 'consent_version': '2026-10-12'}, auth=False)
    actx = browser.new_context(viewport={'width': 1360, 'height': 900}, http_credentials={'username': 'admin', 'password': PASSWORD}, accept_downloads=True)
    adm = actx.new_page(); aerr = []
    adm.on('pageerror', lambda e: aerr.append(str(e)))
    adm.goto(BASE + '/admin', wait_until='networkidle'); adm.wait_for_timeout(1000)
    total = leads()['total']
    check('admin: the page loads for the administrator and reports success', 'Dashboard loaded' in adm.inner_text('#message'), adm.inner_text('#message'))
    check('admin: the headline figures show real numbers (not dashes)', adm.inner_text('#total').replace(',', '') == str(total) and adm.inner_text('#avgScore') not in ('—', '') and adm.inner_text('#pipelineLow') not in ('—', ''), f"{adm.inner_text('#total')} {adm.inner_text('#avgScore')} {adm.inner_text('#pipelineLow')}")
    check('admin: the regional, status and framework panels list real names and counts', 'South Africa' in adm.inner_text('#regions') or 'ZA' in adm.inner_text('#regions') or 'US' in adm.inner_text('#regions'))
    check('admin: panels render names and counts, not "[object Object]"', 'object' not in adm.inner_text('#statuses').lower() and 'New' in adm.inner_text('#statuses'))
    check('admin: the pipeline is labelled as ZAR', 'ZAR' in adm.inner_text('body'))
    check('admin: page 1 shows 50 of the total, with Previous disabled and Next enabled', adm.locator('#rows tr').count() == 50 and adm.locator('#prev').is_disabled() and adm.locator('#next').is_enabled() and f'of {total}' in adm.inner_text('#resultInfo'), adm.inner_text('#resultInfo'))
    adm.click('#next'); adm.wait_for_timeout(600)
    check('admin: Next shows the remaining rows and enables Previous', adm.locator('#rows tr').count() == total - 50 and adm.locator('#prev').is_enabled() and adm.locator('#next').is_disabled())
    adm.click('#prev'); adm.wait_for_timeout(400)
    adm.select_option('#fType', 'waitlist'); adm.click('#filters button[type=submit]'); adm.wait_for_timeout(600)
    check('admin: filtering by type shows only that type', adm.locator('#rows tr').count() == 1 and 'waitlist' in adm.inner_text('#rows'))
    adm.click('#filters button:has-text("Reset")'); adm.wait_for_timeout(500)
    adm.fill('#fQ', 'bulk person 07'); adm.click('#filters button[type=submit]'); adm.wait_for_timeout(600)
    check('admin: search finds the matching person', adm.locator('#rows tr').count() == 1 and 'Bulk Person 07' in adm.inner_text('#rows'))
    adm.click('#filters button:has-text("Reset")'); adm.wait_for_timeout(500)
    adm.fill('#fFrom', '2099-01-01'); adm.click('#filters button[type=submit]'); adm.wait_for_timeout(600)
    check('admin: a date range with no leads shows an empty state', 'No leads found' in adm.inner_text('#rows'))
    adm.click('#filters button:has-text("Reset")'); adm.wait_for_timeout(500)
    adm.fill('#fQ', 'ayesha'); adm.click('#filters button[type=submit]'); adm.wait_for_timeout(600)
    adm.select_option('#rows select.status', 'Qualified'); adm.wait_for_timeout(800)
    check('admin: changing a status shows confirmation and the change is saved (this used to fail with a 400)', 'updated to Qualified' in adm.inner_text('#message') and leads('?q=ayesha')['leads'][0]['lead_status'] == 'Qualified', adm.inner_text('#message'))
    with adm.expect_download() as dl:
        adm.click('#filters button:has-text("Export CSV")')
    csv = open(dl.value.path()).read()
    check('admin: Export CSV downloads the filtered list with consent columns', dl.value.suggested_filename.endswith('.csv') and 'Consent given' in csv.split('\n')[0] and 'ayesha@khan.co.za' in csv and 'bulk' not in csv)
    adm.once('dialog', lambda d: d.accept())
    adm.click('#rows button.danger'); adm.wait_for_timeout(1000)
    check('admin: Delete (after confirming) permanently removes the person', not leads('?q=ayesha')['leads'] and total - 1 == leads()['total'])
    check('admin: deletions and status changes appear in the audit trail, without personal data', all(a in json.dumps(api('GET', '/api/admin/audit')[1]) for a in ['status_change', 'delete']) and 'ayesha' not in json.dumps(api('GET', '/api/admin/audit')[1]))
    check('admin: no script errors', not aerr, str(aerr[:2]))
    actx.close()

    check('no console or page errors on the public pages', not errors, str(errors[:3]))
    check('no Content-Security-Policy violations on the public pages', not page.evaluate('window.__csp'), str(page.evaluate('window.__csp')))
    browser.close()

failed = results.count(False)
print(f"\n{len(results) - failed} passed, {failed} failed, {len(results)} checks")
sys.exit(1 if failed else 0)
