"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = require("node:assert");
const ItemSelector_1 = require("./ItemSelector");
function almostEqual(actual, expected, eps = 1e-12) {
    node_assert_1.strict.ok(Math.abs(actual - expected) <= eps, `actual ${actual} not within ${eps} of expected ${expected}`);
}
describe('ItemSelector', () => {
    describe('normalize', () => {
        it('returns correct norm for typical vector', () => {
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.normalize([3, 4]), 5);
        });
        it('handles negatives', () => {
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.normalize([-2, -3]), Math.sqrt(13));
        });
        it('returns 0 for zero vector', () => {
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.normalize([0, 0]), 0);
        });
        it('returns 0 for empty vector', () => {
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.normalize([]), 0);
        });
    });
    describe('cosineSimilarity', () => {
        it('returns ~1 for identical vectors', () => {
            const actual = ItemSelector_1.ItemSelector.cosineSimilarity([1, 2], [1, 2]);
            almostEqual(actual, 1);
        });
        it('returns ~0 for orthogonal vectors', () => {
            const actual = ItemSelector_1.ItemSelector.cosineSimilarity([1, 0], [0, 1]);
            almostEqual(actual, 0);
        });
        it('returns ~-1 for opposite vectors', () => {
            const actual = ItemSelector_1.ItemSelector.cosineSimilarity([1, 0], [-1, 0]);
            almostEqual(actual, -1);
        });
        it('returns NaN if one vector is zero', () => {
            node_assert_1.strict.ok(Number.isNaN(ItemSelector_1.ItemSelector.cosineSimilarity([0, 0], [1, 2])));
        });
        it('returns NaN if both vectors are zero', () => {
            node_assert_1.strict.ok(Number.isNaN(ItemSelector_1.ItemSelector.cosineSimilarity([0, 0], [0, 0])));
        });
        it('handles different lengths by ignoring extra elements (including in norms)', () => {
            const v1 = [1, 2, 3];
            const v2 = [4, 5];
            const minLen = Math.min(v1.length, v2.length);
            const dot = v1.slice(0, minLen).reduce((sum, val, i) => sum + val * v2[i], 0);
            const norm1 = ItemSelector_1.ItemSelector.normalize(v1.slice(0, minLen));
            const norm2 = ItemSelector_1.ItemSelector.normalize(v2.slice(0, minLen));
            const expected = dot / (norm1 * norm2);
            const result = ItemSelector_1.ItemSelector.cosineSimilarity(v1, v2);
            almostEqual(result, expected);
        });
    });
    describe('normalizedCosineSimilarity', () => {
        it('returns correct similarity with valid norms', () => {
            const v1 = [1, 2];
            const v2 = [2, 3];
            const norm1 = ItemSelector_1.ItemSelector.normalize(v1);
            const norm2 = ItemSelector_1.ItemSelector.normalize(v2);
            const expected = (v1[0] * v2[0] + v1[1] * v2[1]) / (norm1 * norm2);
            const actual = ItemSelector_1.ItemSelector.normalizedCosineSimilarity(v1, norm1, v2, norm2);
            almostEqual(actual, expected);
        });
        it('returns NaN if norm1 is zero', () => {
            node_assert_1.strict.ok(Number.isNaN(ItemSelector_1.ItemSelector.normalizedCosineSimilarity([1, 2], 0, [2, 3], 1)));
        });
        it('returns NaN if norm2 is zero', () => {
            node_assert_1.strict.ok(Number.isNaN(ItemSelector_1.ItemSelector.normalizedCosineSimilarity([1, 2], 1, [2, 3], 0)));
        });
    });
    describe('select', () => {
        it('returns true for empty filter object', () => {
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select({ a: 1 }, {}), true);
        });
        it('returns false if unknown key and metadata missing key', () => {
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select({}, { unknown: 'value' }), false);
        });
        it('returns true if unknown key and metadata has equal value', () => {
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select({ unknown: 'value' }, { unknown: 'value' }), true);
        });
        it('returns false if filter value is undefined or null', () => {
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select({ name: 'alice' }, { name: undefined }), false);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select({ name: 'alice' }, { name: null }), false);
        });
        it('handles $and with all subfilters passing', () => {
            const filter = { $and: [{ a: 1 }, { b: 2 }] };
            const metadata = { a: 1, b: 2 };
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, filter), true);
        });
        it('handles $and with one subfilter failing', () => {
            const filter = { $and: [{ a: 1 }, { b: 3 }] };
            const metadata = { a: 1, b: 2 };
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, filter), false);
        });
        it('handles empty $and array', () => {
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select({}, { $and: [] }), true);
        });
        it('handles nested $and/$or combinations', () => {
            const filter = { $and: [{ $or: [{ a: 1 }, { b: 2 }] }, { c: 3 }] };
            const metadata1 = { a: 1, c: 3 };
            const metadata2 = { b: 2, c: 3 };
            const metadata3 = { a: 1, c: 4 };
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata1, filter), true);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata2, filter), true);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata3, filter), false);
        });
        it('handles $or with at least one subfilter passing', () => {
            const filter = { $or: [{ a: 1 }, { b: 2 }] };
            const metadata = { a: 1, b: 3 };
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, filter), true);
        });
        it('handles $or with all subfilters failing', () => {
            const filter = { $or: [{ a: 2 }, { b: 3 }] };
            const metadata = { a: 1, b: 2 };
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, filter), false);
        });
        it('handles empty $or array', () => {
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select({}, { $or: [] }), false);
        });
        it('handles metadataFilter numeric comparisons', () => {
            const metadata = { num: 5, str: 'hello' };
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { num: { $eq: 5 } }), true);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { num: { $eq: 4 } }), false);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { num: { $ne: 4 } }), true);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { num: { $ne: 5 } }), false);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { num: { $gt: 4 } }), true);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { num: { $gt: 5 } }), false);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { num: { $gt: 4.9 } }), true);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { str: { $gt: 'a' } }), false);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { num: { $gte: 5 } }), true);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { num: { $gte: 6 } }), false);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { str: { $gte: 'a' } }), false);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { num: { $lt: 6 } }), true);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { num: { $lt: 5 } }), false);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { str: { $lt: 'z' } }), false);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { num: { $lte: 5 } }), true);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { num: { $lte: 4 } }), false);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { str: { $lte: 'z' } }), false);
        });
        it('$in behavior matches implementation (booleans false, exact match for strings, substring for strings, numbers via substring in array strings)', () => {
            const metadataBool = { val: true };
            const metadataStr = { val: 'foo' };
            const metadataStr2 = { val: 'oo' };
            const metadataNum = { val: 42 };
            const arrStr = ['foo', 'bar'];
            const arrMixedNo = ['foobar', 'baz'];
            const arrMixedYes = ['x42y', 'baz'];
            // boolean always false
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadataBool, { val: { $in: ['foo'] } }), false);
            // string exact includes
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadataStr, { val: { $in: arrStr } }), true);
            // string not included
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadataStr2, { val: { $in: arrStr } }), false);
            // number: true only if some array string includes the number as a substring
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadataNum, { val: { $in: arrMixedNo } }), false);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadataNum, { val: { $in: arrMixedYes } }), true);
            // array of numbers does not include string '42'
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select({ val: '42' }, { val: { $in: [1, 2] } }), false);
        });
        it('$nin behavior matches implementation (booleans false, blocks exact/substring for strings, numbers only blocked by substring in array strings)', () => {
            const metadataBool = { val: true };
            const metadataStr = { val: 'foo' };
            const metadataStrSub = { val: 'oo' };
            const metadataNum = { val: 42 };
            const arrStr = ['foo', 'bar'];
            const arrMixedNo = ['foobar', 'baz'];
            const arrMixedYes = ['baz', 'z42z'];
            const arrNum = [42];
            // boolean always false
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadataBool, { val: { $nin: ['foo'] } }), false);
            // string exact match present -> false
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadataStr, { val: { $nin: arrStr } }), false);
            // string is a substring of an element -> false
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadataStrSub, { val: { $nin: arrMixedNo } }), false);
            // number: true if no array string includes the number as substring
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadataNum, { val: { $nin: arrMixedNo } }), true);
            // number: false if some array string includes the number as substring
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadataNum, { val: { $nin: arrMixedYes } }), false);
            // array of numbers does not block number (implementation detail)
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadataNum, { val: { $nin: arrNum } }), true);
        });
        it('handles default operator fall-through (unknown operator compares equality to its value)', () => {
            const metadata = { field: 'bar' };
            // Unknown operator compares metadata value to the operator's value
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { field: { $foo: 'bar' } }), true);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { field: { $foo: 'baz' } }), false);
            // Direct scalar equality
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { field: 'bar' }), true);
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { field: 'baz' }), false);
        });
        it('returns false if metadata key missing in object filter', () => {
            const metadata = {};
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, { age: { $gt: 18 } }), false);
        });
        it('handles multi-field filter with mixed scalar and operator filters', () => {
            const metadata = { a: 1, b: 2, c: 3 };
            const filter = { a: 1, b: { $gt: 1 }, c: { $lt: 4 } };
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, filter), true);
            const filterFail = { a: 1, b: { $gt: 2 }, c: { $lt: 4 } };
            node_assert_1.strict.equal(ItemSelector_1.ItemSelector.select(metadata, filterFail), false);
        });
    });
});
//# sourceMappingURL=ItemSelector.spec.js.map