# Solana real-time radar (read-only)

Scanner Node ESM independente do scanner Robinhood preservado na raiz. Os dados de mercado são exclusivamente Solana Mainnet. Não tem carteiras, private keys, LLMs, scoring, alertas externos ou execução financeira.

```sh
cd solana
npm ci --ignore-scripts
npm test
npm start
# Outro terminal:
npm run health
curl http://127.0.0.1:8787/events
curl http://127.0.0.1:8787/gaps
```

Node >=22.13 com `node:sqlite`; validação feita em Node 24.19.0, Linux com `flock`. Configurar variáveis de ambiente conforme [.env.example](.env.example); não existe carregamento automático de `.env`. O processo continua com o browser fechado e usa SQLite WAL local. A pasta de dados precisa de disco persistente. `npm run probe` verifica Mainnet e os programas; `npm run soak` executa 60 minutos reais e guarda `runtime/soak.json`.

**Cobertura parcial**: criação/trading Pump.fun, criação/trading PumpSwap e levantamentos parciais, criação/compra/venda LaunchLab e criação/swaps/depósitos CPMM têm fixtures reais. Outras operações têm apenas testes determinísticos ou não estão implementadas: [cobertura por protocolo](docs/PROTOCOL-COVERAGE.md). Os eventos Pump de trading conhecidos estão `INCOMPLETE` por divergência observada entre IDL e contrato; os campos desconhecidos não são inventadas.

O RPC público não sustentou enriquecimento do volume integral dos quatro programas. Backpressure interrompe subscrições, preserva o inbox e gera lacunas explícitas; o histórico disponível é recuperado com limites. A p95 <2s é um objetivo experimental, não uma garantia. Ver [validação](docs/VALIDATION.md), [limitações](docs/LIMITATIONS.md), [operação](docs/OPERATIONS.md), [arquitetura](docs/ARCHITECTURE.md), [contrato de dados](docs/DATA-CONTRACT.md) e [auditoria](docs/ADAPTATION-AUDIT.md).
