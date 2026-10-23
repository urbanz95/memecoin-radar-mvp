import { activateCloudflare } from './activate-cloudflare.mjs';
process.exitCode = await activateCloudflare();
