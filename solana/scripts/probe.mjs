import { mkdir, writeFile } from "node:fs/promises";
import { RpcClient } from "../src/rpc.mjs";
import { Metrics } from "../src/metrics.mjs";
import { loadConfig } from "../src/config.mjs";
import { PROGRAMS } from "../src/protocols/index.mjs";
const config = loadConfig(),
  metrics = new Metrics(),
  rpc = new RpcClient({
    url: config.httpUrl ?? config.rpcUrl,
    metrics,
    requestsPerMinute: 30,
    retries: 1,
  });
const report = {
  dataMode: "REAL_MAINNET_RPC",
  startedAt: new Date().toISOString(),
  programs: [],
};
try {
  report.genesisHash = await rpc.assertMainnet();
  report.slot = await rpc.request("getSlot", [{ commitment: "finalized" }]);
  for (const program of PROGRAMS) {
    try {
      const account = await rpc.request("getAccountInfo", [
        program.programId,
        { encoding: "base64", commitment: "finalized" },
      ]);
      const signatures = await rpc.request("getSignaturesForAddress", [
        program.programId,
        { limit: 1, commitment: "finalized" },
      ]);
      report.programs.push({
        ...program,
        executable: account.value?.executable ?? false,
        owner: account.value?.owner,
        contextSlot: account.context.slot,
        latest: signatures,
      });
    } catch (e) {
      report.programs.push({ ...program, error: e.code ?? e.message });
    }
  }
} catch (e) {
  report.error = e.code ?? e.message;
  process.exitCode = 1;
} finally {
  report.endedAt = new Date().toISOString();
  report.metrics = metrics.snapshot();
  await mkdir("runtime", { recursive: true });
  await writeFile("runtime/probe.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await rpc.close();
}
