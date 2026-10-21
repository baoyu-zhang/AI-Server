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
exports.createQueryHandlers = createQueryHandlers;
const grpc = __importStar(require("@grpc/grpc-js"));
const helpers_1 = require("./helpers");
function createQueryHandlers(manager, embeddings) {
    return {
        QueryItems: (0, helpers_1.wrapHandler)((call) => __awaiter(this, void 0, void 0, function* () {
            const req = call.request;
            if (!req.index_name) {
                throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'index_name is required');
            }
            const idx = manager.requireIndex(req.index_name).index;
            const topK = req.top_k || 10;
            const filter = (0, helpers_1.parseFilterJson)(req.filter);
            let vector;
            if (req.vector && req.vector.length > 0) {
                vector = req.vector;
            }
            else if (req.text && req.text.length > 0) {
                if (!embeddings) {
                    throw (0, helpers_1.grpcError)(grpc.status.FAILED_PRECONDITION, 'No embeddings model configured on the server');
                }
                const response = yield embeddings.createEmbeddings(req.text);
                if (response.status !== 'success' || !response.output) {
                    throw (0, helpers_1.grpcError)(grpc.status.INTERNAL, `Embeddings error: ${response.message || 'unknown'}`);
                }
                vector = response.output[0];
            }
            else {
                throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'Either text or vector must be provided');
            }
            const results = yield idx.queryItems(vector, req.text || '', topK, filter);
            return {
                results: results.map((r) => ({
                    id: r.item.id,
                    metadata: (0, helpers_1.toProtoMetadata)(r.item.metadata),
                    vector: Array.from(r.item.vector),
                    norm: r.item.norm,
                    score: r.score,
                })),
            };
        })),
        QueryDocuments: (0, helpers_1.wrapHandler)((call) => __awaiter(this, void 0, void 0, function* () {
            const req = call.request;
            if (!req.index_name) {
                throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'index_name is required');
            }
            const { docIndex } = manager.requireDocumentIndex(req.index_name);
            if (!req.query) {
                throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'query is required');
            }
            const filter = (0, helpers_1.parseFilterJson)(req.filter);
            const results = yield docIndex.queryDocuments(req.query, {
                maxDocuments: req.max_documents || 10,
                maxChunks: req.max_chunks || 50,
                filter,
                isBm25: req.use_bm25 || false,
            });
            const protoResults = [];
            for (const result of results) {
                const chunks = [];
                for (const chunk of result.chunks) {
                    const text = yield (() => __awaiter(this, void 0, void 0, function* () {
                        try {
                            const doc = result;
                            const startPos = chunk.item.metadata.startPos || 0;
                            const endPos = chunk.item.metadata.endPos || 0;
                            const fullText = yield doc.loadText();
                            return fullText.substring(startPos, endPos + 1);
                        }
                        catch (_a) {
                            return '';
                        }
                    }))();
                    chunks.push({
                        text,
                        score: chunk.score,
                        token_count: 0,
                    });
                }
                protoResults.push({
                    uri: result.uri,
                    document_id: result.id,
                    chunks,
                    score: result.score,
                });
            }
            return { results: protoResults };
        })),
    };
}
//# sourceMappingURL=queryHandlers.js.map