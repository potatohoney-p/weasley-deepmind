import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../../lib/cli/parseArgs.js';

describe('parseArgs', () => {
  it('returns empty positional array for no args', () => {
    const result = parseArgs([]);
    assert.deepStrictEqual(result, { _: [] });
  });

  it('collects positional arguments', () => {
    const result = parseArgs(['hello', 'world']);
    assert.deepStrictEqual(result._, ['hello', 'world']);
  });

  it('parses boolean flag', () => {
    const result = parseArgs(['--flag']);
    assert.strictEqual(result.flag, true);
  });

  it('parses key-value pair', () => {
    const result = parseArgs(['--key', 'value']);
    assert.strictEqual(result.key, 'value');
  });

  it('parses consecutive boolean flags', () => {
    const result = parseArgs(['--json', '--verbose']);
    assert.strictEqual(result.json, true);
    assert.strictEqual(result.verbose, true);
  });

  it('parses mixed positional, key-value, and boolean flags', () => {
    const result = parseArgs([
      'recall', 'query', '--topic', 'test', '--limit', '5', '--json',
    ]);
    assert.deepStrictEqual(result._, ['recall', 'query']);
    assert.strictEqual(result.topic, 'test');
    assert.strictEqual(result.limit, '5');
    assert.strictEqual(result.json, true);
  });
});
