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
exports.IndexedDBStorage = void 0;
const buffer_1 = require("buffer");
const FileStorageUtilities_1 = require("./FileStorageUtilities");
const pathUtils_1 = require("../utils/pathUtils");
/**
 * Browser-compatible FileStorage implementation using IndexedDB.
 * @remarks
 * This storage backend works in browsers and Electron renderer processes.
 * Data persists across page reloads and browser sessions.
 */
class IndexedDBStorage {
    /**
     * Creates a new `IndexedDBStorage` instance.
     * @param dbName Name of the IndexedDB database. Defaults to 'vectra-db'.
     */
    constructor(dbName = 'vectra-db') {
        this._dbName = dbName;
    }
    /**
     * Opens or creates the IndexedDB database.
     */
    getDB() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._db) {
                return this._db;
            }
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(this._dbName, 1);
                request.onerror = () => { var _a; return reject(new Error(`Failed to open IndexedDB: ${(_a = request.error) === null || _a === void 0 ? void 0 : _a.message}`)); };
                request.onsuccess = () => {
                    this._db = request.result;
                    resolve(this._db);
                };
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    // Store for files: { path, content, createdAt, updatedAt }
                    if (!db.objectStoreNames.contains('files')) {
                        const fileStore = db.createObjectStore('files', { keyPath: 'path' });
                        fileStore.createIndex('parentPath', 'parentPath', { unique: false });
                    }
                    // Store for folders: { path, createdAt }
                    if (!db.objectStoreNames.contains('folders')) {
                        const folderStore = db.createObjectStore('folders', { keyPath: 'path' });
                        folderStore.createIndex('parentPath', 'parentPath', { unique: false });
                    }
                };
            });
        });
    }
    /**
     * Normalizes a path for consistent storage.
     */
    normalizePath(filePath) {
        // Normalize and ensure forward slashes
        let normalized = pathUtils_1.pathUtils.normalize(filePath);
        // Remove trailing slash unless it's the root
        if (normalized.length > 1 && normalized.endsWith('/')) {
            normalized = normalized.slice(0, -1);
        }
        return normalized;
    }
    /**
     * Gets the parent path of a given path.
     */
    getParentPath(filePath) {
        const normalized = this.normalizePath(filePath);
        const parent = pathUtils_1.pathUtils.dirname(normalized);
        return parent === normalized ? '' : parent;
    }
    createFile(filePath, content) {
        return __awaiter(this, void 0, void 0, function* () {
            const db = yield this.getDB();
            const normalizedPath = this.normalizePath(filePath);
            // Convert content to ArrayBuffer for storage
            let arrayBuffer;
            if (typeof content === 'string') {
                arrayBuffer = new TextEncoder().encode(content).buffer;
            }
            else {
                arrayBuffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
            }
            return new Promise((resolve, reject) => {
                const tx = db.transaction('files', 'readwrite');
                const store = tx.objectStore('files');
                const record = {
                    path: normalizedPath,
                    parentPath: this.getParentPath(normalizedPath),
                    content: arrayBuffer,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                };
                const request = store.add(record);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(new Error(`File already exists: ${filePath}`));
            });
        });
    }
    createFolder(folderPath) {
        return __awaiter(this, void 0, void 0, function* () {
            const db = yield this.getDB();
            const normalizedPath = this.normalizePath(folderPath);
            // Create all parent folders recursively
            const parts = normalizedPath.split('/').filter(Boolean);
            let currentPath = '';
            const tx = db.transaction('folders', 'readwrite');
            const store = tx.objectStore('folders');
            for (const part of parts) {
                const parentPath = currentPath;
                currentPath = currentPath ? `${currentPath}/${part}` : part;
                // Use put to create or update (idempotent)
                store.put({
                    path: currentPath,
                    parentPath: parentPath,
                    createdAt: Date.now()
                });
            }
            return new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(new Error(`Failed to create folder: ${folderPath}`));
            });
        });
    }
    deleteFile(filePath) {
        return __awaiter(this, void 0, void 0, function* () {
            const db = yield this.getDB();
            const normalizedPath = this.normalizePath(filePath);
            return new Promise((resolve, reject) => {
                const tx = db.transaction('files', 'readwrite');
                const store = tx.objectStore('files');
                const request = store.delete(normalizedPath);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(new Error(`Failed to delete file: ${filePath}`));
            });
        });
    }
    deleteFolder(folderPath) {
        return __awaiter(this, void 0, void 0, function* () {
            const db = yield this.getDB();
            const normalizedPath = this.normalizePath(folderPath);
            const prefix = normalizedPath + '/';
            return new Promise((resolve, reject) => {
                const tx = db.transaction(['files', 'folders'], 'readwrite');
                const fileStore = tx.objectStore('files');
                const folderStore = tx.objectStore('folders');
                // Delete all files with matching prefix
                const filesCursor = fileStore.openCursor();
                filesCursor.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        if (cursor.value.path === normalizedPath || cursor.value.path.startsWith(prefix)) {
                            cursor.delete();
                        }
                        cursor.continue();
                    }
                };
                // Delete all folders with matching prefix
                const foldersCursor = folderStore.openCursor();
                foldersCursor.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        if (cursor.value.path === normalizedPath || cursor.value.path.startsWith(prefix)) {
                            cursor.delete();
                        }
                        cursor.continue();
                    }
                };
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(new Error(`Failed to delete folder: ${folderPath}`));
            });
        });
    }
    getDetails(fileOrFolderPath) {
        return __awaiter(this, void 0, void 0, function* () {
            const db = yield this.getDB();
            const normalizedPath = this.normalizePath(fileOrFolderPath);
            // Try to find as file first
            const file = yield new Promise((resolve) => {
                const tx = db.transaction('files', 'readonly');
                const store = tx.objectStore('files');
                const request = store.get(normalizedPath);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve(undefined);
            });
            if (file) {
                return {
                    name: pathUtils_1.pathUtils.basename(normalizedPath),
                    path: normalizedPath,
                    isFolder: false,
                    fileType: FileStorageUtilities_1.FileStorageUtilities.getFileType(normalizedPath)
                };
            }
            // Try to find as folder
            const folder = yield new Promise((resolve) => {
                const tx = db.transaction('folders', 'readonly');
                const store = tx.objectStore('folders');
                const request = store.get(normalizedPath);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve(undefined);
            });
            if (folder) {
                return {
                    name: pathUtils_1.pathUtils.basename(normalizedPath),
                    path: normalizedPath,
                    isFolder: true
                };
            }
            throw new Error(`Path not found: ${fileOrFolderPath}`);
        });
    }
    listFiles(folderPath, filter) {
        return __awaiter(this, void 0, void 0, function* () {
            const db = yield this.getDB();
            const normalizedPath = this.normalizePath(folderPath);
            const results = [];
            // Get files in folder
            if (filter !== 'folders') {
                const files = yield new Promise((resolve) => {
                    const tx = db.transaction('files', 'readonly');
                    const store = tx.objectStore('files');
                    const index = store.index('parentPath');
                    const request = index.getAll(normalizedPath);
                    request.onsuccess = () => resolve(request.result || []);
                    request.onerror = () => resolve([]);
                });
                for (const file of files) {
                    results.push({
                        name: pathUtils_1.pathUtils.basename(file.path),
                        path: file.path,
                        isFolder: false,
                        fileType: FileStorageUtilities_1.FileStorageUtilities.getFileType(file.path)
                    });
                }
            }
            // Get subfolders
            if (filter !== 'files') {
                const folders = yield new Promise((resolve) => {
                    const tx = db.transaction('folders', 'readonly');
                    const store = tx.objectStore('folders');
                    const index = store.index('parentPath');
                    const request = index.getAll(normalizedPath);
                    request.onsuccess = () => resolve(request.result || []);
                    request.onerror = () => resolve([]);
                });
                for (const folder of folders) {
                    results.push({
                        name: pathUtils_1.pathUtils.basename(folder.path),
                        path: folder.path,
                        isFolder: true
                    });
                }
            }
            return results;
        });
    }
    pathExists(fileOrFolderPath) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.getDetails(fileOrFolderPath);
                return true;
            }
            catch (_a) {
                return false;
            }
        });
    }
    readFile(filePath) {
        return __awaiter(this, void 0, void 0, function* () {
            const db = yield this.getDB();
            const normalizedPath = this.normalizePath(filePath);
            const file = yield new Promise((resolve, reject) => {
                const tx = db.transaction('files', 'readonly');
                const store = tx.objectStore('files');
                const request = store.get(normalizedPath);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(new Error(`Failed to read file: ${filePath}`));
            });
            if (!file) {
                throw new Error(`File not found: ${filePath}`);
            }
            // Convert ArrayBuffer back to Buffer
            return buffer_1.Buffer.from(file.content);
        });
    }
    upsertFile(filePath, content) {
        return __awaiter(this, void 0, void 0, function* () {
            const db = yield this.getDB();
            const normalizedPath = this.normalizePath(filePath);
            // Convert content to ArrayBuffer for storage
            let arrayBuffer;
            if (typeof content === 'string') {
                arrayBuffer = new TextEncoder().encode(content).buffer;
            }
            else {
                arrayBuffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
            }
            return new Promise((resolve, reject) => {
                const tx = db.transaction('files', 'readwrite');
                const store = tx.objectStore('files');
                const record = {
                    path: normalizedPath,
                    parentPath: this.getParentPath(normalizedPath),
                    content: arrayBuffer,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                };
                const request = store.put(record);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(new Error(`Failed to write file: ${filePath}`));
            });
        });
    }
    /**
     * Closes the database connection.
     */
    close() {
        if (this._db) {
            this._db.close();
            this._db = undefined;
        }
    }
    /**
     * Deletes the entire database.
     */
    destroy() {
        return __awaiter(this, void 0, void 0, function* () {
            this.close();
            return new Promise((resolve, reject) => {
                const request = indexedDB.deleteDatabase(this._dbName);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(new Error(`Failed to delete database: ${this._dbName}`));
            });
        });
    }
}
exports.IndexedDBStorage = IndexedDBStorage;
//# sourceMappingURL=IndexedDBStorage.js.map