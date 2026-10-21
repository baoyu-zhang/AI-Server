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
const LocalIndex_1 = require("../LocalIndex");
const storage_1 = require("../storage");
const ProtobufCodec_1 = require("./ProtobufCodec");
describe('LocalIndex with ProtobufCodec', () => {
    const codec = new ProtobufCodec_1.ProtobufCodec();
    it('creates index with .pb extension', () => __awaiter(void 0, void 0, void 0, function* () {
        const storage = new storage_1.VirtualFileStorage();
        const index = new LocalIndex_1.LocalIndex('mem://idx', undefined, storage, codec);
        node_assert_1.default.equal(index.indexName, 'index.pb');
        yield index.createIndex();
        node_assert_1.default.equal(yield index.isIndexCreated(), true);
    }));
    it('full CRUD operations produce correct results', () => __awaiter(void 0, void 0, void 0, function* () {
        const storage = new storage_1.VirtualFileStorage();
        const index = new LocalIndex_1.LocalIndex('mem://idx', undefined, storage, codec);
        yield index.createIndex();
        // Insert
        yield index.insertItem({ id: 'a', vector: [1, 0, 0], metadata: { cat: 'x' } });
        yield index.insertItem({ id: 'b', vector: [0, 1, 0], metadata: { cat: 'y' } });
        // List
        const items = yield index.listItems();
        node_assert_1.default.equal(items.length, 2);
        node_assert_1.default.equal(items[0].id, 'a');
        // Get
        const item = yield index.getItem('a');
        node_assert_1.default.ok(item);
        node_assert_1.default.equal(item.metadata.cat, 'x');
        // Query
        const results = yield index.queryItems([1, 0, 0], '', 1);
        node_assert_1.default.equal(results.length, 1);
        node_assert_1.default.equal(results[0].item.id, 'a');
        // Upsert
        yield index.upsertItem({ id: 'a', vector: [0, 0, 1], metadata: { cat: 'z' } });
        const updated = yield index.getItem('a');
        node_assert_1.default.equal(updated === null || updated === void 0 ? void 0 : updated.metadata.cat, 'z');
        // Delete
        yield index.deleteItem('b');
        const remaining = yield index.listItems();
        node_assert_1.default.equal(remaining.length, 1);
        node_assert_1.default.equal(remaining[0].id, 'a');
        // Stats
        const stats = yield index.getIndexStats();
        node_assert_1.default.equal(stats.items, 1);
    }));
    it('batch insert works', () => __awaiter(void 0, void 0, void 0, function* () {
        const storage = new storage_1.VirtualFileStorage();
        const index = new LocalIndex_1.LocalIndex('mem://idx', undefined, storage, codec);
        yield index.createIndex();
        yield index.batchInsertItems([
            { id: '1', vector: [1, 0, 0] },
            { id: '2', vector: [0, 1, 0] },
            { id: '3', vector: [0, 0, 1] },
        ]);
        const items = yield index.listItems();
        node_assert_1.default.equal(items.length, 3);
    }));
    it('metadata filtering works with protobuf storage', () => __awaiter(void 0, void 0, void 0, function* () {
        const storage = new storage_1.VirtualFileStorage();
        const index = new LocalIndex_1.LocalIndex('mem://idx', undefined, storage, codec);
        yield index.createIndex();
        yield index.batchInsertItems([
            { id: '1', vector: [1, 0], metadata: { category: 'food' } },
            { id: '2', vector: [0, 1], metadata: { category: 'drink' } },
        ]);
        const food = yield index.listItemsByMetadata({ category: { $eq: 'food' } });
        node_assert_1.default.equal(food.length, 1);
        node_assert_1.default.equal(food[0].id, '1');
    }));
    it('external metadata files use .pb extension', () => __awaiter(void 0, void 0, void 0, function* () {
        const storage = new storage_1.VirtualFileStorage();
        const index = new LocalIndex_1.LocalIndex('mem://idx', undefined, storage, codec);
        yield index.createIndex({ version: 1, metadata_config: { indexed: ['keep'] } });
        yield index.insertItem({ id: 'm1', vector: [1], metadata: { keep: 'x', extra: 'y' } });
        const items = yield index.listItems();
        const stored = items.find(i => i.id === 'm1');
        node_assert_1.default.ok(stored.metadataFile);
        node_assert_1.default.ok(stored.metadataFile.endsWith('.pb'), `Expected .pb extension, got: ${stored.metadataFile}`);
    }));
    it('persists and reloads across instances', () => __awaiter(void 0, void 0, void 0, function* () {
        const storage = new storage_1.VirtualFileStorage();
        // First instance: create and populate
        const idx1 = new LocalIndex_1.LocalIndex('mem://idx', undefined, storage, codec);
        yield idx1.createIndex();
        yield idx1.insertItem({ id: 'persist', vector: [1, 2, 3], metadata: { key: 'val' } });
        // Second instance: should read persisted data
        const idx2 = new LocalIndex_1.LocalIndex('mem://idx', undefined, storage, codec);
        const item = yield idx2.getItem('persist');
        node_assert_1.default.ok(item);
        node_assert_1.default.equal(item.id, 'persist');
        node_assert_1.default.equal(item.metadata.key, 'val');
    }));
});
//# sourceMappingURL=LocalIndex.protobuf.spec.js.map