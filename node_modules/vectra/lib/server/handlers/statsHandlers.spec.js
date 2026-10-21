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
const statsHandlers_1 = require("./statsHandlers");
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
describe('statsHandlers', () => {
    let manager;
    beforeEach(() => {
        manager = sinon.createStubInstance(IndexManager_1.IndexManager);
    });
    afterEach(() => {
        sinon.restore();
    });
    describe('GetIndexStats', () => {
        it('should require index_name', () => __awaiter(void 0, void 0, void 0, function* () {
            const handlers = (0, statsHandlers_1.createStatsHandlers)(manager);
            try {
                yield callHandler(handlers.GetIndexStats, {});
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
            }
        }));
        it('should return index stats', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockIndex = {
                getIndexStats: sinon.stub().resolves({
                    version: 1,
                    items: 42,
                    metadata_config: { indexed: ['tag', 'score'] },
                }),
            };
            manager.requireIndex.returns({ index: mockIndex, name: 'test', isDocumentIndex: false, format: 'protobuf' });
            const handlers = (0, statsHandlers_1.createStatsHandlers)(manager);
            const result = yield callHandler(handlers.GetIndexStats, { index_name: 'test' });
            assert.strictEqual(result.version, 1);
            assert.strictEqual(result.format, 'protobuf');
            assert.strictEqual(result.item_count, 42);
            assert.strictEqual(result.metadata_config_count, 2);
        }));
        it('should handle missing metadata_config', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockIndex = {
                getIndexStats: sinon.stub().resolves({
                    version: 1,
                    items: 0,
                    metadata_config: {},
                }),
            };
            manager.requireIndex.returns({ index: mockIndex, name: 'test', isDocumentIndex: false, format: 'json' });
            const handlers = (0, statsHandlers_1.createStatsHandlers)(manager);
            const result = yield callHandler(handlers.GetIndexStats, { index_name: 'test' });
            assert.strictEqual(result.metadata_config_count, 0);
        }));
    });
    describe('GetCatalogStats', () => {
        it('should require index_name', () => __awaiter(void 0, void 0, void 0, function* () {
            const handlers = (0, statsHandlers_1.createStatsHandlers)(manager);
            try {
                yield callHandler(handlers.GetCatalogStats, {});
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
            }
        }));
        it('should return catalog stats', () => __awaiter(void 0, void 0, void 0, function* () {
            const mockDocIndex = {
                getCatalogStats: sinon.stub().resolves({
                    version: 1,
                    documents: 10,
                    chunks: 150,
                }),
            };
            manager.requireDocumentIndex.returns({ managed: {}, docIndex: mockDocIndex });
            const handlers = (0, statsHandlers_1.createStatsHandlers)(manager);
            const result = yield callHandler(handlers.GetCatalogStats, { index_name: 'test' });
            assert.strictEqual(result.version, 1);
            assert.strictEqual(result.document_count, 10);
            assert.strictEqual(result.chunk_count, 150);
            assert.deepStrictEqual(result.metadata_counts, {});
        }));
    });
});
//# sourceMappingURL=statsHandlers.spec.js.map