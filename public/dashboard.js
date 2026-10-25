(() => {
  'use strict';
  const POLL_MS = 30000;
  const TIMEOUT_MS = 12000;
  const ids = ['refresh', 'status', 'status-detail', 'collected-at', 'block', 'run-id', 'checked-at', 'check-result',
    'poll-state', 'new-pipeline', 'established-pipeline', 'quality', 'approved', 'token', 'coverage',
    'strict-new', 'strict-established', 'screening-summary', 'watch-new', 'watch-established', 'watch-unclassified', 'unclassified-section',
    'market-alerts-count', 'trade-count', 'signal-summary', 'signals-list', 'signals-available', 'data-health',
    'mvp-status', 'mvp-data', 'mvp-wallets', 'mvp-outcomes', 'mvp-alerts', 'mvp-weekly', 'mvp-preview',
    'mvp-weekly-details', 'mvp-weekly-horizon', 'mvp-weekly-tables', 'mvp-weekly-wallet-status',
    'mvp-weekly-cohort', 'mvp-weekly-cohort-status', 'mvp-weekly-pages', 'mvp-weekly-previous', 'mvp-weekly-next', 'mvp-weekly-page-status'];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const dateFormat = new Intl.DateTimeFormat('pt-PT', { timeZone: 'Europe/Lisbon', day: '2-digit', month: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const numberFormat = new Intl.NumberFormat('pt-PT');
  const weeklyDateFormat = new Intl.DateTimeFormat('pt-PT', { timeZone: 'Europe/Lisbon', day: '2-digit', month: '2-digit', year: 'numeric' });
  let timer;
  let freshnessTimer;
  let pending = false;
  let lastReport = null;
  let lastHealth = null;
  let requestFailed = false;
  let entryTimes = [];
  let moduleTimes = [];
  let marketTimes = [];
  let signalTimes = [];
  let signalListKey = '';
  let weeklyBase = null;
  let weeklyPage = null;
  let weeklyPaging = false;
  let weeklyPageError = false;
  let weeklyRequest = 0;

  const text = (id, value) => { if (ui[id].textContent !== value) ui[id].textContent = value; };
  const validObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
  const date = value => Number.isFinite(timestamp(value)) ? dateFormat.format(timestamp(value)) : 'Não disponível';
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const pipelineStatus = (report, pipeline) => {
    const results = Array.isArray(report.recordedResults) ? report.recordedResults.filter(result => result?.pipeline === pipeline) : [];
    if (!results.length) return 'SEM AVALIAÇÃO';
    if (report.currentSignalsAvailable === true && results.some(result => result.status === 'CANDIDATE'
      && timestamp(result.evidenceExpiresAt) > Date.now())) return 'SINAL APROVADO';
    if (results.some(result => result.status === 'CONFIRMING')) return 'EM CONFIRMAÇÃO';
    if (results.some(result => result.status === 'BLOCKED')) return 'BLOCKED';
    if (results.some(result => result.status === 'INCOMPLETE')) return 'INCOMPLETE';
    if (results.every(result => result.status === 'OUT_OF_SCOPE')) return 'OUT_OF_SCOPE';
    return 'SEM SINAL ATUAL';
  };

  const shortText = (value, length = 160) => typeof value === 'string' ? value.slice(0, length) : '';
  const amount = value => {
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(number) && number >= 0 ? new Intl.NumberFormat('pt-PT', { maximumSignificantDigits: 6 }).format(number) : null;
  };
  const signedAmount = value => typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 2, signDisplay: 'exceptZero' }).format(value) : null;
  const usd = value => { const formatted = amount(value); return formatted === null ? 'Sem dados' : `${formatted} USD`; };
  const rawAmount = value => typeof value === 'string' && /^\d{1,78}$/.test(value)
    ? numberFormat.format(BigInt(value)) : null;
  const wethAmount = value => {
    if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) return null;
    const padded = value.padStart(19, '0');
    const fraction = padded.slice(-18).replace(/0+$/, '');
    return `${numberFormat.format(BigInt(padded.slice(0, -18)))}${fraction ? `,${fraction}` : ''}`;
  };
  const node = (tag, className, content) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  };
  const addMetric = (list, label, value) => {
    if (value === null || value === undefined || value === '') return;
    const group = node('div', 'entry-metric');
    group.append(node('dt', '', label), node('dd', '', value));
    list.append(group);
  };

  function ageDescription(age) {
    if (!validObject(age)) return 'Idade do contrato por comprovar.';
    const parts = [];
    if (Number.isFinite(timestamp(age.contractCreatedAt))) parts.push(`Criação reportada: ${date(age.contractCreatedAt)}`);
    const lower = amount(age.lowerBoundMinutes);
    const upper = amount(age.upperBoundMinutes);
    if (lower !== null && upper !== null) parts.push(`Presença de código: entre ${lower} e ${upper} min`);
    else if (lower !== null) parts.push(`Código observado há pelo menos ${lower} min`);
    else if (upper !== null) parts.push(`Limite observado de presença de código: ${upper} min`);
    if (!parts.length) parts.push('Idade do contrato por comprovar');
    const sources = { 'direct-creation-receipt': 'recibo de criação confirmado na rede',
      'code-existence-bounds': 'leituras históricas de bytecode', 'insufficient-evidence': 'prova de idade insuficiente' };
    if (typeof age.basis === 'string' && age.basis) parts.push(`Fonte: ${sources[age.basis] || shortText(age.basis, 100)}`);
    return parts.join(' · ');
  }

  function renderEntryFreshness() {
    for (const item of entryTimes) {
      const observed = timestamp(item.observedAt);
      const age = Date.now() - observed;
      const stale = !Number.isFinite(observed) || age > 600000 || age < -30000;
      const label = `${stale ? 'Observação desatualizada' : 'Observado'}: ${date(item.observedAt)} · Lisboa`;
      if (item.element.textContent !== label) item.element.textContent = label;
      item.element.dataset.stale = String(stale);
    }
    for (const item of moduleTimes) {
      const checked = timestamp(item.checkedAt);
      const age = Date.now() - checked;
      const stale = !Number.isFinite(checked) || age > 600000 || age < -30000;
      const label = Number.isFinite(checked)
        ? `${stale ? 'Verificação desatualizada' : 'Verificado'}: ${date(item.checkedAt)} · Lisboa`
        : 'Ainda sem data de verificação confirmada';
      if (item.element.textContent !== label) item.element.textContent = label;
      item.element.dataset.stale = String(stale);
    }
    for (const item of marketTimes) {
      const fetched = timestamp(item.fetchedAt);
      const age = Date.now() - fetched;
      const stale = !Number.isFinite(fetched) || age > 120000 || age < -30000;
      const label = Number.isFinite(fetched)
        ? `Mercado${stale ? ' desatualizado' : ' atualizado'}: ${date(item.fetchedAt)} · Lisboa`
        : 'Mercado: ainda sem data de consulta confirmada';
      if (item.element.textContent !== label) item.element.textContent = label;
      item.element.dataset.stale = String(stale);
    }
    for (const item of signalTimes) {
      const status = currentSignalStatus(item.signal);
      item.element.dataset.status = status;
      const label = signalLabel(status);
      if (item.element.textContent !== label) item.element.textContent = label;
    }
  }

  function currentSignalStatus(signal, now = Date.now()) {
    const expires = timestamp(signal?.expiresAt);
    return ['NO_SETUP', 'CONFIRMING', 'MARKET_ALERT'].includes(signal?.status)
      && (!Number.isFinite(expires) || expires <= now) ? 'STALE' : signal?.status;
  }

  function signalLabel(status) {
    return { BLOCKED: 'Bloqueado', STALE: 'Dados de mercado desatualizados', OUT_OF_SCOPE: 'Idade fora dos critérios de sinal',
      WAITING_DATA: 'A aguardar dados de mercado', NO_SETUP: 'Sem condições de entrada', CONFIRMING: 'Condições de mercado em confirmação',
      MARKET_ALERT: 'Alerta de mercado · segurança pendente' }[status] || 'A aguardar avaliação de mercado';
  }

  function renderEntrySignal(entry) {
    const signal = validObject(entry.signal) ? entry.signal : { status: 'WAITING_DATA' };
    const section = node('section', 'entry-signal');
    const state = node('p', 'signal-state', signalLabel(signal.status));
    state.dataset.status = signal.status;
    signalTimes.push({ element: state, signal });
    section.append(state);
    const score = amount(signal.score);
    if (score !== null) section.append(node('p', 'note', `Score de mercado: ${score}/100 · não equivale a aprovação de segurança.`));
    const reasons = [...(Array.isArray(signal.reasons) ? signal.reasons : []), ...(Array.isArray(signal.missing) ? signal.missing : [])]
      .filter(value => typeof value === 'string' && value).filter((value, index, values) => values.indexOf(value) === index).slice(0, 3);
    if (!reasons.length && signal.status === 'WAITING_DATA') reasons.push('Preço, liquidez, volume e atividade precisam de dados recentes para avaliar uma entrada.');
    if (reasons.length) {
      const list = node('ul', 'signal-reasons');
      for (const reason of reasons) list.append(node('li', '', shortText(reason, 240)));
      section.append(list);
    }
    const checks = Array.isArray(signal.checks) ? signal.checks.filter(validObject).slice(0, 24) : [];
    if (checks.length) {
      const detail = node('details', 'signal-criteria');
      detail.append(node('summary', '', 'Critérios do sinal de mercado'));
      const list = node('ul');
      for (const check of checks) {
        const label = shortText(check.label, 120) || 'Critério de mercado';
        const value = typeof check.value === 'number' && Number.isFinite(check.value)
          ? numberFormat.format(check.value) : typeof check.value === 'boolean' ? check.value ? 'sim' : 'não'
            : typeof check.value === 'string' ? shortText(check.value, 80) : 'sem dados';
        const threshold = typeof check.threshold === 'number' ? numberFormat.format(check.threshold)
          : typeof check.threshold === 'string' ? shortText(check.threshold, 80)
            : Array.isArray(check.threshold) ? check.threshold.map(item => typeof item === 'number' ? numberFormat.format(item) : shortText(item, 40)).join('–') : null;
        list.append(node('li', '', `${label}: ${value}${threshold !== null ? ` · referência ${threshold}` : ''} · ${check.passed === true ? 'cumpre' : check.passed === false ? 'não cumpre' : 'por comprovar'}`));
      }
      detail.append(list); section.append(detail);
    }
    return section;
  }

  function safetyState(kind, status) {
    const value = typeof status === 'string' ? status.toUpperCase() : '';
    if (kind === 'liquidity') {
      const states = { BURNED_95_PERCENT: 'Queima ≥95% nesta pool', BURN_COVERAGE_BELOW_95: 'Queima abaixo de 95%',
        EMPTY_LP_SUPPLY: 'Sem emissão de LP', UNSUPPORTED: 'Posições por verificar' };
      if (states[value]) return states[value];
    }
    if (kind === 'simulation' && ['PASSED', 'PASS', 'SUCCESS', 'SUCCEEDED', 'COMPLETE', 'CHECKED'].includes(value)) return 'Simulação executada';
    const states = { BLOCKED: 'Risco detetado', RISK_DETECTED: 'Risco detetado', FAILED: 'Falhou', FAIL: 'Falhou',
      CHECKED: 'Leitura concluída', COMPLETE: 'Leitura concluída', COMPLETED: 'Leitura concluída', VERIFIED: 'Verificação registada',
      PARTIAL: 'Verificação parcial', INDEXING: 'Indexação em curso', IN_PROGRESS: 'Em curso', SNAPSHOT_COMPLETE: 'Índice concluído',
      RECONCILED_AT_HEAD: 'Distribuição conciliada',
      UNAVAILABLE: 'Dados indisponíveis', NOT_CHECKED: 'Leitura adiada', UNSUPPORTED: 'Verificação indisponível',
      INCOMPLETE: 'Provas em falta', UNKNOWN: 'Por verificar', DEFERRED: 'Leitura adiada' };
    return states[value] || 'Por verificar';
  }

  function readableCheck(metric) {
    const labels = {
      'security.hasBytecode': 'Código de contrato presente', 'security.contractVerified': 'Código verificado',
      'security.canMint': 'Emissão adicional', 'security.canPause': 'Pausa de transferências',
      'security.canBlacklist': 'Bloqueio de carteiras', 'security.whitelistOnly': 'Lista de carteiras autorizadas',
      'security.canChangeFees': 'Taxas alteráveis', 'security.canConfiscate': 'Confisco de saldos',
      'security.proxyUpgradeable': 'Contrato atualizável', 'security.hiddenPrivileges': 'Privilégios ocultos',
      'security.honeypotDetected': 'Comportamento de honeypot', 'security.buyTaxPct': 'Taxa de compra',
      'security.sellTaxPct': 'Taxa de venda', 'security.knownMalicious': 'Atividade maliciosa conhecida',
      'lp.minimumLiquidity1000Verified': 'Constante mínima de LP confirmada',
      'lp.selectedPoolBurnCoverage95Pct': 'Cobertura queimada de 95% nesta pool', 'lp.creatorBalanceRaw': 'Saldo LP do criador observado',
      'quote.buySucceeded': 'Compra simulada', 'quote.sellSucceeded': 'Venda simulada',
      'quote.buyImpactPct': 'Impacto simulado da compra', 'quote.sellImpactPct': 'Impacto simulado da venda',
      'quote.roundTripLossPct': 'Perda simulada de ida e volta',
    };
    return labels[metric] || shortText(metric, 70).replace(/^[^.]+\./, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  }

  function readableGap(value) {
    const message = typeof value === 'string' ? value : validObject(value) ? value.message || value.reason : '';
    if (typeof message !== 'string' || !message) return 'Evidência adicional ainda por obter.';
    const labels = {
      LINKED_INSIDERS_NOT_INDEXED: 'As ligações de financiamento entre carteiras ainda não foram indexadas.',
      BUNDLES_NOT_PROVEN: 'As transações observadas não comprovam a existência ou ausência de bundles.',
      HOLDER_RANGE_UNAVAILABLE: 'A consulta de transferências não ficou disponível; o índice mantém o progresso anterior.',
      HOLDER_RANGE_SHRUNK: 'O intervalo de transferências foi reduzido para continuar a indexação dentro dos limites.',
      HOLDER_SINGLE_BLOCK_TOO_DENSE: 'Um bloco tem mais transferências do que esta leitura consegue analisar.',
      HOLDER_LEDGER_CAPACITY_REACHED: 'O índice atingiu o limite de carteiras desta análise; a distribuição permanece incompleta.',
      HOLDER_GENESIS_INITIAL_BALANCES_UNKNOWN: 'O token já tinha código no início da rede; os saldos iniciais não estão comprovados.',
      HOLDER_DEPLOYMENT_START_UNPROVEN: 'O início do histórico de transferências ainda não foi comprovado.',
      HOLDER_SUPPLY_NOT_RECONCILED: 'O histórico de transferências ainda não coincide com a emissão total do token.',
      HOLDER_ALL_BALANCES_NOT_VERIFIED: 'Faltam leituras de saldo para confirmar toda a distribuição.',
      HOLDER_BALANCE_READ_UNAVAILABLE: 'Algumas leituras de saldo não devolveram uma prova válida.',
      HOLDER_RPC_BUDGET_DEFERRED: 'A leitura de holders foi adiada para respeitar o limite gratuito deste ciclo.',
      HOLDER_REORG_RESTARTED: 'A rede alterou um bloco indexado; a análise reiniciou a partir da origem comprovada.',
      HOLDER_RANGE_CONFIRMATION_UNAVAILABLE: 'Não foi possível confirmar o bloco das transferências consultadas.',
      HOLDER_CANONICAL_HEADER_UNAVAILABLE: 'O bloco de referência da distribuição não foi confirmado.',
      HOLDER_TOTAL_SUPPLY_UNAVAILABLE_OR_INCONSISTENT: 'A emissão total não ficou disponível ou não coincide com os saldos.',
      HOLDER_ZERO_TOTAL_SUPPLY: 'A emissão total observada é zero.',
      HOLDER_ANALYSIS_UNAVAILABLE: 'Não foi possível concluir a análise de holders nesta leitura.',
      OWNER_AND_INDIRECT_PRIVILEGES_NOT_PROVEN: 'O owner foi observado; os seus privilégios diretos e indiretos continuam por comprovar.',
      DELEGATED_IMPLEMENTATIONS_NOT_VERIFIED: 'A implementação delegada e os seus privilégios ainda exigem verificação.',
      CONTRACT_BYTECODE_FORMAT_UNSUPPORTED: 'O formato do bytecode não permite concluir esta análise de código.',
      CONTRACT_ABI_ENUMERATION_TRUNCATED: 'A lista de funções excedeu o limite desta análise.',
      ROLE_MEMBERSHIP_NOT_ENUMERATED: 'Os membros e administradores das roles ainda não foram enumerados.',
      CONTROL_FLOW_AND_PRIVILEGES_NOT_AUDITED: 'A correspondência do código não substitui uma auditoria aos caminhos de execução e privilégios.',
      TRANSFER_SEMANTICS_NOT_PROVEN: 'Os caminhos de transferência do token ainda não estão todos comprovados.',
      SOURCE_NOT_INDEXED: 'O código deste contrato ainda não está indexado no Sourcify.',
      SOURCE_NOT_EXACTLY_MATCHED: 'O código publicado não ficou confirmado como correspondência exata deste contrato.',
      CONTRACT_SOURCE_UNAVAILABLE: 'O código publicado não ficou disponível nesta consulta.',
      UNSUPPORTED_POOL_TYPE: 'Esta simulação suporta apenas pools v2 com WETH; posições v3/v4 exigem outra simulação.',
      UNSUPPORTED_QUOTE: 'Esta simulação exige WETH como moeda de cotação.',
      POOL_IDENTITY_NOT_VERIFIED: 'A identidade da pool não ficou comprovada para executar a simulação.',
      SIMULATION_RPC_BUDGET_DEFERRED: 'A simulação foi adiada para respeitar o limite gratuito deste ciclo.',
      SIMULATION_RPC_REVERTED_OR_UNSUPPORTED: 'O RPC rejeitou ou não conseguiu executar esta simulação.',
      SIMULATION_UNAVAILABLE: 'Não foi possível obter uma execução válida da simulação.',
      OBSERVED_BUY_OR_SELL_REVERTED: 'A compra ou a venda reverteu nesta execução simulada.',
      PROBE_AMOUNT_DUST: 'O montante de teste ficou abaixo do mínimo útil desta pool.',
      PROBE_ADDRESS_NOT_EMPTY: 'O endereço de teste já tinha código; a simulação foi interrompida.',
      INVALID_SIMULATION_RESULT: 'A resposta não permitiu comprovar a execução da simulação.',
      INCONSISTENT_SIMULATION_OUTPUTS: 'Os resultados da simulação não passaram os controlos de consistência.',
    };
    if (labels[message]) return labels[message];
    if (message.includes('RATE_LIMIT') || message.includes('COOLDOWN')) return 'O fornecedor limitou temporariamente as consultas; uma nova tentativa está agendada.';
    if (message.endsWith('_TIMEOUT') || message === 'TIMEOUT') return 'O fornecedor não respondeu dentro do prazo desta leitura.';
    if (message.includes('HTTP_429')) return 'O fornecedor limitou temporariamente as consultas.';
    if (message.includes('HTTP_404')) return 'O fornecedor não tem informação publicada para este contrato.';
    if (message.includes('HTTP_403')) return 'O fornecedor recusou a consulta desta informação.';
    if (/^[A-Z0-9_:/. -]+$/.test(message) && /_/.test(message)) return 'Não foi possível concluir esta parte da verificação com a evidência disponível.';
    return shortText(message, 220);
  }

  function renderSafety(entry) {
    const section = node('section', 'safety-checks');
    section.append(node('h4', '', 'Verificações de segurança'));
    const descriptions = {
      contract: 'As conclusões limitam-se ao código e aos privilégios que esta leitura conseguiu verificar.',
      holders: 'A distribuição depende da cobertura do índice de transferências e da identificação de carteiras ligadas.',
      liquidity: 'A cobertura refere-se à pool selecionada; não comprova a proteção de todas as pools do token.',
      simulation: 'Uma simulação favorável não aprova o token nem garante a execução futura de uma ordem real.',
    };
    for (const [kind, label] of [['contract', 'Contrato e privilégios'], ['holders', 'Holders'],
      ['liquidity', 'Proteção da LP'], ['simulation', 'Simulação compra/venda']]) {
      const assessment = validObject(entry.safety?.[kind]) ? entry.safety[kind] : null;
      const detail = node('details', 'safety-check');
      detail.dataset.module = kind;
      const state = safetyState(kind, assessment?.status);
      if (['Risco detetado', 'Falhou'].includes(state)) detail.dataset.tone = 'error';
      const summary = node('summary');
      summary.append(node('span', '', `${label} · `), node('strong', '', state));
      detail.append(summary);
      const checkedAt = typeof assessment?.checkedAt === 'string' ? assessment.checkedAt : assessment?.observedAt;
      const time = node('p', 'entry-time');
      moduleTimes.push({ element: time, checkedAt });
      detail.append(time, node('p', 'note', descriptions[kind]));
      if (!assessment) {
        detail.append(node('p', 'note', 'Esta verificação ainda não tem um resultado guardado.'));
        section.append(detail); continue;
      }
      const metrics = node('dl', 'entry-metrics');
      if (kind === 'liquidity') {
        const coverage = amount(assessment.coveragePct);
        if (coverage !== null) addMetric(metrics, 'LP queimada · apenas esta pool', `${coverage}%`);
        if (typeof assessment.canonicalConfirmed === 'boolean') addMetric(metrics, 'Bloco da leitura', assessment.canonicalConfirmed ? 'Confirmado na rede' : 'Por confirmar');
      }
      if (kind === 'holders') {
        const coverage = validObject(assessment.coverage) ? assessment.coverage : assessment;
        const from = coverage.fromBlock ?? coverage.indexedFromBlock;
        const through = coverage.throughBlock ?? coverage.indexedThroughBlock;
        const head = typeof coverage.head === 'object' ? coverage.head?.number : coverage.head ?? coverage.headBlock;
        if (integer(from) && integer(through)) addMetric(metrics, 'Blocos indexados', `${numberFormat.format(from)}–${numberFormat.format(through)}`);
        if (integer(head)) addMetric(metrics, 'Cabeça de referência', numberFormat.format(head));
        const complete = coverage.transferHistoryComplete ?? coverage.complete;
        if (typeof complete === 'boolean') addMetric(metrics, 'Histórico de transferências', complete ? 'Intervalo completo' : 'Ainda incompleto');
        if (typeof coverage.distributionComplete === 'boolean') addMetric(metrics, 'Saldos da distribuição', coverage.distributionComplete ? 'Conciliados no bloco indicado' : 'Por conciliar na totalidade');
        if (integer(coverage.remainingBlocks)) addMetric(metrics, 'Blocos por indexar', numberFormat.format(coverage.remainingBlocks));
        const distribution = validObject(assessment.metrics) ? assessment.metrics : assessment;
        for (const [key, metricLabel] of [['count', 'Holders comprovados'], ['holdersCount', 'Holders comprovados'],
          ['top1Pct', 'Maior carteira'], ['top10Pct', 'Dez maiores carteiras']]) {
          const value = amount(distribution[key]);
          if (value !== null) addMetric(metrics, metricLabel, `${value}${key.endsWith('Pct') ? '%' : ''}`);
        }
        if (!coverage.distributionComplete && validObject(assessment.lowerBounds)) {
          for (const [key, metricLabel] of [['count', 'Carteiras com saldo confirmado · pelo menos'],
            ['top1Pct', 'Maior carteira · concentração mínima'], ['top10Pct', 'Dez maiores · concentração mínima']]) {
            const value = amount(assessment.lowerBounds[key]);
            if (value !== null) addMetric(metrics, metricLabel, `${value}${key.endsWith('Pct') ? '%' : ''}`);
          }
        }
      }
      if (kind === 'simulation') {
        const notional = validObject(assessment.notional) ? assessment.notional : null;
        const size = wethAmount(assessment.requestedQuoteWei) ?? amount(assessment.notionalQuote ?? assessment.amountInQuote ?? notional?.amount);
        const currency = shortText(assessment.quoteAsset ?? notional?.quoteAsset, 16);
        if (size !== null) addMetric(metrics, 'Montante simulado', `${size}${currency ? ` ${currency}` : ''}`);
        const buyOutput = rawAmount(assessment.buy?.receivedTokenRaw ?? assessment.buyOutputRaw);
        if (buyOutput !== null) addMetric(metrics, 'Saída da compra · unidades brutas do token', buyOutput);
        const sellOutput = wethAmount(assessment.sell?.receivedQuoteRaw ?? assessment.sellOutputRaw);
        if (sellOutput !== null) addMetric(metrics, 'Saída da venda', `${sellOutput} WETH`);
        for (const [value, metricLabel] of [[assessment.buy?.observedTransferTaxPct, 'Taxa de transferência observada · compra'],
          [assessment.sell?.observedTransferTaxPct, 'Taxa de transferência observada · venda'],
          [assessment.roundtripLossPct, 'Perda de ida e volta observada']]) {
          const formatted = amount(value);
          if (formatted !== null) addMetric(metrics, metricLabel, `${formatted}%`);
        }
        if (assessment.amountUsdVerified === false && size !== null) detail.append(node('p', 'note', 'Teste com um montante fixo em WETH. Não comprova a simulação exigida de 100 USD.'));
        const failureStage = assessment.failureStage ?? (assessment.status === 'failed' ? assessment.stage : null);
        if (typeof failureStage === 'string') {
          const stages = { buy: 'Compra', sell: 'Venda', approve: 'Autorização', quote: 'Cotação', setup: 'Preparação',
            BUY: 'Compra', SELL: 'Venda', APPROVE: 'Autorização', QUOTE: 'Cotação', SETUP: 'Preparação' };
          addMetric(metrics, 'Etapa sem conclusão', stages[failureStage] || 'Verificação da simulação');
        }
      }
      if (kind === 'contract' && validObject(assessment.sourceVerification)) {
        const source = assessment.sourceVerification;
        addMetric(metrics, 'Código publicado', source.status === 'matched' ? 'Correspondência confirmada' : 'Correspondência por comprovar');
        if (Number.isFinite(timestamp(source.checkedAt))) addMetric(metrics, 'Consulta ao código publicado · Lisboa', date(source.checkedAt));
      }
      if (metrics.childElementCount) detail.append(metrics);
      const gaps = Array.isArray(assessment.gaps) ? assessment.gaps.slice(0, 5)
        : Array.isArray(assessment.unknowns) ? assessment.unknowns.slice(0, 5) : [];
      const risks = Array.isArray(assessment.risks) ? assessment.risks.slice(0, 5) : [];
      const reason = typeof assessment.reason === 'string' && assessment.status !== 'passed' ? assessment.reason : null;
      if (risks.length || gaps.length || reason) {
        const list = node('ul');
        if (reason) list.append(node('li', '', readableGap(reason)));
        for (const risk of risks) list.append(node('li', '', readableGap(risk)));
        for (const gap of gaps) list.append(node('li', '', readableGap(gap)));
        detail.append(list);
      }
      const checks = Array.isArray(assessment.checks) ? assessment.checks.filter(validObject).slice(0, 10) : [];
      if (checks.length) {
        const list = node('ul');
        for (const check of checks) list.append(node('li', '', `${readableCheck(check.metric)}: ${check.passed === true ? 'cumpre o critério' : check.passed === false ? 'não cumpre o critério' : 'observação sem aprovação'}`));
        detail.append(list);
      }
      section.append(detail);
    }
    return section;
  }

  function renderProviders(providers) {
    if (!Array.isArray(providers) || !providers.length) return null;
    const detail = node('details', 'provider-checks');
    detail.append(node('summary', '', 'Disponibilidade das fontes externas'));
    const list = node('ul');
    for (const provider of providers.filter(validObject).slice(0, 3)) {
      const label = { goplus: 'GoPlus · indicadores de segurança', dexscreener: 'DEXScreener · mercado' }[provider.provider];
      if (!label) continue;
      let status = provider.error ? readableGap(provider.error) : provider.result === 'reported'
        ? 'Dados recebidos do fornecedor; não equivalem a uma auditoria.' : 'Sem resultado utilizável nesta consulta.';
      if (integer(provider.httpStatus) && provider.httpStatus >= 100 && provider.httpStatus <= 599 && provider.httpStatus !== 200)
        status += ` HTTP ${provider.httpStatus}.`;
      const item = node('li', '', `${label}: ${status}`);
      if (Number.isFinite(timestamp(provider.fetchedAt))) item.append(node('span', 'entry-source', ` Consulta: ${date(provider.fetchedAt)} · Lisboa.`));
      list.append(item);
    }
    if (!list.childElementCount) return null;
    detail.append(list);
    return detail;
  }

  function renderEntry(entry) {
    const article = node('article', 'watch-entry');
    article.dataset.address = entry.address;
    const symbol = shortText(entry.symbol, 32);
    article.append(node('h3', '', symbol || `${entry.address.slice(0, 8)}…${entry.address.slice(-6)}`));
    const link = node('a', 'mono', entry.address);
    link.href = `https://robinhoodchain.blockscout.com/address/${entry.address}`;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    article.append(link);
    const blocked = entry.status === 'BLOCKED';
    const state = node('p', 'entry-state', blocked ? 'Bloqueado' : 'Segurança pendente');
    state.dataset.blocked = String(blocked);
    article.append(state);
    article.append(renderEntrySignal(entry));
    if (entry.status === 'NO_LIQUIDITY') article.append(node('p', 'note', 'Sem liquidez ativa observada nesta pool.'));
    if (entry.status === 'WATCH') article.append(node('p', 'note', 'Liquidez externa abaixo do limiar de análise deste intervalo.'));
    article.append(node('p', 'entry-age', ageDescription(entry.age)));
    const time = node('p', 'entry-time');
    entryTimes.push({ element: time, observedAt: entry.observedAt });
    article.append(time);

    const metrics = node('dl', 'entry-metrics');
    const quote = entry.native?.priceInQuote;
    const quotePrice = amount(quote?.value);
    if (quotePrice !== null && typeof quote?.quoteAsset === 'string') addMetric(metrics, 'Preço on-chain por token', `${quotePrice} ${shortText(quote.quoteAsset, 16)}`);
    if (typeof entry.native?.activeLiquidity === 'boolean') addMetric(metrics, 'Liquidez ativa observada', entry.native.activeLiquidity ? 'Presente' : 'Ausente');
    else {
      const liquidity = amount(entry.native?.activeLiquidity);
      if (liquidity !== null) addMetric(metrics, 'Liquidez ativa · unidades brutas', liquidity);
    }
    if (typeof entry.native?.identityVerified === 'boolean') addMetric(metrics, 'Identidade da pool', entry.native.identityVerified ? 'Correspondência verificada' : 'Por verificar');
    const activity = validObject(entry.native?.activity) ? entry.native.activity : null;
    if (activity?.complete === true) {
      if (integer(activity.swaps)) addMetric(metrics, 'Swaps · amostra de blocos', numberFormat.format(activity.swaps));
      if (integer(activity.transactionCount)) addMetric(metrics, 'Transações · mesma amostra', numberFormat.format(activity.transactionCount));
      const volume = amount(activity.volumeQuote);
      if (volume !== null && typeof activity.quoteAsset === 'string') addMetric(metrics, 'Volume · mesma amostra', `${volume} ${shortText(activity.quoteAsset, 16)}`);
    }
    const priority = amount(entry.priorityScore);
    if (priority !== null) addMetric(metrics, 'Prioridade de análise', `${priority}/100`);
    const external = validObject(entry.externalMarket) ? entry.externalMarket : null;
    for (const [key, label] of [['priceUsd', 'Preço de mercado'], ['liquidityUsd', 'Liquidez do mercado'], ['fdvUsd', 'FDV']])
      addMetric(metrics, label, usd(external?.[key]));
    for (const [window, label] of [['m5', '5 min'], ['h1', '1 h'], ['h24', '24 h']]) {
      addMetric(metrics, `Volume ${label}`, usd(external?.volumeUsd?.[window]));
      const change = signedAmount(external?.priceChangePct?.[window]);
      addMetric(metrics, `Variação ${label}`, change === null ? 'Sem dados' : `${change}%`);
      const buys = external?.txns?.[window]?.buys;
      const sells = external?.txns?.[window]?.sells;
      addMetric(metrics, `Compras / vendas · ${label}`, `${integer(buys) ? numberFormat.format(buys) : '—'} / ${integer(sells) ? numberFormat.format(sells) : '—'}`);
    }
    if (metrics.childElementCount) article.append(metrics);
    else article.append(node('p', 'note', 'Ainda sem métricas de mercado comprovadas nesta observação.'));
    if (activity?.complete === true) {
      const range = integer(activity.fromBlock) && integer(activity.toBlock)
        ? `Amostra: blocos ${numberFormat.format(activity.fromBlock)}–${numberFormat.format(activity.toBlock)}.` : 'Atividade numa amostra de blocos.';
      article.append(node('p', 'entry-source', `${range} Não equivale a uma janela de cinco minutos nem mede traders únicos.`));
    } else if (activity) article.append(node('p', 'entry-source', 'Amostra de atividade incompleta; os seus totais não são apresentados.'));
    const marketTime = node('p', 'market-time');
    marketTimes.push({ element: marketTime, fetchedAt: external?.fetchedAt });
    article.append(marketTime);
    if (external) article.append(node('p', 'entry-source', `Mercado reportado por ${shortText(external.source, 80) || 'fornecedor não identificado'}. Compras e vendas são transações, não traders únicos. As métricas não substituem a análise de segurança.`));
    else article.append(node('p', 'entry-source', 'As métricas em falta não são tratadas como zero. A avaliação retoma quando existirem dados de mercado utilizáveis.'));

    article.append(renderSafety(entry));
    const providerDetails = renderProviders(entry.providers);
    if (providerDetails) article.append(providerDetails);

    const risks = Array.isArray(entry.risks) ? entry.risks.filter(validObject).slice(0, 24) : [];
    const unknowns = Array.isArray(entry.unknowns) ? entry.unknowns.filter(value => typeof value === 'string').slice(0, 24) : [];
    const checks = Array.isArray(entry.checks) ? entry.checks.filter(validObject).slice(0, 32) : [];
    const details = node('details');
    details.append(node('summary', '', `Análise: ${risks.length} riscos · ${unknowns.length} pontos pendentes`));
    if (risks.length) {
      details.append(node('p', '', 'Riscos observados'));
      const list = node('ul');
      for (const risk of risks) list.append(node('li', '', shortText(risk.reason) || shortText(risk.code, 80) || 'Risco por esclarecer'));
      details.append(list);
    }
    if (unknowns.length) {
      details.append(node('p', '', 'Evidência ainda em falta'));
      const list = node('ul');
      for (const unknown of unknowns) list.append(node('li', '', shortText(unknown, 220)));
      details.append(list);
    }
    if (checks.length) {
      details.append(node('p', '', 'Verificações desta observação'));
      const list = node('ul');
      for (const check of checks) list.append(node('li', '', `${shortText(check.metric, 80)}: ${check.passed === true ? 'cumpre' : check.passed === false ? 'não cumpre' : 'por comprovar'}`));
      details.append(list);
    }
    const strictStatuses = new Set(['INCOMPLETE', 'BLOCKED', 'OUT_OF_SCOPE', 'WATCH', 'CONFIRMING', 'CANDIDATE']);
    const strict = value => strictStatuses.has(value) ? value : 'SEM AVALIAÇÃO';
    details.append(node('p', 'note', `Validação estrita: novos ${strict(entry.strict?.new)} · estabelecidos ${strict(entry.strict?.established)}. Só são apresentados sinais aprovados enquanto as provas de segurança permanecem válidas.`));
    article.append(details);
    return article;
  }

  function renderScreening(screening) {
    entryTimes = [];
    moduleTimes = [];
    marketTimes = [];
    signalTimes = [];
    const entries = Array.isArray(screening?.entries) ? screening.entries.filter(entry => validObject(entry)
      && entry.status !== 'BLOCKED'
      && typeof entry.address === 'string' && /^0x[0-9a-f]{40}$/i.test(entry.address)).slice(0, 20) : [];
    const groups = { new: [], established: [], unclassified: [] };
    for (const entry of entries) groups[entry.pipeline === 'new' || entry.pipeline === 'established' ? entry.pipeline : 'unclassified'].push(entry);
    for (const [pipeline, entries] of Object.entries(groups)) {
      const container = ui[`watch-${pipeline}`];
      container.replaceChildren();
      if (entries.length) for (const entry of entries) container.append(renderEntry(entry));
      else container.append(node('p', 'empty-list', pipeline === 'unclassified' ? 'Nenhuma observação por classificar.' : 'Sem tokens observados neste intervalo.'));
    }
    for (const pipeline of ['new', 'established']) text(`${pipeline}-pipeline`, groups[pipeline].length ? `A monitorizar ${groups[pipeline].length}` : 'Sem tokens neste intervalo');
    ui['unclassified-section'].hidden = groups.unclassified.length === 0;
    const hidden = Array.isArray(screening?.entries) ? screening.entries.filter(entry => entry?.status === 'BLOCKED').length : 0;
    text('screening-summary', entries.length
      ? `${entries.length} ${entries.length === 1 ? 'token em acompanhamento' : 'tokens em acompanhamento'} · avaliação atualizada em ${date(screening.asOf)} (Lisboa). Cada mercado e análise de segurança conserva a sua data.`
      : hidden ? `Sem tokens para acompanhar neste momento: ${hidden} ${hidden === 1 ? 'token bloqueado foi ocultado' : 'tokens bloqueados foram ocultados'}.`
        : 'Sem tokens para acompanhar neste momento. A aguardar observações que possam ser avaliadas.');
    renderEntryFreshness();
  }

  function renderSignals(report) {
    if (!report) return;
    const now = Date.now();
    const allEntries = Array.isArray(report.screening?.entries) ? report.screening.entries.filter(validObject) : [];
    const entries = allEntries.filter(entry => entry.status !== 'BLOCKED');
    const blocked = new Set(allEntries.filter(entry => entry.status === 'BLOCKED' && typeof entry.address === 'string')
      .map(entry => entry.address.toLowerCase()));
    const reportTime = timestamp(report.capturedAt);
    const headTime = report.observedHead?.timestamp;
    const freshReport = report.dataStale === false && Number.isFinite(reportTime) && now - reportTime >= -30000
      && now - reportTime <= 90000 && typeof headTime === 'number' && now - headTime * 1000 >= -30000 && now - headTime * 1000 <= 60000;
    const addressValid = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) && !blocked.has(value.toLowerCase());
    const marketAlerts = freshReport ? entries.filter(entry => addressValid(entry.address) && currentSignalStatus(entry.signal, now) === 'MARKET_ALERT'
      && timestamp(entry.signal.expiresAt) > now && timestamp(entry.signal.observedAt) <= now + 30000) : [];
    const candidates = freshReport && report.currentSignalsAvailable === true && Array.isArray(report.signals?.tradeCandidates)
      ? report.signals.tradeCandidates.filter(candidate => validObject(candidate) && addressValid(candidate.address)
        && candidate.status === 'CANDIDATE' && timestamp(candidate.evidenceExpiresAt) > now) : [];
    text('market-alerts-count', String(marketAlerts.length));
    text('trade-count', String(candidates.length));
    text('approved', String(candidates.length));
    text('signals-available', candidates.length ? `Sim · ${candidates.length} ${candidates.length === 1 ? 'sinal aprovado' : 'sinais aprovados'}`
      : marketAlerts.length ? 'Alertas de mercado disponíveis; segurança ainda por aprovar.' : 'Sem sinais aprovados nesta recolha.');
    let summary;
    if (!freshReport) summary = 'A aguardar dados recentes. Sinais expirados não contam como oportunidades atuais.';
    else if (candidates.length) summary = 'Há sinais que passaram os critérios e as verificações de segurança, válidos apenas até à expiração indicada.';
    else if (marketAlerts.length) summary = `${marketAlerts.length} ${marketAlerts.length === 1 ? 'alerta cumpre' : 'alertas cumprem'} os critérios de mercado. A segurança ainda está pendente: não são sinais aprovados para trade.`;
    else if (!entries.length) summary = blocked.size ? 'Todos os tokens observados estão bloqueados e foram ocultados. Não há sinal aprovado para trade.'
      : 'Ainda não há tokens com dados suficientes para avaliar uma oportunidade.';
    else if (!validObject(report.signals) && !entries.some(entry => validObject(entry.signal))) summary = 'As observações recebidas ainda não incluem uma avaliação de sinais. As métricas e as provas disponíveis aparecem abaixo.';
    else {
      const counts = {};
      for (const entry of entries) {
        const status = currentSignalStatus(entry.signal, now);
        if (typeof status === 'string') counts[status] = (counts[status] || 0) + 1;
      }
      const parts = [];
      for (const [status, label] of [['WAITING_DATA', 'sem dados suficientes'], ['STALE', 'com mercado desatualizado'],
        ['NO_SETUP', 'sem condições de entrada'], ['CONFIRMING', 'em confirmação'], ['OUT_OF_SCOPE', 'fora da janela de idade']]) {
        if (counts[status]) parts.push(`${counts[status]} ${label}`);
      }
      summary = `Sem sinal aprovado para trade.${parts.length ? ` ${parts.join(' · ')}.` : ' Os critérios de mercado e de segurança ainda não estão completos.'} Os motivos aparecem em cada token.`;
    }
    text('signal-summary', summary);
    const listKey = JSON.stringify([candidates.map(item => [item.address, item.pipeline, item.evidenceExpiresAt]),
      marketAlerts.map(item => [item.address, item.pipeline, item.signal?.expiresAt])]);
    if (listKey !== signalListKey) {
      ui['signals-list'].replaceChildren();
      for (const [items, label, expiry] of [[candidates, 'Sinal aprovado para trade', item => item.evidenceExpiresAt],
        [marketAlerts, 'Alerta de mercado · segurança pendente', item => item.signal.expiresAt]]) {
        for (const item of items.slice(0, 20)) {
          const row = node('li');
          const title = shortText(item.symbol, 32) || `${item.address.slice(0, 8)}…${item.address.slice(-6)}`;
          const link = node('a', '', title);
          link.href = `https://robinhoodchain.blockscout.com/address/${item.address}`;
          link.target = '_blank'; link.rel = 'noopener noreferrer';
          row.append(link, node('span', '', ` · ${label} · válido até ${date(expiry(item))} (Lisboa)`));
          ui['signals-list'].append(row);
        }
      }
      signalListKey = listKey;
    }
    const marketLimited = entries.some(entry => Array.isArray(entry.providers) && entry.providers.some(provider => provider?.provider === 'dexscreener'
      && (provider.httpStatus === 429 || /RATE_LIMIT|COOLDOWN/.test(provider.error || ''))));
    const hasRecentMarket = entries.some(entry => {
      const at = timestamp(entry.externalMarket?.fetchedAt);
      return Number.isFinite(at) && now - at >= -30000 && now - at <= 120000;
    });
    ui['data-health'].hidden = !marketLimited || hasRecentMarket;
    text('data-health', marketLimited && !hasRecentMarket ? 'O fornecedor de mercado limitou temporariamente as consultas. A recolha voltará a tentar automaticamente; os dados em falta não geram sinais.' : '');
  }

  const weeklyKey = weekly => validObject(weekly) ? JSON.stringify([weekly.reportKey, weekly.weekStart, weekly.dataCutoff]) : null;
  const weeklyTier = value => ['T0', 'T1S', 'T1', 'T2'].includes(value) ? value : 'UNKNOWN';
  const weeklyCohortKey = cohort => JSON.stringify([cohort.scoreVersion, cohort.profile, weeklyTier(cohort.quoteTier)]);
  const weeklyCohortLabel = cohort => `${shortText(cohort.scoreVersion, 100)} · ${shortText(cohort.profile, 100)} · ${weeklyTier(cohort.quoteTier) === 'UNKNOWN' ? 'cotação por comprovar' : cohort.quoteTier}`;

  function renderWeeklyReport(incoming) {
    if (arguments.length) {
      if (weeklyKey(incoming) !== weeklyKey(weeklyBase) || incoming?.quarantined === true) {
        weeklyPage = null;
        weeklyPageError = false;
        weeklyPaging = false;
        weeklyRequest++;
        ui['mvp-weekly-cohort'].value = '';
      }
      weeklyBase = validObject(incoming) ? incoming : null;
    }
    const weekly = weeklyPage || weeklyBase;
    const tables = ui['mvp-weekly-tables'];
    tables.replaceChildren();
    text('mvp-weekly-wallet-status', '');
    text('mvp-weekly-cohort-status', '');
    ui['mvp-weekly-pages'].hidden = true;
    ui['mvp-weekly-details'].hidden = !validObject(weekly);
    if (!validObject(weekly)) {
      ui['mvp-weekly-cohort'].replaceChildren();
      text('mvp-weekly', 'O relatório semanal aguarda uma semana de lançamentos com a janela de sete dias concluída.');
      return;
    }
    if (weekly.quarantined === true) {
      ui['mvp-weekly-cohort'].replaceChildren();
      text('mvp-weekly', 'Relatório suspenso: a canonicalidade das decisões precisa de ser verificada.');
      tables.append(node('p', 'empty-list', 'Os resultados anteriores ficam excluídos até serem verificados.'));
      return;
    }
    const cohorts = (Array.isArray(weekly.cohorts) ? weekly.cohorts : []).filter(cohort => validObject(cohort)
      && typeof cohort.scoreVersion === 'string' && cohort.scoreVersion.length > 0
      && typeof cohort.profile === 'string' && cohort.profile.length > 0);
    const selector = ui['mvp-weekly-cohort'];
    const priorSelection = selector.value;
    selector.replaceChildren();
    const seen = new Set();
    for (const cohort of cohorts) {
      const key = weeklyCohortKey(cohort);
      if (seen.has(key)) continue;
      seen.add(key);
      const option = node('option', '', weeklyCohortLabel(cohort));
      option.value = key;
      selector.append(option);
    }
    const selected = cohorts.find(cohort => weeklyCohortKey(cohort) === priorSelection) || cohorts[0];
    selector.value = selected ? weeklyCohortKey(selected) : '';
    selector.disabled = weeklyPaging || seen.size < 2;
    const at = timestamp(weekly.weekStart);
    const week = Number.isFinite(at) ? weeklyDateFormat.format(at) : 'data não disponível';
    const decisions = selected?.decisions;
    text('mvp-weekly', `Relatório semanal · semana de ${week} · ${integer(decisions) ? numberFormat.format(decisions) : '—'} decisões reais.`);
    if (!selected) {
      tables.append(node('p', 'empty-list', 'Ainda não há uma coorte por versão, perfil e tier disponível.'));
      return;
    }
    text('mvp-weekly-cohort-status', weeklyCohortLabel(selected));
    const pagination = weekly.pagination;
    if (validObject(pagination) && integer(pagination.page) && integer(pagination.totalPages)) {
      ui['mvp-weekly-pages'].hidden = false;
      ui['mvp-weekly-previous'].disabled = weeklyPaging || pagination.hasPrevious !== true;
      ui['mvp-weekly-next'].disabled = weeklyPaging || pagination.hasNext !== true;
      text('mvp-weekly-page-status', weeklyPaging ? 'A consultar a coorte…'
        : weeklyPageError ? 'A consulta falhou. A coorte anterior mantém-se visível.'
          : `Coorte ${numberFormat.format(pagination.page + 1)} de ${numberFormat.format(pagination.totalPages)}${pagination.complete === false ? ' publicadas · relatório em preparação' : ''}`);
    }
    if (decisions === 0) {
      tables.append(node('p', 'empty-list', 'Esta semana ainda não tem avaliações reais. Os resultados aparecerão quando a respetiva coorte estiver disponível.'));
      return;
    }
    const horizons = ['15m', '1h', '24h', '7d'];
    const selectedHorizon = ui['mvp-weekly-horizon'].value;
    const horizon = horizons.includes(selectedHorizon) ? selectedHorizon : '1h';
    const definitions = [['0-49', '0–49'], ['50-64', '50–64'], ['65-74', '65–74'], ['75-84', '75–84'], ['85-100', '85–100'], ['UNKNOWN', 'Score desconhecido']];
    const addTable = (dimension, caption, bands, unknown) => {
      if (!Array.isArray(bands)) return false;
      const indexed = new Map();
      for (const band of bands.slice(0, 20)) {
        if (validObject(band) && definitions.some(([id]) => id === band.id && id !== 'UNKNOWN') && !indexed.has(band.id)) indexed.set(band.id, band);
      }
      if (validObject(unknown)) indexed.set('UNKNOWN', unknown);
      const wrap = node('div', 'weekly-table-wrap');
      wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', caption);
      const table = node('table', 'weekly-table'); table.dataset.scoreDimension = dimension;
      table.append(node('caption', '', caption));
      const head = node('thead'); const labels = node('tr');
      for (const label of ['Faixa', 'Decisões', 'Retorno médio', 'Retornos com dados']) {
        const cell = node('th', '', label); cell.scope = 'col'; labels.append(cell);
      }
      head.append(labels); table.append(head);
      const body = node('tbody');
      for (const [id, label] of definitions) {
        const band = indexed.get(id); const result = validObject(band?.horizons) ? band.horizons[horizon] : null;
        const samples = result?.returnSamples; const denominator = result?.denominator;
        const covered = integer(samples) && integer(denominator) && samples <= denominator
          && integer(band?.decisions) && denominator === band.decisions;
        const mean = covered && samples > 0 && typeof result?.averageReturnPct === 'number' && Number.isFinite(result.averageReturnPct)
          ? `${signedAmount(result.averageReturnPct)}%` : 'Sem dados';
        const row = node('tr'); row.dataset.band = id;
        const title = node('th', '', label); title.scope = 'row';
        row.append(title, node('td', '', integer(band?.decisions) ? numberFormat.format(band.decisions) : '—'),
          node('td', '', mean), node('td', '', covered ? `${numberFormat.format(samples)}/${numberFormat.format(denominator)}` : '—'));
        body.append(row);
      }
      table.append(body); wrap.append(table); tables.append(wrap);
      return true;
    };
    if (!addTable('token', 'Resultado por score do token', selected.bands, selected.unknownScore))
      tables.append(node('p', 'note', 'As faixas de score do token ainda não estão disponíveis neste relatório.'));
    if (weekly.walletScoreReport?.status === 'COHORT_CHANGED') {
      text('mvp-weekly-wallet-status', 'Não foi possível reconstruir as faixas de wallet score com os dados da mesma semana.');
    } else if (weekly.walletScoreReport?.status !== 'READY'
      || !addTable('wallet', 'Resultado por wallet score à data da decisão', selected.walletScoreBands, selected.walletUnknownScore)) {
      text('mvp-weekly-wallet-status', 'As faixas de wallet score ainda não estão disponíveis neste relatório.');
    }
  }

  async function navigateWeeklyPage(direction) {
    if (weeklyPaging || ![-1, 1].includes(direction)) return;
    const current = weeklyPage || weeklyBase;
    const pagination = current?.pagination;
    if (!validObject(pagination) || !integer(pagination.page) || typeof current?.reportKey !== 'string'
      || (direction === -1 ? pagination.hasPrevious !== true : pagination.hasNext !== true)) return;
    const page = pagination.page + direction;
    if (!integer(page)) return;
    const request = ++weeklyRequest;
    const key = weeklyKey(weeklyBase);
    weeklyPaging = true;
    weeklyPageError = false;
    renderWeeklyReport();
    try {
      const params = new URLSearchParams({ reportKey: current.reportKey, page: String(page) });
      const result = await getJSON(`/weekly?${params}`);
      if (request !== weeklyRequest || key !== weeklyKey(weeklyBase)) return;
      const payload = result.payload;
      if (result.ok && weeklyKey(payload) === key && payload.quarantined === true) {
        weeklyPage = payload;
        return;
      }
      if (!result.ok || weeklyKey(payload) !== key || payload.schemaVersion !== 2
        || payload.pagination?.page !== page || !Array.isArray(payload.cohorts) || payload.cohorts.length !== 1) {
        throw new Error('INVALID_WEEKLY_PAGE');
      }
      weeklyPage = payload;
      ui['mvp-weekly-cohort'].value = '';
    } catch {
      if (request === weeklyRequest) weeklyPageError = true;
    } finally {
      if (request === weeklyRequest) {
        weeklyPaging = false;
        renderWeeklyReport();
      }
    }
  }

  function renderMvp(report) {
    const mvp = report.mvp;
    if (!validObject(mvp) || mvp.recording !== true) {
      text('mvp-status', 'O serviço ainda não confirmou a gravação deste modo.');
      renderWeeklyReport(null);
      return;
    }
    text('mvp-status', `Gravação ativa · avaliação em ${date(report.capturedAt)} (Lisboa) · dry-run.`);
    const archive = mvp.archive;
    const count = value => integer(value) ? numberFormat.format(value) : '—';
    text('mvp-data', `${count(archive?.tokensSeen)} tokens · ${count(archive?.decisions)} decisões versionadas`);
    text('mvp-outcomes', `${count(archive?.outcomesComplete)} observações · ${count(archive?.outcomeJobs?.pending)} pendentes · ${count(archive?.outcomeJobs?.retry)} a repetir`);
    const wallets = mvp.wallets;
    text('mvp-wallets', validObject(wallets)
      ? `${count(wallets.eligible)} elegíveis · ${count(wallets.tracked)} acompanhadas. ${wallets.eligible ? 'Exige pelo menos cinco trades realizados e custos comprovados.' : 'PnL por comprovar: faltam histórico completo, custo inicial e taxas.'}`
      : 'Ainda sem PnL realizado comprovado.');
    text('mvp-alerts', `${count(mvp.outbox?.stats?.queuedDryRun)} guardados · envio desativado`);
    renderWeeklyReport(mvp.weeklyReport);
    const blocked = new Set((report.screening?.entries ?? []).filter(entry => entry.status === 'BLOCKED').map(entry => entry.address?.toLowerCase()));
    const alerts = Array.isArray(mvp.outbox?.recent) ? mvp.outbox.recent.filter(alert => alert?.dryRun === true
      && alert.synthetic !== true && typeof alert.address === 'string' && /^0x[0-9a-f]{40}$/i.test(alert.address)
      && !blocked.has(alert.address.toLowerCase())).slice(0, 5) : [];
    const list = ui['mvp-preview']; list.replaceChildren();
    if (!alerts.length) list.append(node('p', 'empty-list', 'Sem alertas elegíveis guardados.'));
    for (const alert of alerts) {
      const article = node('article', 'dry-run-entry');
      article.append(node('h3', '', `[NOVO] ${shortText(alert.symbol, 32) || alert.address} · score ${amount(alert.score) ?? '—'}/100`),
        node('p', 'mono', alert.address), node('p', 'note', `Dry-run histórico · ${date(alert.observedAt)} (Lisboa)`));
      const reasons = node('ul');
      for (const reason of (Array.isArray(alert.reasons) ? alert.reasons : []).slice(0, 3)) reasons.append(node('li', '', shortText(reason, 240)));
      article.append(reasons); list.append(article);
    }
  }

  function renderReport(report) {
    text('collected-at', date(report.capturedAt));
    text('run-id', typeof report.runId === 'string' ? report.runId : 'Não disponível');
    text('block', integer(report.observedHead?.number) ? numberFormat.format(report.observedHead.number) : 'Não disponível');
    text('strict-new', pipelineStatus(report, 'new'));
    text('strict-established', pipelineStatus(report, 'established'));
    renderScreening(report.screening);
    const qualities = { PARTIAL: 'PARTIAL · dados parciais', DEGRADED: 'DEGRADED · recolha degradada' };
    text('quality', qualities[report.dataQuality] || 'Qualidade não comprovada');
    renderSignals(report);
    renderMvp(report);
    const observations = Array.isArray(report.observations) ? report.observations : [];
    const blockedAddresses = new Set((Array.isArray(report.screening?.entries) ? report.screening.entries : [])
      .filter(entry => entry?.status === 'BLOCKED' && typeof entry.address === 'string')
      .map(entry => entry.address.toLowerCase()));
    const addresses = observations.map(item => item?.address).filter(value => typeof value === 'string'
      && /^0x[0-9a-f]{40}$/i.test(value) && !blockedAddresses.has(value.toLowerCase()));
    text('token', addresses.length ? addresses.join(' · ') : 'Nenhum contrato para apresentar nesta recolha');
    const coverage = report.coverage;
    const range = coverage?.recentRange;
    if (Array.isArray(range) && range.length === 2 && range.every(integer)) {
      let value = `Blocos ${numberFormat.format(range[0])}–${numberFormat.format(range[1])}`;
      if (integer(coverage.recentBacklogBlocks)) value += ` · ${numberFormat.format(coverage.recentBacklogBlocks)} blocos por recuperar`;
      text('coverage', value);
    } else text('coverage', 'Cobertura não disponível');
  }

  function renderStatus() {
    renderEntryFreshness();
    renderSignals(lastReport);
    if (lastReport) {
      text('strict-new', pipelineStatus(lastReport, 'new'));
      text('strict-established', pipelineStatus(lastReport, 'established'));
    }
    const now = Date.now();
    const headTime = lastReport?.observedHead?.timestamp;
    const headAge = typeof headTime === 'number' ? now - headTime * 1000 : NaN;
    const reportTime = timestamp(lastReport?.capturedAt);
    const successTime = timestamp(lastHealth?.payload?.lastSuccessAt);
    const latestFresh = lastReport?.dataStale === false && Number.isFinite(headAge) && headAge >= -30000 && headAge <= 60000
      && Number.isFinite(reportTime) && now - reportTime >= -30000 && now - reportTime <= 90000;
    const health = lastHealth?.payload;
    const healthFresh = lastHealth?.ok === true && health?.stale === false && !health.lastError
      && ['COMPLETED', 'RUNNING'].includes(health.status) && Number.isFinite(successTime)
      && now - successTime >= -30000 && now - successTime <= 360000;
    let label = 'A aguardar dados';
    let detail = 'Ainda não foi possível confirmar uma recolha recente.';
    let tone = 'pending';
    if (requestFailed || navigator.onLine === false) {
      label = 'Não foi possível confirmar a atualização';
      detail = 'A consulta ao serviço falhou. Os últimos dados recebidos continuam visíveis, com a hora original.';
      tone = 'error';
    } else if (health?.status === 'ERROR' || health?.status === 'ABANDONED' || health?.lastError) {
      label = 'Recolha com erro';
      const code = typeof health.lastError === 'string' && /^[A-Z0-9_]{1,64}$/.test(health.lastError) ? ` (${health.lastError})` : '';
      detail = `O servidor reportou uma falha${code}. A próxima execução automática voltará a tentar.`;
      tone = 'error';
    } else if (latestFresh && healthFresh) {
      label = 'Recolha automática ativa';
      detail = 'O serviço confirmou dados recentes. A recolha automática tem intervalo variável; esta vista consulta a cada 30 segundos.';
      tone = 'good';
    } else if (lastReport || health) {
      label = 'A aguardar uma recolha recente';
      detail = 'Os dados recebidos ainda não permitem confirmar uma cabeça recente. A hora da recolha mantém-se visível.';
    }
    text('status', label);
    text('status-detail', detail);
    ui.status.dataset.tone = tone;
    text('poll-state', document.hidden ? 'Pausada nesta vista · retoma ao voltar à página'
      : navigator.onLine === false ? 'Sem ligação · retoma quando a ligação voltar'
        : 'A cada 30 segundos enquanto a página está visível');
  }

  async function getJSON(path) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        headers: { accept: 'application/json' } });
      const payload = await response.json();
      if (!validObject(payload)) throw new Error('INVALID_RESPONSE');
      return { ok: response.ok, status: response.status, payload };
    } finally { clearTimeout(timeout); }
  }

  function schedule() {
    clearTimeout(timer);
    if (!document.hidden && navigator.onLine !== false) timer = setTimeout(() => update(), POLL_MS);
  }

  async function update() {
    if (pending) return;
    if (document.hidden || navigator.onLine === false) { renderStatus(); schedule(); return; }
    pending = true;
    ui.refresh.disabled = true;
    ui.refresh.textContent = 'A consultar…';
    const previousRun = lastReport?.runId;
    try {
      const [healthResult, latestResult] = await Promise.allSettled([getJSON('/health'), getJSON('/latest')]);
      const health = healthResult.status === 'fulfilled' ? healthResult.value : null;
      const latest = latestResult.status === 'fulfilled' ? latestResult.value : null;
      const validHealth = health && typeof health.payload.status === 'string';
      const validLatest = latest?.ok === true && typeof latest.payload.runId === 'string'
        && Number.isFinite(timestamp(latest.payload.capturedAt)) && validObject(latest.payload.observedHead);
      if (validHealth) lastHealth = health;
      if (validLatest) { lastReport = latest.payload; renderReport(lastReport); }
      requestFailed = !validHealth || !validLatest;
      text('checked-at', dateFormat.format(Date.now()));
      if (requestFailed) text('check-result', 'Consulta incompleta ou sem resposta válida');
      else if (!health.ok) text('check-result', `O serviço reportou um erro (HTTP ${health.status})`);
      else text('check-result', previousRun && previousRun === lastReport.runId ? 'Consulta concluída · ainda sem nova recolha'
        : previousRun ? 'Nova recolha recebida' : 'Primeira recolha recebida');
    } finally {
      pending = false;
      ui.refresh.disabled = false;
      ui.refresh.textContent = 'Atualizar vista';
      renderStatus();
      schedule();
    }
  }

  ui.refresh.addEventListener('click', () => { clearTimeout(timer); update(); });
  ui['mvp-weekly-horizon'].addEventListener('change', () => renderWeeklyReport());
  ui['mvp-weekly-cohort'].addEventListener('change', () => renderWeeklyReport());
  ui['mvp-weekly-previous'].addEventListener('click', () => navigateWeeklyPage(-1));
  ui['mvp-weekly-next'].addEventListener('click', () => navigateWeeklyPage(1));
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    clearInterval(freshnessTimer);
    renderStatus();
    if (!document.hidden) { freshnessTimer = setInterval(renderStatus, 1000); update(); }
  });
  window.addEventListener('online', () => { renderStatus(); update(); });
  window.addEventListener('offline', () => { clearTimeout(timer); requestFailed = true; renderStatus(); });
  freshnessTimer = setInterval(renderStatus, 1000);
  update();
})();
