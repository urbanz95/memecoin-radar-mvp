import { readJson, atomicJson } from '../src/cli.mjs';
import { runScan } from '../src/runner.mjs';
import { fixture, DEMO_TIME } from '../examples/fixtures.mjs';

const config = await readJson(new URL('../config/policies.json', import.meta.url));
const demos = [];
for (const pipeline of ['new', 'established']) {
  let state = {};
  const times = pipeline === 'new' ? [0, 60, 120] : [0, 300, 600, 900];
  for (const seconds of times) {
    const now = DEMO_TIME + seconds * 1000;
    const report = runScan([fixture(pipeline, now)], config, { now, state, pipelines: [pipeline] });
    state = report.state;
    demos.push(report);
    console.log(`${pipeline} +${seconds}s → ${report.results[0].status}; score=${report.results[0].score}; novos alertas=${report.alerts.length}`);
  }
}
const unsafe = fixture();
unsafe.security.canBlacklist = true;
const report = runScan([unsafe], config, { now: DEMO_TIME, pipelines: ['new'] });
demos.push(report);
console.log(`Contrato pode bloquear carteiras → ${report.results[0].status}`);
await atomicJson(new URL('../runtime/demo-report.json', import.meta.url).pathname, { warning: 'Apenas dados sintéticos; não é um scanner ligado à rede.', demos });
