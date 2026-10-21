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
exports.createItemHandlers = createItemHandlers;
const grpc = __importStar(require("@grpc/grpc-js"));
const uuid_1 = require("uuid");
const helpers_1 = require("./helpers");
function resolveVector(text, vector, embeddings) {
    return __awaiter(this, void 0, void 0, function* () {
        if (vector && vector.length > 0) {
            return vector;
        }
        if (text && text.length > 0) {
            if (!embeddings) {
                throw (0, helpers_1.grpcError)(grpc.status.FAILED_PRECONDITION, 'No embeddings model configured on the server');
            }
            const response = yield embeddings.createEmbeddings(text);
            if (response.status !== 'success' || !response.output) {
                throw (0, helpers_1.grpcError)(grpc.status.INTERNAL, `Embeddings error: ${response.message || 'unknown'}`);
            }
            return response.output[0];
        }
        throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'Either text or vector must be provided');
    });
}
function asLocalIndex(managed) {
    return managed.index;
}
function itemToProto(item) {
    return {
        id: item.id,
        metadata: (0, helpers_1.toProtoMetadata)(item.metadata),
        vector: Array.from(item.vector),
        norm: item.norm,
        score: 0,
    };
}
function createItemHandlers(manager, embeddings) {
    return {
        InsertItem: (0, helpers_1.wrapHandler)((call) => __awaiter(this, void 0, void 0, function* () {
            const req = call.request;
            if (!req.index_name) {
                throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'index_name is required');
            }
            const idx = asLocalIndex(manager.requireIndex(req.index_name));
            const vector = yield resolveVector(req.text, req.vector, embeddings);
            const metadata = (0, helpers_1.fromProtoMetadata)(req.metadata);
            const id = req.id || (0, uuid_1.v4)();
            const item = yield idx.insertItem({ id, vector, metadata });
            return { id: item.id };
        })),
        UpsertItem: (0, helpers_1.wrapHandler)((call) => __awaiter(this, void 0, void 0, function* () {
            const req = call.request;
            if (!req.index_name) {
                throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'index_name is required');
            }
            if (!req.id) {
                throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'id is required for upsert');
            }
            const idx = asLocalIndex(manager.requireIndex(req.index_name));
            const vector = yield resolveVector(req.text, req.vector, embeddings);
            const metadata = (0, helpers_1.fromProtoMetadata)(req.metadata);
            const item = yield idx.upsertItem({ id: req.id, vector, metadata });
            return { id: item.id };
        })),
        BatchInsertItems: (0, helpers_1.wrapHandler)((call) => __awaiter(this, void 0, void 0, function* () {
            const req = call.request;
            if (!req.index_name) {
                throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'index_name is required');
            }
            const idx = asLocalIndex(manager.requireIndex(req.index_name));
            const items = req.items || [];
            const toInsert = [];
            for (const item of items) {
                const vector = yield resolveVector(item.text, item.vector, embeddings);
                const metadata = (0, helpers_1.fromProtoMetadata)(item.metadata);
                toInsert.push({ id: item.id || (0, uuid_1.v4)(), vector, metadata });
            }
            const inserted = yield idx.batchInsertItems(toInsert);
            return { ids: inserted.map((i) => i.id) };
        })),
        GetItem: (0, helpers_1.wrapHandler)((call) => __awaiter(this, void 0, void 0, function* () {
            const req = call.request;
            if (!req.index_name) {
                throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'index_name is required');
            }
            if (!req.id) {
                throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'id is required');
            }
            const idx = asLocalIndex(manager.requireIndex(req.index_name));
            const item = yield idx.getItem(req.id);
            if (!item) {
                throw (0, helpers_1.grpcError)(grpc.status.NOT_FOUND, `Item not found: ${req.id}`);
            }
            return { item: itemToProto(item) };
        })),
        DeleteItem: (0, helpers_1.wrapHandler)((call) => __awaiter(this, void 0, void 0, function* () {
            const req = call.request;
            if (!req.index_name) {
                throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'index_name is required');
            }
            if (!req.id) {
                throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'id is required');
            }
            const idx = asLocalIndex(manager.requireIndex(req.index_name));
            yield idx.deleteItem(req.id);
            return {};
        })),
        ListItems: (0, helpers_1.wrapHandler)((call) => __awaiter(this, void 0, void 0, function* () {
            const req = call.request;
            if (!req.index_name) {
                throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'index_name is required');
            }
            const idx = asLocalIndex(manager.requireIndex(req.index_name));
            const filter = (0, helpers_1.parseFilterJson)(req.filter);
            const items = filter
                ? yield idx.listItemsByMetadata(filter)
                : yield idx.listItems();
            return {
                items: items.map((item) => itemToProto(item)),
            };
        })),
    };
}
//# sourceMappingURL=itemHandlers.js.map