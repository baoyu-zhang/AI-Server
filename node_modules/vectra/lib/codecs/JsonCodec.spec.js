"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = __importDefault(require("node:assert"));
const JsonCodec_1 = require("./JsonCodec");
describe('JsonCodec', () => {
    const codec = new JsonCodec_1.JsonCodec();
    it('has .json extension', () => {
        node_assert_1.default.equal(codec.extension, '.json');
    });
    describe('serializeIndex / deserializeIndex', () => {
        it('round-trips IndexData', () => {
            const data = {
                version: 1,
                metadata_config: { indexed: ['category'] },
                items: [
                    { id: 'a', metadata: { category: 'food', score: 0.9 }, vector: [1.5, 2.5, 3.5], norm: 4.5 },
                    { id: 'b', metadata: {}, vector: [0, 0, 0], norm: 0, metadataFile: 'ext.json' },
                ],
            };
            const buf = codec.serializeIndex(data);
            node_assert_1.default.ok(Buffer.isBuffer(buf));
            const result = codec.deserializeIndex(buf);
            node_assert_1.default.deepStrictEqual(result, data);
        });
        it('handles empty items', () => {
            const data = { version: 2, metadata_config: {}, items: [] };
            const result = codec.deserializeIndex(codec.serializeIndex(data));
            node_assert_1.default.deepStrictEqual(result, data);
        });
    });
    describe('serializeCatalog / deserializeCatalog', () => {
        it('round-trips DocumentCatalog', () => {
            const catalog = {
                version: 1,
                count: 2,
                uriToId: { 'http://a': 'id-a', 'http://b': 'id-b' },
                idToUri: { 'id-a': 'http://a', 'id-b': 'http://b' },
            };
            const buf = codec.serializeCatalog(catalog);
            node_assert_1.default.ok(Buffer.isBuffer(buf));
            const result = codec.deserializeCatalog(buf);
            node_assert_1.default.deepStrictEqual(result, catalog);
        });
        it('handles empty catalog', () => {
            const catalog = { version: 1, count: 0, uriToId: {}, idToUri: {} };
            const result = codec.deserializeCatalog(codec.serializeCatalog(catalog));
            node_assert_1.default.deepStrictEqual(result, catalog);
        });
        it('round-trips uriToHash when present', () => {
            const catalog = {
                version: 1,
                count: 1,
                uriToId: { 'http://a': 'id-a' },
                idToUri: { 'id-a': 'http://a' },
                uriToHash: { 'http://a': 'abc123' },
            };
            const result = codec.deserializeCatalog(codec.serializeCatalog(catalog));
            node_assert_1.default.deepStrictEqual(result, catalog);
        });
        it('reads old catalogs (without uriToHash) without error', () => {
            const oldBuf = Buffer.from(JSON.stringify({
                version: 1,
                count: 1,
                uriToId: { 'http://a': 'id-a' },
                idToUri: { 'id-a': 'http://a' },
            }), 'utf-8');
            const result = codec.deserializeCatalog(oldBuf);
            node_assert_1.default.equal(result.uriToHash, undefined);
        });
    });
    describe('serializeMetadata / deserializeMetadata', () => {
        it('round-trips metadata with all types', () => {
            const metadata = { name: 'test', score: 42, active: true };
            const buf = codec.serializeMetadata(metadata);
            const result = codec.deserializeMetadata(buf);
            node_assert_1.default.deepStrictEqual(result, metadata);
        });
        it('handles empty metadata', () => {
            const result = codec.deserializeMetadata(codec.serializeMetadata({}));
            node_assert_1.default.deepStrictEqual(result, {});
        });
    });
});
//# sourceMappingURL=JsonCodec.spec.js.map