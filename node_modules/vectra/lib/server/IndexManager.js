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
exports.IndexManager = void 0;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const LocalIndex_1 = require("../LocalIndex");
const LocalDocumentIndex_1 = require("../LocalDocumentIndex");
const LocalFileStorage_1 = require("../storage/LocalFileStorage");
const codecs_1 = require("../codecs");
/**
 * Manages loaded indexes for the gRPC server.
 * Supports single-index and multi-index modes with auto-detection of new indexes.
 */
class IndexManager {
    constructor(config) {
        this._indexes = new Map();
        this._config = config;
        this._singleMode = !!config.indexPath;
    }
    /** Returns all currently loaded indexes. */
    get indexes() {
        return this._indexes;
    }
    /** Returns true if running in single-index mode. */
    get isSingleMode() {
        return this._singleMode;
    }
    /**
     * Initializes the index manager: loads existing indexes and starts auto-detection.
     */
    initialize() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            if (this._singleMode && this._config.indexPath) {
                yield this.loadSingleIndex(this._config.indexPath);
            }
            else if (this._config.rootDir) {
                yield this.scanRootDir();
                // Start periodic scanning for new indexes
                const interval = (_a = this._config.scanInterval) !== null && _a !== void 0 ? _a : 3000;
                this._scanTimer = setInterval(() => {
                    this.scanRootDir().catch(() => { });
                }, interval);
            }
        });
    }
    /**
     * Shuts down the index manager: stops scanning and flushes all indexes.
     */
    shutdown() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._scanTimer) {
                clearInterval(this._scanTimer);
                this._scanTimer = undefined;
            }
            // No special flush needed — LocalIndex writes on endUpdate()
            this._indexes.clear();
        });
    }
    /**
     * Gets a managed index by name.
     * In single-index mode, any name (or empty string) returns the single index.
     */
    getIndex(name) {
        if (this._singleMode) {
            // Return the single loaded index regardless of the name provided
            const entries = Array.from(this._indexes.values());
            return entries[0];
        }
        return this._indexes.get(name);
    }
    /**
     * Gets a managed index, throwing NOT_FOUND-appropriate error if missing.
     */
    requireIndex(name) {
        const managed = this.getIndex(name);
        if (!managed) {
            throw new Error(`Index not found: ${name}`);
        }
        return managed;
    }
    /**
     * Gets a managed document index, throwing if missing or not a document index.
     */
    requireDocumentIndex(name) {
        const managed = this.requireIndex(name);
        if (!managed.isDocumentIndex) {
            throw new Error(`Index "${name}" is not a document index`);
        }
        return { managed, docIndex: managed.index };
    }
    /**
     * Creates a new index on disk and loads it.
     */
    createIndex(name, format, isDocumentIndex, documentConfig) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._indexes.has(name)) {
                throw new Error(`Index already exists: ${name}`);
            }
            const rootDir = this._config.rootDir;
            if (!rootDir && !this._singleMode) {
                throw new Error('Cannot create index: no root directory configured');
            }
            const folderPath = rootDir ? path.join(rootDir, name) : name;
            const storage = new LocalFileStorage_1.LocalFileStorage();
            const codec = format === 'protobuf' ? new codecs_1.ProtobufCodec() : new codecs_1.JsonCodec();
            let index;
            if (isDocumentIndex) {
                const config = {
                    folderPath,
                    storage,
                    codec,
                    embeddings: this._config.embeddings,
                    chunkingConfig: {
                        chunkSize: (documentConfig === null || documentConfig === void 0 ? void 0 : documentConfig.chunkSize) || 512,
                        chunkOverlap: (documentConfig === null || documentConfig === void 0 ? void 0 : documentConfig.chunkOverlap) || 0,
                    },
                };
                index = new LocalDocumentIndex_1.LocalDocumentIndex(config);
            }
            else {
                index = new LocalIndex_1.LocalIndex(folderPath, undefined, storage, codec);
            }
            const createConfig = {
                version: (documentConfig === null || documentConfig === void 0 ? void 0 : documentConfig.version) || 1,
                deleteIfExists: false,
            };
            yield index.createIndex(createConfig);
            const managed = {
                name,
                index,
                isDocumentIndex,
                format: format || 'json',
            };
            this._indexes.set(name, managed);
            return managed;
        });
    }
    /**
     * Deletes an index from disk and unloads it.
     */
    deleteIndex(name) {
        return __awaiter(this, void 0, void 0, function* () {
            const managed = this.requireIndex(name);
            yield managed.index.deleteIndex();
            this._indexes.delete(name);
        });
    }
    /**
     * Lists all loaded indexes.
     */
    listIndexes() {
        return Array.from(this._indexes.values());
    }
    loadSingleIndex(indexPath) {
        return __awaiter(this, void 0, void 0, function* () {
            const name = path.basename(indexPath);
            yield this.loadIndex(name, indexPath);
        });
    }
    scanRootDir() {
        return __awaiter(this, void 0, void 0, function* () {
            const rootDir = this._config.rootDir;
            if (!fs.existsSync(rootDir))
                return;
            const entries = fs.readdirSync(rootDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                if (entry.name.startsWith('.'))
                    continue;
                if (this._indexes.has(entry.name))
                    continue;
                const folderPath = path.join(rootDir, entry.name);
                try {
                    yield this.loadIndex(entry.name, folderPath);
                }
                catch (_a) {
                    // Skip directories that aren't valid indexes
                }
            }
        });
    }
    loadIndex(name, folderPath) {
        return __awaiter(this, void 0, void 0, function* () {
            const storage = new LocalFileStorage_1.LocalFileStorage();
            // Detect codec — throws if no index file found
            const codec = yield (0, codecs_1.detectCodec)(folderPath, storage);
            const format = codec.extension === '.pb' ? 'protobuf' : 'json';
            // Detect if it's a document index (has catalog file)
            const hasCatalogJson = yield storage.pathExists(path.join(folderPath, 'catalog.json'));
            const hasCatalogPb = yield storage.pathExists(path.join(folderPath, 'catalog.pb'));
            const isDocumentIndex = hasCatalogJson || hasCatalogPb;
            let index;
            if (isDocumentIndex) {
                index = new LocalDocumentIndex_1.LocalDocumentIndex({
                    folderPath,
                    storage,
                    codec,
                    embeddings: this._config.embeddings,
                });
            }
            else {
                index = new LocalIndex_1.LocalIndex(folderPath, undefined, storage, codec);
            }
            const managed = {
                name,
                index,
                isDocumentIndex,
                format,
            };
            this._indexes.set(name, managed);
        });
    }
}
exports.IndexManager = IndexManager;
//# sourceMappingURL=IndexManager.js.map