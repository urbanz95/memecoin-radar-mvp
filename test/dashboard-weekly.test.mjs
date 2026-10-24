import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/dashboard.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.value = ''; this.hidden = false; this.disabled = false; this.ownText = ''; }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.ownText = ''; this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener() {}
}
function dashboard(fetchImpl = () => { throw new Error('unexpected fetch'); }) {
  const elements = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  elements['mvp-weekly-horizon'].value = '1h';
  const context = { document: { getElementById: id => elements[id] ?? null, createElement: tag => new Element(tag) },
    Intl, Date, URLSearchParams, AbortController, setTimeout: () => 1, clearTimeout() {}, fetch: fetchImpl };
  vm.createContext(context);
  vm.runInContext(source.replace("  ui.refresh.addEventListener('click'", `  globalThis.__weeklyTest = { renderWeeklyReport,
    get navigate() { return typeof navigateWeeklyPage === 'function' ? navigateWeeklyPage : undefined; } }; return;
  ui.refresh.addEventListener('click'`), context);
  return { elements, render: context.__weeklyTest.renderWeeklyReport, navigate: context.__weeklyTest.navigate };
}
const horizon = (decisions, average) => ({ denominator: decisions, returnSamples: decisions, averageReturnPct: average });
function cohort(version, tier, decisions, average, profile = 'profile_new') {
  const band = { id: '75-84', decisions, horizons: { '1h': horizon(decisions, average), '15m': horizon(decisions, average + 1) } };
  return { scoreVersion: version, profile, quoteTier: tier, decisions, bands: [band], unknownScore: null,
    walletScoreBands: [band], walletUnknownScore: null };
}
function report(cohorts) {
  return { schemaVersion: 1, reportKey: 'week-key', weekStart: '2026-10-05T00:00:00Z', dataCutoff: '2026-10-19T00:15:00Z',
    totals: { realDecisions: 99 }, bands: [{ id: '75-84', decisions: 99, horizons: { '1h': horizon(99, 999) } }],
    walletScoreReport: { status: 'READY' }, cohorts };
}

test('weekly dashboard renders one version/profile/quote tier cohort and never pooled averages', () => {
  const ui = dashboard();
  ui.render(report([cohort('v1', 'T0', 1, 10), cohort('v2', 'T2', 2, 50, 'legacy_new')]));
  const selector = ui.elements['mvp-weekly-cohort'];
  assert.ok(selector, 'cohort selector exists');
  assert.equal(selector.children.length, 2);
  assert.match(ui.elements['mvp-weekly-tables'].textContent, /10%/);
  assert.doesNotMatch(ui.elements['mvp-weekly-tables'].textContent, /999/);
  assert.match(ui.elements['mvp-weekly'].textContent, /1 decisões reais/);
  assert.match(ui.elements['mvp-weekly-cohort-status'].textContent, /v1.*profile_new.*T0/);
  selector.value = selector.children[1].value;
  ui.render();
  assert.match(ui.elements['mvp-weekly-tables'].textContent, /50%/);
  assert.doesNotMatch(ui.elements['mvp-weekly-tables'].textContent, /10%|999/);
  assert.match(ui.elements['mvp-weekly-cohort-status'].textContent, /v2.*legacy_new.*T2/);
});

test('weekly dashboard refuses legacy pooled-only data and labels unknown quote tiers explicitly', () => {
  const ui = dashboard();
  ui.render(report([]));
  assert.doesNotMatch(ui.elements['mvp-weekly-tables'].textContent, /999/);
  assert.match(ui.elements['mvp-weekly-tables'].textContent, /coorte/i);
  const legacy = cohort('v1', undefined, 1, 10);
  ui.render(report([legacy]));
  assert.match(ui.elements['mvp-weekly-cohort-status'].textContent, /cotação por comprovar/i);
  assert.doesNotMatch(ui.elements['mvp-weekly-cohort-status'].textContent, /T0/);
});

function paged(cohorts, page = 0) {
  return { ...report(cohorts), schemaVersion: 2, pagination: { page, totalPages: 2, hasPrevious: page > 0, hasNext: page === 0, complete: true } };
}

test('weekly dashboard pages one cohort at a time and preserves it during normal automatic polling', async () => {
  const requests = [];
  const first = paged([cohort('v1', 'T0', 1, 10)]);
  const second = paged([cohort('v2', 'T2', 2, 50)], 1);
  const ui = dashboard(async path => {
    requests.push(path);
    return { ok: true, json: async () => second };
  });
  ui.render(first);
  assert.equal(ui.elements['mvp-weekly-pages'].hidden, false);
  assert.equal(ui.elements['mvp-weekly-previous'].disabled, true);
  assert.equal(ui.elements['mvp-weekly-next'].disabled, false);
  await ui.navigate(1);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0], 'https://radar.invalid').pathname, '/weekly');
  assert.equal(new URL(requests[0], 'https://radar.invalid').searchParams.get('reportKey'), 'week-key');
  assert.equal(new URL(requests[0], 'https://radar.invalid').searchParams.get('page'), '1');
  assert.match(ui.elements['mvp-weekly-tables'].textContent, /50%/);
  assert.match(ui.elements['mvp-weekly-page-status'].textContent, /Coorte 2 de 2/);
  assert.equal(ui.elements['mvp-weekly-previous'].disabled, false);
  assert.equal(ui.elements['mvp-weekly-next'].disabled, true);
  ui.render(first);
  assert.match(ui.elements['mvp-weekly-cohort-status'].textContent, /v2/);
  assert.match(ui.elements['mvp-weekly-tables'].textContent, /50%/);
  ui.elements['mvp-weekly-horizon'].value = '15m';
  ui.render();
  assert.match(ui.elements['mvp-weekly-tables'].textContent, /51%/);
});

test('weekly page errors or a mismatched report never replace the current cohort', async () => {
  const first = paged([cohort('v1', 'T0', 1, 10)]);
  let mode = 'wrong';
  const ui = dashboard(async () => {
    if (mode === 'throw') throw new Error('network failure');
    return { ok: true, json: async () => ({ ...paged([cohort('wrong', 'T2', 2, 999)], 1), reportKey: 'another-report' }) };
  });
  ui.render(first);
  await ui.navigate(1);
  assert.match(ui.elements['mvp-weekly-tables'].textContent, /10%/);
  assert.doesNotMatch(ui.elements['mvp-weekly-tables'].textContent, /999/);
  assert.match(ui.elements['mvp-weekly-page-status'].textContent, /consulta falhou/);
  mode = 'throw';
  await ui.navigate(1);
  assert.match(ui.elements['mvp-weekly-tables'].textContent, /10%/);
  assert.equal(ui.elements['mvp-weekly-next'].disabled, false);
});

test('weekly quarantined canonicality clears old aggregates and ignores in-flight older pages', async () => {
  const first = paged([cohort('v1', 'T0', 1, 10)]);
  let respond;
  const ui = dashboard(() => new Promise(resolve => { respond = resolve; }));
  ui.render(first);
  const pendingPage = ui.navigate(1);
  const quarantined = { ...first, quarantined: true, cohorts: [] };
  ui.render(quarantined);
  respond({ ok: true, json: async () => paged([cohort('v2', 'T2', 2, 999)], 1) });
  await pendingPage;
  assert.doesNotMatch(ui.elements['mvp-weekly-tables'].textContent, /999|10%/);
  assert.match(ui.elements['mvp-weekly'].textContent, /canonicalidade/);
  assert.equal(ui.elements['mvp-weekly-pages'].hidden, true);
});

test('weekly legacy cohort switch preserves unknown-wallet warnings and does not expose HTML markup', () => {
  const ui = dashboard();
  const fixture = report([cohort('<img onerror=alert(1)>', 'T0', 1, 10)]);
  fixture.walletScoreReport = { status: 'COHORT_CHANGED' };
  ui.render(fixture);
  assert.match(ui.elements['mvp-weekly-wallet-status'].textContent, /mesma semana/);
  assert.equal(ui.elements['mvp-weekly-cohort'].children[0].children.length, 0);
  assert.match(ui.elements['mvp-weekly-cohort'].children[0].textContent, /<img/);
});
