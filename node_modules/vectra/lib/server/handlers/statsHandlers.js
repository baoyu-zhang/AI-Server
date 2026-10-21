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
exports.createStatsHandlers = createStatsHandlers;
const grpc = __importStar(require("@grpc/grpc-js"));
const helpers_1 = require("./helpers");
function createStatsHandlers(manager) {
    return {
        GetIndexStats: (0, helpers_1.wrapHandler)((call) => __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const req = call.request;
            if (!req.index_name) {
                throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'index_name is required');
            }
            const managed = manager.requireIndex(req.index_name);
            const stats = yield managed.index.getIndexStats();
            return {
                version: stats.version,
                format: managed.format,
                item_count: stats.items,
                metadata_config_count: ((_b = (_a = stats.metadata_config) === null || _a === void 0 ? void 0 : _a.indexed) === null || _b === void 0 ? void 0 : _b.length) || 0,
            };
        })),
        GetCatalogStats: (0, helpers_1.wrapHandler)((call) => __awaiter(this, void 0, void 0, function* () {
            const req = call.request;
            if (!req.index_name) {
                throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'index_name is required');
            }
            const { docIndex } = manager.requireDocumentIndex(req.index_name);
            const stats = yield docIndex.getCatalogStats();
            return {
                version: stats.version,
                document_count: stats.documents,
                chunk_count: stats.chunks,
                metadata_counts: {},
            };
        })),
    };
}
//# sourceMappingURL=statsHandlers.js.map