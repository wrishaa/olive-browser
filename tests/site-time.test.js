const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SiteTime, siteForURL, validSite, dayKey, duration } = require('../src/core/site-time');

function clock(options = {}) {
  let wall = options.start ?? new Date('2026-10-27T12:00:00').getTime(), mono = 0;
  const tracker = new SiteTime(options.file || null, { now: () => wall, monotonicNow: () => mono, ...options });
  return { tracker, advance(ms, wallMs = ms) { wall += wallMs; mono += ms; }, at(ms) { wall = ms; }, url(url = 'https://example.com/path?secret=no#fragment', active = true) { tracker.update({ url, active }); } };
}
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-site-time-unit-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const total = tracker => tracker.snapshot('all').totalSeconds;

test('normalizes only real HTTP(S) hostnames, never URLs, ports, auth, or queries', () => {
  assert.equal(siteForURL('https://user:pass@WWW.Example.COM.:8443/private?auth=secret#token'), 'example.com');
  assert.equal(siteForURL('http://bücher.example/'), 'xn--bcher-kva.example');
  assert.equal(siteForURL('http://[::1]:8071/'), '[::1]');
  for (const value of ['file:///tmp/a', 'data:text/html,a', 'about:blank', 'olive://settings', 'javascript:1', 'not a URL', '', null, {}]) assert.equal(siteForURL(value), null);
  for (const site of ['x/y', 'x?token', '__proto__', 'constructor', 'EXAMPLE.COM', 'x:444', 'user@x', 'x\\y']) assert.equal(validSite(site), false, site);
  assert.equal(validSite('example.com'), true);
});

test('one running page accrues exact foreground time and transitions do not duplicate it', () => {
  const c = clock(); c.url(); c.advance(1200); c.url(); c.advance(800);
  assert.equal(total(c.tracker), 2);
  c.url('https://second.example/'); c.advance(3000); c.tracker.update({ active: false }); c.advance(20000);
  const s = c.tracker.snapshot('today');
  assert.equal(s.totalSeconds, 5); assert.equal(s.siteCount, 2); assert.equal(s.currentSite, null);
  assert.deepEqual(s.entries.map(e => [e.site, e.seconds]), [['second.example', 3], ['example.com', 2]]);
  assert.equal(s.entries[0].share, 0.6); assert.equal(s.entries[1].fraction, 2 / 3);
});

test('private, inactive, internal and failed URL transitions never accrue', () => {
  const c = clock();
  for (const state of [{ url: 'https://private.example/', active: true, isPrivate: true }, { url: 'https://hidden.example/', active: false }, { url: 'file:///tmp/a', active: true }, { url: '', active: true }]) {
    c.tracker.update(state); c.advance(1000); assert.equal(total(c.tracker), 0);
  }
  c.url(); c.advance(1000); c.tracker.update({ url: 'data:text/html;olive-error,error', active: true }); c.advance(1000);
  assert.equal(total(c.tracker), 1);
});

test('selected ranges use one, seven, or civil days since the first tracked day', () => {
  const c = clock({ start: new Date('2026-10-15T12:00:00').getTime() });
  c.url('https://old.example/'); c.advance(14000); c.tracker.update({ active: false });
  c.at(new Date('2026-10-26T12:00:00').getTime()); c.url(); c.advance(14000); c.tracker.update({ active: false });
  c.at(new Date('2026-10-27T12:00:00').getTime()); c.url(); c.advance(7000); c.tracker.update({ active: false });
  const today = c.tracker.snapshot('today'), week = c.tracker.snapshot('week'), all = c.tracker.snapshot('all');
  assert.equal(today.totalSeconds, 7); assert.equal(today.averageSeconds, 7); assert.equal(today.dayCount, 1);
  assert.equal(week.totalSeconds, 21); assert.equal(week.averageSeconds, 3); assert.equal(week.dayCount, 7);
  assert.equal(all.totalSeconds, 35); assert.equal(all.averageSeconds, 35 / 13); assert.equal(all.dayCount, 13);
  assert.equal(all.daily.length, 7); assert.equal(all.daily.at(-1).isToday, true); assert.equal(all.daily[0].day, '2026-10-21');
  assert.equal(all.daily[5].seconds, 14); assert.equal(all.daily[6].seconds, 7);
  assert.equal(c.tracker.snapshot('untrusted').range, 'today');
});

test('midnight splits precisely and moving between host paths does not create new sites', () => {
  const c = clock({ start: new Date('2026-10-26T23:59:58').getTime() });
  c.url('https://same.example/first'); c.advance(4000); c.url('https://same.example/next?secret=x'); c.advance(1000); c.tracker.update({ active: false });
  assert.equal(c.tracker.days['2026-10-26']['same.example'], 2);
  assert.equal(c.tracker.days['2026-10-27']['same.example'], 3);
  assert.equal(c.tracker.snapshot('today').totalSeconds, 3);
  assert.equal(total(c.tracker), 5);
});

test('DST uses local civil midnights and All Time includes a zero-use calendar day', () => {
  const script = `const assert=require('node:assert/strict');const {SiteTime}=require(${JSON.stringify(require.resolve('../src/core/site-time'))});
    let wall=new Date('2026-03-07T23:59:59').getTime(),mono=0;
    const t=new SiteTime(null,{now:()=>wall,monotonicNow:()=>mono});
    t.update({url:'https://dst.example/',active:true});wall+=2000;mono+=2000;t.update({active:false});
    assert.equal(t.days['2026-03-07']['dst.example'],1);assert.equal(t.days['2026-03-08']['dst.example'],1);
    wall=new Date('2026-03-09T12:00:00').getTime();const s=t.snapshot('all');assert.equal(s.dayCount,3);assert.equal(s.averageSeconds,2/3);
    wall=new Date('2026-11-01T23:59:59').getTime();t.update({url:'https://fall.example/',active:true});wall+=2000;mono+=2000;t.update({active:false});
    assert.equal(t.days['2026-11-01']['fall.example'],1);assert.equal(t.days['2026-11-02']['fall.example'],1);
    console.log('dst passed');`;
  assert.match(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' }), /dst passed/);
});

test('long event-loop or sleep gaps are discarded, not backfilled', () => {
  const c = clock(); c.url(); c.advance(1000); c.url();
  c.advance(3600000); c.url(); assert.equal(total(c.tracker), 1);
  c.advance(2000); c.url(); assert.equal(total(c.tracker), 3);
  c.advance(1, 3600000); c.url(); assert.equal(total(c.tracker), 3);
  c.advance(1000); c.url(); assert.equal(total(c.tracker), 4);
});

test('elapsed duration is monotonic; clock changes never invent time', () => {
  const c = clock(); c.url(); c.advance(1000, 1100); c.url(); assert.equal(total(c.tracker), 1);
  c.advance(1000, -100000); c.url(); assert.equal(total(c.tracker), 1);
  c.advance(1000, 100000); c.url(); assert.equal(total(c.tracker), 1);
  c.advance(1000); c.url(); assert.equal(total(c.tracker), 2);
});

test('reset cannot resurrect an unflushed active segment and resets the first tracked day', () => {
  const c = clock(); c.url(); c.advance(2000); c.tracker.reset(); c.advance(3000);
  assert.equal(total(c.tracker), 0); assert.equal(c.tracker.currentSite, null); assert.equal(c.tracker.snapshot('all').dayCount, 1);
  c.url('https://after.example/'); c.advance(1000); assert.equal(total(c.tracker), 1); assert.equal(c.tracker.snapshot('all').siteCount, 1);
});

test('ties sort deterministically and snapshots never compound live elapsed time', () => {
  const c = clock(); for (const site of ['z.example', 'a.example']) { c.url(`https://${site}/`); c.advance(1000); }
  for (let i = 0; i < 10; i++) { const s = c.tracker.snapshot('all'); assert.equal(s.totalSeconds, 2); assert.equal(s.entries[0].site, 'a.example'); }
  assert.equal(c.tracker.hasSite('a.example'), true); assert.equal(c.tracker.hasSite('https://a.example/'), false);
});

test('atomic local persistence is 0600 and contains only hostname/day/duration', t => {
  const dir = fixture(t), file = path.join(dir, 'profile', 'site-time.json'); const c = clock({ file });
  c.url('https://username:password@EXAMPLE.com:8042/secret/path?token=hidden#fragment'); c.advance(2300); c.tracker.flush();
  const raw = fs.readFileSync(file, 'utf8'); const data = JSON.parse(raw);
  assert.deepEqual(data, { version: 1, days: { [dayKey(c.tracker.now())]: { 'example.com': 2.3 } } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(/username|password|secret|token|fragment|8042|https/.test(raw), false);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['site-time.json']);
  c.tracker.close(); const loaded = clock({ file }); assert.equal(total(loaded.tracker), 2.3); assert.equal(loaded.tracker.currentSite, null);
  loaded.tracker.close();
});

test('profiles are separate files and resetting never touches the ledger/history', t => {
  const dir = fixture(t), one = clock({ file: path.join(dir, 'one', 'site-time.json') }), two = clock({ file: path.join(dir, 'two', 'site-time.json') });
  fs.writeFileSync(path.join(dir, 'activity.json'), 'unchanged ledger'); fs.writeFileSync(path.join(dir, 'history.json'), 'unchanged history');
  one.url('https://one.example/'); one.advance(1000); one.tracker.close();
  two.url('https://two.example/'); two.advance(2000); two.tracker.close();
  const reload = clock({ file: one.tracker.file }); assert.equal(total(reload.tracker), 1); reload.tracker.reset(); reload.tracker.close();
  assert.equal(total(clock({ file: two.tracker.file }).tracker), 2);
  assert.equal(fs.readFileSync(path.join(dir, 'activity.json'), 'utf8'), 'unchanged ledger'); assert.equal(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'), 'unchanged history');
});

test('load validates and canonicalizes every stored site, day and duration', t => {
  const dir = fixture(t), file = path.join(dir, 'site-time.json');
  fs.writeFileSync(file, '{"version":1,"secret":"strip-me","days":{"2026-10-27":{"okay.example":12,"https://bad.example/path":50,"x:443":1,"constructor":3,"negative.example":-1,"huge.example":999999999,"text.example":"10"},"2026-02-31":{"bad.example":4},"9999-01-01":{"future.example":4},"2026-10-26":[]}}', { mode: 0o666 });
  const c = clock({ file }); assert.equal(total(c.tracker), 12); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  c.tracker.flush(); assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, days: { '2026-10-27': { 'okay.example': 12 } } });
});

test('corrupt/unreadable files and save failures are explicit, not fatal', t => {
  const dir = fixture(t), file = path.join(dir, 'site-time.json'); fs.writeFileSync(file, '{bad json');
  const c = clock({ file }); assert.match(c.tracker.error, /Could not read site time/); assert.equal(total(c.tracker), 0);
  c.url(); c.advance(1000); assert.equal(total(c.tracker), 1); assert.equal(c.tracker.flush(), true); assert.equal(c.tracker.error, null);
  const blocked = path.join(dir, 'not-a-directory'); fs.writeFileSync(blocked, 'block'); const failure = clock({ file: path.join(blocked, 'site-time.json') }); failure.url(); failure.advance(1000);
  assert.equal(failure.tracker.flush(), false); assert.match(failure.tracker.error, /Could not save/); assert.equal(total(failure.tracker), 1);
});

test('symlinks are never followed on read or write and no shared tmp names are used', t => {
  const dir = fixture(t), target = path.join(dir, 'untouched'), file = path.join(dir, 'site-time.json'); fs.writeFileSync(target, 'do not overwrite'); fs.symlinkSync(target, file);
  const c = clock({ file }); assert.match(c.tracker.error, /Could not read/); c.url(); c.advance(1000); assert.equal(c.tracker.flush(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'do not overwrite'); assert.equal(fs.lstatSync(file).isSymbolicLink(), false); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('close flushes once and later updates/reset-free flushes cannot restart it', () => {
  const c = clock(); c.url(); c.advance(1000); c.tracker.close(); c.advance(1000); c.url(); c.tracker.flush();
  assert.equal(c.tracker.currentSite, null); assert.equal(total(c.tracker), 1);
});

test('duration formatting matches compact iOS-style hours, minutes and seconds', () => {
  assert.equal(duration(0), '0s'); assert.equal(duration(1.6), '2s'); assert.equal(duration(61), '1m 01s'); assert.equal(duration(3661), '1h 01m'); assert.equal(duration(-1), '0s');
});
