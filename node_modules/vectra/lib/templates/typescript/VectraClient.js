"use strict";
/**
 * Vectra gRPC client — thin idiomatic wrapper over generated stubs.
 *
 * Usage:
 *   import { VectraClient } from './VectraClient';
 *
 *   const client = new VectraClient();
 *   const results = await client.queryDocuments('my-index', 'search query');
 *   client.close();
 *
 * Generate stubs first:
 *   npm install @grpc/grpc-js @grpc/proto-loader
 *   // Proto is loaded dynamically — no separate codegen step required.
 */
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
exports.VectraClient = void 0;
const grpc = __importStar(require("@grpc/grpc-js"));
const protoLoader = __importStar(require("@grpc/proto-loader"));
const path = __importStar(require("path"));
// Load proto definition dynamically
const PROTO_PATH = path.join(__dirname, 'vectra_service.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
});
const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
const vectra = protoDescriptor.vectra;
// ── Client ───────────────────────────────────────────────
class VectraClient {
    constructor(host = '127.0.0.1', port = 50051) {
        this._client = new vectra.VectraService(`${host}:${port}`, grpc.credentials.createInsecure());
    }
    close() {
        this._client.close();
    }
    // ── Index Management ─────────────────────────────────
    createIndex(name, options) {
        var _a, _b, _c;
        const req = { indexName: name, format: (_a = options === null || options === void 0 ? void 0 : options.format) !== null && _a !== void 0 ? _a : 'json' };
        if (options === null || options === void 0 ? void 0 : options.isDocumentIndex) {
            req.isDocumentIndex = true;
            req.documentConfig = {
                version: 1,
                chunkSize: (_b = options.chunkSize) !== null && _b !== void 0 ? _b : 512,
                chunkOverlap: (_c = options.chunkOverlap) !== null && _c !== void 0 ? _c : 0,
            };
        }
        return this._unary('createIndex', req);
    }
    deleteIndex(name) {
        return this._unary('deleteIndex', { indexName: name });
    }
    listIndexes() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const resp = yield this._unary('listIndexes', {});
            return ((_a = resp.indexes) !== null && _a !== void 0 ? _a : []).map((idx) => ({
                name: idx.name,
                format: idx.format,
                isDocumentIndex: idx.isDocumentIndex,
            }));
        });
    }
    // ── Item Operations ──────────────────────────────────
    insertItem(index, options) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const req = {
                indexName: index,
                text: (_a = options.text) !== null && _a !== void 0 ? _a : '',
                id: (_b = options.id) !== null && _b !== void 0 ? _b : '',
            };
            if (options.vector)
                req.vector = options.vector;
            if (options.metadata)
                req.metadata = toProtoMetadata(options.metadata);
            const resp = yield this._unary('insertItem', req);
            return resp.id;
        });
    }
    upsertItem(index, id, options) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const req = {
                indexName: index,
                id,
                text: (_a = options.text) !== null && _a !== void 0 ? _a : '',
            };
            if (options.vector)
                req.vector = options.vector;
            if (options.metadata)
                req.metadata = toProtoMetadata(options.metadata);
            const resp = yield this._unary('upsertItem', req);
            return resp.id;
        });
    }
    getItem(index, id) {
        return __awaiter(this, void 0, void 0, function* () {
            const resp = yield this._unary('getItem', { indexName: index, id });
            return resp.item ? itemToResult(resp.item) : null;
        });
    }
    deleteItem(index, id) {
        return this._unary('deleteItem', { indexName: index, id });
    }
    listItems(index, filter) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const req = { indexName: index };
            if (filter)
                req.filter = { filterJson: JSON.stringify(filter) };
            const resp = yield this._unary('listItems', req);
            return ((_a = resp.items) !== null && _a !== void 0 ? _a : []).map(itemToResult);
        });
    }
    // ── Query ────────────────────────────────────────────
    queryItems(index, options) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const req = {
                indexName: index,
                text: (_a = options.text) !== null && _a !== void 0 ? _a : '',
                topK: (_b = options.topK) !== null && _b !== void 0 ? _b : 10,
            };
            if (options.vector)
                req.vector = options.vector;
            if (options.filter)
                req.filter = { filterJson: JSON.stringify(options.filter) };
            const resp = yield this._unary('queryItems', req);
            return ((_c = resp.results) !== null && _c !== void 0 ? _c : []).map(itemToResult);
        });
    }
    queryDocuments(index, query, options) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d;
            const req = {
                indexName: index,
                query,
                maxDocuments: (_a = options === null || options === void 0 ? void 0 : options.maxDocuments) !== null && _a !== void 0 ? _a : 10,
                maxChunks: (_b = options === null || options === void 0 ? void 0 : options.maxChunks) !== null && _b !== void 0 ? _b : 50,
                useBm25: (_c = options === null || options === void 0 ? void 0 : options.useBm25) !== null && _c !== void 0 ? _c : false,
            };
            if (options === null || options === void 0 ? void 0 : options.filter)
                req.filter = { filterJson: JSON.stringify(options.filter) };
            const resp = yield this._unary('queryDocuments', req);
            return ((_d = resp.results) !== null && _d !== void 0 ? _d : []).map((doc) => {
                var _a;
                return ({
                    uri: doc.uri,
                    documentId: doc.documentId,
                    score: doc.score,
                    chunks: ((_a = doc.chunks) !== null && _a !== void 0 ? _a : []).map((c) => ({
                        text: c.text,
                        score: c.score,
                        tokenCount: c.tokenCount,
                    })),
                });
            });
        });
    }
    // ── Document Operations ──────────────────────────────
    upsertDocument(index, uri, text, options) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const req = {
                indexName: index,
                uri,
                text,
                docType: (_a = options === null || options === void 0 ? void 0 : options.docType) !== null && _a !== void 0 ? _a : '',
            };
            if (options === null || options === void 0 ? void 0 : options.metadata)
                req.metadata = toProtoMetadata(options.metadata);
            const resp = yield this._unary('upsertDocument', req);
            return resp.documentId;
        });
    }
    deleteDocument(index, uri) {
        return this._unary('deleteDocument', { indexName: index, uri });
    }
    listDocuments(index) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const resp = yield this._unary('listDocuments', { indexName: index });
            return ((_a = resp.documents) !== null && _a !== void 0 ? _a : []).map((d) => ({
                uri: d.uri,
                documentId: d.documentId,
            }));
        });
    }
    // ── Stats ────────────────────────────────────────────
    getIndexStats(index) {
        return __awaiter(this, void 0, void 0, function* () {
            const resp = yield this._unary('getIndexStats', { indexName: index });
            return {
                version: resp.version,
                format: resp.format,
                itemCount: resp.itemCount,
                metadataConfigCount: resp.metadataConfigCount,
            };
        });
    }
    getCatalogStats(index) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const resp = yield this._unary('getCatalogStats', { indexName: index });
            return {
                version: resp.version,
                documentCount: resp.documentCount,
                chunkCount: resp.chunkCount,
                metadataCounts: (_a = resp.metadataCounts) !== null && _a !== void 0 ? _a : {},
            };
        });
    }
    // ── Lifecycle ────────────────────────────────────────
    healthcheck() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const resp = yield this._unary('healthcheck', {});
            return {
                status: resp.status,
                uptimeSeconds: resp.uptimeSeconds,
                loadedIndexes: (_a = resp.loadedIndexes) !== null && _a !== void 0 ? _a : [],
            };
        });
    }
    shutdown() {
        return this._unary('shutdown', {});
    }
    // ── Internals ────────────────────────────────────────
    _unary(method, request) {
        return new Promise((resolve, reject) => {
            this._client[method](request, (err, response) => {
                if (err)
                    reject(err);
                else
                    resolve(response);
            });
        });
    }
}
exports.VectraClient = VectraClient;
// ── Helpers ──────────────────────────────────────────────
function toProtoMetadata(metadata) {
    const result = {};
    for (const [key, value] of Object.entries(metadata)) {
        if (typeof value === 'boolean') {
            result[key] = { boolValue: value };
        }
        else if (typeof value === 'number') {
            result[key] = { numberValue: value };
        }
        else {
            result[key] = { stringValue: String(value) };
        }
    }
    return result;
}
function itemToResult(item) {
    var _a;
    const metadata = {};
    if (item.metadata) {
        for (const [key, val] of Object.entries(item.metadata)) {
            if (val.stringValue !== undefined && val.stringValue !== '') {
                metadata[key] = val.stringValue;
            }
            else if (val.numberValue !== undefined && val.numberValue !== 0) {
                metadata[key] = val.numberValue;
            }
            else if (val.boolValue !== undefined) {
                metadata[key] = val.boolValue;
            }
        }
    }
    return {
        id: item.id,
        metadata,
        vector: (_a = item.vector) !== null && _a !== void 0 ? _a : [],
        norm: item.norm,
        score: item.score,
    };
}
//# sourceMappingURL=VectraClient.js.map