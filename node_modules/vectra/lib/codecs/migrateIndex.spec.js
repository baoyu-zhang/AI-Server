"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = __importDefault(require("node:assert"));
const storage_1 = require("../storage");
const JsonCodec_1 = require("./JsonCodec");
const ProtobufCodec_1 = require("./ProtobufCodec");
const migrateIndex_1 = require("./migrateIndex");
describe('detectCodec', () => {
    it('detects JSON format', () => __awaiter(void 0, void 0, void 0, function* () {
        const storage = new storage_1.VirtualFileStorage();
        yield storage.createFolder('/idx');
        yield storage.upsertFile('/idx/index.json', '{}');
        const codec = yield (0, migrateIndex_1.detectCodec)('/idx', storage);
        node_assert_1.default.equal(codec.extension, '.json');
    }));
    it('detects Protobuf format', () => __awaiter(void 0, void 0, void 0, function* () {
        const storage = new storage_1.VirtualFileStorage();
        yield storage.createFolder('/idx');
        yield storage.upsertFile('/idx/index.pb', Buffer.from([0]));
        const codec = yield (0, migrateIndex_1.detectCodec)('/idx', storage);
        node_assert_1.default.equal(codec.extension, '.pb');
    }));
    it('throws when both formats exist', () => __awaiter(void 0, void 0, void 0, function* () {
        const storage = new storage_1.VirtualFileStorage();
        yield storage.createFolder('/idx');
        yield storage.upsertFile('/idx/index.json', '{}');
        yield storage.upsertFile('/idx/index.pb', Buffer.from([0]));
        yield node_assert_1.default.rejects(() => (0, migrateIndex_1.detectCodec)('/idx', storage), /Both index\.json and index\.pb found/);
    }));
    it('throws when no index file exists', () => __awaiter(void 0, void 0, void 0, function* () {
        const storage = new storage_1.VirtualFileStorage();
        yield storage.createFolder('/idx');
        yield node_assert_1.default.rejects(() => (0, migrateIndex_1.detectCodec)('/idx', storage), /No index file found/);
    }));
});
describe('migrateIndex', () => {
    const json = new JsonCodec_1.JsonCodec();
    const pb = new ProtobufCodec_1.ProtobufCodec();
    function makeIndexData() {
        return {
            version: 1,
            metadata_config: { indexed: ['cat'] },
            items: [
                { id: 'item1', metadata: { cat: 'food' }, vector: [0.1, 0.2, 0.3], norm: 0.374 },
                { id: 'item2', metadata: { cat: 'drink' }, vector: [0.4, 0.5, 0.6], norm: 0.877, metadataFile: 'abc.json' },
            ],
        };
    }
    function makeCatalog() {
        return {
            version: 1,
            count: 1,
            uriToId: { 'doc.txt': 'doc-id-1' },
            idToUri: { 'doc-id-1': 'doc.txt' },
        };
    }
    it('migrates JSON -> Protobuf', () => __awaiter(void 0, void 0, void 0, function* () {
        const storage = new storage_1.VirtualFileStorage();
        yield storage.createFolder('/idx');
        const data = makeIndexData();
        yield storage.upsertFile('/idx/index.json', json.serializeIndex(data));
        yield storage.upsertFile('/idx/abc.json', json.serializeMetadata({ cat: 'drink', extra: 'data' }));
        yield (0, migrateIndex_1.migrateIndex)('/idx', { to: 'protobuf', storage });
        // Old files should be gone
        node_assert_1.default.equal(yield storage.pathExists('/idx/index.json'), false);
        node_assert_1.default.equal(yield storage.pathExists('/idx/abc.json'), false);
        // New files should exist
        node_assert_1.default.equal(yield storage.pathExists('/idx/index.pb'), true);
        node_assert_1.default.equal(yield storage.pathExists('/idx/abc.pb'), true);
        // Data should be intact
        const result = pb.deserializeIndex(yield storage.readFile('/idx/index.pb'));
        node_assert_1.default.equal(result.items.length, 2);
        node_assert_1.default.equal(result.items[0].id, 'item1');
        node_assert_1.default.equal(result.items[1].metadataFile, 'abc.pb');
        // External metadata should be readable
        const meta = pb.deserializeMetadata(yield storage.readFile('/idx/abc.pb'));
        node_assert_1.default.equal(meta.cat, 'drink');
        node_assert_1.default.equal(meta.extra, 'data');
    }));
    it('migrates Protobuf -> JSON', () => __awaiter(void 0, void 0, void 0, function* () {
        const storage = new storage_1.VirtualFileStorage();
        yield storage.createFolder('/idx');
        const data = makeIndexData();
        // Adjust metadataFile extension
        data.items[1].metadataFile = 'abc.pb';
        yield storage.upsertFile('/idx/index.pb', pb.serializeIndex(data));
        yield storage.upsertFile('/idx/abc.pb', pb.serializeMetadata({ cat: 'drink', extra: 'data' }));
        yield (0, migrateIndex_1.migrateIndex)('/idx', { to: 'json', storage });
        node_assert_1.default.equal(yield storage.pathExists('/idx/index.pb'), false);
        node_assert_1.default.equal(yield storage.pathExists('/idx/index.json'), true);
        const result = json.deserializeIndex(yield storage.readFile('/idx/index.json'));
        node_assert_1.default.equal(result.items.length, 2);
        node_assert_1.default.equal(result.items[1].metadataFile, 'abc.json');
    }));
    it('migrates catalog along with index', () => __awaiter(void 0, void 0, void 0, function* () {
        const storage = new storage_1.VirtualFileStorage();
        yield storage.createFolder('/idx');
        const data = { version: 1, metadata_config: {}, items: [] };
        const catalog = makeCatalog();
        yield storage.upsertFile('/idx/index.json', json.serializeIndex(data));
        yield storage.upsertFile('/idx/catalog.json', json.serializeCatalog(catalog));
        yield (0, migrateIndex_1.migrateIndex)('/idx', { to: 'protobuf', storage });
        node_assert_1.default.equal(yield storage.pathExists('/idx/catalog.json'), false);
        node_assert_1.default.equal(yield storage.pathExists('/idx/catalog.pb'), true);
        const result = pb.deserializeCatalog(yield storage.readFile('/idx/catalog.pb'));
        node_assert_1.default.deepStrictEqual(result, catalog);
    }));
    it('migrates document metadata files referenced by catalog', () => __awaiter(void 0, void 0, void 0, function* () {
        const storage = new storage_1.VirtualFileStorage();
        yield storage.createFolder('/idx');
        const data = { version: 1, metadata_config: {}, items: [] };
        const catalog = makeCatalog();
        yield storage.upsertFile('/idx/index.json', json.serializeIndex(data));
        yield storage.upsertFile('/idx/catalog.json', json.serializeCatalog(catalog));
        yield storage.upsertFile('/idx/doc-id-1.json', json.serializeMetadata({ author: 'test' }));
        yield (0, migrateIndex_1.migrateIndex)('/idx', { to: 'protobuf', storage });
        node_assert_1.default.equal(yield storage.pathExists('/idx/doc-id-1.json'), false);
        node_assert_1.default.equal(yield storage.pathExists('/idx/doc-id-1.pb'), true);
        const meta = pb.deserializeMetadata(yield storage.readFile('/idx/doc-id-1.pb'));
        node_assert_1.default.equal(meta.author, 'test');
    }));
    it('no-op when already in target format', () => __awaiter(void 0, void 0, void 0, function* () {
        const storage = new storage_1.VirtualFileStorage();
        yield storage.createFolder('/idx');
        const data = { version: 1, metadata_config: {}, items: [] };
        yield storage.upsertFile('/idx/index.json', json.serializeIndex(data));
        yield (0, migrateIndex_1.migrateIndex)('/idx', { to: 'json', storage });
        // Should still be there, unchanged
        node_assert_1.default.equal(yield storage.pathExists('/idx/index.json'), true);
    }));
    it('interruption detection: dual format raises error on detectCodec', () => __awaiter(void 0, void 0, void 0, function* () {
        const storage = new storage_1.VirtualFileStorage();
        yield storage.createFolder('/idx');
        yield storage.upsertFile('/idx/index.json', '{}');
        yield storage.upsertFile('/idx/index.pb', Buffer.from([0]));
        yield node_assert_1.default.rejects(() => (0, migrateIndex_1.detectCodec)('/idx', storage), /Both index\.json and index\.pb found/);
    }));
});
//# sourceMappingURL=migrateIndex.spec.js.map