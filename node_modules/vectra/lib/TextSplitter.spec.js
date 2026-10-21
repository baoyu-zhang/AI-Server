"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const mocha_1 = require("mocha");
const assert = __importStar(require("node:assert"));
const TextSplitter_1 = require("./TextSplitter");
const charTokenizer = {
    encode(text) {
        return Array.from(text).map(c => c.codePointAt(0));
    },
    decode(tokens) {
        return String.fromCodePoint(...tokens);
    },
};
const makeSplitter = (opts) => new TextSplitter_1.TextSplitter(Object.assign({ chunkSize: 16, chunkOverlap: 0, tokenizer: charTokenizer }, opts));
function joinTexts(chunks, sep = '') {
    return chunks.map(c => c.text).join(sep);
}
(0, mocha_1.describe)('TextSplitter - full coverage suite', () => {
    (0, mocha_1.describe)('constructor validation and defaults', () => {
        (0, mocha_1.it)('throws when chunkSize < 1', () => {
            assert.throws(() => new TextSplitter_1.TextSplitter({ chunkSize: 0 }), /chunkSize must be >= 1/);
        });
        (0, mocha_1.it)('throws when chunkOverlap < 0', () => {
            assert.throws(() => new TextSplitter_1.TextSplitter({ chunkSize: 10, chunkOverlap: -1 }), /chunkOverlap must be >= 0/);
        });
        (0, mocha_1.it)('throws when chunkOverlap > chunkSize', () => {
            assert.throws(() => new TextSplitter_1.TextSplitter({ chunkSize: 5, chunkOverlap: 6 }), /chunkOverlap must be <= chunkSize/);
        });
        (0, mocha_1.it)('works with default constructor and simple text', () => {
            const splitter = new TextSplitter_1.TextSplitter();
            const chunks = splitter.split('Hello world');
            assert.ok(Array.isArray(chunks) && chunks.length > 0);
        });
        (0, mocha_1.it)('returns [] for empty input', () => {
            const splitter = makeSplitter();
            const chunks = splitter.split('');
            assert.strictEqual(chunks.length, 0);
        });
    });
    (0, mocha_1.describe)('basic splitting, whitespace handling, and punctuation preservation', () => {
        (0, mocha_1.it)('drops pure whitespace-only input', () => {
            const splitter = makeSplitter();
            assert.strictEqual(splitter.split('   \t  ').length, 0);
            assert.strictEqual(splitter.split('\n\n').length, 0);
            assert.strictEqual(splitter.split(' \n \n  ').length, 0);
        });
        (0, mocha_1.it)('keeps leading punctuation-only chunk ("---")', () => {
            const splitter = makeSplitter({ chunkSize: 3 });
            const chunks = splitter.split('---');
            assert.deepStrictEqual(chunks.map(c => c.text), ['---']);
        });
        (0, mocha_1.it)('keeps punctuation-only separators (---, ***, ====) at start, middle, end', () => {
            const splitter = makeSplitter({ chunkSize: 4 });
            const text = ['---', 'Hello world', '***', 'Middle', '===='].join('\n');
            const chunks = splitter.split(text);
            const got = chunks.map(c => c.text).join('\n');
            assert.ok(got.includes('---'));
            assert.ok(got.includes('***'));
            assert.ok(got.includes('===='));
        });
        (0, mocha_1.it)('preserves frontmatter delimiters (---) with small chunkSize and zero overlap', () => {
            var _a;
            const splitter = makeSplitter({ chunkSize: 12 });
            const md = [
                '---',
                'title: Test',
                'tags: [a, b]',
                '---',
                '# Heading',
                'Body text goes here.',
            ].join('\n');
            const chunks = splitter.split(md);
            const joined = joinTexts(chunks, '\n');
            const delimiterCount = ((_a = joined.match(/^---$/gm)) !== null && _a !== void 0 ? _a : []).length;
            assert.strictEqual(delimiterCount, 2);
        });
        (0, mocha_1.it)('keeps trailing punctuation-only chunk', () => {
            const splitter = makeSplitter({ chunkSize: 4 });
            const chunks = splitter.split('Content\n---');
            assert.ok(chunks.some(c => c.text.includes('---')));
        });
        (0, mocha_1.it)('still returns alphanumeric chunks normally', () => {
            const splitter = makeSplitter({ chunkSize: 5 });
            const chunks = splitter.split('abcde fghij');
            const joined = joinTexts(chunks, ' ');
            assert.ok(joined.includes('abcde'));
            assert.ok(joined.includes('fghij'));
        });
        (0, mocha_1.it)('does not regress with non-zero overlap and preserves punctuation-only chunk', () => {
            const splitter = makeSplitter({ chunkSize: 5, chunkOverlap: 2 });
            const chunks = splitter.split('---\nabcdef');
            assert.ok(chunks.some(c => c.text.includes('---')));
        });
        (0, mocha_1.it)('handles multiple punctuation-only separators interleaved with content', () => {
            const splitter = makeSplitter({ chunkSize: 8 });
            const text = ['***', 'A', '---', 'B', '====', 'C'].join('\n');
            const chunks = splitter.split(text);
            const joined = joinTexts(chunks, '\n');
            assert.ok(joined.includes('***'));
            assert.ok(joined.includes('---'));
            assert.ok(joined.includes('===='));
            assert.ok(joined.includes('\nA\n'));
            assert.ok(joined.includes('\nB\n'));
            assert.ok(joined.includes('\nC'));
        });
    });
    (0, mocha_1.describe)('keepSeparators vs joiner behavior and merging', () => {
        (0, mocha_1.it)('when keepSeparators=false, merges adjacent content with a space joiner across newline separator', () => {
            const splitter = makeSplitter({ keepSeparators: false, chunkSize: 50 });
            const text = 'Hello\nWorld';
            const chunks = splitter.split(text);
            // Should merge into a single chunk with a space instead of newline
            assert.strictEqual(chunks.length, 1);
            assert.strictEqual(chunks[0].text, 'Hello World');
            // startPos/endPos should reflect original indices
            assert.strictEqual(chunks[0].startPos, 0);
            assert.strictEqual(chunks[0].endPos, text.length - 1);
        });
        (0, mocha_1.it)('when keepSeparators=true, retains separators inline', () => {
            const splitter = makeSplitter({ keepSeparators: true, chunkSize: 50 });
            const text = 'Hello\nWorld\n';
            const chunks = splitter.split(text);
            const joined = joinTexts(chunks, '');
            // Newlines should be preserved in output
            assert.ok(joined.includes('Hello\n'));
            assert.ok(joined.includes('World\n'));
        });
        (0, mocha_1.it)('does not merge when token budget would be exceeded', () => {
            // Very small chunkSize to force non-merge
            const splitter = makeSplitter({ chunkSize: 3, keepSeparators: false });
            const text = 'ABCD\nEFG';
            const chunks = splitter.split(text);
            // Expect multiple chunks due to budget
            assert.ok(chunks.length >= 2);
        });
    });
    (0, mocha_1.describe)('custom separators and precedence over docType', () => {
        (0, mocha_1.it)('custom separators override docType separators (keepSeparators=false)', () => {
            const splitter = makeSplitter({ docType: 'markdown', separators: ['||'], keepSeparators: false });
            const chunks = splitter.split('A||B||C');
            const joined = joinTexts(chunks, '');
            assert.ok(!joined.includes('||'), 'custom separator should be removed');
            assert.ok(joined.includes('ABC'));
        });
        (0, mocha_1.it)('custom separators can be preserved with keepSeparators=true', () => {
            const splitter = makeSplitter({ separators: ['||'], keepSeparators: true });
            const chunks = splitter.split('A||B||C');
            const joined = joinTexts(chunks, '');
            assert.ok(joined.includes('A||'));
            assert.ok(joined.includes('B||'));
            assert.ok(joined.endsWith('C'));
        });
        (0, mocha_1.it)('inline separators with no surrounding whitespace are preserved/dropped based on config', () => {
            const inline = '---Hello---World---';
            const keep = makeSplitter({ keepSeparators: true, chunkSize: 64 });
            const kept = joinTexts(keep.split(inline), '');
            assert.ok(kept.includes('---Hello---World---'));
            const drop = makeSplitter({ keepSeparators: false, chunkSize: 64 });
            const dropped = joinTexts(drop.split(inline), '');
            assert.ok(!dropped.includes('---'));
            assert.ok(dropped.includes('Hello') && dropped.includes('World'));
        });
        (0, mocha_1.it)('multiple consecutive separators do not produce empty chunks', () => {
            const splitter = makeSplitter({ keepSeparators: true, chunkSize: 64 });
            const text = ['---', '***', '===='].join('\n');
            const chunks = splitter.split(text);
            assert.ok(chunks.length >= 3);
            assert.ok(chunks.some(c => c.text.includes('---')));
            assert.ok(chunks.some(c => c.text.includes('***')));
            assert.ok(chunks.some(c => c.text.includes('====')));
        });
    });
    (0, mocha_1.describe)('splitBySpaces coverage (sep === " ")', () => {
        (0, mocha_1.it)('token window path: tokens.length <= chunkSize triggers single part then break', () => {
            const splitter = makeSplitter({ separators: [' '], chunkSize: 100 });
            const text = 'a b c';
            const chunks = splitter.split(text);
            // With large chunkSize and only space separator, it should come out as one chunk
            assert.strictEqual(chunks.length, 1);
            assert.strictEqual(chunks[0].text, text);
        });
        (0, mocha_1.it)('token window path: tokens.length > chunkSize triggers multiple parts', () => {
            const splitter = makeSplitter({ separators: [' '], chunkSize: 4 }); // small window
            const text = 'abcdefghij'; // 10 chars -> 3 parts
            const chunks = splitter.split(text);
            assert.ok(chunks.length >= 3, 'should produce multiple chunks from token windows');
            assert.strictEqual(joinTexts(chunks, ''), text);
        });
    });
    (0, mocha_1.describe)('base case path (no separators) and cutting in half', () => {
        (0, mocha_1.it)('with separators: [] uses cut-in-half strategy and merges back under budget', () => {
            const splitter = makeSplitter({ separators: [], chunkSize: 100, keepSeparators: false });
            const text = 'HelloWorld';
            const chunks = splitter.split(text);
            // Expect merged single chunk but with a space joiner introduced by combineChunks
            assert.strictEqual(chunks.length, 1);
            assert.strictEqual(chunks[0].text.replace(/\s/g, ''), text);
        });
        (0, mocha_1.it)('optimization branch: chunk.length/6 > chunkSize triggers deeper recursion', () => {
            const splitter = makeSplitter({ separators: ['\n'], chunkSize: 1 });
            const text = 'x'.repeat(20); // 20/6 > 1 -> triggers optimization
            const chunks = splitter.split(text);
            assert.ok(chunks.length > 1, 'should split into multiple chunks under heavy optimization');
            assert.strictEqual(joinTexts(chunks, ''), text);
        });
    });
    (0, mocha_1.describe)('overlap behavior', () => {
        (0, mocha_1.it)('adds startOverlap and endOverlap tokens between adjacent chunks', () => {
            const chunkSize = 3;
            const overlap = 2;
            const splitter = makeSplitter({ chunkSize, chunkOverlap: overlap, separators: [], keepSeparators: false });
            const text = 'abcdefghi'; // will be split by halves recursively then sized by budget
            const chunks = splitter.split(text);
            assert.ok(chunks.length >= 2);
            for (let i = 1; i < chunks.length; i++) {
                const prev = chunks[i - 1];
                const curr = chunks[i];
                const next = chunks[i + 1];
                // startOverlap should match last 'overlap' tokens of prev
                const prevTail = prev.tokens.slice(-overlap);
                assert.deepStrictEqual(curr.startOverlap, prevTail.slice(0, curr.startOverlap.length));
                // endOverlap should match first 'overlap' tokens of next (or [])
                if (next) {
                    const nextHead = next.tokens.slice(0, overlap);
                    assert.deepStrictEqual(curr.endOverlap, nextHead.slice(0, curr.endOverlap.length));
                }
                else {
                    assert.deepStrictEqual(curr.endOverlap, []);
                }
            }
        });
        (0, mocha_1.it)('handles maximal overlap (chunkOverlap = chunkSize)', () => {
            const chunkSize = 4;
            const overlap = 4;
            const splitter = makeSplitter({ chunkSize, chunkOverlap: overlap, separators: [], keepSeparators: false });
            const text = 'abcdefgh';
            const chunks = splitter.split(text);
            assert.ok(chunks.length >= 2);
            for (let i = 1; i < chunks.length; i++) {
                const prevTail = chunks[i - 1].tokens.slice(-overlap);
                assert.deepStrictEqual(chunks[i].startOverlap, prevTail.slice(0, chunks[i].startOverlap.length));
            }
        });
    });
    (0, mocha_1.describe)('docType-specific separators coverage', () => {
        const docTypes = [
            'cpp',
            'go',
            'typescript', // covers java/c#/cs/ts/tsx/typescript grouped case
            'javascript',
            'php',
            'proto',
            'python',
            'rst',
            'ruby',
            'rust',
            'scala',
            'swift',
            'markdown',
            'latex',
            'html',
            'sol',
            // default/fallback
            '__default__',
        ];
        for (const dt of docTypes) {
            (0, mocha_1.it)(`constructs with docType: ${dt}`, () => {
                const opts = dt === '__default__' ? {} : { docType: dt };
                const splitter = new TextSplitter_1.TextSplitter(Object.assign({ chunkSize: 64, chunkOverlap: 0, tokenizer: charTokenizer }, opts));
                const chunks = splitter.split('sample');
                assert.ok(chunks.length >= 1);
            });
        }
    });
    (0, mocha_1.describe)('tokenizer injection behavior', () => {
        (0, mocha_1.it)('respects a custom tokenizer that alters token counts', () => {
            // Tokenizer that treats every character as two tokens (simulate heavier tokenization)
            const heavyTokenizer = {
                encode(text) {
                    const out = [];
                    for (const c of Array.from(text)) {
                        const code = c.codePointAt(0);
                        out.push(code, code + 1); // 2 tokens per char
                    }
                    return out;
                },
                decode(tokens) {
                    // Decode by taking every other token
                    const chars = [];
                    for (let i = 0; i < tokens.length; i += 2) {
                        chars.push(tokens[i]);
                    }
                    return String.fromCodePoint(...chars);
                },
            };
            const splitter = new TextSplitter_1.TextSplitter({ chunkSize: 6, chunkOverlap: 0, tokenizer: heavyTokenizer });
            const text = 'abcdef'; // 6 chars -> 12 tokens -> will require splitting
            const chunks = splitter.split(text);
            assert.ok(chunks.length > 1, 'heavier tokenization should force more chunks');
            assert.strictEqual(joinTexts(chunks, ''), text);
        });
    });
});
//# sourceMappingURL=TextSplitter.spec.js.map