"use strict";
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
exports.VirtualFileStorage = void 0;
const pathUtils_1 = require("../utils/pathUtils");
const FileStorageUtilities_1 = require("./FileStorageUtilities");
/**
 * An in-memory `FileStorage` implementation.
 */
class VirtualFileStorage {
    constructor() {
        this._entries = new Map();
    }
    // Normalize keys consistently across all operations:
    // - path.normalize to resolve dot segments
    // - remove trailing separator (except for root) so 'a' and 'a/' match
    // - preserve '' to represent the root namespace in this storage
    normalizeKey(key) {
        if (key.length === 0)
            return "";
        let normalized = pathUtils_1.pathUtils.normalize(key);
        if (normalized.endsWith(pathUtils_1.pathUtils.sep) && normalized !== pathUtils_1.pathUtils.sep) {
            normalized = normalized.slice(0, -1);
        }
        return normalized;
    }
    createFile(filePath, content) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = this.normalizeKey(filePath);
            if (this._entries.has(key)) {
                throw new Error(`File already exists: ${key}`);
            }
            const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : content;
            this._entries.set(key, {
                details: {
                    name: pathUtils_1.pathUtils.basename(key),
                    path: key,
                    isFolder: false,
                    fileType: FileStorageUtilities_1.FileStorageUtilities.getFileType(key),
                },
                // Clone to avoid external mutation of stored buffers (and keep Buffer type)
                content: Buffer.from(buffer),
            });
        });
    }
    createFolder(folderPath) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = this.normalizeKey(folderPath);
            const existing = this._entries.get(key);
            if (existing) {
                if (!existing.details.isFolder) {
                    throw new Error(`Cannot create folder: ${key} is a file`);
                }
                // Idempotent if the folder already exists
                return;
            }
            this._entries.set(key, {
                details: {
                    name: pathUtils_1.pathUtils.basename(key),
                    path: key,
                    isFolder: true,
                    fileType: undefined,
                },
            });
        });
    }
    deleteFile(filePath) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = this.normalizeKey(filePath);
            const existing = this._entries.get(key);
            if (!existing) {
                // no-op if not exists
                return;
            }
            if (existing.details.isFolder) {
                throw new Error(`Cannot delete file: ${key} is a folder`);
            }
            this._entries.delete(key);
        });
    }
    deleteFolder(folderPath) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = this.normalizeKey(folderPath);
            const existing = this._entries.get(key);
            if (!existing) {
                // no-op if not exists
                return;
            }
            if (!existing.details.isFolder) {
                throw new Error(`Cannot delete folder: ${key} is a file`);
            }
            // Note: does not cascade delete children per current implementation
            this._entries.delete(key);
        });
    }
    getDetails(fileOrFolderPath) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = this.normalizeKey(fileOrFolderPath);
            const existing = this._entries.get(key);
            if (!existing) {
                throw new Error(`Path not found: ${key}`);
            }
            // Return a shallow copy to avoid external mutation of returned metadata
            return Object.assign({}, existing.details);
        });
    }
    listFiles(folderPath_1) {
        return __awaiter(this, arguments, void 0, function* (folderPath, filter = "all") {
            const baseFolder = this.normalizeKey(folderPath);
            const results = [];
            for (const [, entry] of this._entries) {
                const parts = entry.details.path.split(pathUtils_1.pathUtils.sep);
                const parentFolder = parts.length > 1 ? parts.slice(0, parts.length - 1).join(pathUtils_1.pathUtils.sep) : "";
                if (parentFolder === baseFolder) {
                    if (filter === "all" ||
                        (filter === "files" && !entry.details.isFolder) ||
                        (filter === "folders" && entry.details.isFolder)) {
                        // Return a shallow copy to avoid external mutation of returned metadata
                        results.push(Object.assign({}, entry.details));
                    }
                }
            }
            return results;
        });
    }
    pathExists(fileOrFolderPath) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = this.normalizeKey(fileOrFolderPath);
            return this._entries.has(key);
        });
    }
    readFile(filePath) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const key = this.normalizeKey(filePath);
            const existing = this._entries.get(key);
            if (!existing) {
                throw new Error(`File not found: ${key}`);
            }
            if (existing.details.isFolder) {
                throw new Error(`Cannot read file: ${key} is a folder`);
            }
            // Return a copy of the buffer to protect internal buffer from external mutation; fall back to empty buffer
            const content = (_a = existing.content) !== null && _a !== void 0 ? _a : Buffer.from("", "utf8");
            return Buffer.from(content);
        });
    }
    upsertFile(filePath, content) {
        return __awaiter(this, void 0, void 0, function* () {
            const key = this.normalizeKey(filePath);
            const existing = this._entries.get(key);
            if (existing && existing.details.isFolder) {
                throw new Error(`Cannot write file: ${key} is a folder`);
            }
            const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : content;
            this._entries.set(key, {
                details: {
                    name: pathUtils_1.pathUtils.basename(key),
                    path: key,
                    isFolder: false,
                    fileType: FileStorageUtilities_1.FileStorageUtilities.getFileType(key),
                },
                // Clone to avoid external mutation of stored buffers (and keep Buffer type)
                content: Buffer.from(buffer),
            });
        });
    }
}
exports.VirtualFileStorage = VirtualFileStorage;
//# sourceMappingURL=VirtualFileStorage.js.map