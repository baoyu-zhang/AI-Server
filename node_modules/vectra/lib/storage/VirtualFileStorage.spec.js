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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = __importDefault(require("node:assert"));
const path = __importStar(require("path"));
const VirtualFileStorage_1 = require("./VirtualFileStorage");
const FileStorageUtilities_1 = require("./FileStorageUtilities");
describe('VirtualFileStorage', () => {
    let storage;
    beforeEach(() => {
        storage = new VirtualFileStorage_1.VirtualFileStorage();
    });
    describe('createFile', () => {
        it('creates a new file with string content', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.createFile('file.txt', 'hello');
            const details = yield storage.getDetails('file.txt');
            node_assert_1.default.strictEqual(details.name, 'file.txt');
            node_assert_1.default.strictEqual(details.path, path.normalize('file.txt'));
            node_assert_1.default.strictEqual(details.isFolder, false);
            node_assert_1.default.strictEqual(details.fileType, FileStorageUtilities_1.FileStorageUtilities.getFileType(path.normalize('file.txt')));
            const content = yield storage.readFile('file.txt');
            node_assert_1.default.deepStrictEqual(content, Buffer.from('hello', 'utf8'));
        }));
        it('creates a new file with Buffer content', () => __awaiter(void 0, void 0, void 0, function* () {
            const buf = Buffer.from('buffer content');
            yield storage.createFile('bufferfile.bin', buf);
            const content = yield storage.readFile('bufferfile.bin');
            node_assert_1.default.deepStrictEqual(content, buf);
        }));
        it('throws when file already exists (including folder at path)', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.createFile('dup.txt', 'content');
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.createFile('dup.txt', 'new content');
            }), /File already exists/);
            yield storage.createFolder('folder');
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.createFile('folder', 'content');
            }), /File already exists/);
        }));
        it('throws when creating file with normalized duplicate path', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.createFile('a/../b/file.txt', 'content');
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.createFile('b/file.txt', 'content');
            }), /File already exists/);
        }));
    });
    describe('createFolder', () => {
        it('creates a new folder', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.createFolder('myfolder');
            const details = yield storage.getDetails('myfolder');
            node_assert_1.default.strictEqual(details.name, 'myfolder');
            node_assert_1.default.strictEqual(details.isFolder, true);
            node_assert_1.default.strictEqual(details.fileType, undefined);
        }));
        it('is idempotent when folder already exists', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.createFolder('myfolder');
            yield storage.createFolder('myfolder'); // no error
        }));
        it('throws when a file exists at that path', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.createFile('file.txt', 'content');
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.createFolder('file.txt');
            }), /Cannot create folder/);
        }));
        it('does not create parent folders automatically', () => __awaiter(void 0, void 0, void 0, function* () {
            // Implementation creates only the explicit folder entry
            yield storage.createFolder('parent/child');
            // Only 'parent/child' exists, not 'parent'
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.getDetails('parent');
            }), /Path not found/);
            const details = yield storage.getDetails('parent/child');
            node_assert_1.default.strictEqual(details.isFolder, true);
        }));
    });
    describe('deleteFile', () => {
        it('deletes an existing file', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.createFile('file.txt', 'content');
            yield storage.deleteFile('file.txt');
            const exists = yield storage.pathExists('file.txt');
            node_assert_1.default.strictEqual(exists, false);
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.readFile('file.txt');
            }), /File not found/);
        }));
        it('throws when deleting a folder as file', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.createFolder('folder');
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.deleteFile('folder');
            }), /Cannot delete file/);
        }));
        it('no error when deleting non-existent file', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.deleteFile('nonexistent');
        }));
    });
    describe('deleteFolder', () => {
        it('deletes an existing folder', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.createFolder('folder');
            yield storage.deleteFolder('folder');
            const exists = yield storage.pathExists('folder');
            node_assert_1.default.strictEqual(exists, false);
        }));
        it('throws when deleting a file as folder', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.createFile('file.txt', 'content');
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.deleteFolder('file.txt');
            }), /Cannot delete folder/);
        }));
        it('no error when deleting non-existent folder', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.deleteFolder('nonexistent');
        }));
        it('does not delete children when deleting folder', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.createFolder('parent');
            yield storage.createFile('parent/child.txt', 'content');
            yield storage.deleteFolder('parent');
            // Parent deleted
            const parentExists = yield storage.pathExists('parent');
            node_assert_1.default.strictEqual(parentExists, false);
            // Child still exists
            const childExists = yield storage.pathExists('parent/child.txt');
            node_assert_1.default.strictEqual(childExists, true);
        }));
    });
    describe('getDetails', () => {
        it('returns details for existing file', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.createFile('file.txt', 'content');
            const details = yield storage.getDetails('file.txt');
            node_assert_1.default.strictEqual(details.name, 'file.txt');
            node_assert_1.default.strictEqual(details.path, path.normalize('file.txt'));
            node_assert_1.default.strictEqual(details.isFolder, false);
            node_assert_1.default.strictEqual(details.fileType, FileStorageUtilities_1.FileStorageUtilities.getFileType(path.normalize('file.txt')));
        }));
        it('returns details for existing folder', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.createFolder('folder');
            const details = yield storage.getDetails('folder');
            node_assert_1.default.strictEqual(details.name, 'folder');
            node_assert_1.default.strictEqual(details.path, path.normalize('folder'));
            node_assert_1.default.strictEqual(details.isFolder, true);
            node_assert_1.default.strictEqual(details.fileType, undefined);
        }));
        it('throws for non-existent path', () => __awaiter(void 0, void 0, void 0, function* () {
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.getDetails('missing');
            }), /Path not found/);
        }));
    });
    describe('listFiles', () => {
        beforeEach(() => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.createFolder('a');
            yield storage.createFolder('a/b');
            yield storage.createFile('a/file1.txt', 'content1');
            yield storage.createFile('a/b/file2.txt', 'content2');
            yield storage.createFolder('c');
            yield storage.createFile('fileRoot.txt', 'root');
        }));
        it('returns immediate children only', () => __awaiter(void 0, void 0, void 0, function* () {
            const listA = yield storage.listFiles('a');
            (0, node_assert_1.default)(listA.some(e => e.name === 'file1.txt'));
            (0, node_assert_1.default)(listA.some(e => e.name === 'b'));
            (0, node_assert_1.default)(!listA.some(e => e.name === 'file2.txt'));
            const listRoot = yield storage.listFiles('');
            (0, node_assert_1.default)(listRoot.some(e => e.name === 'a'));
            (0, node_assert_1.default)(listRoot.some(e => e.name === 'c'));
            (0, node_assert_1.default)(listRoot.some(e => e.name === 'fileRoot.txt'));
        }));
        it('respects filter "all"', () => __awaiter(void 0, void 0, void 0, function* () {
            const all = yield storage.listFiles('a', 'all');
            (0, node_assert_1.default)(all.some(e => e.isFolder));
            (0, node_assert_1.default)(all.some(e => !e.isFolder));
        }));
        it('respects filter "files"', () => __awaiter(void 0, void 0, void 0, function* () {
            const files = yield storage.listFiles('a', 'files');
            (0, node_assert_1.default)(files.every(e => !e.isFolder));
            (0, node_assert_1.default)(files.some(e => e.name === 'file1.txt'));
            (0, node_assert_1.default)(!files.some(e => e.name === 'b'));
        }));
        it('respects filter "folders"', () => __awaiter(void 0, void 0, void 0, function* () {
            const folders = yield storage.listFiles('a', 'folders');
            (0, node_assert_1.default)(folders.every(e => e.isFolder));
            (0, node_assert_1.default)(folders.some(e => e.name === 'b'));
            (0, node_assert_1.default)(!folders.some(e => e.name === 'file1.txt'));
        }));
        it('normalizes folderPath', () => __awaiter(void 0, void 0, void 0, function* () {
            const list1 = yield storage.listFiles('a/');
            const list2 = yield storage.listFiles('a');
            node_assert_1.default.deepStrictEqual(list1, list2);
        }));
    });
    describe('pathExists', () => {
        it('returns true for existing file and folder', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.createFile('file.txt', 'content');
            yield storage.createFolder('folder');
            node_assert_1.default.strictEqual(yield storage.pathExists('file.txt'), true);
            node_assert_1.default.strictEqual(yield storage.pathExists('folder'), true);
        }));
        it('returns false for missing path', () => __awaiter(void 0, void 0, void 0, function* () {
            node_assert_1.default.strictEqual(yield storage.pathExists('missing'), false);
        }));
    });
    describe('readFile', () => {
        it('returns exact Buffer written', () => __awaiter(void 0, void 0, void 0, function* () {
            const buf = Buffer.from('data');
            yield storage.createFile('file.txt', buf);
            const read = yield storage.readFile('file.txt');
            node_assert_1.default.deepStrictEqual(read, buf);
        }));
        it('throws when path does not exist', () => __awaiter(void 0, void 0, void 0, function* () {
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.readFile('missing.txt');
            }), /File not found/);
        }));
        it('throws when path is a folder', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.createFolder('folder');
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.readFile('folder');
            }), /Cannot read file/);
        }));
        it('returns empty buffer if content is undefined (forced)', () => __awaiter(void 0, void 0, void 0, function* () {
            // Force an entry with undefined content to hit the fallback branch
            storage._entries.set('emptyfile.txt', {
                details: {
                    name: 'emptyfile.txt',
                    path: path.normalize('emptyfile.txt'),
                    isFolder: false,
                    fileType: FileStorageUtilities_1.FileStorageUtilities.getFileType(path.normalize('emptyfile.txt')),
                },
                content: undefined,
            });
            const content = yield storage.readFile('emptyfile.txt');
            node_assert_1.default.deepStrictEqual(content, Buffer.from('', 'utf8'));
        }));
    });
    describe('upsertFile', () => {
        it('creates new file when missing with string content', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.upsertFile('newfile.txt', 'content');
            const details = yield storage.getDetails('newfile.txt');
            node_assert_1.default.strictEqual(details.isFolder, false);
            node_assert_1.default.strictEqual(details.fileType, FileStorageUtilities_1.FileStorageUtilities.getFileType(path.normalize('newfile.txt')));
            const content = yield storage.readFile('newfile.txt');
            node_assert_1.default.deepStrictEqual(content, Buffer.from('content', 'utf8'));
        }));
        it('replaces content of existing file and keeps correct fileType', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.createFile('file.txt', 'old');
            yield storage.upsertFile('file.txt', Buffer.from('new'));
            const content = yield storage.readFile('file.txt');
            node_assert_1.default.deepStrictEqual(content, Buffer.from('new'));
            const details = yield storage.getDetails('file.txt');
            node_assert_1.default.strictEqual(details.fileType, FileStorageUtilities_1.FileStorageUtilities.getFileType(path.normalize('file.txt')));
        }));
        it('throws when a folder exists at that path', () => __awaiter(void 0, void 0, void 0, function* () {
            yield storage.createFolder('folder');
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.upsertFile('folder', 'content');
            }), /Cannot write file/);
        }));
    });
});
//# sourceMappingURL=VirtualFileStorage.spec.js.map