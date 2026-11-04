import test from "node:test";
import assert from "node:assert/strict";
import { Metrics } from "../src/metrics.mjs";

test("cumulative latency buckets retain old high values after the bounded recent window wraps", () => {
  const metrics = new Metrics({ reservoirSize: 3 });
  for (const value of [30000, 30000, 30000, 1, 1, 1])
    metrics.observe("latency", value);
  const sample = metrics.snapshot().histograms.latency;
  assert.equal(sample.p95, 1);
  assert.equal(sample.count, 6);
  assert.equal(sample.retainedSamples, 3);
  assert.equal(sample.cumulativeQuantileUpperBounds.p95, 30000);
  assert.equal(sample.cumulativeQuantileUpperBounds.p99, 30000);
  assert.equal(sample.totalMaxMs, 30000);
  assert.equal(
    sample.cumulativeBuckets.find((b) => b.upperBoundMs === 1).count,
    3,
  );
  assert.equal(sample.cumulativeBuckets.at(-1).count, 6);
  assert.match(sample.cumulativeScope, /upper bounds/);
  assert.match(sample.percentileScope, /last 3/);
});

test("cumulative bucket boundaries are inclusive, monotonic and count every sample exactly once", () => {
  const metrics = new Metrics({ reservoirSize: 2 });
  for (const value of [0, 1, 2, 5, 250, 251, 1000, 3600000])
    metrics.observe("latency", value);
  const sample = metrics.snapshot().histograms.latency;
  assert.equal(sample.count, 8);
  assert.equal(sample.cumulativeBuckets.length, 19);
  assert.equal(
    sample.cumulativeBuckets.find((b) => b.upperBoundMs === 1).count,
    2,
  );
  assert.equal(
    sample.cumulativeBuckets.find((b) => b.upperBoundMs === 5).count,
    4,
  );
  assert.equal(
    sample.cumulativeBuckets.find((b) => b.upperBoundMs === 250).count,
    5,
  );
  assert.equal(
    sample.cumulativeBuckets.find((b) => b.upperBoundMs === 500).count,
    6,
  );
  assert.equal(sample.cumulativeBuckets.at(-2).count, 8);
  assert.equal(sample.cumulativeBuckets.at(-1).count, 8);
  assert.equal(sample.cumulativeQuantileUpperBounds.p95, 3600000);
  assert.deepEqual(sample.cumulativeQuantileOverflow, {
    p50: false,
    p95: false,
    p99: false,
  });
  assert.ok(
    sample.cumulativeBuckets.every(
      (bucket, index, buckets) =>
        index === 0 || bucket.count >= buckets[index - 1].count,
    ),
  );
});

test("overflow is explicit and JSON serializable rather than a fabricated finite percentile", () => {
  const metrics = new Metrics();
  metrics.observe("latency", 3600001);
  const sample = JSON.parse(JSON.stringify(metrics.snapshot())).histograms
    .latency;
  assert.equal(sample.cumulativeBuckets.at(-1).upperBoundMs, "Infinity");
  assert.equal(sample.cumulativeBuckets.at(-1).count, 1);
  assert.deepEqual(sample.cumulativeQuantileUpperBounds, {
    p50: null,
    p95: null,
    p99: null,
  });
  assert.deepEqual(sample.cumulativeQuantileOverflow, {
    p50: true,
    p95: true,
    p99: true,
  });
  assert.equal(sample.totalMaxMs, 3600001);
});

test("empty and invalid latency measurements never create zero-valued success metrics", () => {
  const metrics = new Metrics();
  assert.deepEqual(metrics.snapshot().histograms, {});
  for (const value of [NaN, Infinity, -1, undefined, null, "4"])
    metrics.observe("latency", value);
  assert.deepEqual(metrics.snapshot().histograms, {});
  assert.throws(
    () => new Metrics({ reservoirSize: 0 }),
    /INVALID_METRICS_RESERVOIR/,
  );
});

test("cumulative histogram memory stays fixed and counts are exact across many reservoir wraps", () => {
  const metrics = new Metrics({ reservoirSize: 4 });
  for (let index = 0; index < 100001; index++)
    metrics.observe("latency", index % 2 ? 10 : 100);
  const sample = metrics.snapshot().histograms.latency;
  assert.equal(sample.count, 100001);
  assert.equal(
    sample.cumulativeBuckets.find((b) => b.upperBoundMs === 10).count,
    50000,
  );
  assert.equal(
    sample.cumulativeBuckets.find((b) => b.upperBoundMs === 100).count,
    100001,
  );
  assert.equal(metrics.samples.get("latency").values.length, 4);
  assert.equal(metrics.samples.get("latency").bucketCounts.length, 19);
});

test("observation throughput is independent of enriched-event throughput and expires normally", () => {
  let now = 1000;
  const metrics = new Metrics({ now: () => now });
  metrics.inc("logObservationsPersisted", 12);
  metrics.inc("events_processed", 2);
  metrics.inc("rpc_requests", 3);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.observationsPerSecond, 12);
  assert.equal(snapshot.eventsPerSecond, 2);
  assert.equal(snapshot.rpcRequestsPerMinute, 3);
  now += 1001;
  assert.equal(metrics.snapshot().observationsPerSecond, 0);
  assert.equal(metrics.snapshot().eventsPerSecond, 0);
  assert.equal(metrics.snapshot().rpcRequestsPerMinute, 3);
  now += 60000;
  assert.equal(metrics.snapshot().rpcRequestsPerMinute, 0);
});
