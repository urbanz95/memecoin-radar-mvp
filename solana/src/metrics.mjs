const HISTOGRAM_BOUNDS_MS = Object.freeze([
  1,
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1000,
  2000,
  5000,
  10000,
  30000,
  60000,
  120000,
  300000,
  600000,
  3600000,
  Infinity,
]);

/** Bounded operational measurements. Histograms describe this process only. */
export class Metrics {
  constructor({ reservoirSize = 4096, now = Date.now } = {}) {
    if (!Number.isSafeInteger(reservoirSize) || reservoirSize < 1)
      throw Error("INVALID_METRICS_RESERVOIR");
    this.now = now;
    this.startedAt = now();
    this.reservoirSize = reservoirSize;
    this.counters = {};
    this.gauges = {};
    this.samples = new Map();
    this.timestamps = new Map();
  }
  inc(name, count = 1) {
    this.counters[name] = (this.counters[name] ?? 0) + count;
    const rateName =
      {
        eventsProcessed: "events_processed",
        rpcRequests: "rpc_requests",
        logObservationsPersisted: "log_observations",
      }[name] ?? name;
    if (
      ["rpc_requests", "events_processed", "log_observations"].includes(
        rateName,
      )
    ) {
      const list = this.timestamps.get(rateName) ?? [];
      const now = this.now();
      list.push([now, count]);
      while (list.length && list[0][0] < now - 60000) list.shift();
      // Bound independently of wall clock/rate configuration.
      if (list.length > 100000) list.shift();
      this.timestamps.set(rateName, list);
    }
  }
  set(name, value) {
    this.gauges[name] = value;
  }
  observe(name, value) {
    if (!Number.isFinite(value) || value < 0) return;
    const sample = this.samples.get(name) ?? {
      values: [],
      next: 0,
      count: 0,
      sum: 0,
      totalMax: 0,
      bucketCounts: HISTOGRAM_BOUNDS_MS.map(() => 0),
    };
    if (sample.values.length < this.reservoirSize) sample.values.push(value);
    else {
      sample.values[sample.next] = value;
      sample.next = (sample.next + 1) % this.reservoirSize;
    }
    sample.count++;
    sample.sum += value;
    sample.totalMax = Math.max(sample.totalMax, value);
    sample.bucketCounts[
      HISTOGRAM_BOUNDS_MS.findIndex((bound) => value <= bound)
    ]++;
    this.samples.set(name, sample);
  }
  snapshot() {
    const now = this.now();
    const histograms = {};
    for (const [name, sample] of this.samples) {
      const values = [...sample.values].sort((a, b) => a - b);
      const quantile = (p) =>
        values.length
          ? values[Math.max(0, Math.ceil(p * values.length) - 1)]
          : null;
      let cumulativeCount = 0;
      const cumulativeBuckets = HISTOGRAM_BOUNDS_MS.map((bound, index) => {
        cumulativeCount += sample.bucketCounts[index];
        return {
          upperBoundMs: Number.isFinite(bound) ? bound : "Infinity",
          count: cumulativeCount,
        };
      });
      const cumulativeUpperBound = (p) => {
        const bucket = cumulativeBuckets.find(
          (item) => item.count >= Math.ceil(p * sample.count),
        );
        return typeof bucket?.upperBoundMs === "number"
          ? bucket.upperBoundMs
          : null;
      };
      const cumulativeQuantileUpperBounds = {
        p50: cumulativeUpperBound(0.5),
        p95: cumulativeUpperBound(0.95),
        p99: cumulativeUpperBound(0.99),
      };
      histograms[name] = {
        count: sample.count,
        retainedSamples: values.length,
        p50: quantile(0.5),
        p95: quantile(0.95),
        p99: quantile(0.99),
        max: values.at(-1) ?? null,
        mean: sample.count ? sample.sum / sample.count : null,
        totalMaxMs: sample.totalMax,
        cumulativeBuckets,
        cumulativeQuantileUpperBounds,
        cumulativeQuantileOverflow: Object.fromEntries(
          Object.entries(cumulativeQuantileUpperBounds).map(([key, value]) => [
            key,
            value === null,
          ]),
        ),
        percentileScope: `last ${this.reservoirSize} observations`,
        cumulativeScope:
          "all observations in this process since startedAt; quantiles are bucket upper bounds, not exact percentiles",
      };
    }
    const countSince = (name, window) =>
      (this.timestamps.get(name) ?? [])
        .filter(([at]) => at >= now - window)
        .reduce((sum, [, count]) => sum + count, 0);
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      measuredAt: new Date(now).toISOString(),
      uptimeMs: Math.max(0, now - this.startedAt),
      counters: { ...this.counters },
      gauges: { ...this.gauges },
      histograms,
      rpcRequestsPerMinute: countSince("rpc_requests", 60000),
      eventsPerSecond: countSince("events_processed", 1000),
      observationsPerSecond: countSince("log_observations", 1000),
      histogramWindow: `last ${this.reservoirSize} observations per metric`,
    };
  }
}
