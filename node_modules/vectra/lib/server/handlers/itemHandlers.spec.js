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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert = __importStar(require("assert"));
const sinon = __importStar(require("sinon"));
const grpc = __importStar(require("@grpc/grpc-js"));
const itemHandlers_1 = require("./itemHandlers");
const IndexManager_1 = require("../IndexManager");
function callHandler(handler, request) {
    return new Promise((resolve, reject) => {
        handler({ request }, (err, result) => {
            if (err)
                reject(err);
            else
                resolve(result);
        });
    });
}
describe('itemHandlers', () => {
    let manager;
    let embeddings;
    beforeEach(() => {
        manager = sinon.createStubInstance(IndexManager_1.IndexManager);
        embeddings = {
            createEmbeddings: sinon.stub(),
            maxTokens: 8192,
        };
    });
    afterEach(() => {
        sinon.restore();
    });
    describe('InsertItem', () => {
        it('should require index_name', () => __awaiter(void 0, void 0, void 0, function* () {
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            try {
                yield callHandler(handlers.InsertItem, {});
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
                assert.ok(err.message.includes('index_name'));
            }
        }));
        it('should insert with vector', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockIndex = {
                insertItem: sinon.stub().resolves({ id: 'item-1' }),
            };
            manager.requireIndex.returns({ index: mockIndex, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            const result = yield callHandler(handlers.InsertItem, {
                index_name: 'test',
                vector: [0.1, 0.2],
                id: 'item-1',
                metadata: { tag: { string_value: 'a' } },
            });
            assert.strictEqual(result.id, 'item-1');
            const insertedItem = mockIndex.insertItem.firstCall.args[0];
            assert.strictEqual(insertedItem.id, 'item-1');
            assert.deepStrictEqual(insertedItem.vector, [0.1, 0.2]);
            assert.deepStrictEqual(insertedItem.metadata, { tag: 'a' });
        }));
        it('should insert with text using embeddings', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockIndex = {
                insertItem: sinon.stub().resolves({ id: 'item-2' }),
            };
            manager.requireIndex.returns({ index: mockIndex, name: 'test', isDocumentIndex: false, format: 'json' });
            embeddings.createEmbeddings.resolves({
                status: 'success',
                output: [[0.3, 0.4]],
            });
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager, embeddings);
            const result = yield callHandler(handlers.InsertItem, {
                index_name: 'test',
                text: 'hello',
            });
            assert.ok(result.id); // auto-generated UUID
            const insertedItem = mockIndex.insertItem.firstCall.args[0];
            assert.deepStrictEqual(insertedItem.vector, [0.3, 0.4]);
        }));
        it('should fail without text or vector', () => __awaiter(void 0, void 0, void 0, function* () {
            manager.requireIndex.returns({ index: {}, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            try {
                yield callHandler(handlers.InsertItem, { index_name: 'test' });
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
                assert.ok(err.message.includes('text or vector'));
            }
        }));
        it('should fail when text provided but no embeddings model', () => __awaiter(void 0, void 0, void 0, function* () {
            manager.requireIndex.returns({ index: {}, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager); // no embeddings
            try {
                yield callHandler(handlers.InsertItem, { index_name: 'test', text: 'hello' });
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.FAILED_PRECONDITION);
            }
        }));
        it('should fail when embeddings returns error', () => __awaiter(void 0, void 0, void 0, function* () {
            manager.requireIndex.returns({ index: {}, name: 'test', isDocumentIndex: false, format: 'json' });
            embeddings.createEmbeddings.resolves({ status: 'error', message: 'quota exceeded' });
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager, embeddings);
            try {
                yield callHandler(handlers.InsertItem, { index_name: 'test', text: 'hello' });
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INTERNAL);
                assert.ok(err.message.includes('quota exceeded'));
            }
        }));
    });
    describe('UpsertItem', () => {
        it('should require index_name', () => __awaiter(void 0, void 0, void 0, function* () {
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            try {
                yield callHandler(handlers.UpsertItem, {});
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
            }
        }));
        it('should require id', () => __awaiter(void 0, void 0, void 0, function* () {
            manager.requireIndex.returns({ index: {}, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            try {
                yield callHandler(handlers.UpsertItem, { index_name: 'test' });
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
                assert.ok(err.message.includes('id'));
            }
        }));
        it('should upsert with vector', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockIndex = {
                upsertItem: sinon.stub().resolves({ id: 'item-1' }),
            };
            manager.requireIndex.returns({ index: mockIndex, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            const result = yield callHandler(handlers.UpsertItem, {
                index_name: 'test',
                id: 'item-1',
                vector: [0.1, 0.2],
            });
            assert.strictEqual(result.id, 'item-1');
        }));
    });
    describe('BatchInsertItems', () => {
        it('should require index_name', () => __awaiter(void 0, void 0, void 0, function* () {
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            try {
                yield callHandler(handlers.BatchInsertItems, {});
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
            }
        }));
        it('should batch insert items', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockIndex = {
                batchInsertItems: sinon.stub().resolves([{ id: 'a' }, { id: 'b' }]),
            };
            manager.requireIndex.returns({ index: mockIndex, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            const result = yield callHandler(handlers.BatchInsertItems, {
                index_name: 'test',
                items: [
                    { vector: [0.1, 0.2], metadata: {}, id: 'a' },
                    { vector: [0.3, 0.4], metadata: {}, id: 'b' },
                ],
            });
            assert.deepStrictEqual(result.ids, ['a', 'b']);
        }));
        it('should handle empty items array', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockIndex = {
                batchInsertItems: sinon.stub().resolves([]),
            };
            manager.requireIndex.returns({ index: mockIndex, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            const result = yield callHandler(handlers.BatchInsertItems, {
                index_name: 'test',
            });
            assert.deepStrictEqual(result.ids, []);
        }));
    });
    describe('GetItem', () => {
        it('should require index_name', () => __awaiter(void 0, void 0, void 0, function* () {
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            try {
                yield callHandler(handlers.GetItem, {});
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
            }
        }));
        it('should require id', () => __awaiter(void 0, void 0, void 0, function* () {
            manager.requireIndex.returns({ index: {}, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            try {
                yield callHandler(handlers.GetItem, { index_name: 'test' });
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
                assert.ok(err.message.includes('id'));
            }
        }));
        it('should return item', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockIndex = {
                getItem: sinon.stub().resolves({
                    id: 'item-1',
                    metadata: { tag: 'a' },
                    vector: [0.1, 0.2],
                    norm: 1.0,
                }),
            };
            manager.requireIndex.returns({ index: mockIndex, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            const result = yield callHandler(handlers.GetItem, {
                index_name: 'test',
                id: 'item-1',
            });
            assert.strictEqual(result.item.id, 'item-1');
            assert.deepStrictEqual(result.item.vector, [0.1, 0.2]);
        }));
        it('should return NOT_FOUND for missing item', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockIndex = {
                getItem: sinon.stub().resolves(undefined),
            };
            manager.requireIndex.returns({ index: mockIndex, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            try {
                yield callHandler(handlers.GetItem, { index_name: 'test', id: 'missing' });
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.NOT_FOUND);
            }
        }));
    });
    describe('DeleteItem', () => {
        it('should require index_name', () => __awaiter(void 0, void 0, void 0, function* () {
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            try {
                yield callHandler(handlers.DeleteItem, {});
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
            }
        }));
        it('should require id', () => __awaiter(void 0, void 0, void 0, function* () {
            manager.requireIndex.returns({ index: {}, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            try {
                yield callHandler(handlers.DeleteItem, { index_name: 'test' });
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
            }
        }));
        it('should delete item', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockIndex = {
                deleteItem: sinon.stub().resolves(),
            };
            manager.requireIndex.returns({ index: mockIndex, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            const result = yield callHandler(handlers.DeleteItem, {
                index_name: 'test',
                id: 'item-1',
            });
            assert.deepStrictEqual(result, {});
            assert.ok(mockIndex.deleteItem.calledWith('item-1'));
        }));
    });
    describe('ListItems', () => {
        it('should require index_name', () => __awaiter(void 0, void 0, void 0, function* () {
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            try {
                yield callHandler(handlers.ListItems, {});
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
            }
        }));
        it('should list all items without filter', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockIndex = {
                listItems: sinon.stub().resolves([
                    { id: 'a', metadata: {}, vector: [0.1], norm: 1.0 },
                    { id: 'b', metadata: {}, vector: [0.2], norm: 1.0 },
                ]),
            };
            manager.requireIndex.returns({ index: mockIndex, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            const result = yield callHandler(handlers.ListItems, { index_name: 'test' });
            assert.strictEqual(result.items.length, 2);
            assert.ok(mockIndex.listItems.calledOnce);
        }));
        it('should list items with filter', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockIndex = {
                listItemsByMetadata: sinon.stub().resolves([
                    { id: 'a', metadata: { tag: 'x' }, vector: [0.1], norm: 1.0 },
                ]),
            };
            manager.requireIndex.returns({ index: mockIndex, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, itemHandlers_1.createItemHandlers)(manager);
            const result = yield callHandler(handlers.ListItems, {
                index_name: 'test',
                filter: { filter_json: '{"tag":"x"}' },
            });
            assert.strictEqual(result.items.length, 1);
            assert.ok(mockIndex.listItemsByMetadata.calledWith({ tag: 'x' }));
        }));
    });
});
//# sourceMappingURL=itemHandlers.spec.js.map