"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = require("node:assert");
const mocha_1 = require("mocha");
const contentHash_1 = require("./contentHash");
(0, mocha_1.describe)('computeContentHash', () => {
    (0, mocha_1.it)('returns a 64-character lowercase hex string', () => {
        const h = (0, contentHash_1.computeContentHash)('hello');
        node_assert_1.strict.match(h, /^[0-9a-f]{64}$/);
    });
    (0, mocha_1.it)('produces the same hash for identical inputs', () => {
        const a = (0, contentHash_1.computeContentHash)('text', 'md', { author: 'x', n: 1 });
        const b = (0, contentHash_1.computeContentHash)('text', 'md', { author: 'x', n: 1 });
        node_assert_1.strict.equal(a, b);
    });
    (0, mocha_1.it)('changes when the text changes', () => {
        const a = (0, contentHash_1.computeContentHash)('one');
        const b = (0, contentHash_1.computeContentHash)('two');
        node_assert_1.strict.notEqual(a, b);
    });
    (0, mocha_1.it)('changes when docType changes', () => {
        const a = (0, contentHash_1.computeContentHash)('same', 'md');
        const b = (0, contentHash_1.computeContentHash)('same', 'txt');
        node_assert_1.strict.notEqual(a, b);
    });
    (0, mocha_1.it)('changes when metadata values change', () => {
        const a = (0, contentHash_1.computeContentHash)('t', undefined, { k: 'v1' });
        const b = (0, contentHash_1.computeContentHash)('t', undefined, { k: 'v2' });
        node_assert_1.strict.notEqual(a, b);
    });
    (0, mocha_1.it)('is independent of metadata key order', () => {
        const a = (0, contentHash_1.computeContentHash)('t', 'md', { a: 1, b: 2, c: 3 });
        const b = (0, contentHash_1.computeContentHash)('t', 'md', { c: 3, a: 1, b: 2 });
        node_assert_1.strict.equal(a, b);
    });
    (0, mocha_1.it)('treats undefined metadata and empty metadata as equivalent', () => {
        const a = (0, contentHash_1.computeContentHash)('t', 'md', undefined);
        const b = (0, contentHash_1.computeContentHash)('t', 'md', {});
        node_assert_1.strict.equal(a, b);
    });
    (0, mocha_1.it)('treats undefined docType and empty docType as equivalent', () => {
        const a = (0, contentHash_1.computeContentHash)('t');
        const b = (0, contentHash_1.computeContentHash)('t', '');
        node_assert_1.strict.equal(a, b);
    });
    (0, mocha_1.it)('avoids cross-field collisions via null-byte separators', () => {
        // "ab" + "" + "{}" vs "a" + "b" + "{}" — without separators these could hash the same.
        const a = (0, contentHash_1.computeContentHash)('ab', '');
        const b = (0, contentHash_1.computeContentHash)('a', 'b');
        node_assert_1.strict.notEqual(a, b);
    });
});
//# sourceMappingURL=contentHash.spec.js.map