import { keccak256 } from 'viem';
import { EVENTS, topic } from './abi.mjs';
import { hex, quantity } from './rpc.mjs';
import { decodePool } from './decode-pool.mjs';
export { decodePool } from './decode-pool.mjs';


export async function discover(rpc, head, config, previous = {}) {
  const recentStart = await rpc.findBlockAtOrAfter(Math.max(0, head.timestamp - config.recentHours * 3600), head);
  const sampleStart = config.historicalSampleChunksPerVenue > 0
    ? await rpc.findBlockAtOrAfter(Math.max(0, head.timestamp - config.establishedSampleDays * 86400), head) : null;
  let reorgDetected = false;
  if (previous.checkpoint) {
    const checkpoint = await rpc.block(previous.checkpoint.number);
    reorgDetected = checkpoint.hash.toLowerCase() !== previous.checkpoint.hash.toLowerCase();
  }
  const old = reorgDetected ? {} : previous;
  const catalog = new Map((old.catalog ?? []).map((p) => [p.id, p]));
  const venues = {};
  const diagnostics = [];
  for (const venue of config.venues) {
    const key = `${venue.type}:${venue.address}`;
    const saved = old.venues?.[key];
    try {
      const code = await rpc.request('eth_getCode', [venue.address, hex(head.number)]);
      if (typeof code !== 'string' || code === '0x') throw new Error('Factory/PoolManager sem código');
      const codeHash = keccak256(code);
      if (saved?.codeHash && saved.codeHash !== codeHash) throw new Error('Bytecode da factory/PoolManager mudou');
      const requestedStart = saved?.lastScanned !== undefined ? Math.max(recentStart, saved.lastScanned - config.reorgOverlapBlocks) : recentStart;
      let end = head.number;
      let minimum = head.number + 1;
      let chunks = 0;
      const fresh = [];
      while (end >= requestedStart && chunks < config.maxRecentChunksPerVenue) {
        const start = Math.max(requestedStart, end - config.chunkSize + 1);
        fresh.push(...await rpc.logs(venue.address, [topic(EVENTS[venue.type])], start, end));
        minimum = start; end = start - 1; chunks++;
      }
      // Se houve uma paragem maior que a janela recente, voltar a percorrer a
      // história desde o novo intervalo, cobrindo também o buraco da paragem.
      const interrupted = saved?.lastScanned !== undefined && saved.lastScanned < recentStart;
      let backfillCursor = interrupted ? minimum - 1 : Math.min(saved?.backfillCursor ?? minimum - 1, minimum - 1);
      const ranges = [{ fromBlock: minimum, toBlock: head.number, kind: 'recent' }];
      for (let i = 0; i < config.backfillChunksPerVenue && backfillCursor >= 0; i++) {
        const start = Math.max(0, backfillCursor - config.chunkSize + 1);
        fresh.push(...await rpc.logs(venue.address, [topic(EVENTS[venue.type])], start, backfillCursor));
        ranges.push({ fromBlock: start, toBlock: backfillCursor, kind: 'backfill' });
        backfillCursor = start - 1;
      }
      // Amostra histórica independente para observar desde já pools antigas.
      // Não avança nem preenche artificialmente o cursor contíguo de backfill.
      let sampleCursor = saved?.sampleCursor ?? sampleStart;
      for (let i = 0; i < config.historicalSampleChunksPerVenue && sampleCursor >= 0; i++) {
        const start = Math.max(0, sampleCursor - config.chunkSize + 1);
        fresh.push(...await rpc.logs(venue.address, [topic(EVENTS[venue.type])], start, sampleCursor));
        ranges.push({ fromBlock: start, toBlock: sampleCursor, kind: 'historical-sample-not-exhaustive' });
        sampleCursor = start - 1;
      }
      const discovered = [];
      for (const log of fresh) {
        const pool = decodePool(log, venue);
        // Timestamps e hash canónico são enriquecidos nas pools selecionadas,
        // evitando um pedido de cabeçalho por cada pool do catálogo inteiro.
        discovered.push(pool);
      }
      // Só alterar o catálogo depois de concluir e verificar todo o intervalo.
      for (const [id, pool] of catalog) if (pool.factory === venue.address && pool.createdBlock >= minimum) catalog.delete(id);
      for (const pool of discovered) catalog.set(pool.id, pool);
      venues[key] = { lastScanned: head.number, backfillCursor, sampleCursor, codeHash, ranges,
        recentWindowComplete: minimum <= requestedStart, fullHistoryComplete: backfillCursor < 0, eventsRead: fresh.length };
    } catch (error) {
      // Sem sucesso não avançar o cursor nem afirmar que um universo vazio é completo.
      venues[key] = { ...(saved ?? {}), error: error.code ?? error.message };
      diagnostics.push({ venue: key, error: error.code ?? error.message });
    }
  }
  return { catalog: [...catalog.values()].sort((a, b) => b.createdBlock - a.createdBlock), venues, diagnostics,
    reorgDetected, checkpoint: { number: head.number, hash: head.hash }, recentStart };
}
