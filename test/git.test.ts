import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, renameSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git, parseNameStatus, parseNumstat, countStatusEntries } from '../src/git';

let dir: string;
let git: Git;

async function commit(file: string, content: string, msg: string) {
  writeFileSync(join(dir, file), content);
  await git.run(['add', '-A']);
  await git.run(['commit', '-q', '-m', msg]);
  return (await git.run(['rev-parse', 'HEAD'])).trim();
}

before(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'branchline-test-')));
  git = new Git(dir);
  await git.run(['init', '-q', '-b', 'main']);
  await git.run(['config', 'user.name', 'Test User']);
  await git.run(['config', 'user.email', 'test@example.com']);
  await git.run(['config', 'commit.gpgsign', 'false']);
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('empty repository has no commits and no head', async () => {
  assert.deepEqual(await git.log({ skip: 0, count: 10, allRefs: true }), []);
  const state = await git.state();
  assert.equal(state.head, null);
  assert.equal(state.branch, 'main');
});

test('log, refs, details and diffs on a branched history', async () => {
  const a = await commit('a.txt', 'one\n', 'first');
  await git.run(['checkout', '-q', '-b', 'feature']);
  const f = await commit('f.txt', 'feature\n', 'feature work');
  await git.run(['checkout', '-q', 'main']);
  await commit('a.txt', 'one\ntwo\n', 'second\n\nwith a body');
  await git.run(['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature']);
  await git.run(['tag', '-a', 'v1', '-m', 'release']);

  const log = await git.log({ skip: 0, count: 50, allRefs: true });
  assert.equal(log.length, 4);
  assert.equal(log[0].subject, 'merge feature');
  assert.equal(log[0].parents.length, 2);
  assert.equal(log[0].author, 'Test User');
  assert.equal(log.at(-1)!.hash, a);

  const paged = await git.log({ skip: 1, count: 2, allRefs: true });
  assert.deepEqual(paged.map(c => c.hash), log.slice(1, 3).map(c => c.hash));

  const history = await git.log({ skip: 0, count: 50, allRefs: true, path: 'a.txt' });
  assert.deepEqual(history.map(c => c.subject), ['second', 'first'], 'only commits touching the path');
  assert.deepEqual(history[0].parents, [a], 'parents are rewritten to the previous commit touching the path');

  const found = await git.log({ skip: 0, count: 50, allRefs: true, search: 'FEATURE WORK' });
  assert.deepEqual(found.map(c => c.hash), [f]);

  const state = await git.state();
  assert.equal(state.branch, 'main');
  assert.equal(state.head, log[0].hash);
  const tag = state.refs.find(r => r.type === 'tag')!;
  assert.equal(tag.name, 'v1');
  assert.equal(tag.hash, log[0].hash, 'annotated tag is peeled to the commit');
  assert.deepEqual(state.refs.filter(r => r.type === 'head').map(r => r.name).sort(), ['feature', 'main']);

  const second = log.find(c => c.subject === 'second')!;
  const d = await git.details(second.hash);
  assert.equal(d.body, 'with a body');
  assert.deepEqual(d.files, [{ status: 'M', path: 'a.txt', additions: 1, deletions: 0 }]);

  const root = await git.details(a);
  assert.deepEqual(root.files.map(x => [x.status, x.path]), [['A', 'a.txt']]);

  assert.equal(await git.show(a, 'a.txt'), 'one\n');
  assert.equal(await git.show(a, 'missing.txt'), '');
});

test('detects the commit-graph cache', async () => {
  assert.equal(await git.hasCommitGraph(), false);
  await git.run(['commit-graph', 'write', '--reachable']);
  assert.equal(await git.hasCommitGraph(), true);
});

test('working tree changes include renames and untracked files', async () => {
  renameSync(join(dir, 'f.txt'), join(dir, 'g.txt'));
  await git.run(['add', '-A']);
  writeFileSync(join(dir, 'new.txt'), 'x');
  const state = await git.state();
  assert.equal(state.dirty, 2);
  const files = await git.changes(null, null);
  assert.deepEqual(files.map(x => [x.status, x.path, x.oldPath]).sort(), [
    ['R', 'g.txt', 'f.txt'],
    ['U', 'new.txt', undefined],
  ]);
});

test('lists stashes with their base commit', async () => {
  const head = (await git.run(['rev-parse', 'HEAD'])).trim();
  await git.run(['stash', 'push', '-q', '-m', 'wip: experiment']);
  const stashes = await git.stashes();
  assert.equal(stashes.length, 1);
  assert.equal(stashes[0].selector, 'stash@{0}');
  assert.equal(stashes[0].base, head);
  assert.deepEqual(stashes[0].parents, [head], 'only the base parent is kept for the graph');
  assert.match(stashes[0].subject, /wip: experiment/);
  assert.ok(!(await git.state()).refs.some(r => r.type === 'stash'), 'stash is shown as a row, not a ref badge');
  await git.run(['stash', 'pop', '-q']);
});

test('parsers handle rename records', () => {
  assert.deepEqual(parseNameStatus('R100\0old name.txt\0new name.txt\0M\0b.txt\0'), [
    { status: 'R', oldPath: 'old name.txt', path: 'new name.txt' },
    { status: 'M', path: 'b.txt' },
  ]);
  const stats = parseNumstat('3\t1\t\0old.txt\0new.txt\0-\t-\timg.png\0');
  assert.deepEqual(stats.get('new.txt'), { additions: 3, deletions: 1 });
  assert.deepEqual(stats.get('img.png'), { additions: undefined, deletions: undefined });
  assert.equal(countStatusEntries('R  new.txt\0old.txt\0?? x\0 M y z\0'), 3);
});
