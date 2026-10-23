# Worker Linux opcional para uma máquina já existente

A opção principal sem cartão é [Cloudflare Workers Free + D1](FREE-HOSTING.md). Este worker é uma alternativa se já existir Linux com disco persistente. Recolhe reservas/swaps além da descoberta e metadados do adaptador pequeno. Não foi instalado num servidor remoto.

## Instalação

Requisitos: Linux com systemd, `flock` (util-linux), Node >=22 e npm em `/usr/local/bin` ou `/usr/bin`. A unidade usa heap Node de 768 MB e limite total de 1 GB; reservar pelo menos 2 GB de RAM na máquina.

Transferir o ZIP, descomprimir e rever o instalador. Na pasta do projeto:

```sh
sudo bash deploy/install-worker.sh
sudo systemctl status memecoin-radar --no-pager
sudo journalctl -u memecoin-radar -n 30 --no-pager
sudo -u memecoin-radar env RADAR_DATA_DIR=/var/lib/memecoin-radar node /opt/memecoin-radar/src/worker/health.mjs
```

O instalador cria utilizador sem login, coloca código root-owned em `/opt/memecoin-radar`, instala dependências do lockfile sem scripts, valida a política, prepara o diretório persistente e ativa systemd. Numa atualização, para o serviço primeiro e preserva os dados/configuração.

Configuração privada em `/etc/memecoin-radar.env`:

```text
RADAR_DATA_DIR=/var/lib/memecoin-radar
RADAR_POLL_SECONDS=60
RADAR_RETENTION_DAYS=7
RADAR_MAX_ARCHIVE_BYTES=8589934592
```

`ROBINHOOD_RPC_URL` é opcional; sem ela usa-se o RPC público oficial, sem SLA nem garantia de archive/traces. Não configurar fornecedor pago. Depois de alterar a configuração: `sudo systemctl restart memecoin-radar`.

Para desenvolvimento, sem instalar serviço:

```sh
npm run worker -- --once
npm run worker
npm run worker:health
```

Esse modo termina quando o processo/computador é desligado. O worker usa `runtime/worker/`, separado de `runtime/onchain/` da CLI manual. Não correr os dois no mesmo diretório. Não executar o módulo mjs diretamente: o wrapper é que adquire `flock`.

## Limites e recuperação

Cada sessão tem prazo de 240s, 4 contratos, até 2 pools por contrato, 800 pedidos RPC, timeout individual 12s e um retry. O período alvo entre arranques é 60s, sem sobreposição; há pelo menos 5s após uma sessão longa e 15s após erro. A rotação dos contratos não garante que todos sejam revistos por minuto. TTL e filtros de segurança mantêm-se.

O kernel liberta o lock após SIGKILL/reboot. systemd usa Restart=always e arranque no boot; isso não recupera uma máquina que o fornecedor retire. Evidência gzip precede o commit de latest.json, com fsync/rename. Erros/interrupções preservam o catálogo confirmado e reiniciam confirmação. Estado corrompido interrompe o processo. Temporários abandonados são removidos na retoma.

Retenção: arquivos com mais de 7 dias são elegíveis para remoção e o orçamento de arquivos é 8 GiB. Arquivos antigos sem referências podem sair antes para caber nesse limite. Estado atual e provas referenciadas em cache ficam protegidos. Se o orçamento estiver ocupado por dados protegidos, a recolha sinaliza erro; não apaga as provas para criar espaço. Exige também reserva de 512 MiB livre no filesystem. Há limite de 64 MiB para JSON de estado e 128 MiB por documento de evidência antes de comprimir.

worker-status.json guarda horários, resumo e retenção. O comando de saúde sinaliza ABANDONED após interrupção e STALE sem sucesso há mais de 6 minutos. Não há monitorização externa nem backup remoto automático. Consultar logs e fazer backup dos dados importantes.

Onze testes locais verificam persistência, retoma, confirmação, falha, concorrência, estado corrompido, abort, saúde, retenção/orçamento e temporários. Um teste real entre processos confirma exclusão por flock e recuperação após SIGKILL. Os requisitos e syntax do instalador foram revistos; instalação/boot num servidor real ainda precisam de validação.
