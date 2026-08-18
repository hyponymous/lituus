// Vendored from kifu (https://github.com/hyponymous/kifu),
// test/sgf-parser.test.ts. Unmodified apart from this header and the explicit
// .ts import extension. Record any divergence in docs/reuse-notes.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, MAX_NODES, MAX_BYTES } from '../src/sgf-parser.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseOne(src: string) {
  const trees = parse(src);
  assert.equal(trees.length, 1);
  return trees[0];
}

function throws(src: string, pattern: RegExp) {
  assert.throws(() => parse(src), { message: pattern });
}

// ── Valid input ───────────────────────────────────────────────────────────────

test('minimal game tree', () => {
  const tree = parseOne('(;)');
  assert.equal(tree.nodes.length, 1);
  assert.deepEqual(tree.nodes[0].props, {});
  assert.equal(tree.variations.length, 0);
});

test('single node with properties', () => {
  const tree = parseOne('(;FF[4]GM[1]SZ[19])');
  const props = tree.nodes[0].props;
  assert.deepEqual(props.FF, ['4']);
  assert.deepEqual(props.GM, ['1']);
  assert.deepEqual(props.SZ, ['19']);
});

test('multiple nodes (a game)', () => {
  const tree = parseOne('(;FF[4];B[pd];W[dp];B[pp];W[dd])');
  assert.equal(tree.nodes.length, 5);
  assert.deepEqual(tree.nodes[1].props.B, ['pd']);
  assert.deepEqual(tree.nodes[2].props.W, ['dp']);
});

test('property with multiple values', () => {
  const tree = parseOne('(;AB[pd][qd][rd])');
  assert.deepEqual(tree.nodes[0].props.AB, ['pd', 'qd', 'rd']);
});

test('empty property value', () => {
  const tree = parseOne('(;C[])');
  assert.deepEqual(tree.nodes[0].props.C, ['']);
});

test('variations (nested trees)', () => {
  const tree = parseOne('(;FF[4];B[pd](;W[dp])(;W[pp]))');
  assert.equal(tree.variations.length, 2);
  assert.deepEqual(tree.variations[0].nodes[0].props.W, ['dp']);
  assert.deepEqual(tree.variations[1].nodes[0].props.W, ['pp']);
});

test('deeply nested variations', () => {
  const tree = parseOne('(;B[pd](;W[dp](;B[pp])(;B[fq]))(;W[pp]))');
  assert.equal(tree.variations.length, 2);
  assert.equal(tree.variations[0].variations.length, 2);
});

test('collection: multiple game trees', () => {
  const trees = parse('(;GM[1])(;GM[2])');
  assert.equal(trees.length, 2);
  assert.deepEqual(trees[0].nodes[0].props.GM, ['1']);
  assert.deepEqual(trees[1].nodes[0].props.GM, ['2']);
});

test('whitespace between tokens is ignored', () => {
  // Spaces between structural tokens (not inside values) are insignificant
  const tree = parseOne('(\n  ; FF[4]\n  ; B[pd]\n)');
  assert.deepEqual(tree.nodes[0].props.FF, ['4']);
  assert.deepEqual(tree.nodes[1].props.B, ['pd']);
});

// ── Escape sequences in values ────────────────────────────────────────────────

test('escaped closing bracket \\]', () => {
  const tree = parseOne('(;C[a\\]b])');
  assert.deepEqual(tree.nodes[0].props.C, ['a]b']);
});

test('escaped backslash \\\\', () => {
  const tree = parseOne('(;C[a\\\\b])');
  assert.deepEqual(tree.nodes[0].props.C, ['a\\b']);
});

test('other escaped characters pass through', () => {
  const tree = parseOne('(;C[\\n])');
  assert.deepEqual(tree.nodes[0].props.C, ['n']);
});

test('soft line break (\\\\n) is discarded', () => {
  const tree = parseOne('(;C[hello\\\nworld])');
  assert.deepEqual(tree.nodes[0].props.C, ['helloworld']);
});

test('soft line break (\\\\r\\\\n) is discarded', () => {
  const tree = parseOne('(;C[hello\\\r\nworld])');
  assert.deepEqual(tree.nodes[0].props.C, ['helloworld']);
});

// ── Line ending handling ──────────────────────────────────────────────────────

test('\\r\\n line endings count as one line', () => {
  // The error should report line 2, not line 3
  assert.throws(
    () => parse('(;\r\nB[pd]\r\nX'),
    (e: unknown) => {
      assert.match((e as Error).message, /line 3/);
      return true;
    }
  );
});

// ── Error messages include line and column ────────────────────────────────────

test('error includes line and column', () => {
  assert.throws(
    () => parse('(;\nB[pd]\nBAD'),
    (e: unknown) => {
      assert.match((e as Error).message, /line 3/);
      assert.match((e as Error).message, /col/);
      return true;
    }
  );
});

test('unterminated value reports correct position', () => {
  assert.throws(
    () => parse('(;C[unterminated)'),
    (e: unknown) => {
      assert.match((e as Error).message, /unterminated property value/);
      return true;
    }
  );
});

// ── Invalid input ─────────────────────────────────────────────────────────────

test('empty input', () => {
  throws('', /empty input/);
});

test('whitespace only', () => {
  throws('   \n  ', /empty input/);
});

test('missing opening paren', () => {
  throws(';B[pd]', /expected '\('/);
});

test('missing semicolon after paren', () => {
  throws('(B[pd])', /expected ';' to open first node/);
});

test('empty tree (no nodes)', () => {
  throws('()', /expected ';' to open first node/);
});

test('missing [ after property name', () => {
  throws('(;B pd)', /expected '\[' after property 'B'/);
});

test('unterminated property value', () => {
  throws('(;C[hello)', /unterminated property value/);
});

test('missing closing paren', () => {
  throws('(;B[pd]', /expected '\)', got end of input/);
});

test('trailing garbage', () => {
  throws('(;B[pd])garbage', /expected '\('/);
});

// ── Safety limits ─────────────────────────────────────────────────────────────

test('input exceeding MAX_BYTES is rejected', () => {
  const big = '(;C[' + 'a'.repeat(MAX_BYTES) + '])';
  assert.throws(() => parse(big), /too large/);
});

test('exceeding MAX_NODES is rejected', () => {
  const nodes = ';B[aa]'.repeat(MAX_NODES + 1);
  assert.throws(() => parse(`(${nodes})`), /too many nodes/);
});
