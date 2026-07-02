#!/usr/bin/env python3
"""
Refresh USSC enrollment data and update camp-scheduler CAMP_NEEDS.
Logs in to director.ussportscamps.com, fetches Fee/Registration Type counts
for every 2026 class, calculates 1-per-10 AM/PM staff needs, and writes
enrollment.json used by the admin panel.
"""
import requests, json, math, re, time, warnings, sys, os
from bs4 import BeautifulSoup
warnings.filterwarnings('ignore')

BASE = 'https://director.ussportscamps.com'
LOGIN_URL = BASE + '/director/login/director/classes'
CAMPERS_URL = BASE + '/director/campers'
OUT_FILE = os.path.join(os.path.dirname(__file__), 'enrollment.json')

CREDENTIALS = {
    'fname': 'Rich',
    'lname': 'Schreiner',
    'password': 'ussportscamps',
}

# Map USSC camp display names → scheduler location labels
CAMP_LOCATION_MAP = {
    'Nike Soccer Camp at Seattle University 2026': 'Seattle University',
    'Nike Soccer Camp at Lower Woodland Playfields 2026': 'Lower Woodland',
    'Nike Soccer Camp at Washington Park Playfield 2026': 'Washington Park',
    'Nike Soccer Camp in Bothell 2026': 'Bothell',
    'Nike Soccer Camp in Issaquah 2026': 'Issaquah',
    'Nike Soccer Camp in Kirkland 2026': 'Kirkland',
    'Nike Soccer Camp in Lake Hills - Bellevue 2026': 'Bellevue',
    'Nike Soccer Camp in West Seattle 2026': 'West Seattle',
}

# Scheduler admin.html camp keys (location · date)
SCHEDULER_CAMP_NAMES = {
    ('Seattle University', '06/15'): 'June 15\u201319 \u00b7 Seattle University',
    ('Seattle University', '06/22'): 'June 22\u201326 \u00b7 Seattle University',
    ('West Seattle',       '06/22'): 'June 22\u201326 \u00b7 West Seattle Del Ridge',
    ('Kirkland',           '07/06'): 'July 6\u201310 \u00b7 Kirkland',
    ('Lower Woodland',     '07/06'): 'July 6\u201310 \u00b7 Lower Woodland',
    ('Seattle University', '07/06'): 'July 6\u201310 \u00b7 Seattle University',
    ('Issaquah',           '07/13'): 'July 13\u201317 \u00b7 Issaquah',
    ('Seattle University', '07/13'): 'July 13\u201317 \u00b7 Seattle University',
    ('West Seattle',       '07/13'): 'July 13\u201317 \u00b7 West Seattle Hiawatha',
    ('Bothell',            '07/20'): 'July 20\u201324 \u00b7 Bothell',
    ('Seattle University', '07/20'): 'July 20\u201324 \u00b7 Seattle University',
    ('West Seattle',       '07/20'): 'July 20\u201324 \u00b7 West Seattle Del Ridge',
    ('Bellevue',           '08/03'): 'Aug 3\u20137 \u00b7 Bellevue',
    ('Washington Park',    '08/03'): 'Aug 3\u20137 \u00b7 Washington Park',
    ('Issaquah',           '08/10'): 'Aug 10\u201314 \u00b7 Issaquah',
    ('Lower Woodland',     '08/10'): 'Aug 10\u201314 \u00b7 Lower Woodland',
    ('Bellevue',           '08/17'): 'Aug 17\u201321 \u00b7 Bellevue',
    ('West Seattle',       '08/17'): 'Aug 17\u201321 \u00b7 West Seattle Del Ridge',
}


def login():
    sess = requests.Session()
    sess.headers['User-Agent'] = 'Mozilla/5.0'
    r = sess.get(LOGIN_URL)
    soup = BeautifulSoup(r.content, 'html.parser')
    def gv(name):
        el = soup.find('input', {'name': name})
        return el['value'] if el else ''
    r2 = sess.post(LOGIN_URL, data={
        '__EVENTTARGET': 'ctl00$ContentPlaceHolder1$LinkButtonLogin',
        '__EVENTARGUMENT': '',
        '__LASTFOCUS': '',
        '__VIEWSTATE': gv('__VIEWSTATE'),
        '__VIEWSTATEGENERATOR': gv('__VIEWSTATEGENERATOR'),
        'ctl00$ContentPlaceHolder1$TextBoxFname': CREDENTIALS['fname'],
        'ctl00$ContentPlaceHolder1$TextBoxLname': CREDENTIALS['lname'],
        'ctl00$ContentPlaceHolder1$TextBoxPassword': CREDENTIALS['password'],
    })
    if 'Log off' not in r2.text and 'Hello' not in r2.text:
        raise RuntimeError('USSC login failed')
    print('✓ Logged in to USSC')
    return sess


def get_class_map(sess):
    """Returns list of {campName, campId, classId, className}"""
    r = sess.get(CAMPERS_URL)
    soup = BeautifulSoup(r.content, 'html.parser')

    camp_sel = soup.find('select', {'id': 'DropDownListCamps'})
    camps = [(o['value'], o.get_text(strip=True)) for o in camp_sel.find_all('option')
             if o.get('value') and 'Girls Soccer' not in o.get_text() and 'Show All' not in o.get_text()]

    def form_state(s):
        out = {}
        for f in ['__VIEWSTATE','__VIEWSTATEGENERATOR','__EVENTVALIDATION']:
            el = s.find('input', {'name': f})
            if el: out[f] = el.get('value','')
        return out

    state = form_state(soup)
    class_map = []

    for camp_id, camp_name in camps:
        r2 = sess.post(CAMPERS_URL, data={
            **state,
            '__EVENTTARGET': 'ctl00$DropDownListCamps',
            '__EVENTARGUMENT': '',
            'ctl00$DropDownListSeasons': '29',
            'ctl00$DropDownListCamps': camp_id,
            'ctl00$DropDownListClass': '',
            'ctl00$DropDownListReport': '1',
            'ctl00$ContentPlaceHolder1$DropDownListDisplay': 'roster',
        })
        soup2 = BeautifulSoup(r2.content, 'html.parser')
        state = form_state(soup2)

        cls_sel = soup2.find('select', {'id': 'DropDownListClass'})
        if not cls_sel:
            continue

        for o in cls_sel.find_all('option'):
            if not o.get('value') or 'Show All' in o.get_text():
                continue
            # Skip plain Transfers and Residential (July 9-12); keep SUYI Scholarship Transfers
            txt = o.get_text(strip=True)
            if '07/09' in txt:
                continue
            if 'Transfer' in txt and 'SUYI' not in txt:
                continue
            class_map.append({
                'campId': camp_id, 'campName': camp_name,
                'classId': o['value'], 'className': o.get_text(strip=True),
            })
        time.sleep(0.2)

    print(f'✓ Found {len(class_map)} classes')
    return class_map


def fetch_fee_counts(sess, camp_id, class_id):
    """Returns {fee_type: count, ..., '_care': {yes_morning: n, yes_afternoon: n, yes_both: n}}"""
    url = f"{BASE}/director/report/1/2026/{camp_id}/{class_id}"
    r = sess.get(url, timeout=15)
    soup = BeautifulSoup(r.content, 'html.parser')
    for table in soup.find_all('table'):
        headers = [th.get_text(strip=True) for th in table.find_all('th')]
        if 'Fee/Registration Type' not in headers:
            continue
        fi = headers.index('Fee/Registration Type')
        # Find extended care column (may be named slightly differently across camps)
        care_col = None
        for i, h in enumerate(headers):
            if 'Extended Care' in h or 'extended care' in h.lower():
                care_col = i
                break
        counts = {}
        care = {'yes_morning': 0, 'yes_afternoon': 0, 'yes_both': 0}
        for row in table.find_all('tr'):
            cells = row.find_all('td')
            if len(cells) > fi:
                fee = cells[fi].get_text(strip=True)
                if fee:
                    counts[fee] = counts.get(fee, 0) + 1
            if care_col is not None and len(cells) > care_col:
                val = cells[care_col].get_text(strip=True).lower()
                if 'morning and afternoon' in val:
                    care['yes_both'] += 1
                elif 'morning' in val:
                    care['yes_morning'] += 1
                elif 'afternoon' in val:
                    care['yes_afternoon'] += 1
        counts['_care'] = care
        return counts
    return {}


def date_key(class_name):
    m = re.search(r'\((\d{2})/(\d{2})/\d{4}', class_name)
    return f"{m.group(1)}/{m.group(2)}" if m else '00/00'


def build_camp_needs(class_map, sess):
    """Aggregate by location+start-month/day, return {scheduler_name: {am, pm, ...}}"""
    from collections import defaultdict
    grouped = defaultdict(lambda: {'full': 0, 'half': 0})

    for cls in class_map:
        loc = CAMP_LOCATION_MAP.get(cls['campName'])
        if not loc:
            continue
        dk = date_key(cls['className'])
        counts = fetch_fee_counts(sess, cls['campId'], cls['classId'])
        grouped[(loc, dk)]['full'] += counts.get('Full Day', 0)
        grouped[(loc, dk)]['half'] += counts.get('Half Day', 0)
        care = counts.get('_care', {})
        grouped[(loc, dk)]['early_care'] = grouped[(loc, dk)].get('early_care', 0) + care.get('yes_morning', 0) + care.get('yes_both', 0)
        grouped[(loc, dk)]['late_care'] = grouped[(loc, dk)].get('late_care', 0) + care.get('yes_afternoon', 0) + care.get('yes_both', 0)
        time.sleep(0.2)

    result = {}
    for key, vals in grouped.items():
        sched_name = SCHEDULER_CAMP_NAMES.get(key)
        if not sched_name:
            print(f'  ⚠ No scheduler name for {key}')
            continue
        total = vals['full'] + vals['half']
        am = math.ceil(total / 10)
        pm = math.ceil(vals['full'] / 10)
        ec = vals.get('early_care', 0)
        lc = vals.get('late_care', 0)
        result[sched_name] = {
            'am': am, 'pm': pm,
            'fullDay': vals['full'], 'halfDay': vals['half'], 'total': total,
            'earlyCare': ec, 'lateCare': lc,
        }
        print(f"  {sched_name:<42} AM:{am:2} PM:{pm:2}  ({total} campers)  Early:{ec} Late:{lc}")

    return result


def update_admin_html(camp_needs):
    """Update CAMP_NEEDS in admin.html"""
    admin_path = os.path.join(os.path.dirname(__file__), 'public', 'admin.html')
    with open(admin_path) as f:
        html = f.read()

    # Build replacement JS object
    lines = ['// Staff needs auto-updated from USSC enrollment (1 staff per 10 campers)',
             '// AM = all campers; PM = Full Day campers only; earlyCare/lateCare from extended care signups',
             'const CAMP_NEEDS = {']
    for name, v in sorted(camp_needs.items(), key=lambda x: x[0]):
        lines.append(f'  {json.dumps(name)}: {{am:{v["am"]}, pm:{v["pm"]}, earlyCare:{v.get("earlyCare",0)}, lateCare:{v.get("lateCare",0)}}},  // {v["total"]} AM / {v["fullDay"]} PM campers  Early:{v.get("earlyCare",0)} Late:{v.get("lateCare",0)}')
    lines.append('};')
    new_block = '\n'.join(lines)

    # Replace existing CAMP_NEEDS block (use lambda to avoid backslash issues)
    pattern = r'// Staff needs.*?^const CAMP_NEEDS = \{.*?^};'
    new_html = re.sub(pattern, lambda m: new_block, html, flags=re.DOTALL | re.MULTILINE)
    if new_html == html:
        # Fallback: replace just the const block
        new_html = re.sub(r'const CAMP_NEEDS = \{.*?^};', lambda m: new_block, html, flags=re.DOTALL | re.MULTILINE)

    with open(admin_path, 'w') as f:
        f.write(new_html)
    print(f'✓ Updated admin.html')


def main():
    print('=== USSC Enrollment Refresh ===')
    sess = login()
    class_map = get_class_map(sess)
    print('Fetching enrollment data...')
    camp_needs = build_camp_needs(class_map, sess)

    # Save enrollment.json
    with open(OUT_FILE, 'w') as f:
        json.dump({'updated': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'camps': camp_needs}, f, indent=2)
    print(f'✓ Saved enrollment.json')

    update_admin_html(camp_needs)
    print('=== Done ===')
    return camp_needs


if __name__ == '__main__':
    main()
