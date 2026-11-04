import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.mjs";
import { Scanner } from "../src/scanner.mjs";
import { serve } from "../src/api.mjs";
const reportDirectory = process.env.SOLANA_REPORT_DIR ?? "runtime";
const seconds = Number(process.env.SOLANA_SOAK_SECONDS ?? 3600);
if (!Number.isFinite(seconds) || seconds < 1)
  throw Error("INVALID_SOAK_DURATION");
const config = loadConfig(),
  scanner = new Scanner(config),
  samples = [];
const report = {
  dataMode: "REAL_MAINNET_LIVE",
  requestedSeconds: seconds,
  startedAt: new Date().toISOString(),
  samples,
};
let server,
  timer,
  done = false;
async function finish(reason) {
  if (done) return;
  done = true;
  clearInterval(timer);
  scanner.flush();
  report.reason = reason;
  report.endedAt = new Date().toISOString();
  report.elapsedSeconds = (Date.now() - Date.parse(report.startedAt)) / 1000;
  report.final = scanner.health();
  report.gaps = scanner.store.gaps(1000);
  report.eventExamples = scanner.store.events({ limit: 10 });
  report.logObservationExamples = scanner.store.observations({ limit: 10 });
  report.logObservationCounts = scanner.store.db
    .prepare(
      "SELECT json_extract(payload,'$.protocol') protocol,json_extract(payload,'$.eventType') eventType,COUNT(*) count FROM event_observations GROUP BY protocol,eventType",
    )
    .all();
  report.protocolCounts = scanner.store.db
    .prepare(
      "SELECT json_extract(payload,'$.protocol') protocol,event_type,COUNT(*) count FROM events GROUP BY protocol,event_type",
    )
    .all();
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    join(reportDirectory, "soak.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      action: "soak_finished",
      elapsedSeconds: report.elapsedSeconds,
      reason,
      final: report.final,
    }),
  );
  server?.close();
  await scanner.stop();
}
process.once("SIGTERM", () => finish("SIGTERM"));
process.once("SIGINT", () => finish("SIGINT"));
try {
  await scanner.start();
  server = await serve(scanner, config);
  console.log(
    JSON.stringify({
      action: "soak_started",
      seconds,
      startedAt: report.startedAt,
    }),
  );
  timer = setInterval(async () => {
    samples.push(scanner.health());
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(
      join(reportDirectory, "soak-progress.json"),
      JSON.stringify(
        {
          ...report,
          elapsedSeconds: (Date.now() - Date.parse(report.startedAt)) / 1000,
        },
        null,
        2,
      ),
    );
    if (Date.now() - Date.parse(report.startedAt) >= seconds * 1000)
      await finish("DURATION_COMPLETED");
  }, 10000);
} catch (e) {
  report.error = e.code ?? e.message;
  await finish("STARTUP_FAILED");
  process.exitCode = 1;
}
