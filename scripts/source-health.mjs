#!/usr/bin/env node
// Local setup check. Never prints credential values or makes API requests.
import '../apis/utils/env.mjs';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
console.log(`Crucix dependency check (Node ${process.version}; required ${pkg.engines.node})`);
if (Number(process.versions.node.split('.')[0]) < 22) process.exitCode = 1;
for (const [group, optional] of [[pkg.dependencies, false], [pkg.optionalDependencies, true]]) {
  for (const name of Object.keys(group || {})) {
    try {
      await import(name);
      console.log(`  ${name}: OK${optional ? ' (optional)' : ''}`);
    } catch {
      console.log(`  ${name}: missing or unable to import${optional ? ' (optional)' : ''}`);
      if (!optional) process.exitCode = 1;
    }
  }
}

console.log('\nSource credentials (values hidden):');
for (const [name, keys] of Object.entries({
  ACLED: ['ACLED_EMAIL', 'ACLED_PASSWORD'],
  Reddit: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
  'Cloudflare Radar': ['CLOUDFLARE_API_TOKEN'],
  Maritime: ['AISSTREAM_API_KEY'],
  FIRMS: ['FIRMS_MAP_KEY'], FRED: ['FRED_API_KEY'], EIA: ['EIA_API_KEY'],
})) {
  const missing = keys.filter(key => !process.env[key]);
  console.log(`  ${name}: ${missing.length ? `missing ${missing.join(', ')}` : 'configured'}`);
}
console.log('  Maritime also requires an AIS collector; a key alone does not enable tracking.');
console.log('  Patents requires connector migration; no additional npm package fixes it.');

try {
  const snapshot = JSON.parse(await readFile(new URL('runs/latest.json', root), 'utf8'));
  console.log(`\nLast saved sweep: ${snapshot.crucix?.timestamp || 'unknown'}`);
  for (const item of snapshot.sourceHealth || []) console.log(`  ${item.n}: ${item.status}`);
  console.log('Saved results may predate code or credential changes. Restart Crucix and allow a new sweep.');
} catch {
  console.log('\nNo readable sweep snapshot yet. Start Crucix to collect source health.');
}
