import assert from 'node:assert';
import { readFileSync } from 'node:fs';

// Testar den riktiga funktionen i scanner.html, inte en kopia
const html = readFileSync(new URL('./public/scanner.html', import.meta.url), 'utf8');
const extractRunnerId = new Function(html.match(/function extractRunnerId[\s\S]*?\n}/)[0] + '; return extractRunnerId;')();

assert.strictEqual(extractRunnerId('https://tid.app/l/42'), '42');
assert.strictEqual(extractRunnerId('https://tid.app/l/42\n'), '42');
assert.strictEqual(extractRunnerId('https://tid.app/l/42/'), '42');
assert.strictEqual(extractRunnerId('https://tid.app/l/42?utm=x'), '42');
assert.strictEqual(extractRunnerId('https://tid.app/scan/ab12cd34'), null);
assert.strictEqual(extractRunnerId('42'), '42');
assert.strictEqual(extractRunnerId('not-a-url'), 'not-a-url');

console.log('ok');
