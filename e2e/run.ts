import { runTests } from '@vscode/test-electron';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

(async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'branchline-e2e-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'E2E');
  git('config', 'user.email', 'e2e@example.com');
  writeFileSync(join(repo, 'a.txt'), 'hello\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  writeFileSync(join(repo, 'a.txt'), 'hello world\n');

  await runTests({
    extensionDevelopmentPath: resolve(__dirname, '../..'),
    extensionTestsPath: resolve(__dirname, 'suite.js'),
    launchArgs: [repo, '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
  });
})().catch(err => {
  console.error(err);
  process.exit(1);
});
