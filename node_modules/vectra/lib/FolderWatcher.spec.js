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
const assert_1 = require("assert");
const sinon = __importStar(require("sinon"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const node_fs_1 = __importDefault(require("node:fs"));
const FolderWatcher_1 = require("./FolderWatcher");
const LocalDocumentIndex_1 = require("./LocalDocumentIndex");
const LocalFileStorage_1 = require("./storage/LocalFileStorage");
// Stub embeddings model that returns deterministic vectors
class StubEmbeddings {
    constructor() {
        this.maxTokens = 8000;
    }
    createEmbeddings(inputs) {
        return __awaiter(this, void 0, void 0, function* () {
            const texts = Array.isArray(inputs) ? inputs : [inputs];
            const output = texts.map(() => {
                const vec = new Array(384).fill(0);
                vec[0] = 1; // unit vector
                return vec;
            });
            return { status: 'success', output };
        });
    }
}
describe('FolderWatcher', () => {
    let tmpDir;
    let indexDir;
    let watchDir;
    let index;
    let sandbox;
    beforeEach(() => __awaiter(void 0, void 0, void 0, function* () {
        sandbox = sinon.createSandbox();
        // realpath the temp dir to resolve Windows 8.3 short names (e.g.,
        // os.tmpdir() returns `C:\Users\STEVEN~1\...` on some boxes). The
        // FolderWatcher canonicalizes internally; matching here keeps tracked
        // URIs aligned with the paths the tests look up.
        tmpDir = yield node_fs_1.default.promises.realpath(yield node_fs_1.default.promises.mkdtemp(path.join(os.tmpdir(), 'vectra-watch-')));
        indexDir = path.join(tmpDir, 'index');
        watchDir = path.join(tmpDir, 'watch');
        yield node_fs_1.default.promises.mkdir(indexDir, { recursive: true });
        yield node_fs_1.default.promises.mkdir(watchDir, { recursive: true });
        index = new LocalDocumentIndex_1.LocalDocumentIndex({
            folderPath: indexDir,
            embeddings: new StubEmbeddings(),
            storage: new LocalFileStorage_1.LocalFileStorage(),
        });
        yield index.createIndex({ version: 1, deleteIfExists: true });
    }));
    afterEach(() => __awaiter(void 0, void 0, void 0, function* () {
        sandbox.restore();
        yield node_fs_1.default.promises.rm(tmpDir, { recursive: true, force: true });
    }));
    it('should perform initial sync of existing files', () => __awaiter(void 0, void 0, void 0, function* () {
        // Create files before starting watcher
        yield node_fs_1.default.promises.writeFile(path.join(watchDir, 'file1.txt'), 'hello world');
        yield node_fs_1.default.promises.writeFile(path.join(watchDir, 'file2.txt'), 'goodbye world');
        const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [watchDir] });
        const synced = [];
        watcher.on('sync', (uri) => synced.push(uri));
        yield watcher.start();
        try {
            assert_1.strict.equal(watcher.trackedFileCount, 2);
            assert_1.strict.equal(synced.length, 2);
            // Verify documents exist in index
            const id1 = yield index.getDocumentId(path.join(watchDir, 'file1.txt'));
            const id2 = yield index.getDocumentId(path.join(watchDir, 'file2.txt'));
            assert_1.strict.ok(id1, 'file1.txt should be indexed');
            assert_1.strict.ok(id2, 'file2.txt should be indexed');
        }
        finally {
            yield watcher.stop();
        }
    }));
    it('should emit ready event after initial sync', () => __awaiter(void 0, void 0, void 0, function* () {
        const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [watchDir] });
        let ready = false;
        watcher.on('ready', () => { ready = true; });
        yield watcher.start();
        try {
            assert_1.strict.equal(ready, true);
        }
        finally {
            yield watcher.stop();
        }
    }));
    it('should filter by extensions', () => __awaiter(void 0, void 0, void 0, function* () {
        yield node_fs_1.default.promises.writeFile(path.join(watchDir, 'include.txt'), 'included');
        yield node_fs_1.default.promises.writeFile(path.join(watchDir, 'exclude.js'), 'excluded');
        yield node_fs_1.default.promises.writeFile(path.join(watchDir, 'include.md'), 'also included');
        const watcher = new FolderWatcher_1.FolderWatcher({
            index,
            paths: [watchDir],
            extensions: ['.txt', '.md']
        });
        yield watcher.start();
        try {
            assert_1.strict.equal(watcher.trackedFileCount, 2);
            const idTxt = yield index.getDocumentId(path.join(watchDir, 'include.txt'));
            const idMd = yield index.getDocumentId(path.join(watchDir, 'include.md'));
            const idJs = yield index.getDocumentId(path.join(watchDir, 'exclude.js'));
            assert_1.strict.ok(idTxt, 'include.txt should be indexed');
            assert_1.strict.ok(idMd, 'include.md should be indexed');
            assert_1.strict.equal(idJs, undefined, 'exclude.js should not be indexed');
        }
        finally {
            yield watcher.stop();
        }
    }));
    it('should handle extensions without leading dot', () => __awaiter(void 0, void 0, void 0, function* () {
        yield node_fs_1.default.promises.writeFile(path.join(watchDir, 'test.txt'), 'hello');
        const watcher = new FolderWatcher_1.FolderWatcher({
            index,
            paths: [watchDir],
            extensions: ['txt']
        });
        yield watcher.start();
        try {
            assert_1.strict.equal(watcher.trackedFileCount, 1);
        }
        finally {
            yield watcher.stop();
        }
    }));
    it('should recurse into subdirectories', () => __awaiter(void 0, void 0, void 0, function* () {
        const subDir = path.join(watchDir, 'sub');
        yield node_fs_1.default.promises.mkdir(subDir, { recursive: true });
        yield node_fs_1.default.promises.writeFile(path.join(watchDir, 'root.txt'), 'root');
        yield node_fs_1.default.promises.writeFile(path.join(subDir, 'nested.txt'), 'nested');
        const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [watchDir] });
        yield watcher.start();
        try {
            assert_1.strict.equal(watcher.trackedFileCount, 2);
            const idRoot = yield index.getDocumentId(path.join(watchDir, 'root.txt'));
            const idNested = yield index.getDocumentId(path.join(subDir, 'nested.txt'));
            assert_1.strict.ok(idRoot, 'root.txt should be indexed');
            assert_1.strict.ok(idNested, 'nested.txt should be indexed');
        }
        finally {
            yield watcher.stop();
        }
    }));
    it('should watch individual files', () => __awaiter(void 0, void 0, void 0, function* () {
        const singleFile = path.join(tmpDir, 'single.txt');
        yield node_fs_1.default.promises.writeFile(singleFile, 'single file');
        const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [singleFile] });
        yield watcher.start();
        try {
            assert_1.strict.equal(watcher.trackedFileCount, 1);
            const id = yield index.getDocumentId(singleFile);
            assert_1.strict.ok(id, 'single.txt should be indexed');
        }
        finally {
            yield watcher.stop();
        }
    }));
    it('should watch multiple paths', () => __awaiter(void 0, void 0, void 0, function* () {
        const dir2 = path.join(tmpDir, 'watch2');
        yield node_fs_1.default.promises.mkdir(dir2, { recursive: true });
        yield node_fs_1.default.promises.writeFile(path.join(watchDir, 'a.txt'), 'a');
        yield node_fs_1.default.promises.writeFile(path.join(dir2, 'b.txt'), 'b');
        const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [watchDir, dir2] });
        yield watcher.start();
        try {
            assert_1.strict.equal(watcher.trackedFileCount, 2);
        }
        finally {
            yield watcher.stop();
        }
    }));
    it('should handle sync() detecting deleted files', () => __awaiter(void 0, void 0, void 0, function* () {
        yield node_fs_1.default.promises.writeFile(path.join(watchDir, 'ephemeral.txt'), 'temporary');
        const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [watchDir] });
        yield watcher.start();
        assert_1.strict.equal(watcher.trackedFileCount, 1);
        // Delete the file
        yield node_fs_1.default.promises.unlink(path.join(watchDir, 'ephemeral.txt'));
        // Manual sync should detect deletion
        const synced = [];
        watcher.on('sync', (uri, action) => synced.push({ uri, action }));
        yield watcher.sync();
        try {
            assert_1.strict.equal(watcher.trackedFileCount, 0);
            const deleted = synced.find(s => s.action === 'deleted');
            assert_1.strict.ok(deleted, 'should have emitted a delete event');
        }
        finally {
            yield watcher.stop();
        }
    }));
    it('should handle sync() detecting updated files', () => __awaiter(void 0, void 0, void 0, function* () {
        const filePath = path.join(watchDir, 'mutable.txt');
        yield node_fs_1.default.promises.writeFile(filePath, 'version 1');
        const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [watchDir] });
        yield watcher.start();
        assert_1.strict.equal(watcher.trackedFileCount, 1);
        // Update the file (ensure mtime changes)
        yield new Promise(r => setTimeout(r, 50));
        yield node_fs_1.default.promises.writeFile(filePath, 'version 2');
        // Manual sync should detect update
        const synced = [];
        watcher.on('sync', (uri, action) => synced.push({ uri, action }));
        yield watcher.sync();
        try {
            assert_1.strict.equal(watcher.trackedFileCount, 1);
            const updated = synced.find(s => s.action === 'updated');
            assert_1.strict.ok(updated, 'should have emitted an update event');
        }
        finally {
            yield watcher.stop();
        }
    }));
    it('should not throw if path does not exist', () => __awaiter(void 0, void 0, void 0, function* () {
        const watcher = new FolderWatcher_1.FolderWatcher({
            index,
            paths: [path.join(tmpDir, 'nonexistent')]
        });
        yield watcher.start();
        try {
            assert_1.strict.equal(watcher.trackedFileCount, 0);
        }
        finally {
            yield watcher.stop();
        }
    }));
    it('should throw if started twice', () => __awaiter(void 0, void 0, void 0, function* () {
        const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [watchDir] });
        yield watcher.start();
        try {
            yield assert_1.strict.rejects(() => watcher.start(), /already running/);
        }
        finally {
            yield watcher.stop();
        }
    }));
    it('should report isRunning correctly', () => __awaiter(void 0, void 0, void 0, function* () {
        const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [watchDir] });
        assert_1.strict.equal(watcher.isRunning, false);
        yield watcher.start();
        assert_1.strict.equal(watcher.isRunning, true);
        yield watcher.stop();
        assert_1.strict.equal(watcher.isRunning, false);
    }));
    it('should emit error events for sync failures', () => __awaiter(void 0, void 0, void 0, function* () {
        yield node_fs_1.default.promises.writeFile(path.join(watchDir, 'bad.txt'), 'content');
        // Create watcher with no embeddings to force error
        const badIndex = new LocalDocumentIndex_1.LocalDocumentIndex({
            folderPath: indexDir,
            // no embeddings — will throw on upsertDocument
            storage: new LocalFileStorage_1.LocalFileStorage(),
        });
        const watcher = new FolderWatcher_1.FolderWatcher({ index: badIndex, paths: [watchDir] });
        const errors = [];
        watcher.on('error', (err, uri) => errors.push({ err, uri }));
        yield watcher.start();
        try {
            assert_1.strict.equal(errors.length, 1);
            assert_1.strict.ok(errors[0].err.message.includes('Embeddings model not configured'));
        }
        finally {
            yield watcher.stop();
        }
    }));
    describe('internal event dispatch (white-box)', () => {
        // These tests invoke the private event-dispatch helpers directly so we
        // don't depend on the OS firing fs.watch events at a predictable time.
        // They exercise the same code paths that fs.watch would trigger.
        it('_processEvent on a new subdirectory installs watchers and syncs files inside it', () => __awaiter(void 0, void 0, void 0, function* () {
            // Stage the subdirectory first so this test is isolated from the
            // race between real fs.watch events and our manual dispatch.
            const subDir = path.join(watchDir, 'new-sub');
            yield node_fs_1.default.promises.mkdir(subDir);
            yield node_fs_1.default.promises.writeFile(path.join(subDir, 'a.txt'), 'a');
            yield node_fs_1.default.promises.writeFile(path.join(subDir, 'b.txt'), 'b');
            const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [watchDir] });
            // Manually enable _running and call _processEvent directly without
            // ever starting the OS fs.watch, so this test is deterministic.
            watcher._running = true;
            try {
                yield watcher._processEvent(subDir);
                assert_1.strict.equal(watcher.trackedFileCount, 2);
                assert_1.strict.ok(watcher._dirWatchers.has(subDir));
            }
            finally {
                watcher._running = false;
                for (const w of watcher._watchers) {
                    try {
                        w.close();
                    }
                    catch ( /* ignore */_a) { /* ignore */ }
                }
            }
        }));
        it('_processEvent on a deleted watched directory tears down its watcher (and descendants)', () => __awaiter(void 0, void 0, void 0, function* () {
            const subDir = path.join(watchDir, 'doomed');
            const innerDir = path.join(subDir, 'inner');
            yield node_fs_1.default.promises.mkdir(innerDir, { recursive: true });
            yield node_fs_1.default.promises.writeFile(path.join(innerDir, 'inside.txt'), 'x');
            const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [watchDir] });
            yield watcher.start();
            try {
                assert_1.strict.ok(watcher._dirWatchers.has(subDir));
                assert_1.strict.ok(watcher._dirWatchers.has(innerDir));
                // Delete the subdir on disk, then signal the event.
                yield node_fs_1.default.promises.rm(subDir, { recursive: true, force: true });
                yield watcher._processEvent(subDir);
                assert_1.strict.equal(watcher._dirWatchers.has(subDir), false);
                assert_1.strict.equal(watcher._dirWatchers.has(innerDir), false, 'descendant watcher should be cleaned up too');
            }
            finally {
                yield watcher.stop();
            }
        }));
        it('_processEvent on a file path debounces a sync', () => __awaiter(void 0, void 0, void 0, function* () {
            yield node_fs_1.default.promises.writeFile(path.join(watchDir, 'existing.txt'), 'v1');
            const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [watchDir], debounceMs: 10 });
            yield watcher.start();
            try {
                const filePath = path.join(watchDir, 'existing.txt');
                yield node_fs_1.default.promises.writeFile(filePath, 'v2');
                yield watcher._processEvent(filePath);
                // Wait for the debounce timer to fire.
                yield new Promise(r => setTimeout(r, 40));
                const tracked = watcher._tracked.get(filePath);
                assert_1.strict.ok(tracked, 'file should be tracked after debounce fires');
            }
            finally {
                yield watcher.stop();
            }
        }));
        it('_processEvent on a deleted tracked file triggers debouncedSync that deletes it', () => __awaiter(void 0, void 0, void 0, function* () {
            const filePath = path.join(watchDir, 'goner.txt');
            yield node_fs_1.default.promises.writeFile(filePath, 'v1');
            const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [watchDir], debounceMs: 10 });
            yield watcher.start();
            try {
                assert_1.strict.equal(watcher.trackedFileCount, 1);
                yield node_fs_1.default.promises.unlink(filePath);
                yield watcher._processEvent(filePath);
                // Wait for the debounce timer to fire and call _deleteFile.
                yield new Promise(r => setTimeout(r, 40));
                assert_1.strict.equal(watcher.trackedFileCount, 0);
            }
            finally {
                yield watcher.stop();
            }
        }));
        it('_processEvent ignores files whose extension does not match the filter', () => __awaiter(void 0, void 0, void 0, function* () {
            const watcher = new FolderWatcher_1.FolderWatcher({
                index,
                paths: [watchDir],
                extensions: ['.md'],
                debounceMs: 10,
            });
            yield watcher.start();
            try {
                const filePath = path.join(watchDir, 'skip.txt');
                yield node_fs_1.default.promises.writeFile(filePath, 'should be skipped');
                yield watcher._processEvent(filePath);
                yield new Promise(r => setTimeout(r, 40));
                assert_1.strict.equal(watcher.trackedFileCount, 0);
            }
            finally {
                yield watcher.stop();
            }
        }));
        it('_processEvent does nothing once the watcher has been stopped', () => __awaiter(void 0, void 0, void 0, function* () {
            const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [watchDir] });
            yield watcher.start();
            yield watcher.stop();
            const filePath = path.join(watchDir, 'never.txt');
            yield node_fs_1.default.promises.writeFile(filePath, 'x');
            yield watcher._processEvent(filePath);
            assert_1.strict.equal(watcher.trackedFileCount, 0);
        }));
        it('error events from a directory watcher remove it from the internal maps', () => __awaiter(void 0, void 0, void 0, function* () {
            const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [watchDir] });
            yield watcher.start();
            try {
                const dirWatcher = watcher._dirWatchers.get(watchDir);
                assert_1.strict.ok(dirWatcher, 'watcher should be installed');
                const errors = [];
                watcher.on('error', (err, uri) => errors.push({ err, uri }));
                dirWatcher.emit('error', new Error('simulated watcher fault'));
                assert_1.strict.equal(errors.length, 1);
                assert_1.strict.equal(errors[0].err.message, 'simulated watcher fault');
                assert_1.strict.equal(watcher._dirWatchers.has(watchDir), false, 'the dead watcher should have been removed from the map');
            }
            finally {
                yield watcher.stop();
            }
        }));
        it('error events from a single-file watcher are surfaced to consumers', () => __awaiter(void 0, void 0, void 0, function* () {
            const singleFile = path.join(tmpDir, 'single.txt');
            yield node_fs_1.default.promises.writeFile(singleFile, 'hi');
            const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [singleFile] });
            yield watcher.start();
            try {
                const fileWatcher = watcher._watchers[0];
                assert_1.strict.ok(fileWatcher, 'file watcher should be installed');
                const errors = [];
                watcher.on('error', (err, uri) => errors.push({ err, uri }));
                fileWatcher.emit('error', new Error('file watcher fault'));
                assert_1.strict.equal(errors.length, 1);
                assert_1.strict.equal(errors[0].err.message, 'file watcher fault');
            }
            finally {
                yield watcher.stop();
            }
        }));
        it('_addDirectoryWatch emits an error event when fs.watch throws synchronously', () => __awaiter(void 0, void 0, void 0, function* () {
            const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [watchDir] });
            yield watcher.start();
            try {
                const errors = [];
                watcher.on('error', (err, uri) => errors.push({ err, uri }));
                const stub = sandbox.stub(node_fs_1.default, 'watch').throws(new Error('watch failed'));
                try {
                    watcher._addDirectoryWatch(path.join(watchDir, 'never-watched'));
                }
                finally {
                    stub.restore();
                }
                assert_1.strict.equal(errors.length, 1);
                assert_1.strict.equal(errors[0].err.message, 'watch failed');
            }
            finally {
                yield watcher.stop();
            }
        }));
        it('_watchFile change event fires the debounced sync', () => __awaiter(void 0, void 0, void 0, function* () {
            const singleFile = path.join(tmpDir, 'single.txt');
            yield node_fs_1.default.promises.writeFile(singleFile, 'v1');
            const watcher = new FolderWatcher_1.FolderWatcher({
                index,
                paths: [singleFile],
                debounceMs: 10,
            });
            yield watcher.start();
            try {
                const fileWatcher = watcher._watchers[0];
                yield node_fs_1.default.promises.writeFile(singleFile, 'v2');
                // FSWatcher emits 'change' events that invoke the callback we
                // registered with fs.watch.
                fileWatcher.emit('change', 'change', path.basename(singleFile));
                yield new Promise(r => setTimeout(r, 40));
                const tracked = watcher._tracked.get(singleFile);
                assert_1.strict.ok(tracked, 'file should be tracked after debounce fires');
            }
            finally {
                yield watcher.stop();
            }
        }));
        it('_watchFile emits an error event when fs.watch throws synchronously', () => __awaiter(void 0, void 0, void 0, function* () {
            const singleFile = path.join(tmpDir, 'single.txt');
            yield node_fs_1.default.promises.writeFile(singleFile, 'hi');
            const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [singleFile] });
            const errors = [];
            watcher.on('error', (err, uri) => errors.push({ err, uri }));
            const stub = sandbox.stub(node_fs_1.default, 'watch').throws(new Error('file watch failed'));
            try {
                watcher._watchFile(singleFile);
            }
            finally {
                stub.restore();
            }
            assert_1.strict.equal(errors.length, 1);
            assert_1.strict.equal(errors[0].err.message, 'file watch failed');
        }));
        it('_processEvent surfaces exceptions through the error event', () => __awaiter(void 0, void 0, void 0, function* () {
            const watcher = new FolderWatcher_1.FolderWatcher({ index, paths: [watchDir] });
            yield watcher.start();
            try {
                const errors = [];
                watcher.on('error', (err, uri) => errors.push({ err, uri }));
                // Force _processEvent to reject so we exercise the .catch in
                // _handleEvent.
                const stub = sandbox.stub(watcher, '_processEvent').rejects(new Error('boom'));
                try {
                    watcher._handleEvent(path.join(watchDir, 'whatever.txt'));
                    yield new Promise(r => setImmediate(r));
                }
                finally {
                    stub.restore();
                }
                assert_1.strict.equal(errors.length, 1);
                assert_1.strict.equal(errors[0].err.message, 'boom');
            }
            finally {
                yield watcher.stop();
            }
        }));
    });
});
//# sourceMappingURL=FolderWatcher.spec.js.map