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
exports.createIndexHandlers = createIndexHandlers;
const grpc = __importStar(require("@grpc/grpc-js"));
const helpers_1 = require("./helpers");
function createIndexHandlers(manager) {
    return {
        CreateIndex: (0, helpers_1.wrapHandler)((call) => __awaiter(this, void 0, void 0, function* () {
            const req = call.request;
            if (!req.index_name) {
                throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'index_name is required');
            }
            const format = req.format || 'json';
            const isDoc = req.is_document_index || false;
            const docConfig = req.document_config ? {
                version: req.document_config.version || 1,
                chunkSize: req.document_config.chunk_size || 512,
                chunkOverlap: req.document_config.chunk_overlap || 0,
            } : undefined;
            yield manager.createIndex(req.index_name, format, isDoc, docConfig);
            return {};
        })),
        DeleteIndex: (0, helpers_1.wrapHandler)((call) => __awaiter(this, void 0, void 0, function* () {
            const req = call.request;
            if (!req.index_name) {
                throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'index_name is required');
            }
            yield manager.deleteIndex(req.index_name);
            return {};
        })),
        ListIndexes: (0, helpers_1.wrapHandler)((_call) => __awaiter(this, void 0, void 0, function* () {
            const indexes = manager.listIndexes();
            return {
                indexes: indexes.map(idx => ({
                    name: idx.name,
                    format: idx.format,
                    is_document_index: idx.isDocumentIndex,
                })),
            };
        })),
    };
}
//# sourceMappingURL=indexHandlers.js.map