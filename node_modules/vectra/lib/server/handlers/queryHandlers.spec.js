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
const queryHandlers_1 = require("./queryHandlers");
const IndexManager_1 = require("../IndexManager");
function makeCall(request) {
    return { request };
}
function callHandler(handler, request) {
    return new Promise((resolve, reject) => {
        handler(makeCall(request), (err, result) => {
            if (err)
                reject(err);
            else
                resolve(result);
        });
    });
}
describe('queryHandlers', () => {
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
    describe('QueryItems', () => {
        it('should require index_name', () => __awaiter(void 0, void 0, void 0, function* () {
            const handlers = (0, queryHandlers_1.createQueryHandlers)(manager);
            try {
                yield callHandler(handlers.QueryItems, {});
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
                assert.ok(err.message.includes('index_name'));
            }
        }));
        it('should query by vector', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockIndex = {
                queryItems: sinon.stub().resolves([
                    {
                        item: { id: 'item-1', metadata: { tag: 'a' }, vector: [0.1, 0.2], norm: 1.0 },
                        score: 0.95,
                    },
                ]),
            };
            manager.requireIndex.returns({ index: mockIndex, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, queryHandlers_1.createQueryHandlers)(manager);
            const result = yield callHandler(handlers.QueryItems, {
                index_name: 'test',
                vector: [0.1, 0.2],
                top_k: 5,
            });
            assert.strictEqual(result.results.length, 1);
            assert.strictEqual(result.results[0].id, 'item-1');
            assert.strictEqual(result.results[0].score, 0.95);
            assert.ok(mockIndex.queryItems.calledOnce);
            assert.deepStrictEqual(mockIndex.queryItems.firstCall.args[0], [0.1, 0.2]);
            assert.strictEqual(mockIndex.queryItems.firstCall.args[2], 5);
        }));
        it('should default top_k to 10', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockIndex = { queryItems: sinon.stub().resolves([]) };
            manager.requireIndex.returns({ index: mockIndex, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, queryHandlers_1.createQueryHandlers)(manager);
            yield callHandler(handlers.QueryItems, {
                index_name: 'test',
                vector: [0.1, 0.2],
            });
            assert.strictEqual(mockIndex.queryItems.firstCall.args[2], 10);
        }));
        it('should query by text using embeddings', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockIndex = { queryItems: sinon.stub().resolves([]) };
            manager.requireIndex.returns({ index: mockIndex, name: 'test', isDocumentIndex: false, format: 'json' });
            embeddings.createEmbeddings.resolves({
                status: 'success',
                output: [[0.5, 0.6]],
            });
            const handlers = (0, queryHandlers_1.createQueryHandlers)(manager, embeddings);
            yield callHandler(handlers.QueryItems, {
                index_name: 'test',
                text: 'hello world',
            });
            assert.ok(embeddings.createEmbeddings.calledWith('hello world'));
            assert.deepStrictEqual(mockIndex.queryItems.firstCall.args[0], [0.5, 0.6]);
        }));
        it('should fail when text provided but no embeddings model', () => __awaiter(void 0, void 0, void 0, function* () {
            manager.requireIndex.returns({ index: {}, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, queryHandlers_1.createQueryHandlers)(manager); // no embeddings
            try {
                yield callHandler(handlers.QueryItems, {
                    index_name: 'test',
                    text: 'hello',
                });
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.FAILED_PRECONDITION);
                assert.ok(err.message.includes('No embeddings model'));
            }
        }));
        it('should fail when embeddings returns error', () => __awaiter(void 0, void 0, void 0, function* () {
            manager.requireIndex.returns({ index: {}, name: 'test', isDocumentIndex: false, format: 'json' });
            embeddings.createEmbeddings.resolves({
                status: 'error',
                message: 'rate limited',
            });
            const handlers = (0, queryHandlers_1.createQueryHandlers)(manager, embeddings);
            try {
                yield callHandler(handlers.QueryItems, {
                    index_name: 'test',
                    text: 'hello',
                });
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INTERNAL);
                assert.ok(err.message.includes('rate limited'));
            }
        }));
        it('should require text or vector', () => __awaiter(void 0, void 0, void 0, function* () {
            manager.requireIndex.returns({ index: {}, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, queryHandlers_1.createQueryHandlers)(manager);
            try {
                yield callHandler(handlers.QueryItems, {
                    index_name: 'test',
                });
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
                assert.ok(err.message.includes('text or vector'));
            }
        }));
        it('should pass filter to queryItems', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockIndex = { queryItems: sinon.stub().resolves([]) };
            manager.requireIndex.returns({ index: mockIndex, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, queryHandlers_1.createQueryHandlers)(manager);
            yield callHandler(handlers.QueryItems, {
                index_name: 'test',
                vector: [0.1],
                filter: { filter_json: '{"tag":"a"}' },
            });
            assert.deepStrictEqual(mockIndex.queryItems.firstCall.args[3], { tag: 'a' });
        }));
    });
    describe('QueryDocuments', () => {
        it('should require index_name', () => __awaiter(void 0, void 0, void 0, function* () {
            const handlers = (0, queryHandlers_1.createQueryHandlers)(manager);
            try {
                yield callHandler(handlers.QueryDocuments, {});
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
            }
        }));
        it('should require query', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockDocIndex = {};
            manager.requireDocumentIndex.returns({ managed: {}, docIndex: mockDocIndex });
            const handlers = (0, queryHandlers_1.createQueryHandlers)(manager);
            try {
                yield callHandler(handlers.QueryDocuments, {
                    index_name: 'test',
                });
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
                assert.ok(err.message.includes('query'));
            }
        }));
        it('should query documents and return results', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockDocIndex = {
                queryDocuments: sinon.stub().resolves([
                    {
                        uri: 'doc1.txt',
                        id: 'doc-1',
                        score: 0.9,
                        chunks: [
                            {
                                item: { metadata: { startPos: 0, endPos: 4 } },
                                score: 0.9,
                            },
                        ],
                        loadText: sinon.stub().resolves('hello world'),
                    },
                ]),
            };
            manager.requireDocumentIndex.returns({ managed: {}, docIndex: mockDocIndex });
            const handlers = (0, queryHandlers_1.createQueryHandlers)(manager);
            const result = yield callHandler(handlers.QueryDocuments, {
                index_name: 'test',
                query: 'search term',
                max_documents: 5,
                max_chunks: 20,
            });
            assert.strictEqual(result.results.length, 1);
            assert.strictEqual(result.results[0].uri, 'doc1.txt');
            assert.strictEqual(result.results[0].document_id, 'doc-1');
            assert.strictEqual(result.results[0].score, 0.9);
            assert.strictEqual(result.results[0].chunks.length, 1);
            assert.strictEqual(result.results[0].chunks[0].text, 'hello');
            assert.strictEqual(result.results[0].chunks[0].score, 0.9);
        }));
        it('should handle chunk text loading failure gracefully', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockDocIndex = {
                queryDocuments: sinon.stub().resolves([
                    {
                        uri: 'doc1.txt',
                        id: 'doc-1',
                        score: 0.8,
                        chunks: [
                            {
                                item: { metadata: { startPos: 0, endPos: 4 } },
                                score: 0.8,
                            },
                        ],
                        loadText: sinon.stub().rejects(new Error('file gone')),
                    },
                ]),
            };
            manager.requireDocumentIndex.returns({ managed: {}, docIndex: mockDocIndex });
            const handlers = (0, queryHandlers_1.createQueryHandlers)(manager);
            const result = yield callHandler(handlers.QueryDocuments, {
                index_name: 'test',
                query: 'search',
            });
            assert.strictEqual(result.results[0].chunks[0].text, '');
        }));
        it('should pass filter and bm25 options', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockDocIndex = { queryDocuments: sinon.stub().resolves([]) };
            manager.requireDocumentIndex.returns({ managed: {}, docIndex: mockDocIndex });
            const handlers = (0, queryHandlers_1.createQueryHandlers)(manager);
            yield callHandler(handlers.QueryDocuments, {
                index_name: 'test',
                query: 'search',
                filter: { filter_json: '{"tag":"b"}' },
                use_bm25: true,
            });
            const opts = mockDocIndex.queryDocuments.firstCall.args[1];
            assert.deepStrictEqual(opts.filter, { tag: 'b' });
            assert.strictEqual(opts.isBm25, true);
        }));
    });
});
//# sourceMappingURL=queryHandlers.spec.js.map