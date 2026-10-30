import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

if (existsSync('ui/package.json')) {
  execFileSync('npm', ['--prefix', 'ui', 'run', 'build'], { stdio: 'inherit' });
}

const common = { bundle: true, platform: 'node', target: 'node24', packages: 'external', sourcemap: true };
await Promise.all([
  build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist/electron/main.cjs', format: 'cjs' }),
  build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist/electron/preload.cjs', format: 'cjs' }),
  build({ ...common, entryPoints: ['src/server/index.ts'], outfile: 'dist/server/server.mjs', format: 'esm' }),
  build({ ...common, entryPoints: ['src/mcp/server.ts'], outfile: 'dist/mcp.mjs', format: 'esm' }),
  build({ ...common, entryPoints: ['src/cli/hwped.ts'], outfile: 'dist/hwped.mjs', format: 'esm' }),
]);
await Promise.all(['dist', 'dist/server'].map(async dir => {
  await mkdir(`${dir}/template`, { recursive: true });
  await copyFile('src/core/template/blank.hwpx', `${dir}/template/blank.hwpx`);
}));
