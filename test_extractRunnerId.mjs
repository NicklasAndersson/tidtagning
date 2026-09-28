import assert from 'node:assert';

function extractRunnerId(text) {
  const m = text.match(/\/(\d+)\s*$/);
  return m ? m[1] : text;
}

assert.strictEqual(extractRunnerId('https://tid.app/l/42'), '42');
assert.strictEqual(extractRunnerId('https://tid.app/l/42\n'), '42');
assert.strictEqual(extractRunnerId('not-a-url'), 'not-a-url');

console.log('ok');
