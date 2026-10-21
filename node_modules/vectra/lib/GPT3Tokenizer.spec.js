"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = require("node:assert");
const mocha_1 = require("mocha");
const GPT3Tokenizer_1 = require("../src/GPT3Tokenizer");
(0, mocha_1.describe)('GPT3Tokenizer', () => {
    const tokenizer = new GPT3Tokenizer_1.GPT3Tokenizer();
    (0, mocha_1.it)('encodes empty string to [] and decodes [] to empty string', () => {
        const tokens = tokenizer.encode('');
        node_assert_1.strict.deepEqual(tokens, [], 'encode("") should return []');
        const text = tokenizer.decode([]);
        node_assert_1.strict.equal(text, '', 'decode([]) should return empty string');
    });
    (0, mocha_1.it)('round-trips various strings including unicode and punctuation', () => {
        const samples = [
            'Hello, world!',
            'Café 😊 こんにちは 𠜎𠜱𠝹𠱓',
            'Newlines\nand\ttabs with   multiple   spaces.',
            '--- *** ===='
        ];
        for (const s of samples) {
            const tokens = tokenizer.encode(s);
            const decoded = tokenizer.decode(tokens);
            node_assert_1.strict.equal(decoded, s, `decode(encode(s)) should equal s for: ${JSON.stringify(s)}`);
            // Validate token array shape: array of non-negative integers
            node_assert_1.strict.ok(Array.isArray(tokens), 'encode should return an array');
            for (const t of tokens) {
                node_assert_1.strict.equal(typeof t, 'number', 'each token should be a number');
                node_assert_1.strict.ok(Number.isInteger(t), 'each token should be an integer');
                node_assert_1.strict.ok(t >= 0, 'each token should be non-negative');
            }
            // Encoding should be stable across calls for the same input
            const tokens2 = tokenizer.encode(s);
            node_assert_1.strict.deepEqual(tokens2, tokens, 'encode should be deterministic for the same input');
        }
    });
    (0, mocha_1.it)('produces non-empty tokens for typical non-empty input', () => {
        const s = 'This is a simple test.';
        const tokens = tokenizer.encode(s);
        node_assert_1.strict.ok(tokens.length > 0, 'expected some tokens for non-empty input');
        const decoded = tokenizer.decode(tokens);
        node_assert_1.strict.equal(decoded, s, 'decoded text should match original input');
    });
});
//# sourceMappingURL=GPT3Tokenizer.spec.js.map