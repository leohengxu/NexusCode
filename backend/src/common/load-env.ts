import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';

// Load .env before modules read process.env (for example LLM_MAX_TOKENS at import time).
try {
  loadEnvFile(resolve(process.cwd(), '.env'));
} catch (error: any) {
  if (error?.code !== 'ENOENT') {
    console.warn(`[Config] 无法加载 .env: ${error?.message || error}`);
  }
}
