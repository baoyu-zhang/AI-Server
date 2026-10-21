"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = require("node:assert");
const mocha_1 = require("mocha");
const TransformersTokenizer_1 = require("./TransformersTokenizer");
(0, mocha_1.describe)('TransformersTokenizer', () => {
    // Create a mock tokenizer that mimics Transformers.js behavior
    function createMockTokenizer() {
        const vocab = new Map([
            ['hello', 101],
            ['world', 102],
            ['test', 103],
            ['[CLS]', 1],
            ['[SEP]', 2]
        ]);
        const reverseVocab = new Map();
        vocab.forEach((v, k) => reverseVocab.set(v, k));
        return {
            // Mimics the callable tokenizer behavior
            __call__: (text) => {
                const words = text.toLowerCase().split(/\s+/).filter(w => w);
                const ids = words.map(w => { var _a; return (_a = vocab.get(w)) !== null && _a !== void 0 ? _a : 100; });
                return {
                    input_ids: {
                        data: BigInt64Array.from(ids.map(id => BigInt(id)))
                    }
                };
            },
            decode: (tokens, options) => {
                const words = tokens
                    .filter(t => !(options === null || options === void 0 ? void 0 : options.skip_special_tokens) || (t !== 1 && t !== 2))
                    .map(t => { var _a; return (_a = reverseVocab.get(t)) !== null && _a !== void 0 ? _a : '[UNK]'; });
                return words.join(' ');
            }
        };
    }
    (0, mocha_1.it)('encodes text to token array using callable tokenizer', () => {
        const mockTokenizer = createMockTokenizer();
        // Make it callable
        const callableTokenizer = Object.assign((text) => mockTokenizer.__call__(text), { decode: mockTokenizer.decode });
        const tokenizer = new TransformersTokenizer_1.TransformersTokenizer(callableTokenizer);
        const tokens = tokenizer.encode('hello world');
        node_assert_1.strict.ok(Array.isArray(tokens), 'encode should return an array');
        node_assert_1.strict.equal(tokens.length, 2, 'should have 2 tokens');
        node_assert_1.strict.deepEqual(tokens, [101, 102], 'tokens should match expected values');
    });
    (0, mocha_1.it)('handles BigInt64Array conversion correctly', () => {
        const mockTokenizer = {
            __call__: () => ({
                input_ids: {
                    data: BigInt64Array.from([BigInt(1), BigInt(2), BigInt(3)])
                }
            }),
            decode: () => 'decoded'
        };
        const callableTokenizer = Object.assign(() => mockTokenizer.__call__(), { decode: mockTokenizer.decode });
        const tokenizer = new TransformersTokenizer_1.TransformersTokenizer(callableTokenizer);
        const tokens = tokenizer.encode('any text');
        node_assert_1.strict.deepEqual(tokens, [1, 2, 3], 'should convert BigInt to number');
        tokens.forEach(t => {
            node_assert_1.strict.equal(typeof t, 'number', 'each token should be a number');
        });
    });
    (0, mocha_1.it)('decodes tokens back to text', () => {
        const mockTokenizer = {
            __call__: () => ({ input_ids: { data: BigInt64Array.from([]) } }),
            decode: (tokens, opts) => {
                if (opts === null || opts === void 0 ? void 0 : opts.skip_special_tokens) {
                    return 'hello world';
                }
                return '[CLS] hello world [SEP]';
            }
        };
        const callableTokenizer = Object.assign(() => mockTokenizer.__call__(), { decode: mockTokenizer.decode });
        const tokenizer = new TransformersTokenizer_1.TransformersTokenizer(callableTokenizer);
        const text = tokenizer.decode([1, 101, 102, 2]);
        node_assert_1.strict.equal(text, 'hello world', 'should decode with skip_special_tokens=true');
    });
    (0, mocha_1.it)('handles empty input', () => {
        const mockTokenizer = {
            __call__: () => ({
                input_ids: { data: BigInt64Array.from([]) }
            }),
            decode: () => ''
        };
        const callableTokenizer = Object.assign(() => mockTokenizer.__call__(), { decode: mockTokenizer.decode });
        const tokenizer = new TransformersTokenizer_1.TransformersTokenizer(callableTokenizer);
        const tokens = tokenizer.encode('');
        node_assert_1.strict.deepEqual(tokens, [], 'empty input should return empty array');
        const text = tokenizer.decode([]);
        node_assert_1.strict.equal(text, '', 'empty tokens should return empty string');
    });
    (0, mocha_1.it)('returns consistent results for same input', () => {
        let callCount = 0;
        const mockTokenizer = {
            __call__: () => {
                callCount++;
                return {
                    input_ids: { data: BigInt64Array.from([BigInt(101), BigInt(102)]) }
                };
            },
            decode: () => 'hello world'
        };
        const callableTokenizer = Object.assign(() => mockTokenizer.__call__(), { decode: mockTokenizer.decode });
        const tokenizer = new TransformersTokenizer_1.TransformersTokenizer(callableTokenizer);
        const tokens1 = tokenizer.encode('hello world');
        const tokens2 = tokenizer.encode('hello world');
        node_assert_1.strict.deepEqual(tokens1, tokens2, 'encode should be deterministic');
        node_assert_1.strict.equal(callCount, 2, 'should call underlying tokenizer each time');
    });
});
//# sourceMappingURL=TransformersTokenizer.spec.js.map