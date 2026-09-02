// Load .env file for API keys
// Searches: project root .env first, then apis/.env as fallback
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const paths = [
  resolve(__dirname, '..', '..', '.env'), // project root
  resolve(__dirname, '..', '.env'),        // apis/.env (legacy)
];

/**
 * Parse .env text into a plain object.
 * Tolerates `export KEY=value`, and strips one matching pair of surrounding
 * single or double quotes from the value (so `KEY="a b"` yields `a b`).
 */
export function parseEnv(content) {
  const out = {};
  for (const line of String(content).split('\n')) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^export\s+/.test(trimmed)) trimmed = trimmed.replace(/^export\s+/, '');
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val.at(-1) === val[0]) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadEnv(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch { return -1; }
  let loaded = 0;
  for (const [key, val] of Object.entries(parseEnv(content))) {
    if (!process.env[key]) { process.env[key] = val; loaded++; }
  }
  return loaded;
}

for (const p of paths) {
  if (loadEnv(p) >= 0) break;
}
