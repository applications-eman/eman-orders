// Click-through of every screen and button in real Chromium, on a phone and on a desktop, against a local server + fake Odoo.
// Needs DATABASE_URL (scratch DB whose name contains "test"). Optional: UI_DATA=path/to/data.json, SHOTS=folder for screenshots.
if (!/test/i.test(process.env.DATABASE_URL || '') && process.env.ALLOW_WIPE !== 'yes') {
  console.error('Refusing to run: this test EMPTIES the database. Use a scratch database whose name contains "test".');
  process.exit(2);
}
process.env.APP_SECRET = 'test-secret-test-secret-1234';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ODOO_URL = 'http://127.0.0.1:54700';
process.env.ODOO_DB = 'demo';
process.env.ODOO_EXPECT_COMPANY = 'Eman Bakery Demo';
process.env.PORT = '54703';
process.env.PGSSL = 'off';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { createMock } = require('./mock-odoo');

const base = 'http://127.0.0.1:54703';
const out = process.env.SHOTS || path.join(__dirname, 'shots');
fs.mkdirSync(out, { recursive: true });
const FEAT = ['order_create', 'order_finalize', 'order_cancel', 'order_view', 'payments', 'credit_notes', 'trays_view', 'trays_transfer', 'daily_print', 'customers_view', 'sync_view'];

async function api(method, p, body, cookie) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

const problems = [];
let checks = 0;

(async () => {
  const db = require('../server/db');
  await db.q('drop schema public cascade; create schema public;');
  const mock = createMock();
  await mock.listen(54700);
  await require('../server/index').main();
  const data = process.env.UI_DATA ? JSON.parse(fs.readFileSync(process.env.UI_DATA, 'utf8')) : {
    P: [['PRD-001', 'CHAPATHI 25', 'CHAPATHI', 25, 4.5], ['PRD-002', 'CHAPATHI 25 B', 'CHAPATHI', 25, 4.2], ['PRD-003', 'BURGER 10', 'BURGER', 10, 2], ['PRD-004', 'SAMOULI 6', 'SAMOULI', 6, 1.25]],
    C: [['SLM-001', 'CUST A', 0], ['SLM-002', 'CUST B', 150], ['SLM-003', 'CUST C', 0]], X: { 'SLM-001': { 'PRD-001': 4.2 } }
  };
  mock.st.partners = data.C.map((c, i) => ({ id: 500 + i, name: c[1] }));
  mock.st.products = data.P.map((p, i) => ({ id: 10 + i, default_code: p[0] }));
  const admin = (await api('POST', '/api/login', { email: 'admin@test.local', password: 'admin-pass-123' })).cookie;
  await api('POST', '/api/admin/import', data, admin);
  await api('PUT', '/api/admin/users/1', { name: 'Shafeeq', email: 'admin@test.local', admin: true, active: true, feat: [], key: 'key-shafeeq' }, admin);
  await api('POST', '/api/admin/users', { name: 'Sidheek', email: 'sidheek@test.local', password: 'sidheek-pass', key: 'key-sidheek', feat: FEAT }, admin);
  await api('POST', '/api/admin/trays/branch', { branch: 'Hira Branch', qty: 500 }, admin);
  await api('POST', '/api/admin/trays/branch', { branch: 'Rahmaniyyah Branch', qty: 300 }, admin);
  for (const c of data.C.slice(0, 5)) await api('POST', '/api/admin/trays/customer', { cust: c[0], qty: 12 }, admin);

  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  async function run(name, w, h, email, password, steps) {
    if (process.env.ONLY && !process.env.ONLY.split(',').includes(name)) return;
    const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: w < 800, isMobile: w < 800, deviceScaleFactor: 2 });
    const pg = await ctx.newPage();
    pg.setDefaultTimeout(6000);
    pg.on('pageerror', e => problems.push(`[${name}] page error: ${e.message}`));
    pg.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) problems.push(`[${name}] console: ${m.text()}`); });
    pg.on('dialog', d => d.accept());
    const step = async (label, fn) => {
      checks++;
      try { await fn(); } catch (e) { await pg.screenshot({ path: `${out}/FAIL_${name}_${label.replace(/[^a-z0-9]+/gi, '_')}.png` }).catch(() => {}); problems.push(`[${name}] ${label}: ${String(e.message).split('\n').slice(0, process.env.VERBOSE ? 12 : 1).join(' | ')}`); }
    };
    const click = (sel, o = {}) => pg.click(sel, { timeout: 4000, ...o });
    const nav = async id => {
      const sel = `:is(.tabbar,.side) [data-act="nav"][data-id="${id}"]:visible`;
      if (await pg.locator(sel).count()) { await click(sel); return; }
      await click('[data-act="more"]');
      await click(`.modal [data-act="nav"][data-id="${id}"]`);
    };
    const shot = n => pg.screenshot({ path: `${out}/${name}_${n}.png` });
    const layout = async label => {
      const r = await pg.evaluate(() => {
        const res = [];
        const de = document.documentElement;
        if (de.scrollWidth > de.clientWidth + 1) res.push(`page wider than screen (${de.scrollWidth} > ${de.clientWidth})`);
        const c = document.querySelector('#content');
        if (c && c.scrollWidth > c.clientWidth + 1) res.push(`content scrolls sideways (${c.scrollWidth} > ${c.clientWidth})`);
        document.querySelectorAll('input:not([type=checkbox]):not([type=file]),select,textarea').forEach(e => {
          if (e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 16) res.push(`input text under 16px (iPhone would zoom): ${e.id || e.className}`);
        });
        return res;
      });
      r.forEach(x => problems.push(`[${name}] ${label}: ${x}`));
    };
    await pg.goto(base);
    await steps({ pg, step, click, nav, shot, layout, name, w });
    await ctx.close();
  }

  const login = async ({ pg, click, step, shot, layout }, email, pw) => {
    await step('landing shows', async () => { await pg.waitForSelector('[data-act="gologin"]'); await shot('landing'); await layout('landing'); });
    await step('sign in opens', async () => { await click('[data-act="gologin"]'); await pg.waitForSelector('#lf'); await shot('login'); await layout('login'); });
    await step('wrong password message', async () => {
      await pg.fill('#le', email); await pg.fill('#lp', 'wrong-pass'); await click('#lf button[type=submit]');
      await pg.waitForFunction(() => document.querySelector('#lerr').textContent.length > 0);
    });
    await step('show-password button', async () => { await click('[data-act="togpw"]'); if ((await pg.getAttribute('#lp', 'type')) !== 'text') throw new Error('did not switch'); });
    await step('sign in works', async () => { await pg.fill('#lp', pw); await click('#lf button[type=submit]'); await pg.waitForSelector('.shell'); });
  };

  const staff = async t => {
    const { pg, step, click, nav, shot, layout, name, w } = t;
    await login(t, 'sidheek@test.local', 'sidheek-pass');
    await step('home', async () => { await shot('home'); await layout('home'); });
    await step('theme switch', async () => { await click('[data-act="theme"]'); await shot('home_dark'); await click('[data-act="theme"]'); });
    await step('bell opens and closes', async () => { await click('[data-act="bell"]'); await pg.waitForSelector('.pop'); await click('.pop [data-act="bell"]'); });

    // new order, with the back button on each step
    await step('new order: branch -> back', async () => {
      await nav('new'); await click('[data-act="branch"][data-id="Hira Branch"]');
      await pg.waitForSelector('#cq');
      // the step bar cannot be used to jump back, and Back asks before throwing the order away
      if (await pg.$('.steps [data-act="step"]')) throw new Error('step bar lets the user jump back on a new order');
      await click('[data-act="back"]'); await pg.waitForSelector('.modal #askno'); await shot('ask_cancel');
      if (!/cancel this order/i.test(await pg.innerText('.modal'))) throw new Error('cancel question missing');
      await click('#askno'); await pg.waitForSelector('#cq');
      await click('[data-act="back"]'); await pg.waitForSelector('.modal #askno'); await click('[data-act="askyes"]');
      await pg.waitForFunction(() => !document.querySelector('.modal'), null, { timeout: 4000 });
      await nav('new'); await pg.waitForSelector('[data-act="branch"]'); await click('[data-act="branch"][data-id="Hira Branch"]');
    });
    await step('new order: search and pick customer', async () => {
      await pg.fill('#cq', data.C[0][1].slice(0, 4)); await click('[data-act="pickcust"]');
      await pg.waitForSelector('#tiq'); await layout('trays popup'); await shot('trays_step');
    });
    await step('new order: keypad', async () => {
      // the popup opens by itself with the cursor already in the number box: just type, no click needed
      if (!(await pg.evaluate(() => document.activeElement && document.activeElement.id === 'tiq'))) throw new Error('number box is not focused');
      await pg.keyboard.type('12x'); if ((await pg.inputValue('#tiq')) !== '12') throw new Error('only digits expected, got ' + (await pg.inputValue('#tiq')));
      await pg.keyboard.press('Backspace'); await pg.keyboard.press('Backspace');
      await pg.keyboard.type('0'); await pg.keyboard.press('Enter');
    });
    await step('new order: products, packets, quantity', async () => {
      await pg.waitForSelector('[data-act="cat"]'); await shot('picker_empty'); await layout('picker');
      const cats = await pg.$$('.catgrid [data-act="cat"]');
      await cats[cats.length > 1 ? 1 : 0].click();
      const pcs = await pg.$$('[data-act="pcs"]'); if (pcs.length) await pcs[0].click();
      await pg.waitForSelector('.pt', { timeout: 4000 });
      const ph = w <= 760, box = ph ? 'mq' : 'zq';
      // tap a card: it zooms (phone: quantity card on top) and the cursor is already in the quantity box; type, Enter
      await click('.pt[data-act="padd"]');
      if (!(await pg.evaluate(b => document.activeElement && document.activeElement.id === b, box))) throw new Error('quantity box is not focused');
      await pg.keyboard.type('4x'); await pg.keyboard.press('Enter');
      await pg.waitForFunction(ph0 => !document.querySelector('.pt.zoom, .qcard') && document.querySelector('.pt [data-qty]').value === '4' && !(ph0 && document.activeElement && document.activeElement.tagName === 'INPUT'), ph, { timeout: 4000 });
      if (ph) {
        // plus and minus inside the phone quantity card, then the explicit Add button
        await click('.pt .pt-name'); await pg.waitForSelector('#mq');
        await click('[data-act="minc"]'); await click('[data-act="minc"]'); await click('[data-act="mdec"]');
        if ((await pg.inputValue('#mq')) !== '5') throw new Error('plus/minus in quantity card gave ' + await pg.inputValue('#mq'));
        await click('[data-act="madd"]');
        await pg.waitForFunction(() => !document.querySelector('.qcard') && document.querySelector('.pt [data-qty]').value === '5' && !(document.activeElement && document.activeElement.tagName === 'INPUT'), null, { timeout: 4000 });
      } else {
        await click('.pt [data-act="pinc"]'); await click('.pt [data-act="pinc"]'); await click('.pt [data-act="pdec"]');
        await pg.waitForFunction(() => document.querySelector('.pt [data-qty]').value === '5', null, { timeout: 4000 });
        await click('.pt .pt-name'); await pg.waitForSelector('.pt.zoom .zadd', { timeout: 3000 });
        await pg.keyboard.type('7'); await click('.pt.zoom .zadd');
        await pg.waitForFunction(() => !document.querySelector('.pt.zoom') && document.querySelector('.pt [data-qty]').value === '7', null, { timeout: 4000 });
      }
      await shot('picker'); await layout('picker with items');
    });
    await step('new order: cart and create', async () => {
      if (w <= 760) { await click('.top [data-act="cartdrop"]'); await pg.waitForSelector('.cdrop.open', { timeout: 3000 }); await pg.waitForTimeout(350); await shot('cart_drop'); await click('.cdrop [data-act="create"]'); }
      else if (w < 1100) { await click('[data-act="opencart"]'); await shot('cart'); await click('.modal [data-act="create"]'); }
      else await click('.cart [data-act="create"]');
      await pg.waitForSelector('.modal .rcpt'); await shot('created'); await click('.modal button[data-act="closemodal"]');
    });
    await step('pending: edit then save', async () => {
      await nav('pending'); await shot('pending'); await layout('pending');
      await click('[data-act="editord"]'); await pg.waitForSelector('.pt, .ghost');
      await pg.evaluate(() => document.querySelector('[data-act="back"]').click());
      await pg.waitForSelector('.modal #askno'); await click('[data-act="askyes"]');
    });
    await step('pending: print slip opens without error', async () => { await pg.evaluate(() => { window.print = () => {}; }); await click('[data-act="print"]'); });
    await step('pending: cancel an order', async () => {
      await nav('new'); await click('[data-act="branch"][data-id="Hira Branch"]'); await click('[data-act="pickcust"]'); await pg.waitForSelector('#tiq'); await click('[data-act="tinzero"]');
      const cats = await pg.$$('.catgrid [data-act="cat"]'); await cats[0].click(); const pcs = await pg.$$('[data-act="pcs"]'); if (pcs.length) await pcs[0].click();
      await click('.pt[data-act="padd"]'); await pg.keyboard.press('Enter'); // Enter on an empty box adds one packet
      await pg.waitForSelector('[data-act="create"]:not([disabled])', { state: 'attached', timeout: 4000 });
      if (w <= 760) { await click('.top [data-act="cartdrop"]'); await pg.waitForSelector('.cdrop.open', { timeout: 3000 }); await pg.waitForTimeout(350); await click('.cdrop [data-act="create"]'); }
      else if (w < 1100) { await click('[data-act="opencart"]'); await click('.modal [data-act="create"]'); } else await click('.cart [data-act="create"]');
      await click('.modal button[data-act="closemodal"]'); await nav('pending');
      const n = (await pg.$$('[data-act="cancelord"]')).length;
      await click('[data-act="cancelord"]'); await pg.fill('#crs', 'test cancel'); await click('[data-act="docancel"]');
      await pg.waitForFunction(k => document.querySelectorAll('[data-act="cancelord"]').length === k - 1, n);
    });
    await step('finalize with keypad', async () => {
      await click('[data-act="fin"]'); await pg.waitForSelector('[data-act="mset"]');
      await click('[data-act="mkey"][data-id="3"]'); await click('[data-act="mkey"][data-id="B"]'); await click('[data-act="mset"][data-id="5"]'); await shot('finalize'); await layout('finalize');
      await click('[data-act="dofin"]'); await pg.waitForFunction(() => /Invoice posted/.test(document.body.innerText), null, { timeout: 20000 }); await shot('done');
      await click('.modal button[data-act="closemodal"]');
    });
    await step('orders: tabs, search, details', async () => {
      await nav('orders'); await shot('orders'); await layout('orders');
      await click('[data-act="orddet"]'); await pg.waitForSelector('.modal'); await shot('order_detail'); await click('.modal button[data-act="closemodal"]');
      for (const t of ['pending', 'cancelled', 'final']) await click(`[data-act="tab"][data-id="${t}"]`);
      await pg.fill('[data-list="ordList"]', 'zzzz'); await pg.fill('[data-list="ordList"]', '');
    });
    await step('payments: cash is one customer and today only; transfers stay flexible', async () => {
      await nav('payments');
      await click('[data-act="method"][data-id="Cash"]');
      if (!(await pg.$('#pd[disabled]'))) throw new Error('cash date can be changed');
      if (!/cash note/i.test(await pg.innerText('#payf'))) throw new Error('cash note label missing');
      await pg.fill('#pa', '5'); await click('[data-act="payadd"]'); await pg.waitForSelector('[data-pl][readonly]');
      if (await pg.$('[data-act="payaddopen"]')) throw new Error('cash allows a second customer');
      if (parseFloat(await pg.inputValue('[data-pl]')) !== 5) throw new Error('cash amount did not follow the total');
      await click('[data-act="method"][data-id="SAB bank"]');
      if (await pg.$('#pd[disabled]')) throw new Error('transfer date is locked');
      await click('#pd'); await pg.waitForSelector('.dpm .dpd'); const before = await pg.innerText('#pd'); await click('.dpm [data-act="dpmove"][data-id="-1"]'); await click('.dpm .dpd >> nth=4');
      await pg.waitForFunction(() => !document.querySelector('.dpm'), null, { timeout: 3000 });
      if ((await pg.innerText('#pd')) === before) throw new Error('transfer date did not change');
      if (!/transfer reference/i.test(await pg.innerText('#payf'))) throw new Error('transfer reference label missing');
      if (!(await pg.$('[data-act="payaddopen"]'))) throw new Error('transfer cannot add another customer');
      await click('[data-act="payrm"]'); await pg.fill('#pa', '');
    });
    await step('payments: split between two customers', async () => {
      await nav('payments'); await click('[data-act="method"][data-id="SAB bank"]'); await pg.fill('#pa', '100');
      await click('[data-act="payadd"]'); await pg.waitForSelector('[data-pl]'); await click('[data-act="payaddopen"]'); await pg.fill('[data-list="payList"]', ''); await click('[data-act="payadd"]');
      await pg.fill('[data-pl]', '60'); await click('[data-act="payfill"] >> nth=1'); await shot('payments'); await layout('payments');
      await click('#paybtn'); await pg.waitForFunction(() => /posted to Odoo|waiting for Odoo/.test(document.body.innerText), null, { timeout: 15000 });
    });
    await step('payments: remove a customer line and reverse a payment', async () => {
      await pg.waitForSelector('[data-act="payrev"]'); await click('[data-act="payrev"]'); await pg.fill('#prs', 'test reverse'); await click('[data-act="dopayrev"]');
      await pg.waitForFunction(() => /reversed/i.test(document.body.innerText), null, { timeout: 15000 });
    });
    await step('credit note', async () => {
      await nav('credit'); await click('[data-act="selcust"]'); await pg.fill('#ca', '3.50'); await click('[data-act="reason"][data-id="Returned goods"]'); await pg.fill('#cnn', 'test');
      await shot('credit'); await layout('credit'); await click('#cnf button[type=submit]');
      await pg.waitForFunction(() => /credit note/i.test(document.querySelector('.toast') ? document.querySelector('.toast').innerText : ''), null, { timeout: 15000 });
    });
    await step('trays: overview, ledger, filters', async () => {
      await nav('trays'); await shot('trays'); await layout('trays');
      await click('[data-act="traycust"]'); await shot('trays_ledger'); await layout('trays ledger');
      await pg.selectOption('#trayb', 'Hira Branch'); await click('[data-act="tab"][data-id="over"]');
    });
    await step('trays: move trays between branches (preview, limit, save)', async () => {
      await nav('trays'); await click('[data-act="xfer"]'); await pg.waitForSelector('#xq'); await shot('transfer'); await layout('transfer');
      await pg.fill('#xq', '999999'); if (!(await pg.isDisabled('#xgo'))) throw new Error('more than the branch has was allowed');
      await pg.fill('#xq', '7'); await pg.fill('#xn', 'truck test');
      const prev = await pg.innerText('#xprev'); if (!/→/.test(prev)) throw new Error('no before/after preview: ' + prev);
      await click('[data-act="xfrom"][data-id="Rahmaniyyah Branch"]'); await pg.waitForFunction(() => /only 0|has only/.test(document.querySelector('#xprev').innerText), null, { timeout: 4000 }).catch(() => {});
      await click('[data-act="xfrom"][data-id="Hira Branch"]');
      if (await pg.inputValue('#xq') !== '7') throw new Error('typed number was lost');
      await click('#xgo'); await pg.waitForFunction(() => /TRF-\d+: 7 trays moved/.test(document.body.innerText), null, { timeout: 8000 });
      await click('[data-act="tab"][data-id="moves"]'); await pg.selectOption('#trayf', ''); await pg.selectOption('#trayb', '');
      await pg.waitForFunction(() => /Branch transfer/.test(document.body.innerText), null, { timeout: 4000 });
      await shot('transfer_ledger'); await layout('transfer ledger');
    });
    await step('customers: list, detail, prices, back', async () => {
      await nav('customers'); await shot('customers'); await layout('customers');
      await pg.fill('[data-list="cvList"]', 'CUST'); await pg.fill('[data-list="cvList"]', '');
      await click('[data-act="viewcust"]'); await shot('customer'); await layout('customer'); await click('[data-act="custback"]');
    });
    await step('day statement: preview and print', async () => {
      await nav('daily'); await shot('daily'); await layout('daily');
      if (await pg.$('[data-act="dayfmt"], [data-act="dayprintall"]')) throw new Error('paper buttons or print-all are still there');
      if (await pg.$('input[type=date]')) throw new Error('a browser date box is still used (it follows the device calendar)');
      await click('#dd'); await pg.waitForSelector('.dpm .dpd'); await shot('calendar');
      if (!/^(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/.test((await pg.innerText('.dpm .dpt')).trim())) throw new Error('calendar is not Gregorian: ' + await pg.innerText('.dpm .dpt'));
      await click('.dpm [data-act="dpmove"][data-id="-1"]'); await click('.dpm .dpd >> nth=2');
      await pg.waitForFunction(() => !document.querySelector('.dpm'), null, { timeout: 3000 });
      await click('#dd'); await pg.waitForSelector('.dpm'); await click('.dpm .btn.pri'); await pg.waitForFunction(() => !document.querySelector('.dpm'), null, { timeout: 3000 });
      await pg.waitForSelector('[data-act="daypick"]');
      // search by any part of the name; nothing matches gibberish
      await pg.fill('#dq', 'qqzzxx'); await pg.waitForFunction(() => !document.querySelector('[data-act="daypick"]') && /No customer matches/.test(document.body.innerText), null, { timeout: 3000 });
      await pg.fill('#dq', ''); await pg.waitForSelector('[data-act="daypick"]');
      if (!(await pg.$('.dayact [data-act="dayprint"][disabled]'))) throw new Error('print should wait for a customer');
      await click('[data-act="daypick"]'); await pg.waitForSelector('.dcard.on'); await shot('daily_selected');
      await click('.dayact [data-act="dayview"]'); await pg.waitForSelector('.dsview'); await shot('daily_preview'); await click('.modal button[data-act="closemodal"]');
      await pg.evaluate(() => { window.print = () => {}; }); await click('.dayact [data-act="dayprint"]');
    });
    await step('odoo sync screen', async () => { await nav('sync'); await shot('sync'); await layout('sync'); });
    await step('staff cannot see admin', async () => { if (await pg.$('[data-act="nav"][data-id="admin"]')) throw new Error('admin menu visible'); });
    await step('leaving an unfinished order through the menu asks first', async () => {
      await nav('new'); await click('[data-act="branch"][data-id="Hira Branch"]');
      await pg.evaluate(() => document.querySelector('[data-act="nav"][data-id="payments"]').click());
      await pg.waitForSelector('.modal #askno'); await click('#askno');
      if (!(await pg.$('#cq'))) throw new Error('order was lost although the user chose to keep it');
      await pg.evaluate(() => document.querySelector('[data-act="nav"][data-id="payments"]').click());
      await pg.waitForSelector('.modal #askno'); await click('[data-act="askyes"]');
      await pg.waitForFunction(() => !document.querySelector('.modal') && document.querySelector('#pa'), null, { timeout: 4000 });
      await nav('new'); await pg.waitForSelector('[data-act="branch"]');
    });
    await step('more sheet and sign out', async () => {
      if (w < 800) { await click('[data-act="more"]'); await shot('more'); await click('.modal [data-act="nav"] >> nth=0').catch(() => {}); }
      await pg.evaluate(() => document.querySelector('[data-act="logout"]').click());
      await pg.waitForSelector('.modal #askno'); if (!/log out/i.test(await pg.innerText('.modal'))) throw new Error('logout question missing');
      await click('#askno'); await pg.waitForFunction(() => !document.querySelector('.modal'), null, { timeout: 3000 });
      if (await pg.$('[data-act="gologin"]')) throw new Error('logged out although the user said no');
      await pg.evaluate(() => document.querySelector('[data-act="logout"]').click());
      await pg.waitForSelector('.modal [data-act="askyes"]'); await click('[data-act="askyes"]'); await pg.waitForSelector('[data-act="gologin"], #lf');
    });
  };

  const adminSteps = async t => {
    const { pg, step, click, nav, shot, layout, name: tag } = t;
    await login(t, 'admin@test.local', 'admin-pass-123');
    await step('admin: home', async () => { await shot('home'); await layout('admin home'); });
    await step('admin: customers page has Add customer', async () => { await nav('customers'); await shot('customers'); if (!(await pg.$('[data-act="custnew"]'))) throw new Error('no Add customer button on the Customers page'); });
    await step('admin: add customer from Customers page', async () => {
      await click('[data-act="custnew"]'); await pg.fill('#cnm', `UI TEST CUSTOMER ${tag.toUpperCase()}`); await pg.fill('#cob', '25'); await shot('add_customer'); await layout('add customer');
      await click('#cf button[type=submit]'); await pg.waitForFunction(() => /UI TEST CUSTOMER|Customer SLM/.test(document.body.innerText), null, { timeout: 8000 });
    });
    await step('admin: open console', async () => { await nav('admin'); await shot('admin_users'); await layout('admin users'); });
    await step('admin: add user', async () => {
      await click('[data-act="usernew"]'); await pg.fill('#un', `Jasil ${tag}`); await pg.fill('#ue', `jasil-${tag}@test.local`); await pg.fill('#uk', 'key-sidheek'); await pg.fill('#up', 'jasil-pass-1'); await shot('add_user'); await layout('add user');
      await click('#uf button[type=submit]'); await pg.waitForFunction(() => /Jasil/.test(document.querySelector('.tbl') ? document.querySelector('.tbl').innerText : ''), null, { timeout: 8000 });
    });
    await step('admin: key status is real and Check key asks Odoo', async () => {
      await click('[data-act="checkkey"] >> nth=0');
      await pg.waitForFunction(() => /Key works with Odoo|Key failed/.test(document.body.innerText));
      const t = await pg.innerText('.tbl');
      if (!/Works|Failed/.test(t)) throw new Error('no real key status shown');
      if (/Saved, not checked yet/.test(t)) throw new Error('a saved key was never checked');
      await shot('admin_users_keys'); await layout('admin users keys');
    });
    await step('admin: edit user', async () => { await click('[data-act="useredit"] >> nth=1'); await pg.waitForSelector('#uf'); await click('#uf button[data-act="closemodal"]'); });
    await step('admin: products add, edit', async () => {
      await click('[data-act="tab"][data-id="products"]'); await shot('admin_products'); await layout('admin products');
      await click('[data-act="prodnew"]'); await pg.fill('#pname', `UI TEST BREAD ${tag.toUpperCase()}`); await pg.fill('#pppi', '5'); await pg.fill('#pdf', '3.25'); await click('#pf button[type=submit]');
      await pg.waitForFunction(() => /UI TEST BREAD/.test(document.body.innerText), null, { timeout: 8000 });
      await click('[data-act="prodedit"] >> nth=0'); await click('#pf button[data-act="closemodal"]');
    });
    await step('admin: customer prices', async () => {
      await click('[data-act="tab"][data-id="custs"]'); await shot('admin_custs'); await layout('admin custs');
      await click('[data-act="admcust"] >> nth=0'); await pg.waitForSelector('[data-price]'); await pg.fill('[data-price] >> nth=0', '9.9'); await pg.keyboard.press('Tab'); await pg.waitForTimeout(400); await shot('admin_prices'); await layout('admin prices');
      await click('[data-act="admcustback"]');
    });
    await step('admin: opening trays', async () => {
      await click('[data-act="tab"][data-id="trayopen"]'); await shot('admin_trays'); await layout('admin trays');
      await pg.fill('#bo0', '510'); await click('#bof button[type=submit]'); await pg.waitForFunction(() => /Branch stock saved/.test(document.body.innerText), null, { timeout: 8000 });
    });
    await step('admin: opening trays from a file (preview first, then save)', async () => {
      const f = path.join(out, 'trays_test.json');
      fs.writeFileSync(f, JSON.stringify([{ name: '  ' + data.C[0][1].toLowerCase() + ' ', outstanding: tag === 'adminphone' ? 9 : 10 }, { name: 'NOT A CUSTOMER', outstanding: 5 }]));
      await pg.setInputFiles('#otf', f);
      await pg.waitForFunction(() => /customers? found by name/.test(document.body.innerText), null, { timeout: 8000 });
      const t = await pg.innerText('.content');
      if (!/not customers here/.test(t) || !/NOT A CUSTOMER/.test(t)) throw new Error('unknown name was not reported');
      if (!/preview, nothing saved yet/.test(t)) throw new Error('not shown as a preview');
      await shot('admin_tray_file'); await layout('admin tray file');
      await click('[data-act="otapply"]'); await pg.waitForSelector('.modal [data-act="askyes"]'); await click('[data-act="askyes"]');
      await pg.waitForFunction(() => /Opening trays saved/.test(document.body.innerText), null, { timeout: 8000 });
    });
    await step('admin: data and Odoo', async () => {
      await click('[data-act="tab"][data-id="data"]'); await shot('admin_data'); await layout('admin data');
      await click('[data-act="odootest"]'); await pg.waitForFunction(() => /Connected/.test(document.body.innerText), null, { timeout: 10000 });
    });
    await step('admin: readiness and balance checks run against Odoo and show real results', async () => {
      await click('[data-act="readiness"]');
      await pg.waitForFunction(() => /All checks passed|problems? found/.test(document.body.innerText), null, { timeout: 15000 });
      await click('[data-act="reconcile"]');
      await pg.waitForFunction(() => /of \d+ customers match/.test(document.body.innerText), null, { timeout: 15000 });
      await shot('admin_checks'); await layout('admin checks');
    });
    await step('admin: audit log', async () => { await click('[data-act="tab"][data-id="audit"]'); await pg.selectOption('#auser', { index: 1 }); await shot('admin_audit'); await layout('admin audit'); });
    await step('admin: settings', async () => {
      await click('[data-act="tab"][data-id="settings"]'); await shot('admin_settings'); await layout('admin settings');
      await click('#setf button[type=submit]'); await pg.waitForFunction(() => /Settings saved/.test(document.body.innerText), null, { timeout: 8000 });
    });
  };

  await run('phone', 390, 800, null, null, async t => { await staff(t); });
  await run('desk', 1280, 800, null, null, async t => { await staff(t); });
  await run('adminphone', 390, 800, null, null, async t => { await adminSteps(t); });
  await run('admindesk', 1280, 800, null, null, async t => { await adminSteps(t); });
  await run('tablet', 820, 1100, null, null, async t => { await staff(t); });

  await b.close();
  console.log(`${checks} steps run`);
  console.log(problems.length ? 'PROBLEMS (' + problems.length + '):\n - ' + [...new Set(problems)].join('\n - ') : 'no problems found');
  await mock.close();
  await db.pool.end();
  process.exit(problems.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
