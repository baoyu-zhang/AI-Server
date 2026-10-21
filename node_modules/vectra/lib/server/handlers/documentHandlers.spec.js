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
const documentHandlers_1 = require("./documentHandlers");
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
describe('documentHandlers', () => {
    let manager;
    beforeEach(() => {
        manager = sinon.createStubInstance(IndexManager_1.IndexManager);
    });
    afterEach(() => {
        sinon.restore();
    });
    describe('UpsertDocument', () => {
        it('should require index_name', () => __awaiter(void 0, void 0, void 0, function* () {
            const handlers = (0, documentHandlers_1.createDocumentHandlers)(manager);
            try {
                yield callHandler(handlers.UpsertDocument, {});
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
                assert.ok(err.message.includes('index_name'));
            }
        }));
        it('should require uri', () => __awaiter(void 0, void 0, void 0, function* () {
            const handlers = (0, documentHandlers_1.createDocumentHandlers)(manager);
            try {
                yield callHandler(handlers.UpsertDocument, { index_name: 'test' });
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
                assert.ok(err.message.includes('uri'));
            }
        }));
        it('should require text', () => __awaiter(void 0, void 0, void 0, function* () {
            const handlers = (0, documentHandlers_1.createDocumentHandlers)(manager);
            try {
                yield callHandler(handlers.UpsertDocument, { index_name: 'test', uri: 'doc.txt' });
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
                assert.ok(err.message.includes('text'));
            }
        }));
        it('should upsert a document and return id', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockDocIndex = {
                upsertDocument: sinon.stub().resolves({ id: 'doc-123' }),
            };
            manager.requireDocumentIndex.returns({ managed: {}, docIndex: mockDocIndex });
            const handlers = (0, documentHandlers_1.createDocumentHandlers)(manager);
            const result = yield callHandler(handlers.UpsertDocument, {
                index_name: 'test',
                uri: 'doc.txt',
                text: 'Hello world',
            });
            assert.strictEqual(result.document_id, 'doc-123');
            assert.ok(mockDocIndex.upsertDocument.calledOnce);
            assert.strictEqual(mockDocIndex.upsertDocument.firstCall.args[0], 'doc.txt');
            assert.strictEqual(mockDocIndex.upsertDocument.firstCall.args[1], 'Hello world');
        }));
        it('should pass doc_type when provided', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockDocIndex = {
                upsertDocument: sinon.stub().resolves({ id: 'doc-123' }),
            };
            manager.requireDocumentIndex.returns({ managed: {}, docIndex: mockDocIndex });
            const handlers = (0, documentHandlers_1.createDocumentHandlers)(manager);
            yield callHandler(handlers.UpsertDocument, {
                index_name: 'test',
                uri: 'doc.md',
                text: '# Title',
                doc_type: 'markdown',
            });
            assert.strictEqual(mockDocIndex.upsertDocument.firstCall.args[2], 'markdown');
        }));
        it('should pass metadata when provided', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockDocIndex = {
                upsertDocument: sinon.stub().resolves({ id: 'doc-123' }),
            };
            manager.requireDocumentIndex.returns({ managed: {}, docIndex: mockDocIndex });
            const handlers = (0, documentHandlers_1.createDocumentHandlers)(manager);
            yield callHandler(handlers.UpsertDocument, {
                index_name: 'test',
                uri: 'doc.txt',
                text: 'content',
                metadata: { author: { string_value: 'alice' } },
            });
            assert.deepStrictEqual(mockDocIndex.upsertDocument.firstCall.args[3], { author: 'alice' });
        }));
        it('should pass undefined metadata when empty', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockDocIndex = {
                upsertDocument: sinon.stub().resolves({ id: 'doc-123' }),
            };
            manager.requireDocumentIndex.returns({ managed: {}, docIndex: mockDocIndex });
            const handlers = (0, documentHandlers_1.createDocumentHandlers)(manager);
            yield callHandler(handlers.UpsertDocument, {
                index_name: 'test',
                uri: 'doc.txt',
                text: 'content',
                metadata: {},
            });
            assert.strictEqual(mockDocIndex.upsertDocument.firstCall.args[3], undefined);
        }));
    });
    describe('DeleteDocument', () => {
        it('should require index_name', () => __awaiter(void 0, void 0, void 0, function* () {
            const handlers = (0, documentHandlers_1.createDocumentHandlers)(manager);
            try {
                yield callHandler(handlers.DeleteDocument, {});
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
            }
        }));
        it('should require uri', () => __awaiter(void 0, void 0, void 0, function* () {
            const handlers = (0, documentHandlers_1.createDocumentHandlers)(manager);
            try {
                yield callHandler(handlers.DeleteDocument, { index_name: 'test' });
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
                assert.ok(err.message.includes('uri'));
            }
        }));
        it('should delete a document', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockDocIndex = {
                deleteDocument: sinon.stub().resolves(),
            };
            manager.requireDocumentIndex.returns({ managed: {}, docIndex: mockDocIndex });
            const handlers = (0, documentHandlers_1.createDocumentHandlers)(manager);
            const result = yield callHandler(handlers.DeleteDocument, {
                index_name: 'test',
                uri: 'doc.txt',
            });
            assert.deepStrictEqual(result, {});
            assert.ok(mockDocIndex.deleteDocument.calledWith('doc.txt'));
        }));
    });
    describe('ListDocuments', () => {
        it('should require index_name', () => __awaiter(void 0, void 0, void 0, function* () {
            const handlers = (0, documentHandlers_1.createDocumentHandlers)(manager);
            try {
                yield callHandler(handlers.ListDocuments, {});
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
            }
        }));
        it('should list documents', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockDocIndex = {
                listDocuments: sinon.stub().resolves([
                    { uri: 'a.txt', id: 'doc-1' },
                    { uri: 'b.txt', id: 'doc-2' },
                ]),
            };
            manager.requireDocumentIndex.returns({ managed: {}, docIndex: mockDocIndex });
            const handlers = (0, documentHandlers_1.createDocumentHandlers)(manager);
            const result = yield callHandler(handlers.ListDocuments, {
                index_name: 'test',
            });
            assert.strictEqual(result.documents.length, 2);
            assert.strictEqual(result.documents[0].uri, 'a.txt');
            assert.strictEqual(result.documents[0].document_id, 'doc-1');
            assert.strictEqual(result.documents[1].uri, 'b.txt');
        }));
    });
});
//# sourceMappingURL=documentHandlers.spec.js.map