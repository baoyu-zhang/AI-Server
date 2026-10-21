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
const sinon_1 = __importDefault(require("sinon"));
const LocalIndex_1 = require("./LocalIndex");
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const storage_1 = require("./storage");
const LocalDocument_1 = require("./LocalDocument");
describe('LocalIndex', () => {
    const testIndexDir = path_1.default.join(__dirname, 'test_index');
    const basicIndexItems = [
        { id: '1', vector: [1, 2, 3] },
        { id: '2', vector: [2, 3, 4] },
        { id: '3', vector: [3, 4, 5] }
    ];
    beforeEach(() => __awaiter(void 0, void 0, void 0, function* () {
        yield promises_1.default.rm(testIndexDir, { recursive: true, force: true });
    }));
    afterEach(() => __awaiter(void 0, void 0, void 0, function* () {
        yield promises_1.default.rm(testIndexDir, { recursive: true, force: true });
        sinon_1.default.restore();
    }));
    it('should create a new index', () => __awaiter(void 0, void 0, void 0, function* () {
        const index = new LocalIndex_1.LocalIndex(testIndexDir);
        yield index.createIndex();
        const created = yield index.isIndexCreated();
        node_assert_1.default.equal(created, true);
        node_assert_1.default.equal(index.folderPath, testIndexDir);
    }));
    it('exposes getters indexName and storage', () => __awaiter(void 0, void 0, void 0, function* () {
        const index = new LocalIndex_1.LocalIndex(testIndexDir);
        node_assert_1.default.equal(index.indexName, 'index.json');
        node_assert_1.default.ok(index.storage);
    }));
    it('blocks concurrent operations when lock is held', () => __awaiter(void 0, void 0, void 0, function* () {
        const index = new LocalIndex_1.LocalIndex(testIndexDir);
        yield index.createIndex();
        yield index.beginUpdate();
        yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
            yield index.beginUpdate();
        }), new Error('Update already in progress'));
    }));
    describe('createIndex', () => {
        it('checks for existing index on creation', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield index.createIndex();
            }), new Error('Index already exists'));
            yield index.insertItem({ id: '1', vector: [1, 2, 3] });
            const lengthBefore = (yield index.listItems()).length;
            node_assert_1.default.equal(lengthBefore, 1);
            yield index.createIndex({ deleteIfExists: true, version: 2, metadata_config: {} });
            const lengthAfter = (yield index.listItems()).length;
            node_assert_1.default.equal(lengthAfter, 0);
        }));
        it('delete index if file creation fails', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            sinon_1.default.stub(promises_1.default, 'writeFile').rejects(new Error('fs error'));
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield index.createIndex();
            }), new Error('Error creating index'));
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield index.listItems();
            }));
        }));
        it('persists version and metadata_config', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex({ deleteIfExists: true, version: 2, metadata_config: { indexed: [] } });
            const stats = yield index.getIndexStats();
            node_assert_1.default.deepStrictEqual(stats, { version: 2, metadata_config: { indexed: [] }, items: 0 });
        }));
    });
    describe('deleteIndex and load guard', () => {
        it('listItems before createIndex rejects with not-exist error', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () { return index.listItems(); }), new Error('Index does not exist'));
        }));
        it('deleteIndex removes the index and prevents further reads', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.insertItem({ id: 'a', vector: [1] });
            node_assert_1.default.equal(yield index.isIndexCreated(), true);
            yield index.deleteIndex();
            node_assert_1.default.equal(yield index.isIndexCreated(), false);
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () { return index.listItems(); }), new Error('Index does not exist'));
        }));
    });
    describe('insert/upsert validation and behavior', () => {
        it('insertItem validation: requires vector', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.beginUpdate();
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () { return index.insertItem({ id: 'x' }); }), new Error('Vector is required'));
            yield index.cancelUpdate();
        }));
        it('upsertItem inserts when not existing', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            const inserted = yield index.upsertItem({ id: 'up', vector: [9, 9] });
            node_assert_1.default.equal(inserted.id, 'up');
            node_assert_1.default.deepStrictEqual(inserted.vector, [9, 9]);
            const all = yield index.listItems();
            node_assert_1.default.equal(all.length, 1);
            node_assert_1.default.equal(all[0].id, 'up');
        }));
        it('upsertItem replaces existing item contents', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.insertItem({ id: 'same', vector: [1], metadata: { a: 1 } });
            const updated = yield index.upsertItem({ id: 'same', vector: [2], metadata: { a: 2 } });
            node_assert_1.default.equal(updated.id, 'same');
            node_assert_1.default.deepStrictEqual(updated.vector, [2]);
            node_assert_1.default.deepStrictEqual(updated.metadata, { a: 2 });
            const reread = yield index.getItem('same');
            node_assert_1.default.deepStrictEqual(reread === null || reread === void 0 ? void 0 : reread.vector, [2]);
            node_assert_1.default.deepStrictEqual(reread === null || reread === void 0 ? void 0 : reread.metadata, { a: 2 });
        }));
        it('auto-generates id when not provided and does not create metadataFile with no metadata even if indexed config exists', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex({ version: 1, metadata_config: { indexed: ['keep'] } });
            const inserted = yield index.insertItem({ vector: [1, 2, 3] });
            node_assert_1.default.ok(inserted.id && typeof inserted.id === 'string');
            const reread = yield index.getItem(inserted.id);
            node_assert_1.default.deepStrictEqual(reread === null || reread === void 0 ? void 0 : reread.metadata, {});
            node_assert_1.default.equal(reread.metadataFile, undefined);
        }));
    });
    describe('cancelUpdate', () => {
        it('discards staged changes', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.beginUpdate();
            yield index.insertItem({ id: 'temp', vector: [1, 1, 1] });
            index.cancelUpdate();
            const items = yield index.listItems();
            node_assert_1.default.deepStrictEqual(items, []);
        }));
    });
    describe('isIndexCreated transitions', () => {
        it('reports false -> true -> false across lifecycle', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            node_assert_1.default.equal(yield index.isIndexCreated(), false);
            yield index.createIndex();
            node_assert_1.default.equal(yield index.isIndexCreated(), true);
            yield index.deleteIndex();
            node_assert_1.default.equal(yield index.isIndexCreated(), false);
        }));
    });
    describe('deleteItem', () => {
        it('does nothing when id not found', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.beginUpdate();
            yield index.insertItem(basicIndexItems[0]);
            yield index.insertItem(basicIndexItems[1]);
            yield index.insertItem(basicIndexItems[2]);
            yield index.endUpdate();
            yield node_assert_1.default.doesNotReject(() => __awaiter(void 0, void 0, void 0, function* () {
                yield index.deleteItem('dne');
            }));
            node_assert_1.default.equal((yield index.listItems()).length, 3);
        }));
        it('leaves existing empty index when last el deleted', () => __awaiter(void 0, void 0, void 0, function* () {
            var _a;
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.insertItem(basicIndexItems[0]);
            yield index.deleteItem((_a = basicIndexItems[0].id) !== null && _a !== void 0 ? _a : '');
            node_assert_1.default.equal(yield index.isIndexCreated(), true);
            node_assert_1.default.equal((yield index.listItems()).length, 0);
        }));
        it('removes elements from any position', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.batchInsertItems([
                { id: '1', vector: [] },
                { id: '2', vector: [] },
                { id: '3', vector: [] },
                { id: '4', vector: [] },
                { id: '5', vector: [] }
            ]);
            yield index.beginUpdate();
            yield index.deleteItem('1');
            yield index.deleteItem('3');
            yield index.deleteItem('5');
            yield index.endUpdate();
            node_assert_1.default.deepStrictEqual(yield index.listItems(), [
                { id: '2', vector: [], metadata: {}, norm: 0 },
                { id: '4', vector: [], metadata: {}, norm: 0 }
            ]);
        }));
        it('no-op delete while update active when id missing', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.batchInsertItems([
                { id: '1', vector: [1] },
                { id: '2', vector: [2] }
            ]);
            yield index.beginUpdate();
            yield node_assert_1.default.doesNotReject(() => __awaiter(void 0, void 0, void 0, function* () { return index.deleteItem('missing'); }));
            yield index.endUpdate();
            const items = yield index.listItems();
            node_assert_1.default.deepStrictEqual(items.map(i => i.id), ['1', '2']);
        }));
    });
    describe('deleteItems', () => {
        it('removes a batch of items in one pass when no update is in progress', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.batchInsertItems([
                { id: '1', vector: [1] },
                { id: '2', vector: [2] },
                { id: '3', vector: [3] },
                { id: '4', vector: [4] }
            ]);
            yield index.deleteItems(['1', '3']);
            const items = yield index.listItems();
            node_assert_1.default.deepStrictEqual(items.map(i => i.id).sort(), ['2', '4']);
        }));
        it('removes items inside an active update without committing', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.batchInsertItems([
                { id: '1', vector: [1] },
                { id: '2', vector: [2] }
            ]);
            yield index.beginUpdate();
            yield index.deleteItems(['1']);
            // Not committed yet — listItems uses the persisted snapshot.
            node_assert_1.default.deepStrictEqual((yield index.listItems()).map(i => i.id).sort(), ['1', '2']);
            yield index.endUpdate();
            node_assert_1.default.deepStrictEqual((yield index.listItems()).map(i => i.id), ['2']);
        }));
        it('accepts a Set directly', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.batchInsertItems([
                { id: 'a', vector: [1] },
                { id: 'b', vector: [2] }
            ]);
            yield index.deleteItems(new Set(['a']));
            node_assert_1.default.deepStrictEqual((yield index.listItems()).map(i => i.id), ['b']);
        }));
        it('silently ignores ids that do not exist', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.batchInsertItems([{ id: '1', vector: [1] }]);
            yield node_assert_1.default.doesNotReject(index.deleteItems(['missing', '1']));
            node_assert_1.default.deepStrictEqual((yield index.listItems()).map(i => i.id), []);
        }));
        it('no-ops on empty input without starting an update', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.batchInsertItems([{ id: '1', vector: [1] }]);
            yield index.deleteItems([]);
            node_assert_1.default.deepStrictEqual((yield index.listItems()).map(i => i.id), ['1']);
        }));
    });
    describe('beginUpdate shallow snapshot', () => {
        it('cancelUpdate does not leak in-progress changes back to _data', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.batchInsertItems([{ id: '1', vector: [1, 2, 3] }]);
            const before = (yield index.listItems())[0];
            yield index.beginUpdate();
            yield index.deleteItems(['1']);
            index.cancelUpdate();
            const after = (yield index.listItems())[0];
            node_assert_1.default.deepStrictEqual(after, before);
        }));
        it('upserting an existing item recomputes its norm from the new vector', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.insertItem({ id: '1', vector: [3, 4] }); // norm = 5
            yield index.upsertItem({ id: '1', vector: [6, 8] }); // norm should now be 10
            const item = (yield index.listItems()).find(i => i.id === '1');
            node_assert_1.default.ok(Math.abs(item.norm - 10) < 1e-9, `expected norm ~10, got ${item.norm}`);
        }));
        it('upserting an existing item does not mutate the previously committed snapshot', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex({ version: 1, metadata_config: { indexed: ['k'] } });
            yield index.insertItem({ id: '1', vector: [1, 0, 0], metadata: { k: 'first' } });
            // Capture a reference to the pre-upsert item from a list snapshot.
            const beforeRef = (yield index.listItems())[0];
            const beforeMetaSnapshot = Object.assign({}, beforeRef.metadata);
            yield index.upsertItem({ id: '1', vector: [0, 1, 0], metadata: { k: 'second' } });
            // The reference we captured before should be untouched by the upsert.
            node_assert_1.default.deepStrictEqual(beforeRef.metadata, beforeMetaSnapshot);
        }));
    });
    describe('endUpdate', () => {
        it('throws an error if no update has begun', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield index.endUpdate();
            }), new Error('No update in progress'));
        }));
        it('throws an error if the index could not be saved', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.beginUpdate();
            sinon_1.default.stub(promises_1.default, 'writeFile').rejects(new Error('fs error'));
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield index.endUpdate();
            }), new Error('Error saving index: Error: fs error'));
        }));
    });
    describe('getIndexStats', () => {
        it('reports empty index correctly', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            node_assert_1.default.deepStrictEqual(yield index.getIndexStats(), {
                version: 1,
                metadata_config: {},
                items: 0
            });
        }));
        it('correctly reports non-empty index stats', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex({ version: 1, metadata_config: { indexed: [] } });
            yield index.batchInsertItems(basicIndexItems);
            node_assert_1.default.deepStrictEqual(yield index.getIndexStats(), {
                version: 1,
                metadata_config: { indexed: [] },
                items: 3
            });
        }));
    });
    describe('getItem', () => {
        it('returns undefined when item not found', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            node_assert_1.default.equal(yield index.getItem('1'), undefined);
        }));
        it('returns requested item', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.batchInsertItems(basicIndexItems);
            const item2 = yield index.getItem('2');
            node_assert_1.default.equal(item2 === null || item2 === void 0 ? void 0 : item2.id, basicIndexItems[1].id);
            node_assert_1.default.deepStrictEqual(item2 === null || item2 === void 0 ? void 0 : item2.vector, basicIndexItems[1].vector);
            node_assert_1.default.equal((yield index.listItems()).length, 3);
        }));
    });
    describe('batchInsertItems', () => {
        it('should insert provided items', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            const newItems = yield index.batchInsertItems(basicIndexItems);
            node_assert_1.default.equal(newItems.length, 3);
            const retrievedItems = yield index.listItems();
            node_assert_1.default.equal(retrievedItems.length, 3);
        }));
        it('on id collision - cancel batch insert & bubble up error', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.insertItem({ id: '2', vector: [9, 9, 9] });
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield index.batchInsertItems(basicIndexItems);
            }), {
                name: 'Error',
                message: 'Item with id 2 already exists'
            });
            const storedItems = yield index.listItems();
            node_assert_1.default.equal(storedItems.length, 1);
        }));
    });
    describe('listItemsByMetadata', () => {
        it('returns items matching metadata filter', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.batchInsertItems([
                { id: '1', vector: [], metadata: { category: 'food' } },
                { id: '2', vector: [], metadata: { category: 'food' } },
                { id: '3', vector: [], metadata: { category: 'electronics' } },
                { id: '4', vector: [], metadata: { category: 'drink' } },
                { id: '5', vector: [], metadata: { category: 'food' } }
            ]);
            const foodItems = yield index.listItemsByMetadata({ category: { $eq: 'food' } });
            node_assert_1.default.deepStrictEqual(foodItems.map(item => item.id), ['1', '2', '5']);
            const drinkItems = yield index.listItemsByMetadata({ category: { $eq: 'drink' } });
            node_assert_1.default.deepStrictEqual(drinkItems.map(item => item.id), ['4']);
            const clothingItems = yield index.listItemsByMetadata({ category: { $eq: 'clothes' } });
            node_assert_1.default.deepStrictEqual(clothingItems, []);
        }));
        it('returns nothing when no items in index', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            const items = yield index.listItemsByMetadata({});
            node_assert_1.default.deepStrictEqual(items, []);
        }));
        it('empty filter {} with items returns all', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.batchInsertItems([
                { id: 'a', vector: [1] },
                { id: 'b', vector: [2] }
            ]);
            const items = yield index.listItemsByMetadata({});
            node_assert_1.default.deepStrictEqual(items.map(i => i.id), ['a', 'b']);
        }));
    });
    describe('metadata indexing behavior', () => {
        it('stores only indexed metadata in index and writes full metadata to external file', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex({ version: 1, metadata_config: { indexed: ['keep'] } });
            const realWriteFile = promises_1.default.writeFile.bind(promises_1.default);
            const writes = [];
            sinon_1.default.stub(promises_1.default, 'writeFile').callsFake((file, data, options) => __awaiter(void 0, void 0, void 0, function* () {
                writes.push({ file, data });
                return realWriteFile(file, data, options);
            }));
            yield index.insertItem({ id: 'm1', vector: [1], metadata: { keep: 'x', drop: 'y' } });
            const items = yield index.listItems();
            const stored = items.find(i => i.id === 'm1');
            node_assert_1.default.deepStrictEqual(stored.metadata, { keep: 'x' });
            node_assert_1.default.ok(stored.metadataFile);
            const textPayloads = writes
                .map(w => { var _a, _b; return (typeof w.data === 'string' ? w.data : (_b = (_a = w.data) === null || _a === void 0 ? void 0 : _a.toString) === null || _b === void 0 ? void 0 : _b.call(_a)); })
                .filter(Boolean);
            const hasFullMetadata = textPayloads.some(t => {
                try {
                    const obj = JSON.parse(t);
                    return obj && obj.keep === 'x' && obj.drop === 'y';
                }
                catch (_a) {
                    return false;
                }
            });
            node_assert_1.default.equal(hasFullMetadata, true);
        }));
        it('does not write external file when metadata only contains indexed keys', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex({ version: 1, metadata_config: { indexed: ['only'] } });
            yield index.insertItem({ id: 'm2', vector: [1], metadata: { only: 'ok' } });
            const item = yield index.getItem('m2');
            node_assert_1.default.deepStrictEqual(item === null || item === void 0 ? void 0 : item.metadata, { only: 'ok' });
            node_assert_1.default.equal(item.metadataFile, undefined);
        }));
    });
    describe('queryItems', () => {
        it('upsertItem uses the in-progress update path when _update is present', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.beginUpdate();
            // goes through the if (this._update) early return branch in upsertItem
            const up = yield index.upsertItem({ id: 'inplace', vector: [7, 7], metadata: { k: 'v' } });
            // not persisted until endUpdate
            let items = yield index.listItems();
            node_assert_1.default.equal(items.length, 0);
            yield index.endUpdate();
            items = yield index.listItems();
            node_assert_1.default.equal(items.length, 1);
            node_assert_1.default.equal(items[0].id, 'inplace');
            node_assert_1.default.deepStrictEqual(items[0].metadata, { k: 'v' });
        }));
        it('with no indexed config, full metadata is stored inline and no metadataFile is written', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex({ version: 1 /* metadata_config undefined => inline */ });
            yield index.insertItem({ id: 'fullMd', vector: [1], metadata: { a: 1, b: 2 } });
            const item = yield index.getItem('fullMd');
            node_assert_1.default.deepStrictEqual(item === null || item === void 0 ? void 0 : item.metadata, { a: 1, b: 2 });
            node_assert_1.default.equal(item.metadataFile, undefined);
        }));
        it('BM25 uses the default docReader (LocalDocument.loadText) when not injected', () => __awaiter(void 0, void 0, void 0, function* () {
            // stub LocalDocument.loadText so default docReader path runs without touching disk
            const stub = sinon_1.default.stub(LocalDocument_1.LocalDocument.prototype, 'loadText').resolves('Hello default docReader text');
            const addDocSpy = sinon_1.default.spy();
            const fakeEngine = {
                defineConfig: sinon_1.default.stub(),
                definePrepTasks: sinon_1.default.stub(),
                addDoc: (...a) => addDocSpy(...a),
                consolidate: sinon_1.default.stub(),
                search: (_q) => []
            };
            const index = new LocalIndex_1.LocalIndex(testIndexDir, undefined, undefined, undefined, { bm25Factory: () => fakeEngine /* no docReader injected */ });
            yield index.createIndex();
            yield index.batchInsertItems([
                { id: 'a', vector: [1, 0, 0], metadata: { documentId: 'docA', startPos: 0, endPos: 4 } },
                { id: 'b', vector: [0, 1, 0], metadata: { documentId: 'docB', startPos: 0, endPos: 4 } }
            ]);
            yield index.queryItems([1, 0, 0], 'kw', 1, undefined, true);
            node_assert_1.default.ok(addDocSpy.called); // default docReader loaded and chunks added
            stub.restore();
        }));
        it('executes the prepTask defined in setupBm25 to cover tokenization/negation pipeline', () => __awaiter(void 0, void 0, void 0, function* () {
            let capturedTasks = [];
            const fakeEngine = {
                defineConfig: sinon_1.default.stub(),
                definePrepTasks: (arr) => { capturedTasks = arr; },
                addDoc: sinon_1.default.stub(),
                consolidate: sinon_1.default.stub(),
                search: (_q) => []
            };
            const index = new LocalIndex_1.LocalIndex(testIndexDir, undefined, undefined, undefined, { bm25Factory: () => fakeEngine, docReader: () => __awaiter(void 0, void 0, void 0, function* () { return 'text'; }) });
            yield index.createIndex();
            // trigger setupBm25 via a BM25 query
            yield index.batchInsertItems([{ id: 'x', vector: [1], metadata: { documentId: 'd', startPos: 0, endPos: 0 } }]);
            yield index.queryItems([1], 'q', 1, undefined, true);
            node_assert_1.default.ok(Array.isArray(capturedTasks) && capturedTasks.length === 1);
            const tokens = capturedTasks[0]("I don't like complicated tokens!");
            // ensure pipeline ran: non-empty tokens, punctuation removed, possible negation handling
            node_assert_1.default.ok(Array.isArray(tokens) && tokens.length > 0);
        }));
        it('upsertItem uses the in-progress update path when _update is present', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.beginUpdate();
            yield index.upsertItem({ id: 'inplace', vector: [7, 7], metadata: { k: 'v' } });
            // Not persisted yet because endUpdate not called
            let items = yield index.listItems();
            node_assert_1.default.equal(items.length, 0);
            yield index.endUpdate();
            items = yield index.listItems();
            node_assert_1.default.equal(items.length, 1);
            node_assert_1.default.equal(items[0].id, 'inplace');
            node_assert_1.default.deepStrictEqual(items[0].metadata, { k: 'v' });
        }));
        it('with no indexed config, full metadata is stored inline and no metadataFile is written', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex({ version: 1 }); // metadata_config undefined => inline
            yield index.insertItem({ id: 'fullMd', vector: [1], metadata: { a: 1, b: 2 } });
            const item = yield index.getItem('fullMd');
            node_assert_1.default.deepStrictEqual(item === null || item === void 0 ? void 0 : item.metadata, { a: 1, b: 2 });
            node_assert_1.default.equal(item.metadataFile, undefined);
        }));
        it('BM25 uses the default docReader (LocalDocument.loadText) when not injected', () => __awaiter(void 0, void 0, void 0, function* () {
            const stub = sinon_1.default.stub(LocalDocument_1.LocalDocument.prototype, 'loadText').resolves('Hello default docReader text');
            const addDocSpy = sinon_1.default.spy();
            const fakeEngine = {
                defineConfig: sinon_1.default.stub(),
                definePrepTasks: sinon_1.default.stub(),
                addDoc: (...a) => addDocSpy(...a),
                consolidate: sinon_1.default.stub(),
                search: (_q) => []
            };
            const index = new LocalIndex_1.LocalIndex(testIndexDir, undefined, undefined, undefined, { bm25Factory: () => fakeEngine });
            yield index.createIndex();
            yield index.batchInsertItems([
                { id: 'a', vector: [1, 0, 0], metadata: { documentId: 'docA', startPos: 0, endPos: 4 } },
                { id: 'b', vector: [0, 1, 0], metadata: { documentId: 'docB', startPos: 0, endPos: 4 } }
            ]);
            yield index.queryItems([1, 0, 0], 'kw', 1, undefined, true);
            node_assert_1.default.ok(addDocSpy.called);
            stub.restore();
        }));
        it('executes the prepTask defined in setupBm25 to cover tokenization/negation pipeline', () => __awaiter(void 0, void 0, void 0, function* () {
            let capturedTasks = [];
            const fakeEngine = {
                defineConfig: sinon_1.default.stub(),
                definePrepTasks: (arr) => { capturedTasks = arr; },
                addDoc: sinon_1.default.stub(),
                consolidate: sinon_1.default.stub(),
                search: (_q) => []
            };
            const index = new LocalIndex_1.LocalIndex(testIndexDir, undefined, undefined, undefined, { bm25Factory: () => fakeEngine, docReader: () => __awaiter(void 0, void 0, void 0, function* () { return 'text'; }) });
            yield index.createIndex();
            yield index.batchInsertItems([{ id: 'x', vector: [1], metadata: { documentId: 'd', startPos: 0, endPos: 0 } }]);
            yield index.queryItems([1], 'q', 1, undefined, true);
            node_assert_1.default.ok(Array.isArray(capturedTasks) && capturedTasks.length === 1);
            const tokens = capturedTasks[0]("I don't like complicated tokens!");
            node_assert_1.default.ok(Array.isArray(tokens) && tokens.length > 0);
        }));
        it('returns empty array on empty index search', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            const result = yield index.queryItems([1, 2, 3], '', 10);
            node_assert_1.default.deepStrictEqual(result, []);
        }));
        it('returns bad match when no better match exists', () => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b;
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.insertItem({ id: '1', vector: [0.9, 0, 0, 0, 0] });
            const result = yield index.queryItems([0, 0, 0, 0, 0.1], '', 1);
            node_assert_1.default.equal((_a = result[0]) === null || _a === void 0 ? void 0 : _a.score, 0);
            node_assert_1.default.equal((_b = result[0]) === null || _b === void 0 ? void 0 : _b.item.id, '1');
        }));
        it('returns all vectors when fewer than topK exist', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.batchInsertItems(basicIndexItems);
            const result = yield index.queryItems([0, 0, 1], '', 10);
            node_assert_1.default.equal(result.length, 3);
            node_assert_1.default.deepStrictEqual(result.map(({ item }) => item.id), basicIndexItems.map(item => item.id));
        }));
        it('limits results to topK when more items exist', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.batchInsertItems([
                { id: 'a', vector: [1, 0, 0] },
                { id: 'b', vector: [0, 1, 0] },
                { id: 'c', vector: [0, 0, 1] },
                { id: 'd', vector: [1, 1, 0] },
                { id: 'e', vector: [0, 1, 1] }
            ]);
            const result = yield index.queryItems([1, 0, 0], '', 2);
            node_assert_1.default.equal(result.length, 2);
        }));
        it('filters by metadata when filter provided', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex();
            yield index.batchInsertItems([
                { id: '1', vector: [1, 0, 0], metadata: { category: 'food' } },
                { id: '2', vector: [0, 0, 1], metadata: { category: 'drink' } }
            ]);
            const bestGeneralMatch = yield index.queryItems([1, 0, 0], '', 1);
            const bestDrinkMatch = yield index.queryItems([1, 0, 0], '', 1, {
                category: { $eq: 'drink' }
            });
            node_assert_1.default.equal(bestGeneralMatch[0].item.id, '1');
            node_assert_1.default.equal(bestDrinkMatch[0].item.id, '2');
        }));
        it('reads item metadata file when provided', () => __awaiter(void 0, void 0, void 0, function* () {
            const index = new LocalIndex_1.LocalIndex(testIndexDir);
            yield index.createIndex({ version: 1, metadata_config: { indexed: ['category'] } });
            yield index.batchInsertItems([
                { id: '1', vector: [1, 0, 0] },
                { id: '2', vector: [0, 0, 1], metadata: { category: 'drink', extra: 'x' } }
            ]);
            sinon_1.default.stub(promises_1.default, 'readFile').resolves(JSON.stringify({ category: 'drink', extra: 'x' }));
            const bestDrinkMatch = yield index.queryItems([1, 0, 0], '', 2, { category: { $eq: 'drink' } });
            node_assert_1.default.notEqual(bestDrinkMatch[0].item.metadataFile, undefined);
            node_assert_1.default.equal(bestDrinkMatch[0].item.id, '2');
        }));
        it('appends BM25 results when isBm25=true (tuple results)', () => __awaiter(void 0, void 0, void 0, function* () {
            // Inject a fake BM25 engine and docReader
            const addDocSpy = sinon_1.default.spy();
            const consolidateSpy = sinon_1.default.spy();
            const fakeEngine = {
                defineConfig: sinon_1.default.stub(),
                definePrepTasks: sinon_1.default.stub(),
                addDoc: (...a) => addDocSpy(...a),
                consolidate: (...a) => consolidateSpy(...a),
                search: (q) => {
                    void q;
                    // results as tuples [index, score]
                    return [[0, 0.123], [1, 0.122]];
                }
            };
            const index = new LocalIndex_1.LocalIndex(testIndexDir, undefined, undefined, undefined, {
                bm25Factory: () => fakeEngine,
                docReader: (_docId) => __awaiter(void 0, void 0, void 0, function* () { return 'SAMPLETEXT'; })
            });
            yield index.createIndex();
            yield index.batchInsertItems([
                { id: 's1', vector: [1, 0, 0], metadata: { category: 'alpha', documentId: 'd1', startPos: 0, endPos: 3 } },
                { id: 's2', vector: [0, 1, 0], metadata: { category: 'beta', documentId: 'd2', startPos: 0, endPos: 3 } },
                { id: 's3', vector: [0, 0, 1], metadata: { category: 'gamma', documentId: 'd3', startPos: 0, endPos: 3 } }
            ]);
            const topK = 1;
            const results = yield index.queryItems([1, 0, 0], 'keyword', topK, undefined, true);
            node_assert_1.default.ok(results.length >= 1);
            node_assert_1.default.ok(results.some(r => { var _a; return ((_a = r.item.metadata) === null || _a === void 0 ? void 0 : _a.isBm25) === true; }));
            node_assert_1.default.ok(consolidateSpy.calledOnce);
            // only non-top items should have been offered to addDoc (top item excluded)
            node_assert_1.default.ok(addDocSpy.callCount >= 1);
        }));
        it('BM25 indexes only non-top items with document metadata, calls consolidate, and swallows load errors', () => __awaiter(void 0, void 0, void 0, function* () {
            // docReader returns text for docB, throws for docC
            const addDocSpy = sinon_1.default.spy();
            const consolidateSpy = sinon_1.default.spy();
            const fakeEngine = {
                defineConfig: sinon_1.default.stub(),
                definePrepTasks: sinon_1.default.stub(),
                addDoc: (...a) => addDocSpy(...a),
                consolidate: (...a) => consolidateSpy(...a),
                search: (_q) => {
                    // invalid tuple index is ignored
                    return [[999, 0.77]];
                }
            };
            const docReader = (docId) => __awaiter(void 0, void 0, void 0, function* () {
                if (docId === 'docB')
                    return 'ABCDEFGHIJ';
                if (docId === 'docC')
                    throw new Error('load failed');
                return '';
            });
            const index = new LocalIndex_1.LocalIndex(testIndexDir, undefined, undefined, undefined, { bm25Factory: () => fakeEngine, docReader });
            yield index.createIndex();
            yield index.batchInsertItems([
                { id: 'sTop', vector: [1, 0, 0], metadata: { documentId: 'docA', startPos: 0, endPos: 4 } },
                { id: 'd1', vector: [0, 1, 0], metadata: { documentId: 'docB', startPos: 0, endPos: 4 } },
                { id: 'd2', vector: [0, 0, 1], metadata: { documentId: 'docC', startPos: 0, endPos: 4 } }
            ]);
            const res = yield index.queryItems([1, 0, 0], 'kw', 1, undefined, true);
            node_assert_1.default.equal(addDocSpy.callCount, 1); // only d1 added; d2 threw; sTop excluded
            node_assert_1.default.equal(consolidateSpy.callCount, 1);
            node_assert_1.default.ok(res.length >= 1);
        }));
        it('BM25 object results are appended and marked isBm25 even if item is undefined', () => __awaiter(void 0, void 0, void 0, function* () {
            const fakeEngine = {
                defineConfig: sinon_1.default.stub(),
                definePrepTasks: sinon_1.default.stub(),
                addDoc: sinon_1.default.stub(),
                consolidate: sinon_1.default.stub(),
                search: (_q) => [{ item: undefined, score: 0.55 }]
            };
            const index = new LocalIndex_1.LocalIndex(testIndexDir, undefined, undefined, undefined, { bm25Factory: () => fakeEngine, docReader: () => __awaiter(void 0, void 0, void 0, function* () { return 'YY'; }) });
            yield index.createIndex();
            yield index.batchInsertItems([
                { id: 'x1', vector: [1, 0], metadata: { documentId: 'doc1', startPos: 0, endPos: 1 } },
                { id: 'x2', vector: [0, 1], metadata: { documentId: 'doc2', startPos: 0, endPos: 1 } }
            ]);
            const res = yield index.queryItems([1, 0], 'any', 1, undefined, true);
            node_assert_1.default.ok(res.some(r => { var _a; return ((_a = r.item.metadata) === null || _a === void 0 ? void 0 : _a.isBm25) === true; }));
        }));
        it('BM25 engine missing addDoc/consolidate does not throw and returns semantic results', () => __awaiter(void 0, void 0, void 0, function* () {
            const fakeEngine = {
                defineConfig: sinon_1.default.stub(),
                definePrepTasks: sinon_1.default.stub(),
                search: (_q) => []
            };
            const index = new LocalIndex_1.LocalIndex(testIndexDir, undefined, undefined, undefined, { bm25Factory: () => fakeEngine, docReader: () => __awaiter(void 0, void 0, void 0, function* () { return 'YY'; }) });
            yield index.createIndex();
            yield index.batchInsertItems([
                { id: 's1', vector: [1, 0], metadata: { documentId: 'doc1', startPos: 0, endPos: 1 } },
                { id: 's2', vector: [0, 1], metadata: { documentId: 'doc2', startPos: 0, endPos: 1 } }
            ]);
            const res = yield index.queryItems([1, 0], 'kw', 1, undefined, true);
            node_assert_1.default.ok(res.length >= 1);
            node_assert_1.default.ok(res.every(r => { var _a; return !((_a = r.item.metadata) === null || _a === void 0 ? void 0 : _a.isBm25); }));
        }));
    });
    describe('VirtualFileStorage (in-memory)', () => {
        it('works end-to-end in-memory without touching disk', () => __awaiter(void 0, void 0, void 0, function* () {
            const storage = new storage_1.VirtualFileStorage();
            const index = new LocalIndex_1.LocalIndex('mem://idx', undefined, storage);
            yield index.createIndex({ version: 3, metadata_config: { indexed: ['t'] } });
            yield index.insertItem({ vector: [1], metadata: { t: 'x', other: 'y' } });
            const stats = yield index.getIndexStats();
            node_assert_1.default.deepStrictEqual(stats, { version: 3, metadata_config: { indexed: ['t'] }, items: 1 });
        }));
    });
});
//# sourceMappingURL=LocalIndex.spec.js.map