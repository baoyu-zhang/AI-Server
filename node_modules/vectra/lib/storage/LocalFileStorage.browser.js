"use strict";
/**
 * Browser stub for LocalFileStorage.
 * This module throws an error if LocalFileStorage is used in a browser environment.
 * Use IndexedDBStorage or VirtualFileStorage instead.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalFileStorage = void 0;
class LocalFileStorage {
    constructor() {
        throw new Error('LocalFileStorage is not supported in browser environments. ' +
            'Use IndexedDBStorage or VirtualFileStorage instead.');
    }
    createFile() {
        throw new Error('LocalFileStorage is not supported in browser environments.');
    }
    createFolder() {
        throw new Error('LocalFileStorage is not supported in browser environments.');
    }
    deleteFile() {
        throw new Error('LocalFileStorage is not supported in browser environments.');
    }
    deleteFolder() {
        throw new Error('LocalFileStorage is not supported in browser environments.');
    }
    getDetails() {
        throw new Error('LocalFileStorage is not supported in browser environments.');
    }
    listFiles() {
        throw new Error('LocalFileStorage is not supported in browser environments.');
    }
    pathExists() {
        throw new Error('LocalFileStorage is not supported in browser environments.');
    }
    readFile() {
        throw new Error('LocalFileStorage is not supported in browser environments.');
    }
    upsertFile() {
        throw new Error('LocalFileStorage is not supported in browser environments.');
    }
}
exports.LocalFileStorage = LocalFileStorage;
//# sourceMappingURL=LocalFileStorage.browser.js.map