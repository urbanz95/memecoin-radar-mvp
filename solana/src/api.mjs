import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const RADAR_HTML = readFileSync(new URL("../static/radar.html", import.meta.url), "utf8");
export function serve(scanner, { host = "127.0.0.1", port = 8788 } = {}) {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end(JSON.stringify({ error: "READ_ONLY" }));
      return;
    }
    try {
      const url = new URL(req.url, "http://local");
      const limit = Math.min(
        1000,
        Math.max(1, Number.parseInt(url.searchParams.get("limit"), 10) || 100),
      );
      const mint = url.searchParams.get("mint"),
        wallet = url.searchParams.get("wallet");
      let data;
      switch (url.pathname) {
        case "/radar":
          data = scanner.radar({ limit });
          break;
        case "/dashboard": {
          // Snapshot renders without JS/network when downloaded as HTML.
          // On loopback it refreshes /radar automatically without Solana RPC.
          const snapshot = JSON.stringify(scanner.radar({ limit: 50 }))
            .replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
            .replace(/&/g, "\\u0026");
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'");
          res.end(RADAR_HTML.replace("__SNAPSHOT_JSON__", snapshot));
          return;
        }
        case "/health":
          data = scanner.health();
          break;
        case "/observations":
          data = {
            data: scanner.store.observations({
              mint,
              wallet,
              poolAddress: url.searchParams.get("pool"),
              signature: url.searchParams.get("signature"),
              limit,
            }),
            coverage: "PARTIAL",
            context: "RPC_LOGS_WITH_INCOMPLETE_TRANSACTION_CONTEXT",
            mergedWithMarket: false,
          };
          break;
        case "/evidence":
          data = url.searchParams.get('signature') ? scanner.store.evidence(url.searchParams.get('signature')) : {error:'SIGNATURE_REQUIRED'};
          break;
        case "/events":
          data = {
            data: scanner.store.events({
              mint,
              wallet,
              signature: url.searchParams.get("signature"),
              limit,
            }),
            coverage: "PARTIAL",
          };
          break;
        case "/tokens":
          data = { data: scanner.store.tokens(limit), coverage: "PARTIAL" };
          break;
        case "/market":
          data = scanner.market();
          break;
        case "/gaps":
          data = { data: scanner.store.gaps(limit), coverage: "PARTIAL" };
          break;
        case "/security":
          data = { mint, data: mint ? scanner.store.getSecurity(mint) : null };
          break;
        default:
          res.writeHead(404);
          res.end(JSON.stringify({ error: "NOT_FOUND" }));
          return;
      }
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(500);
      res.end(JSON.stringify({ error: "READ_FAILED" }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
