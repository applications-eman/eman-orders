const express = require('express');
const db = require('./db');
const odoo = require('./odoo');
const post = require('./post');
const { buildState, FEATURES } = require('./state');
const { hashPassword, checkPassword, signToken, verifyToken, encrypt } = require('./crypto');
const { pad, audit, endOfDayRiyadh, totals } = require('./util');

const router = express.Router();
const COOKIE = 'eb_session';
const SESSION_MS = 12 * 3600 * 1000;
const REASONS = ['Discount', 'Round off', 'Returned goods', 'Price correction', 'Other'];

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class Bad extends Error { constructor(msg, code) { super(msg); this.code = code || 400; } }

function readCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// ---- sign in (limited tries) ----
const tries = new Map();
function tooMany(key) {
  const now = Date.now();
  const e = tries.get(key);
  if (!e || e.until < now) return false;
  return e.n >= 8;
}
function noteFail(key) {
  const now = Date.now();
  const e = tries.get(key);
  if (!e || e.until < now) tries.set(key, { n: 1, until: now + 10 * 60000 });
  else e.n++;
}

// Normal use: strict same-site cookie. Only while testing inside Replit's preview frame (not in the published app)
// the cookie must also work inside that frame, so it is set as a partitioned cross-site cookie there.
function cookieAttrs(req) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const replitPreview = !!process.env.REPL_ID && !process.env.REPLIT_DEPLOYMENT;
  if (secure && replitPreview) return 'Path=/; HttpOnly; Secure; SameSite=None; Partitioned';
  return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

router.post('/login', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  const key = (req.ip || '') + '|' + email;
  if (tooMany(key)) throw new Bad('Too many tries. Wait 10 minutes and try again.', 429);
  const r = await db.q('select * from users where lower(email)=$1', [email]);
  const u = r.rows[0];
  if (!u || !checkPassword(pw, u.pw_hash)) { noteFail(key); throw new Bad('Email or password is wrong.', 401); }
  if (!u.active) throw new Bad('This account is disabled. Ask the administrator.', 403);
  tries.delete(key);
  const tok = signToken({ uid: u.id, exp: Date.now() + SESSION_MS });
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(tok)}; ${cookieAttrs(req)}; Max-Age=${SESSION_MS / 1000}`);
  await audit(u.name, 'Signed in', 'User', u.name, '');
  res.json({ ok: true });
}));

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(req)}; Max-Age=0`);
  res.json({ ok: true });
});

// numbers for the landing page only (no names, no money)
router.get('/public', wrap(async (req, res) => {
  const set = await db.getSettings();
  const [p, c] = await Promise.all([
    db.q('select count(*) n from products where active'),
    db.q('select count(*) n from customers where active')
  ]);
  res.json({ products: Number(p.rows[0].n), customers: Number(c.rows[0].n), branches: set.branches, finalizeMin: set.finalizeMin });
}));

// ---- everything below needs a signed-in, active user ----
router.use(wrap(async (req, res, next) => {
  const p = verifyToken(readCookie(req, COOKIE));
  if (!p) throw new Bad('Please sign in.', 401);
  const r = await db.q('select id,name,email,admin,active,feat from users where id=$1', [p.uid]);
  const u = r.rows[0];
  if (!u || !u.active) throw new Bad('Please sign in.', 401);
  req.user = u;
  next();
}));

const can = (u, f) => u.admin || (u.feat || []).includes(f);
const need = f => (req, res, next) => (can(req.user, f) ? next() : next(new Bad('You do not have access to this.', 403)));
const adminOnly = (req, res, next) => (req.user.admin ? next() : next(new Bad('Administrator only.', 403)));

const int = (v, name, min, max) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Bad(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
};
const money = (v, name) => {
  const n = Math.round(Number(v) * 100);
  if (!Number.isFinite(n) || n <= 0 || n > 100000000) throw new Bad(`${name} must be an amount above zero.`);
  return n;
};

async function held(cust, run = db.q) {
  const r = await run('select coalesce(sum(qty),0) n from tray_ledger where cust=$1', [cust]);
  return Number(r.rows[0].n);
}
async function bstock(branch, run = db.q) {
  const r = await run('select coalesce(sum(case when cust is null then qty else -qty end),0) n from tray_ledger where branch=$1', [branch]);
  return Number(r.rows[0].n);
}
const trayRow = (run, cust, qty, type, ref, reason, branch, by) =>
  run('insert into tray_ledger(t,cust,branch,qty,type,ref,by_name,reason) values($1,$2,$3,$4,$5,$6,$7,$8)',
    [Date.now(), cust, branch || null, qty, type, ref, by, reason || '']);

async function priced(lines, cust, run = db.q) {
  if (!Array.isArray(lines) || !lines.length) throw new Bad('Add at least one product.');
  if (lines.length > 200) throw new Bad('Too many lines.');
  const codes = lines.map(l => String(l.code));
  if (new Set(codes).size !== codes.length) throw new Bad('A product appears twice.');
  const pr = await run('select code,dflt,active from products where code = any($1)', [codes]);
  const cp = await run('select prod,price from customer_prices where cust=$1 and prod = any($2)', [cust, codes]);
  const dflt = {}, custom = {};
  pr.rows.forEach(p => { dflt[p.code] = p; });
  cp.rows.forEach(p => { custom[p.prod] = Number(p.price); });
  return lines.map(l => {
    const p = dflt[String(l.code)];
    if (!p || !p.active) throw new Bad('Unknown or inactive product: ' + l.code);
    return { code: p.code, qty: int(l.qty, 'Quantity', 1, 9999), price: custom[p.code] != null ? custom[p.code] : Number(p.dflt) };
  });
}

// anything new is blocked while an order is past its finalize time (admin is exempt)
async function lockCheck(user) {
  if (user.admin) return;
  const r = await db.q("select count(*) n from orders where status='pending' and deadline<=$1", [Date.now()]);
  if (Number(r.rows[0].n) > 0) throw new Bad('An order is past its finalize time. Finalize it first.', 423);
}

// printing is logged; nothing else is accepted here
router.post('/audit', wrap(async (req, res) => {
  const b = req.body || {};
  if (!['Day statement printed', 'Slip printed'].includes(b.action)) throw new Bad('Not allowed.');
  await audit(req.user.name, b.action, String(b.entity || '').slice(0, 40), String(b.ref || '').slice(0, 60), String(b.detail || '').slice(0, 300));
  res.json({ ok: true });
}));

// ---- state ----
router.get('/state', wrap(async (req, res) => {
  res.json(await buildState(req.user));
}));

// ---- orders ----
router.post('/orders', need('order_create'), wrap(async (req, res) => {
  await lockCheck(req.user);
  const b = req.body || {};
  const set = await db.getSettings();
  if (!set.branches.includes(b.branch)) throw new Bad('Choose a branch.');
  const c = (await db.q('select * from customers where code=$1 and active', [b.cust])).rows[0];
  if (!c) throw new Bad('Choose a customer.');
  const tin = int(b.traysIn, 'Trays brought', 0, 999);
  if (tin > await held(c.code)) throw new Bad('Customer holds only ' + await held(c.code) + ' trays.');
  const lines = await priced(b.lines, c.code);
  const id = await db.tx(async run => {
    const no = await db.nextNo('ord', run);
    const id = 'ORD-' + pad(no, 6);
    const t = Date.now();
    const dl = Math.min(t + set.finalizeMin * 60000, endOfDayRiyadh(t));
    await run(`insert into orders(id,branch,cust,created_at,deadline,status,trays_in,by_name,by_id,lines)
               values($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9)`, [id, b.branch, c.code, t, dl, tin, req.user.name, req.user.id, JSON.stringify(lines)]);
    await trayRow(run, c.code, -tin, 'in', id, 'Customer brought trays', b.branch, req.user.name);
    await audit(req.user.name, 'Order created', 'Order', id, `${c.name} · ${b.branch} · ${lines.length} items · trays in ${tin}`, run);
    return id;
  });
  res.json({ id });
}));

router.put('/orders/:id', need('order_create'), wrap(async (req, res) => {
  const b = req.body || {};
  await db.tx(async run => {
    const o = (await run('select * from orders where id=$1 for update', [req.params.id])).rows[0];
    if (!o || o.status !== 'pending') throw new Bad('Only pending orders can be changed.');
    const tin = int(b.traysIn, 'Trays brought', 0, 999);
    const max = (await held(o.cust, run)) + o.trays_in;
    if (tin > max) throw new Bad('Customer holds only ' + max + ' trays.');
    const lines = await priced(b.lines, o.cust, run);
    const before = o.lines.map(l => l.code + '×' + l.qty).join(', ');
    await run('update orders set lines=$2, trays_in=$3 where id=$1', [o.id, JSON.stringify(lines), tin]);
    const delta = tin - o.trays_in;
    if (delta) await trayRow(run, o.cust, -delta, 'adjust', o.id, `Trays brought changed from ${o.trays_in} to ${tin}`, o.branch, req.user.name);
    await audit(req.user.name, 'Order edited', 'Order', o.id, `Before: ${before} → After: ${lines.map(l => l.code + '×' + l.qty).join(', ')}`, run);
  });
  res.json({ ok: true });
}));

router.post('/orders/:id/cancel', need('order_cancel'), wrap(async (req, res) => {
  const reason = String((req.body || {}).reason || '').trim();
  if (reason.length < 2) throw new Bad('Give a reason.');
  await db.tx(async run => {
    const o = (await run('select * from orders where id=$1 for update', [req.params.id])).rows[0];
    if (!o || o.status !== 'pending') throw new Bad('Only pending orders can be cancelled.');
    await run("update orders set status='cancelled', cancel_reason=$2 where id=$1", [o.id, reason]);
    if (o.trays_in) await trayRow(run, o.cust, o.trays_in, 'adjust', o.id, 'Order cancelled, trays brought reversed', o.branch, req.user.name);
    await audit(req.user.name, 'Order cancelled', 'Order', o.id, reason, run);
  });
  res.json({ ok: true });
}));

router.post('/orders/:id/finalize', need('order_finalize'), wrap(async (req, res) => {
  const tout = int((req.body || {}).traysOut, 'Trays taken', 0, 999);
  await db.tx(async run => {
    const o = (await run('select * from orders where id=$1 for update', [req.params.id])).rows[0];
    if (!o || o.status !== 'pending') throw new Bad('This order is not pending any more.');
    const stock = await bstock(o.branch, run);
    if (tout > stock) throw new Bad(`Only ${stock} trays in ${o.branch}.`);
    // prices are frozen at finalize time from the order lines (set when the order was saved)
    const T = totals(o.lines);
    const now = Date.now();
    await run(`update orders set status='final', finalized_at=$2, final_by=$3, trays_out=$4, total_cents=$5, rounding_cents=$6,
               odoo_state='queued', odoo_msg='Waiting to be posted to Odoo' where id=$1`,
      [o.id, now, req.user.name, tout, T.rounded * 100, T.diff]);
    if (tout) await trayRow(run, o.cust, tout, 'out', o.id, 'Customer took trays with the order', o.branch, req.user.name);
    await audit(req.user.name, 'Order finalized', 'Order', o.id, `total ${T.rounded}.00 · rounding ${T.diff >= 0 ? '+' : ''}${(T.diff / 100).toFixed(2)} · trays out ${tout}`, run);
  });
  const run = await post.drain();
  const o = (await db.q('select status, odoo_state, odoo_msg, inv from orders where id=$1', [req.params.id])).rows[0];
  res.json({ ok: true, odoo: o.odoo_state, msg: o.odoo_msg, inv: o.inv, queue: run });
}));

// ---- payments (one transfer can be split across customers) ----
router.post('/payments', need('payments'), wrap(async (req, res) => {
  await lockCheck(req.user);
  const b = req.body || {};
  if (!odoo.JOURNAL_CODE[b.method]) throw new Bad('Choose how it was paid.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) || isNaN(Date.parse(b.date))) throw new Bad('Enter a valid date.');
  const lines = Array.isArray(b.lines) ? b.lines : [];
  if (!lines.length || lines.length > 100) throw new Bad('Add at least one customer.');
  const total = money(b.total, 'Total received');
  const amts = lines.map(l => money(l.amount, 'Amount'));
  if (amts.reduce((a, x) => a + x, 0) !== total) throw new Bad('The amounts must add up to the total received.');
  const codes = lines.map(l => String(l.cc));
  if (new Set(codes).size !== codes.length) throw new Bad('A customer appears twice.');
  const cu = await db.q('select code from customers where active and code = any($1)', [codes]);
  if (cu.rows.length !== codes.length) throw new Bad('Unknown customer in the list.');
  const ids = await db.tx(async run => {
    const grp = lines.length > 1 ? 'SPLIT-' + pad(await db.nextNo('split', run), 5) : '';
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const id = 'PAY-' + pad(await db.nextNo('pay', run), 6);
      await run(`insert into payments(id,cust,amount_cents,method,pdate,note,grp,group_total_cents,by_name,by_id,t,odoo_state,odoo_msg)
                 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued','Waiting to be posted to Odoo')`,
        [id, codes[i], amts[i], b.method, b.date, String(b.note || '').slice(0, 200), grp, total, req.user.name, req.user.id, Date.now()]);
      out.push(id);
    }
    if (grp) await audit(req.user.name, 'Split payment', 'Payment', grp, `${(total / 100).toFixed(2)} · ${b.method} · ${lines.length} customers`, run);
    await audit(req.user.name, 'Payment received', 'Payment', out.join(', '), `${(total / 100).toFixed(2)} · ${b.method}`, run);
    return out;
  });
  const q = await post.drain();
  const st = await db.q('select id, odoo_state from payments where id = any($1)', [ids]);
  res.json({ ids, states: st.rows, queue: q });
}));

router.post('/payments/:id/reverse', need('payments'), wrap(async (req, res) => {
  const reason = String((req.body || {}).reason || '').trim();
  if (reason.length < 2) throw new Bad('Give a reason.');
  await db.tx(async run => {
    const p = (await run('select * from payments where id=$1 for update', [req.params.id])).rows[0];
    if (!p || p.reversed) throw new Bad('This payment cannot be reversed.');
    const inOdoo = p.odoo_state === 'posted';
    await run('update payments set reversed=true, reverse_reason=$2, reversed_by=$3, reverse_state=$4 where id=$1',
      [p.id, reason, req.user.name, inOdoo ? 'queued' : null]);
    await audit(req.user.name, 'Payment reversed', 'Payment', p.id, reason, run);
  });
  const q = await post.drain();
  res.json({ ok: true, queue: q });
}));

// ---- credit notes (discounts given later) ----
router.post('/credits', need('credit_notes'), wrap(async (req, res) => {
  await lockCheck(req.user);
  const b = req.body || {};
  const amt = money(b.amount, 'Amount');
  const reason = REASONS.includes(b.reason) ? b.reason : 'Discount';
  const c = (await db.q('select code from customers where code=$1 and active', [b.cust])).rows[0];
  if (!c) throw new Bad('Choose a customer.');
  const id = await db.tx(async run => {
    const id = 'DSC-' + pad(await db.nextNo('cn', run), 6);
    await run(`insert into credits(id,cust,amount_cents,reason,note,by_name,by_id,t,odoo_state,odoo_msg)
               values($1,$2,$3,$4,$5,$6,$7,$8,'queued','Waiting to be posted to Odoo')`,
      [id, c.code, amt, reason, String(b.note || '').slice(0, 200), req.user.name, req.user.id, Date.now()]);
    await audit(req.user.name, 'Credit note issued', 'Credit note', id, `${(amt / 100).toFixed(2)} · ${reason}`, run);
    return id;
  });
  const q = await post.drain();
  const st = (await db.q('select odoo_state from credits where id=$1', [id])).rows[0];
  res.json({ id, odoo: st.odoo_state, queue: q });
}));

// ---- Odoo queue ----
router.post('/sync/retry', need('sync_view'), wrap(async (req, res) => {
  // failed items go back in the queue only when asked
  if ((req.body || {}).failed) {
    await db.q("update orders set odoo_state='queued' where status='final' and odoo_state='failed'");
    await db.q("update payments set odoo_state='queued' where odoo_state='failed' and not reversed");
    await db.q("update credits set odoo_state='queued' where odoo_state='failed'");
    await db.q("update payments set reverse_state='queued' where reversed and reverse_state='failed'");
  }
  const q = await post.drain();
  await audit(req.user.name, 'Odoo queue retried', 'Sync', '', `${q.posted} posted, ${q.failed} refused, ${q.waiting} waiting`);
  res.json(q);
}));

// ---- admin ----
router.put('/admin/settings', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const old = await db.getSettings();
  const next = {
    finalizeMin: int(b.finalizeMin, 'Minutes', 5, 600),
    autoPrint: !!b.autoPrint,
    footer: String(b.footer || '').slice(0, 120)
  };
  for (const [k, v] of Object.entries(next)) await db.setSetting(k, v);
  await audit(req.user.name, 'Settings changed', 'Settings', '', JSON.stringify([old.finalizeMin, old.autoPrint, old.footer]) + ' → ' + JSON.stringify(Object.values(next)));
  res.json({ ok: true });
}));

router.put('/admin/offline', adminOnly, wrap(async (req, res) => {
  const v = !!(req.body || {}).offline;
  await db.setSetting('offline', v);
  await audit(req.user.name, 'Setting changed', 'Settings', 'Odoo offline simulation', String(v));
  res.json({ ok: true });
}));

const FEAT = f => (Array.isArray(f) ? f.filter(x => FEATURES.includes(x)) : []);

// Asks Odoo with this user's own key. The result is saved so the screen can show it. Nothing is created in Odoo.
async function runKeyCheck(id) {
  const u = (await db.q('select id,name,email from users where id=$1', [id])).rows[0];
  let chk;
  try {
    const ctx = await odoo.getUserKey(id);
    const v = await odoo.verifyKey(ctx, u.email);
    chk = {
      ok: v.companyOk, t: Date.now(), companies: v.companies, odooUser: v.odooUser,
      note: !v.companyOk ? `This key opens "${v.companies.join(', ')}", expected "${odoo.EXPECT_COMPANY}".`
        : v.odooUser === '' ? `Odoo has no user with the login ${u.email}.` : ''
    };
  } catch (e) { chk = { ok: false, t: Date.now(), companies: [], odooUser: null, note: e.message }; }
  await db.q('update users set key_check=$2 where id=$1', [id, JSON.stringify(chk)]);
  return chk;
}

router.post('/admin/users', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase();
  if (name.length < 2) throw new Bad('Enter a name.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Bad('Enter the Odoo login email.');
  if (String(b.password || '').length < 8) throw new Bad('Password needs at least 8 characters.');
  if (!b.key) throw new Bad('Paste the Odoo API key for this user.');
  const ex = await db.q('select 1 from users where lower(email)=$1', [email]);
  if (ex.rows.length) throw new Bad('This email is already a user.');
  const ins = await db.q('insert into users(name,email,pw_hash,admin,active,feat,odoo_key_enc) values($1,$2,$3,$4,$5,$6,$7) returning id',
    [name, email, hashPassword(String(b.password)), !!b.admin, b.active !== false, FEAT(b.feat), encrypt(String(b.key).trim())]);
  await audit(req.user.name, 'User added', 'User', name, email);
  const chk = await runKeyCheck(ins.rows[0].id);
  res.json({ ok: true, keyCheck: chk });
}));

router.put('/admin/users/:id', adminOnly, wrap(async (req, res) => {
  const id = int(req.params.id, 'User', 1, 1e9);
  const b = req.body || {};
  const u = (await db.q('select * from users where id=$1', [id])).rows[0];
  if (!u) throw new Bad('User not found.', 404);
  const name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase();
  if (name.length < 2) throw new Bad('Enter a name.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Bad('Enter the Odoo login email.');
  const dup = await db.q('select 1 from users where lower(email)=$1 and id<>$2', [email, id]);
  if (dup.rows.length) throw new Bad('This email is already a user.');
  const admin = !!b.admin, active = b.active !== false;
  if (id === req.user.id && (!admin || !active)) throw new Bad('You cannot remove your own admin access or disable yourself.');
  const ch = [];
  if (u.name !== name) ch.push('name');
  if (u.email !== email) ch.push('email');
  if (b.key) ch.push('API key replaced');
  if (b.password) ch.push('password reset');
  if (u.admin !== admin) ch.push('admin ' + admin);
  if (u.active !== active) ch.push('active ' + active);
  const feat = FEAT(b.feat);
  if (JSON.stringify([...u.feat].sort()) !== JSON.stringify([...feat].sort())) ch.push('access changed');
  if (b.password && String(b.password).length < 8) throw new Bad('Password needs at least 8 characters.');
  await db.q('update users set name=$2,email=$3,admin=$4,active=$5,feat=$6 where id=$1', [id, name, email, admin, active, feat]);
  if (b.password) await db.q('update users set pw_hash=$2 where id=$1', [id, hashPassword(String(b.password))]);
  if (b.key) await db.q('update users set odoo_key_enc=$2, key_check=null where id=$1', [id, encrypt(String(b.key).trim())]);
  await audit(req.user.name, 'User edited', 'User', name, ch.join(', ') || 'no change');
  const chk = b.key || u.email !== email ? await runKeyCheck(id) : null;
  res.json({ ok: true, keyCheck: chk });
}));

router.post('/admin/products', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim().toUpperCase(), name = String(b.name || '').trim().toUpperCase(), cat = String(b.cat || '').trim().toUpperCase();
  const ppp = int(b.ppp, 'Pieces', 1, 9999), dflt = Number(b.dflt);
  if (!code || name.length < 2 || !cat) throw new Bad('Fill in code, name and category.');
  if (!(dflt >= 0)) throw new Bad('Price must be a number.');
  const ex = await db.q('select * from products where code=$1', [code]);
  if (ex.rows.length) {
    const p = ex.rows[0];
    const ch = [];
    if (Number(p.dflt) !== dflt) ch.push(`default price ${p.dflt} → ${dflt}`);
    if (p.name !== name) ch.push('name');
    if (p.cat !== cat) ch.push('category');
    if (p.ppp !== ppp) ch.push('pieces');
    if (p.active !== (b.active !== false)) ch.push('active ' + (b.active !== false));
    await db.q('update products set name=$2,cat=$3,ppp=$4,dflt=$5,active=$6 where code=$1', [code, name, cat, ppp, dflt, b.active !== false]);
    await audit(req.user.name, 'Product edited', 'Product', code, ch.join(', ') || 'no change');
  } else {
    await db.q('insert into products(code,name,cat,ppp,dflt,active) values($1,$2,$3,$4,$5,$6)', [code, name, cat, ppp, dflt, b.active !== false]);
    await audit(req.user.name, 'Product added', 'Product', code, `${name} · ${dflt}`);
  }
  res.json({ ok: true });
}));

router.post('/admin/customers', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().toUpperCase();
  if (name.length < 2) throw new Bad('Enter the customer name.');
  const ex = await db.q('select 1 from customers where lower(name)=lower($1)', [name]);
  if (ex.rows.length) throw new Bad('A customer with this name exists.');
  const ob = Math.round((Number(b.opening) || 0) * 100);
  const n = await db.q('select count(*) n from customers');
  let code;
  for (let i = Number(n.rows[0].n) + 1; ; i++) {
    code = 'SLM-' + pad(i, 3);
    if (!(await db.q('select 1 from customers where code=$1', [code])).rows.length) break;
  }
  await db.q('insert into customers(code,name,opening_cents) values($1,$2,$3)', [code, name, ob]);
  await audit(req.user.name, 'Customer added', 'Customer', name, `${code} · opening ${(ob / 100).toFixed(2)}`);
  res.json({ code });
}));

// switch a customer on or off (hidden customers stay in the books and in old orders)
router.put('/admin/customers/:code', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.active !== 'boolean') throw new Bad('Say whether the customer is active.');
  const c = (await db.q('select name,active from customers where code=$1', [req.params.code])).rows[0];
  if (!c) throw new Bad('Customer not found.', 404);
  if (c.active !== b.active) {
    await db.q('update customers set active=$2 where code=$1', [req.params.code, b.active]);
    await audit(req.user.name, b.active ? 'Customer switched on' : 'Customer switched off', 'Customer', c.name, req.params.code);
  }
  res.json({ ok: true });
}));

router.put('/admin/price', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const c = (await db.q('select name from customers where code=$1', [b.cust])).rows[0];
  const p = (await db.q('select dflt from products where code=$1', [b.prod])).rows[0];
  if (!c || !p) throw new Bad('Unknown customer or product.');
  const old = (await db.q('select price from customer_prices where cust=$1 and prod=$2', [b.cust, b.prod])).rows[0];
  if (b.price === null || b.price === '') {
    await db.q('delete from customer_prices where cust=$1 and prod=$2', [b.cust, b.prod]);
    await audit(req.user.name, 'Customer price reset', 'Price', `${c.name} / ${b.prod}`, `${old ? old.price : 'default'} → default`);
  } else {
    const v = Number(b.price);
    if (!(v >= 0)) throw new Bad('Enter a valid price.');
    await db.q('insert into customer_prices(cust,prod,price) values($1,$2,$3) on conflict(cust,prod) do update set price=excluded.price', [b.cust, b.prod, v]);
    await audit(req.user.name, 'Customer price changed', 'Price', `${c.name} / ${b.prod}`, `${old ? old.price : p.dflt} → ${v}`);
  }
  res.json({ ok: true });
}));

// Opening trays: each change becomes a NEW row in the ledger (nothing is edited)
router.post('/admin/trays/branch', adminOnly, wrap(async (req, res) => {
  const set = await db.getSettings();
  const b = req.body || {};
  if (!set.branches.includes(b.branch)) throw new Bad('Unknown branch.');
  const v = int(b.qty, 'Tray count', 0, 100000);
  await db.tx(async run => {
    const r = await run("select coalesce(sum(qty),0) n from tray_ledger where type='bopen' and branch=$1", [b.branch]);
    const d = v - Number(r.rows[0].n);
    if (!d) return;
    await trayRow(run, null, d, 'bopen', 'Opening stock', `Branch opening stock set to ${v}`, b.branch, req.user.name);
    await audit(req.user.name, 'Opening stock set', 'Tray', b.branch, `${v - d} → ${v}`, run);
  });
  res.json({ ok: true });
}));

router.post('/admin/trays/customer', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const c = (await db.q('select name from customers where code=$1', [b.cust])).rows[0];
  if (!c) throw new Bad('Unknown customer.');
  const v = int(b.qty, 'Tray count', 0, 100000);
  await db.tx(async run => {
    const r = await run("select coalesce(sum(qty),0) n from tray_ledger where type='opening' and cust=$1", [b.cust]);
    const d = v - Number(r.rows[0].n);
    if (!d) return;
    await trayRow(run, b.cust, d, 'opening', 'Opening balance', `Opening count set to ${v}`, null, req.user.name);
    await audit(req.user.name, 'Opening trays set', 'Tray', c.name, `Customer opening ${v - d} → ${v}`, run);
  });
  res.json({ ok: true });
}));

// Load products, customers and the price matrix from the file Shafeeq keeps (never stored in the repository)
router.post('/admin/import', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.P) || !Array.isArray(b.C) || typeof b.X !== 'object' || !b.X) throw new Bad('This is not the starting-data file (needs P, C and X).');
  const r = await db.tx(async run => {
    let np = 0, nc = 0, nx = 0;
    for (const p of b.P) {
      await run(`insert into products(code,name,cat,ppp,dflt,active) values($1,$2,$3,$4,$5,true)
                 on conflict(code) do update set name=excluded.name, cat=excluded.cat, ppp=excluded.ppp, dflt=excluded.dflt`,
        [String(p[0]), String(p[1]), String(p[2]), Number(p[3]) || 1, Number(p[4]) || 0]);
      np++;
    }
    for (const c of b.C) {
      const res1 = await run(`insert into customers(code,name,opening_cents) values($1,$2,$3)
                 on conflict(code) do update set name=excluded.name returning (xmax = 0) as fresh`,
        [String(c[0]), String(c[1]), Math.round((Number(c[2]) || 0) * 100)]);
      if (res1.rows[0].fresh) nc++;
    }
    await run('delete from customer_prices');
    for (const [cc, m] of Object.entries(b.X)) {
      for (const [pc, price] of Object.entries(m)) {
        await run('insert into customer_prices(cust,prod,price) values($1,$2,$3) on conflict do nothing', [cc, pc, Number(price)]);
        nx++;
      }
    }
    await audit(req.user.name, 'Starting data loaded', 'Import', '', `${np} products, ${b.C.length} customers (${nc} new), ${nx} customer prices`, run);
    return { products: np, customers: b.C.length, newCustomers: nc, prices: nx };
  });
  res.json(r);
}));

async function adminCtx(req) {
  const u = await odoo.getUserKey(req.user.id);
  return { name: u.name, key: u.key };
}

router.post('/admin/users/:id/check-key', adminOnly, wrap(async (req, res) => {
  const id = int(req.params.id, 'User', 1, 1e9);
  const u = (await db.q('select name, odoo_key_enc from users where id=$1', [id])).rows[0];
  if (!u) throw new Bad('User not found.', 404);
  if (!u.odoo_key_enc) throw new Bad('No Odoo key is saved for ' + u.name + '.');
  const chk = await runKeyCheck(id);
  await audit(req.user.name, 'Odoo key checked', 'User', u.name, chk.ok ? 'works' : 'failed: ' + chk.note);
  res.json(chk);
}));

router.post('/admin/odoo/test', adminOnly, wrap(async (req, res) => {
  const ctx = await adminCtx(req);
  const names = await odoo.ping(ctx);
  const out = { companies: names, expected: odoo.EXPECT_COMPANY || null, ok: !odoo.EXPECT_COMPANY || names.includes(odoo.EXPECT_COMPANY) };
  await db.setSetting('odooTest', { ...out, t: Date.now(), by: req.user.name });
  res.json(out);
}));

// Read-only: is everything the app needs there in Odoo? (company, journals, account, rounding, products, customers)
router.post('/admin/odoo/readiness', adminOnly, wrap(async (req, res) => {
  const ctx = await adminCtx(req);
  const codes = (await db.q('select code from products where active order by code')).rows.map(r => r.code);
  const names = (await db.q('select name from customers where active order by name')).rows.map(r => r.name);
  const r = await odoo.readiness(ctx, codes, names);
  const out = { t: Date.now(), by: req.user.name, ok: r.checks.every(c => c.ok), failed: r.checks.filter(c => !c.ok).length, checks: r.checks };
  await db.setSetting('odooCheck', out);
  await audit(req.user.name, 'Odoo readiness checked', 'Odoo', '', out.ok ? 'all passed' : out.failed + ' problem(s)');
  res.json(out);
}));

// Read-only: per customer, the balance in this app against the receivable balance in Odoo.
// The app side counts only documents Odoo already has (posted); waiting or refused ones are listed separately.
router.post('/admin/odoo/reconcile', adminOnly, wrap(async (req, res) => {
  const ctx = await adminCtx(req);
  const odooRows = await odoo.receivableBalances(ctx);
  const cu = (await db.q('select code,name,opening_cents,odoo_partner_id from customers order by name')).rows;
  const sums = async sql => { const m = {}; (await db.q(sql)).rows.forEach(r => { m[r.cust] = { posted: Number(r.posted), waiting: Number(r.waiting) }; }); return m; };
  const inv = await sums("select cust, coalesce(sum(total_cents) filter (where odoo_state='posted'),0) posted, count(*) filter (where odoo_state is distinct from 'posted') waiting from orders where status='final' group by cust");
  const pay = await sums("select cust, coalesce(sum(amount_cents) filter (where odoo_state='posted'),0) posted, count(*) filter (where odoo_state is distinct from 'posted') waiting from payments where not reversed group by cust");
  const crd = await sums("select cust, coalesce(sum(amount_cents) filter (where odoo_state='posted'),0) posted, count(*) filter (where odoo_state is distinct from 'posted') waiting from credits group by cust");
  const byId = new Map(odooRows.map(r => [r.id, r]));
  const byName = new Map(odooRows.map(r => [String(r.name).trim().toLowerCase(), r]));
  const seen = new Set();
  const rows = [];
  let same = 0;
  for (const c of cu) {
    const o = (c.odoo_partner_id && byId.get(c.odoo_partner_id)) || byName.get(c.name.trim().toLowerCase());
    if (o) seen.add(o.id);
    const get = (m, k) => (m[c.code] || { posted: 0, waiting: 0 })[k];
    const app = Number(c.opening_cents) + get(inv, 'posted') - get(pay, 'posted') - get(crd, 'posted');
    const odooC = o ? Math.round(o.balance * 100) : 0;
    const waiting = get(inv, 'waiting') + get(pay, 'waiting') + get(crd, 'waiting');
    if (app === odooC) { same++; continue; }
    rows.push({ code: c.code, name: c.name, app: app / 100, odoo: odooC / 100, diff: (odooC - app) / 100, waiting, inOdoo: !!o });
  }
  const odooOnly = odooRows.filter(r => !seen.has(r.id) && Math.abs(r.balance) > 0.004).map(r => ({ name: r.name, balance: r.balance }));
  const out = {
    t: Date.now(), by: req.user.name, checked: cu.length, same, differences: rows.length, ok: rows.length === 0 && odooOnly.length === 0,
    rows: rows.slice(0, 200), odooOnly: odooOnly.slice(0, 100)
  };
  await db.setSetting('reconcile', out);
  await audit(req.user.name, 'Balances compared with Odoo', 'Odoo', '', `${same} of ${cu.length} customers match, ${rows.length} differ`);
  res.json(out);
}));

// Starting balances = what Odoo shows each customer owes right now. Only before the app has its own records.
router.post('/admin/odoo/balances', adminOnly, wrap(async (req, res) => {
  const force = !!(req.body || {}).force;
  const used = await db.q(`select (select count(*) from orders where status='final') +
    (select count(*) from payments) + (select count(*) from credits) n`);
  if (Number(used.rows[0].n) > 0 && !force) throw new Bad('The app already has finalized orders or payments. Starting balances can only be loaded before go-live.');
  const ctx = await adminCtx(req);
  const rows = await odoo.receivableBalances(ctx);
  const cu = (await db.q('select code,name from customers')).rows;
  const byName = new Map(cu.map(c => [c.name.trim().toLowerCase(), c]));
  let matched = 0, total = 0;
  const unmatchedOdoo = [];
  const seen = new Set();
  await db.tx(async run => {
    for (const r of rows) {
      const c = byName.get(String(r.name).trim().toLowerCase());
      if (!c) { if (Math.abs(r.balance) > 0.004) unmatchedOdoo.push({ name: r.name, balance: r.balance }); continue; }
      const cents = Math.round(r.balance * 100);
      await run('update customers set opening_cents=$2, odoo_partner_id=$3 where code=$1', [c.code, cents, r.id]);
      seen.add(c.code);
      matched++; total += cents;
    }
    await audit(req.user.name, 'Starting balances loaded from Odoo', 'Import', '', `${matched} customers, total ${(total / 100).toFixed(2)}`, run);
  });
  const notInOdoo = cu.filter(c => !seen.has(c.code)).map(c => c.name);
  res.json({ matched, total: total / 100, unmatchedOdoo, appCustomersWithoutOdooBalance: notInOdoo });
}));

// Continue numbering after the highest number already in Odoo
router.post('/admin/odoo/numbers', adminOnly, wrap(async (req, res) => {
  const ctx = await adminCtx(req);
  const last = await odoo.lastRefs(ctx);
  const num = s => { const m = /(\d+)$/.exec(s || ''); return m ? Number(m[1]) : 0; };
  const out = {};
  for (const [k, ref] of Object.entries(last)) {
    const next = num(ref) + 1;
    await db.q('update counters set val=greatest(val,$2) where name=$1', [k, next]);
    out[k] = { last: ref || '(none)', next: (await db.q('select val from counters where name=$1', [k])).rows[0].val };
  }
  await audit(req.user.name, 'Numbers synced from Odoo', 'Sync', '', JSON.stringify(out));
  res.json(out);
}));

router.get('/admin/sync-log', adminOnly, wrap(async (req, res) => {
  const r = await db.q('select id,t,user_name,endpoint,status,left(response::text,300) response from sync_log order by id desc limit 100');
  res.json(r.rows);
}));

router.use((err, req, res, next) => {
  if (err instanceof Bad) return res.status(err.code).json({ error: err.message });
  if (err instanceof odoo.OdooError) return res.status(err.retryable ? 502 : 400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

module.exports = router;
