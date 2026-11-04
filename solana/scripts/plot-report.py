"""Optional report export: Python + matplotlib, never required by the scanner."""
import argparse
import datetime as dt
import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import ScalarFormatter

parser = argparse.ArgumentParser(description="Plot a completed, real Mainnet soak report")
parser.add_argument("report", type=Path)
parser.add_argument("output_prefix", type=Path)
args = parser.parse_args()
report = json.loads(args.report.read_text())
if report.get("dataMode") != "REAL_MAINNET_LIVE" or report.get("reason") != "DURATION_COMPLETED":
    raise ValueError("A completed real Mainnet report is required; fixture replay is not a live benchmark")
started = dt.datetime.fromisoformat(report["startedAt"].replace("Z", "+00:00"))
samples = report["samples"] + [report["final"]]
minutes = [(dt.datetime.fromisoformat(s["metrics"]["measuredAt"].replace("Z", "+00:00")) - started).total_seconds() / 60 for s in samples]

def latency(name):
    values = [s["metrics"].get("histograms", {}).get(name, {}).get("p95") for s in samples]
    return [v / 1000 if isinstance(v, (int, float)) and v > 0 else float("nan") for v in values]

plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False})
fig, axes = plt.subplots(3, 1, figsize=(11, 9), sharex=True, constrained_layout=True)
axes[0].plot(minutes, latency("logObservationLatencyMs"), color="#16708d", label="Logs: observações parciais")
axes[0].plot(minutes, latency("eventProcessingLatencyMs"), color="#b64b29", label="Eventos enriquecidos")
axes[0].axhline(2, color="#666666", linestyle="--", linewidth=1, label="Objetivo experimental: 2 s")
axes[0].set_yscale("log")
axes[0].yaxis.set_major_formatter(ScalarFormatter())
axes[0].set_ylabel("p95 local (s, escala log)")
axes[0].legend(loc="upper left", fontsize=9)
axes[0].set_title("Solana Mainnet — ensaio operacional real\nPercentis recentes de até 4096 amostras; os caminhos têm completude diferente", loc="left", fontsize=13)
axes[1].plot(minutes, [s["metrics"]["rpcRequestsPerMinute"] for s in samples], color="#53498d")
axes[1].set_ylabel("Pedidos RPC / 60 s")
axes[2].plot(minutes, [s["storage"]["storageBytes"] / 1024**2 for s in samples], color="#357447")
axes[2].set_ylabel("SQLite + WAL/SHM (MiB)")
axes[2].set_xlabel("Minutos desde o início do processo")
for axis in axes:
    axis.grid(axis="y", alpha=0.18)
    axis.set_xlim(0, max(minutes))
final = report["final"]["metrics"]
summary = final["histograms"].get("logObservationLatencyMs", {})
upper = summary.get("cumulativeQuantileUpperBounds", {}).get("p95")
fig.suptitle(f"Duração: {report['elapsedSeconds'] / 60:.2f} min | p95 acumulada de logs: limite superior {upper} ms (buckets)\nMáximo local de logs: {summary.get('totalMaxMs')} ms | Reconexões: {final['counters'].get('reconnect_count', 0)} | Sem garantia de cobertura total", fontsize=10)
args.output_prefix.parent.mkdir(parents=True, exist_ok=True)
for extension in ("png", "svg"):
    fig.savefig(args.output_prefix.with_suffix("." + extension), dpi=170)
    if extension == "svg":
        target = args.output_prefix.with_suffix(".svg")
        target.write_text("\n".join(line.rstrip() for line in target.read_text().splitlines()) + "\n")
plt.close(fig)
print(json.dumps({"dataMode": report["dataMode"], "elapsedSeconds": report["elapsedSeconds"], "exports": [str(args.output_prefix.with_suffix("." + e)) for e in ("png", "svg")]}))
