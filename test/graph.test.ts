import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphLayout, GraphCommit, RowLayout } from '../src/graph';

function layout(commits: GraphCommit[]): RowLayout[] {
  const g = new GraphLayout();
  return commits.map(c => g.add(c));
}

const seg = (r: RowLayout, half: 'top' | 'bottom') =>
  r.segments.filter(s => s.half === half).map(s => [s.from, s.to]).sort();

test('linear history stays in one column', () => {
  const rows = layout([
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ]);
  assert.deepEqual(rows.map(r => r.col), [0, 0, 0]);
  assert.deepEqual(seg(rows[0], 'top'), []);
  assert.deepEqual(seg(rows[1], 'top'), [[0, 0]]);
  assert.deepEqual(seg(rows[2], 'bottom'), [], 'root commit has no line below');
  assert.ok(rows.every(r => r.color === rows[0].color));
});

test('merge opens a lane for the second parent and closes it at the fork point', () => {
  //  m        merge of b1 (main) and f1 (feature)
  //  |\
  //  | f1
  //  b1 |
  //  |/
  //  a
  const rows = layout([
    { hash: 'm', parents: ['b1', 'f1'] },
    { hash: 'f1', parents: ['a'] },
    { hash: 'b1', parents: ['a'] },
    { hash: 'a', parents: [] },
  ]);
  assert.deepEqual(rows.map(r => r.col), [0, 1, 0, 0]);
  assert.deepEqual(seg(rows[0], 'bottom'), [[0, 0], [0, 1]]);
  assert.deepEqual(seg(rows[1], 'top'), [[0, 0], [1, 1]]);
  // a is expected by two lanes; both converge into column 0
  assert.deepEqual(seg(rows[3], 'top'), [[0, 0], [1, 0]]);
  assert.equal(rows[3].width, 2);
  assert.notEqual(rows[1].color, rows[0].color, 'feature lane gets its own color');
});

test('two branch tips get separate columns and reuse freed slots', () => {
  const rows = layout([
    { hash: 'x', parents: ['a'] }, // tip of branch x
    { hash: 'y', parents: ['a'] }, // tip of branch y, not a child of x
    { hash: 'a', parents: [] },
    { hash: 'z', parents: [] }, // unrelated root after everything closed
  ]);
  assert.deepEqual(rows.map(r => r.col), [0, 1, 0, 0]);
});

test('merge parent already on screen joins the existing lane', () => {
  const rows = layout([
    { hash: 'f', parents: ['b'] }, // feature tip, lane 0 expects b
    { hash: 'm', parents: ['c', 'b'] }, // merge whose second parent b is already expected
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: [] },
  ]);
  assert.equal(rows[1].col, 1);
  assert.deepEqual(seg(rows[1], 'bottom'), [[0, 0], [1, 0], [1, 1]]);
  assert.equal(rows[1].width, 2, 'no third lane opened');
});

test('octopus merge opens one lane per extra parent', () => {
  const rows = layout([
    { hash: 'o', parents: ['a', 'b', 'c'] },
    { hash: 'c', parents: [] },
    { hash: 'b', parents: [] },
    { hash: 'a', parents: [] },
  ]);
  assert.deepEqual(seg(rows[0], 'bottom'), [[0, 0], [0, 1], [0, 2]]);
  assert.deepEqual(rows.map(r => r.col), [0, 2, 1, 0]);
});

test('layout continues correctly across pages', () => {
  const all: GraphCommit[] = [
    { hash: 'm', parents: ['b', 'f'] },
    { hash: 'f', parents: ['a'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ];
  const whole = layout(all);
  const g = new GraphLayout();
  const paged = [...all.slice(0, 2).map(c => g.add(c)), ...all.slice(2).map(c => g.add(c))];
  assert.deepEqual(paged, whole);
});
