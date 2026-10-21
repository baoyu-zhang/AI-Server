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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = __importDefault(require("node:assert"));
const sinon_1 = __importDefault(require("sinon"));
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const LocalFileStorage_1 = require("./LocalFileStorage");
const FileStorageUtilities_1 = require("./FileStorageUtilities");
describe('LocalFileStorage', () => {
    let storage;
    afterEach(() => __awaiter(void 0, void 0, void 0, function* () {
        sinon_1.default.restore();
    }));
    describe('constructor and getFullPath', () => {
        it('returns relativePath if no rootFolder and relativePath non-empty', () => {
            storage = new LocalFileStorage_1.LocalFileStorage();
            // @ts-ignore access private for test
            node_assert_1.default.strictEqual(storage['getFullPath']('some/path'), 'some/path');
        });
        it("returns '.' if no rootFolder and relativePath empty", () => {
            storage = new LocalFileStorage_1.LocalFileStorage();
            // @ts-ignore access private for test
            node_assert_1.default.strictEqual(storage['getFullPath'](''), '.');
        });
        it('returns rootFolder if rootFolder set and relativePath empty', () => {
            storage = new LocalFileStorage_1.LocalFileStorage('/root');
            // @ts-ignore access private for test
            node_assert_1.default.strictEqual(storage['getFullPath'](''), '/root');
        });
        it('joins rootFolder and relativePath if both set', () => {
            storage = new LocalFileStorage_1.LocalFileStorage('/root');
            // @ts-ignore access private for test
            node_assert_1.default.strictEqual(storage['getFullPath']('sub/folder'), path_1.default.join('/root', 'sub/folder'));
        });
    });
    describe('createFile', () => {
        beforeEach(() => {
            storage = new LocalFileStorage_1.LocalFileStorage('/root');
        });
        it('writes a new file with Buffer content', () => __awaiter(void 0, void 0, void 0, function* () {
            const writeFileStub = sinon_1.default.stub(promises_1.default, 'writeFile').resolves();
            const content = Buffer.from('hello');
            yield storage.createFile('file.txt', content);
            sinon_1.default.assert.calledWith(writeFileStub, path_1.default.join('/root', 'file.txt'), content, { flag: 'wx' });
        }));
        it('writes a new file with string content as UTF-8', () => __awaiter(void 0, void 0, void 0, function* () {
            const writeFileStub = sinon_1.default.stub(promises_1.default, 'writeFile').resolves();
            const content = 'hello';
            yield storage.createFile('file.txt', content);
            sinon_1.default.assert.calledWith(writeFileStub, path_1.default.join('/root', 'file.txt'), Buffer.from(content, 'utf8'), { flag: 'wx' });
        }));
        it('bubbles up error if file already exists', () => __awaiter(void 0, void 0, void 0, function* () {
            sinon_1.default.stub(promises_1.default, 'writeFile').rejects(new Error('EEXIST'));
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.createFile('file.txt', 'content');
            }));
        }));
        it('bubbles up error if parent directory does not exist', () => __awaiter(void 0, void 0, void 0, function* () {
            sinon_1.default.stub(promises_1.default, 'writeFile').rejects(new Error('ENOENT'));
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.createFile('nonexistent/file.txt', 'content');
            }));
        }));
    });
    describe('createFolder', () => {
        beforeEach(() => {
            storage = new LocalFileStorage_1.LocalFileStorage('/root');
        });
        it('creates nested directory structure recursively', () => __awaiter(void 0, void 0, void 0, function* () {
            const mkdirStub = sinon_1.default.stub(promises_1.default, 'mkdir').resolves();
            yield storage.createFolder('nested/folder');
            sinon_1.default.assert.calledWith(mkdirStub, path_1.default.join('/root', 'nested/folder'), { recursive: true });
        }));
        it('calling again on same path still calls mkdir (idempotent due to recursive:true)', () => __awaiter(void 0, void 0, void 0, function* () {
            const mkdirStub = sinon_1.default.stub(promises_1.default, 'mkdir').resolves();
            yield storage.createFolder('nested/folder');
            yield storage.createFolder('nested/folder');
            sinon_1.default.assert.calledTwice(mkdirStub);
        }));
    });
    describe('deleteFile', () => {
        beforeEach(() => {
            storage = new LocalFileStorage_1.LocalFileStorage('/root');
        });
        it('deletes existing file', () => __awaiter(void 0, void 0, void 0, function* () {
            const unlinkStub = sinon_1.default.stub(promises_1.default, 'unlink').resolves();
            yield storage.deleteFile('file.txt');
            sinon_1.default.assert.calledWith(unlinkStub, path_1.default.join('/root', 'file.txt'));
        }));
        it('bubbles up error when file does not exist', () => __awaiter(void 0, void 0, void 0, function* () {
            sinon_1.default.stub(promises_1.default, 'unlink').rejects(new Error('ENOENT'));
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.deleteFile('missing.txt');
            }));
        }));
    });
    describe('deleteFolder', () => {
        beforeEach(() => {
            storage = new LocalFileStorage_1.LocalFileStorage('/root');
        });
        it('deletes existing folder recursively', () => __awaiter(void 0, void 0, void 0, function* () {
            const rmStub = sinon_1.default.stub(promises_1.default, 'rm').resolves();
            yield storage.deleteFolder('folder');
            sinon_1.default.assert.calledWith(rmStub, path_1.default.join('/root', 'folder'), { recursive: true });
        }));
        it('bubbles up error when folder does not exist', () => __awaiter(void 0, void 0, void 0, function* () {
            sinon_1.default.stub(promises_1.default, 'rm').rejects(new Error('ENOENT'));
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.deleteFolder('missing');
            }));
        }));
    });
    describe('getDetails', () => {
        beforeEach(() => {
            storage = new LocalFileStorage_1.LocalFileStorage('/root');
        });
        it('returns correct details for file', () => __awaiter(void 0, void 0, void 0, function* () {
            const statStub = sinon_1.default.stub(promises_1.default, 'stat').resolves({
                isDirectory: () => false,
                isFile: () => true,
            });
            const getFileTypeStub = sinon_1.default.stub(FileStorageUtilities_1.FileStorageUtilities, 'getFileType').returns('txt');
            const details = yield storage.getDetails('file.txt');
            node_assert_1.default.strictEqual(details.name, 'file.txt');
            node_assert_1.default.strictEqual(details.path, 'file.txt');
            node_assert_1.default.strictEqual(details.isFolder, false);
            node_assert_1.default.strictEqual(details.fileType, 'txt');
            sinon_1.default.assert.calledWith(statStub, path_1.default.join('/root', 'file.txt'));
            sinon_1.default.assert.calledWith(getFileTypeStub, 'file.txt');
        }));
        it('returns correct details for folder', () => __awaiter(void 0, void 0, void 0, function* () {
            sinon_1.default.stub(promises_1.default, 'stat').resolves({
                isDirectory: () => true,
                isFile: () => false,
            });
            const details = yield storage.getDetails('folder');
            node_assert_1.default.strictEqual(details.name, 'folder');
            node_assert_1.default.strictEqual(details.path, 'folder');
            node_assert_1.default.strictEqual(details.isFolder, true);
            node_assert_1.default.strictEqual(details.fileType, undefined);
        }));
        it('bubbles up error for non-existent path', () => __awaiter(void 0, void 0, void 0, function* () {
            sinon_1.default.stub(promises_1.default, 'stat').rejects(new Error('ENOENT'));
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.getDetails('missing');
            }));
        }));
    });
    describe('listFiles', () => {
        beforeEach(() => {
            storage = new LocalFileStorage_1.LocalFileStorage('/root');
        });
        it('returns entries for folder with files and subfolders', () => __awaiter(void 0, void 0, void 0, function* () {
            const dirents = [
                { name: 'file1.txt', isDirectory: () => false, isFile: () => true },
                { name: 'subfolder', isDirectory: () => true, isFile: () => false },
            ];
            sinon_1.default.stub(promises_1.default, 'readdir').resolves(dirents);
            const getFileTypeStub = sinon_1.default.stub(FileStorageUtilities_1.FileStorageUtilities, 'getFileType').callsFake((name) => {
                if (name === 'file1.txt')
                    return 'txt';
                return undefined;
            });
            const results = yield storage.listFiles('folder');
            node_assert_1.default.strictEqual(results.length, 2);
            node_assert_1.default.strictEqual(results[0].name, 'file1.txt');
            node_assert_1.default.strictEqual(results[0].path, path_1.default.join('/root', 'folder', 'file1.txt'));
            node_assert_1.default.strictEqual(results[0].isFolder, false);
            node_assert_1.default.strictEqual(results[0].fileType, 'txt');
            node_assert_1.default.strictEqual(results[1].name, 'subfolder');
            node_assert_1.default.strictEqual(results[1].path, path_1.default.join('/root', 'folder', 'subfolder'));
            node_assert_1.default.strictEqual(results[1].isFolder, true);
            node_assert_1.default.strictEqual(results[1].fileType, undefined);
            sinon_1.default.assert.calledWith(getFileTypeStub, 'file1.txt');
        }));
        it('ignores filter argument', () => __awaiter(void 0, void 0, void 0, function* () {
            sinon_1.default.stub(promises_1.default, 'readdir').resolves([]);
            const results = yield storage.listFiles('folder', { any: true });
            node_assert_1.default.ok(Array.isArray(results));
            node_assert_1.default.strictEqual(results.length, 0);
        }));
    });
    describe('pathExists', () => {
        beforeEach(() => {
            storage = new LocalFileStorage_1.LocalFileStorage('/root');
        });
        it('returns true for existing file or folder', () => __awaiter(void 0, void 0, void 0, function* () {
            sinon_1.default.stub(promises_1.default, 'access').resolves();
            const exists = yield storage.pathExists('file.txt');
            node_assert_1.default.strictEqual(exists, true);
        }));
        it('returns false for non-existent path', () => __awaiter(void 0, void 0, void 0, function* () {
            sinon_1.default.stub(promises_1.default, 'access').rejects(new Error('ENOENT'));
            const exists = yield storage.pathExists('missing');
            node_assert_1.default.strictEqual(exists, false);
        }));
    });
    describe('readFile', () => {
        beforeEach(() => {
            storage = new LocalFileStorage_1.LocalFileStorage('/root');
        });
        it('reads and returns exact bytes', () => __awaiter(void 0, void 0, void 0, function* () {
            const content = Buffer.from('hello');
            sinon_1.default.stub(promises_1.default, 'readFile').resolves(content);
            const result = yield storage.readFile('file.txt');
            node_assert_1.default.strictEqual(result, content);
        }));
        it('bubbles up error when file does not exist', () => __awaiter(void 0, void 0, void 0, function* () {
            sinon_1.default.stub(promises_1.default, 'readFile').rejects(new Error('ENOENT'));
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.readFile('missing.txt');
            }));
        }));
    });
    describe('upsertFile', () => {
        beforeEach(() => {
            storage = new LocalFileStorage_1.LocalFileStorage('/root');
        });
        it('creates new file when absent', () => __awaiter(void 0, void 0, void 0, function* () {
            const writeFileStub = sinon_1.default.stub(promises_1.default, 'writeFile').resolves();
            yield storage.upsertFile('file.txt', 'content');
            sinon_1.default.assert.calledWith(writeFileStub, path_1.default.join('/root', 'file.txt'), Buffer.from('content', 'utf8'), { flag: 'w' });
        }));
        it('overwrites existing file', () => __awaiter(void 0, void 0, void 0, function* () {
            const writeFileStub = sinon_1.default.stub(promises_1.default, 'writeFile').resolves();
            yield storage.upsertFile('file.txt', Buffer.from('new content'));
            sinon_1.default.assert.calledWith(writeFileStub, path_1.default.join('/root', 'file.txt'), Buffer.from('new content'), { flag: 'w' });
        }));
        it('bubbles up error if parent directory does not exist', () => __awaiter(void 0, void 0, void 0, function* () {
            sinon_1.default.stub(promises_1.default, 'writeFile').rejects(new Error('ENOENT'));
            yield node_assert_1.default.rejects(() => __awaiter(void 0, void 0, void 0, function* () {
                yield storage.upsertFile('nonexistent/file.txt', 'content');
            }));
        }));
    });
});
//# sourceMappingURL=LocalFileStorage.spec.js.map