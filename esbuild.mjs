import * as esbuild from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'warning' };

if (args.has('--tests')) {
  rmSync('dist-test', { recursive: true, force: true });
  await esbuild.build({
    ...common,
    entryPoints: readdirSync('test').filter(f => f.endsWith('.test.ts')).map(f => `test/${f}`),
    outdir: 'dist-test',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  process.exit(0);
}

const builds = [
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'] },
  { entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife' },
  { entryPoints: ['webview/style.css'], outfile: 'dist/webview.css' },
];

if (args.has('--watch')) {
  for (const b of builds) await (await esbuild.context({ ...common, ...b })).watch();
} else {
  await Promise.all(builds.map(b => esbuild.build({ ...common, ...b })));
}
