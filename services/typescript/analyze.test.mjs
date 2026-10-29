import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from './analyze.mjs';

test('resolves imported aliases and methods without guessing by name', () => {
  const result = analyze([
    { path: 'entry.ts', content: `import { Service as Renamed } from './service'; export function main() { const service = new Renamed(); return service.run(); }` },
    { path: 'service.ts', content: `export class Service { run() { return 42; } } export function unrelated() { return unknown.run(); }` },
  ]);
  const main = result.nodes.find(n => n.name === 'main');
  const run = result.nodes.find(n => n.name === 'run');
  const service = result.nodes.find(n => n.name === 'Service');
  const unrelated = result.nodes.find(n => n.name === 'unrelated');
  assert.ok(result.edges.some(e => e.source === main.id && e.target === run.id && e.kind === 'calls'));
  assert.ok(result.edges.some(e => e.source === main.id && e.target === service.id && e.kind === 'calls'));
  assert.ok(!result.edges.some(e => e.source === unrelated.id && e.target === run.id));
});

test('preserves recursion and exact source spans', () => {
  const result = analyze([{ path: 'loop.ts', content: '/** Recursive entry. */\nexport function main(n: number) { return n ? main(n - 1) : 0; }' }]);
  const node = result.nodes[0];
  assert.equal(node.startLine, 2);
  assert.equal(node.description, 'Recursive entry.');
  assert.ok(result.edges.some(e => e.source === node.id && e.target === node.id));
});

test('attributes deferred callback calls to the callback and preserves function references', () => {
  const result = analyze([{ path: 'index.ts', content: `function target() {} function register(cb: () => void) {} export default function main() { register(() => target()); register(target); }` }]);
  const main = result.nodes.find(n => n.name === 'main'), target = result.nodes.find(n => n.name === 'target');
  const callback = result.nodes.find(n => n.name.startsWith('callback'));
  assert.ok(callback);
  assert.ok(main.entry);
  assert.ok(result.edges.some(e => e.source === callback.id && e.target === target.id && e.kind === 'calls'));
  assert.ok(!result.edges.some(e => e.source === main.id && e.target === target.id && e.kind === 'calls'));
  assert.ok(result.edges.some(e => e.source === main.id && e.target === target.id && e.kind === 'references'));
});

test('indexes cyclic local imports without executing their code', () => {
  const result = analyze([
    { path: 'a.ts', content: `import { b } from './b'; throw new Error('MUST NOT EXECUTE'); export function a() { return b(); }` },
    { path: 'b.ts', content: `import { a } from './a'; export function b() { return a(); }` },
  ]);
  assert.equal(result.nodes.filter(n => n.kind === 'function').length, 2);
  assert.equal(result.edges.filter(e => e.kind === 'calls').length, 2);
  assert.equal(result.edges.filter(e => e.kind === 'imports').length, 2);
});
