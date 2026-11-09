import { loadConfig } from "./config.mjs";
import { Scanner } from "./scanner.mjs";
import { serve } from "./api.mjs";
import { bootstrapR2Backup } from "./backup-runtime.mjs";

const config = loadConfig();
// IMPORTANT: Scanner constructor opens SQLite. Restore happens before that.
let scanner, backupAgent, server, stopping = false;

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ action: "shutdown", signal }));
  server?.close();
  try {
    // Wait for any running snapshot before closing its DatabaseSync connection.
    await backupAgent?.stop();
  } catch {
    console.error(JSON.stringify({ error: "R2_BACKUP_STOP_FAILED" }));
    process.exitCode = 1;
  }
  try {
    await scanner?.stop();
  } catch (e) {
    console.error(JSON.stringify({ error: e.code ?? e.message }));
    process.exitCode = 1;
  }
}
process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGINT", () => stop("SIGINT"));

try {
  const boot = await bootstrapR2Backup({ dbPath: config.dbPath });
  backupAgent = boot.agent;
  // A remote restore, if required, is finished and verified at this point.
  scanner = new Scanner(config);
  scanner.backupAgent = backupAgent;
  if (boot.enabled) {
    console.log(JSON.stringify({
      action: "r2_backup_bootstrap",
      restoreStatus: boot.restoreStatus,
      // Never print account, bucket, endpoint, token or object key.
    }));
  }
  await scanner.start();
  if (backupAgent) {
    backupAgent.start(scanner.store.db, code =>
      console.log(JSON.stringify({ action: "r2_backup_status", code })));
  }
  server = await serve(scanner, config);
  console.log(
    JSON.stringify({
      action: "started",
      mode: "READ_ONLY",
      mainnet: true,
      programs: scanner.programs,
      dbPath: config.dbPath,
    }),
  );
} catch (e) {
  // A wrapped R2 restore error is emitted as a code only; its cause could
  // contain an SDK error with URLs or credentials and is never logged here.
  const safe = String(e?.message ?? "");
  console.error(JSON.stringify({
    action: "startup_failed",
    error: safe.startsWith("R2_") ? safe : "SCANNER_STARTUP_FAILED",
  }));
  await stop("STARTUP_FAILED");
  process.exitCode = 1;
}
