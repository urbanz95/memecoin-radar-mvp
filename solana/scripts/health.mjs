const port = process.env.SOLANA_HEALTH_PORT ?? 8787;
try {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Error(`HTTP_${response.status}`);
  const value = await response.json();
  console.log(JSON.stringify(value, null, 2));
  if (value.status !== "OBSERVING") process.exitCode = 2;
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
