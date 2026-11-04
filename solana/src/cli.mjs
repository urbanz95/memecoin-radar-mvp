import { loadConfig } from "./config.mjs";
import { Scanner } from "./scanner.mjs";
import { serve } from "./api.mjs";
const config = loadConfig();
const scanner = new Scanner(config);
let server,
  stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ action: "shutdown", signal }));
  server?.close();
  try {
    await scanner.stop();
  } catch (e) {
    console.error(JSON.stringify({ error: e.code ?? e.message }));
    process.exitCode = 1;
  }
}
process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGINT", () => stop("SIGINT"));
try {
  await scanner.start();
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
  console.error(
    JSON.stringify({ action: "startup_failed", error: e.code ?? e.message }),
  );
  await stop("STARTUP_FAILED");
  process.exitCode = 1;
}
