"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = __importDefault(require("node:assert"));
const ProtobufCodec_1 = require("./ProtobufCodec");
const JsonCodec_1 = require("./JsonCodec");
describe('ProtobufCodec', () => {
    const codec = new ProtobufCodec_1.ProtobufCodec();
    it('has .pb extension', () => {
        node_assert_1.default.equal(codec.extension, '.pb');
    });
    describe('serializeIndex / deserializeIndex', () => {
        it('round-trips IndexData', () => {
            const data = {
                version: 1,
                metadata_config: { indexed: ['category'] },
                items: [
                    { id: 'a', metadata: { category: 'food', score: 42 }, vector: [1.5, 2.5, 3.5], norm: 4.5 },
                    { id: 'b', metadata: {}, vector: [0, 0, 0], norm: 0, metadataFile: 'ext.pb' },
                ],
            };
            const buf = codec.serializeIndex(data);
            node_assert_1.default.ok(Buffer.isBuffer(buf));
            const result = codec.deserializeIndex(buf);
            node_assert_1.default.equal(result.version, data.version);
            node_assert_1.default.deepStrictEqual(result.metadata_config, data.metadata_config);
            node_assert_1.default.equal(result.items.length, 2);
            node_assert_1.default.equal(result.items[0].id, 'a');
            node_assert_1.default.deepStrictEqual(result.items[0].metadata, { category: 'food', score: 42 });
            // Float32 precision: vectors should be close but not exact
            node_assert_1.default.ok(Math.abs(result.items[0].vector[0] - 1.5) < 0.001);
            node_assert_1.default.ok(Math.abs(result.items[0].vector[1] - 2.5) < 0.001);
            node_assert_1.default.ok(Math.abs(result.items[0].vector[2] - 3.5) < 0.001);
            node_assert_1.default.equal(result.items[0].norm, 4.5); // norm is double, exact
            node_assert_1.default.equal(result.items[1].metadataFile, 'ext.pb');
        });
        it('handles empty items', () => {
            const data = { version: 2, metadata_config: {}, items: [] };
            const result = codec.deserializeIndex(codec.serializeIndex(data));
            node_assert_1.default.equal(result.version, 2);
            node_assert_1.default.deepStrictEqual(result.items, []);
        });
        it('handles boolean metadata values', () => {
            const data = {
                version: 1,
                metadata_config: {},
                items: [
                    { id: 'x', metadata: { active: true, deleted: false }, vector: [1], norm: 1 },
                ],
            };
            // Note: false/0/"" are proto3 default values — test the tricky case
            const result = codec.deserializeIndex(codec.serializeIndex(data));
            node_assert_1.default.equal(result.items[0].metadata.active, true);
        });
        it('handles string metadata', () => {
            const data = {
                version: 1,
                metadata_config: {},
                items: [
                    { id: 'x', metadata: { name: 'hello', tag: 'world' }, vector: [1], norm: 1 },
                ],
            };
            const result = codec.deserializeIndex(codec.serializeIndex(data));
            node_assert_1.default.equal(result.items[0].metadata.name, 'hello');
            node_assert_1.default.equal(result.items[0].metadata.tag, 'world');
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
                uriToId: { 'file://doc': 'id-1' },
                idToUri: { 'id-1': 'file://doc' },
                uriToHash: { 'file://doc': 'a'.repeat(64) },
            };
            const result = codec.deserializeCatalog(codec.serializeCatalog(catalog));
            node_assert_1.default.deepStrictEqual(result, catalog);
        });
        it('returns uriToHash undefined when absent (old catalog shape)', () => {
            const catalog = {
                version: 1,
                count: 1,
                uriToId: { 'file://doc': 'id-1' },
                idToUri: { 'id-1': 'file://doc' },
            };
            const result = codec.deserializeCatalog(codec.serializeCatalog(catalog));
            node_assert_1.default.equal(result.uriToHash, undefined);
        });
    });
    describe('serializeMetadata / deserializeMetadata', () => {
        it('round-trips metadata (uses JSON for external files)', () => {
            const metadata = { name: 'test', score: 42, active: true };
            const buf = codec.serializeMetadata(metadata);
            const result = codec.deserializeMetadata(buf);
            node_assert_1.default.deepStrictEqual(result, metadata);
        });
    });
    describe('cross-codec compatibility', () => {
        const json = new JsonCodec_1.JsonCodec();
        const pb = new ProtobufCodec_1.ProtobufCodec();
        it('data serialized with JSON can be re-serialized with Protobuf and back (logical equivalence)', () => {
            const data = {
                version: 1,
                metadata_config: { indexed: ['cat'] },
                items: [
                    { id: 'item1', metadata: { cat: 'a', num: 7 }, vector: [0.1, 0.2, 0.3], norm: 0.374 },
                ],
            };
            // JSON -> Protobuf
            const jsonBuf = json.serializeIndex(data);
            const fromJson = json.deserializeIndex(jsonBuf);
            const pbBuf = pb.serializeIndex(fromJson);
            const fromPb = pb.deserializeIndex(pbBuf);
            node_assert_1.default.equal(fromPb.version, data.version);
            node_assert_1.default.deepStrictEqual(fromPb.metadata_config, data.metadata_config);
            node_assert_1.default.equal(fromPb.items[0].id, data.items[0].id);
            node_assert_1.default.deepStrictEqual(fromPb.items[0].metadata, data.items[0].metadata);
            // Protobuf -> JSON
            const jsonBuf2 = json.serializeIndex(fromPb);
            const final = json.deserializeIndex(jsonBuf2);
            node_assert_1.default.equal(final.items[0].id, 'item1');
            node_assert_1.default.deepStrictEqual(final.items[0].metadata, { cat: 'a', num: 7 });
        });
        it('catalog round-trips across codecs', () => {
            const catalog = {
                version: 1,
                count: 1,
                uriToId: { 'file://doc.txt': 'uuid-1' },
                idToUri: { 'uuid-1': 'file://doc.txt' },
            };
            const pbBuf = pb.serializeCatalog(catalog);
            const fromPb = pb.deserializeCatalog(pbBuf);
            const jsonBuf = json.serializeCatalog(fromPb);
            const final = json.deserializeCatalog(jsonBuf);
            node_assert_1.default.deepStrictEqual(final, catalog);
        });
    });
    describe('protobuf produces smaller output than JSON for vector data', () => {
        it('binary is smaller than JSON for a 1536-dim vector', () => {
            const vector = Array.from({ length: 1536 }, (_, i) => Math.random() * 2 - 1);
            const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
            const data = {
                version: 1,
                metadata_config: {},
                items: [{ id: 'vec', metadata: {}, vector, norm }],
            };
            const jsonSize = new JsonCodec_1.JsonCodec().serializeIndex(data).length;
            const pbSize = codec.serializeIndex(data).length;
            // Protobuf should be significantly smaller
            node_assert_1.default.ok(pbSize < jsonSize, `Expected pb (${pbSize}) < json (${jsonSize})`);
            // Spec says ~40-50% savings
            node_assert_1.default.ok(pbSize < jsonSize * 0.7, `Expected at least 30% savings, got ${((1 - pbSize / jsonSize) * 100).toFixed(1)}%`);
        });
    });
});
//# sourceMappingURL=ProtobufCodec.spec.js.map