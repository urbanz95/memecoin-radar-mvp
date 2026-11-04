import { createServer } from "node:http";
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
