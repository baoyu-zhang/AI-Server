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
const assert = __importStar(require("node:assert"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const IndexManager_1 = require("./IndexManager");
const LocalIndex_1 = require("../LocalIndex");
const LocalDocumentIndex_1 = require("../LocalDocumentIndex");
function mkTmp(prefix) {
    return __awaiter(this, void 0, void 0, function* () {
        return fs.promises.realpath(yield fs.promises.mkdtemp(path.join(os.tmpdir(), prefix)));
    });
}
describe('IndexManager', () => {
    let tmpRoot;
    beforeEach(() => __awaiter(void 0, void 0, void 0, function* () {
        tmpRoot = yield mkTmp('vectra-im-');
    }));
    afterEach(() => __awaiter(void 0, void 0, void 0, function* () {
        yield fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }));
    describe('mode flags', () => {
        it('isSingleMode reflects whether indexPath is provided', () => {
            const single = new IndexManager_1.IndexManager({ indexPath: path.join(tmpRoot, 'one') });
            const multi = new IndexManager_1.IndexManager({ rootDir: tmpRoot });
            assert.equal(single.isSingleMode, true);
            assert.equal(multi.isSingleMode, false);
        });
    });
    describe('initialize / shutdown', () => {
        it('initialize is a no-op when neither indexPath nor rootDir is set', () => __awaiter(void 0, void 0, void 0, function* () {
            const mgr = new IndexManager_1.IndexManager({});
            yield mgr.initialize();
            assert.equal(mgr.listIndexes().length, 0);
            yield mgr.shutdown();
        }));
        it('shutdown clears the periodic scan timer', () => __awaiter(void 0, void 0, void 0, function* () {
            const mgr = new IndexManager_1.IndexManager({ rootDir: tmpRoot, scanInterval: 200 });
            yield mgr.initialize();
            // Internal field check — verifies the timer was set.
            assert.ok(mgr._scanTimer);
            yield mgr.shutdown();
            assert.equal(mgr._scanTimer, undefined);
            assert.equal(mgr.listIndexes().length, 0);
        }));
        it('initialize in single mode loads the single index by basename', () => __awaiter(void 0, void 0, void 0, function* () {
            const indexDir = path.join(tmpRoot, 'solo');
            const idx = new LocalIndex_1.LocalIndex(indexDir);
            yield idx.createIndex();
            const mgr = new IndexManager_1.IndexManager({ indexPath: indexDir });
            yield mgr.initialize();
            try {
                const list = mgr.listIndexes();
                assert.equal(list.length, 1);
                assert.equal(list[0].name, 'solo');
                assert.equal(list[0].isDocumentIndex, false);
            }
            finally {
                yield mgr.shutdown();
            }
        }));
        it('single-mode getIndex returns the loaded index regardless of the name passed', () => __awaiter(void 0, void 0, void 0, function* () {
            const indexDir = path.join(tmpRoot, 'solo');
            const idx = new LocalIndex_1.LocalIndex(indexDir);
            yield idx.createIndex();
            const mgr = new IndexManager_1.IndexManager({ indexPath: indexDir });
            yield mgr.initialize();
            try {
                const a = mgr.getIndex('solo');
                const b = mgr.getIndex('something-else-entirely');
                const c = mgr.getIndex('');
                assert.ok(a);
                assert.equal(a, b);
                assert.equal(a, c);
            }
            finally {
                yield mgr.shutdown();
            }
        }));
    });
    describe('scanRootDir', () => {
        it('skips non-directories, dot-prefixed entries, and already-loaded indexes', () => __awaiter(void 0, void 0, void 0, function* () {
            // One real index, a hidden dir, a stray file, and a junk dir that isn't an index.
            const realIndex = path.join(tmpRoot, 'real');
            yield new LocalIndex_1.LocalIndex(realIndex).createIndex();
            yield fs.promises.mkdir(path.join(tmpRoot, '.hidden'));
            yield fs.promises.writeFile(path.join(tmpRoot, 'stray.txt'), 'x');
            yield fs.promises.mkdir(path.join(tmpRoot, 'not-an-index'));
            const mgr = new IndexManager_1.IndexManager({ rootDir: tmpRoot, scanInterval: 100000 });
            yield mgr.initialize();
            try {
                const names = mgr.listIndexes().map(m => m.name).sort();
                assert.deepEqual(names, ['real']);
            }
            finally {
                yield mgr.shutdown();
            }
        }));
        it('returns silently when rootDir does not exist on disk', () => __awaiter(void 0, void 0, void 0, function* () {
            const ghostRoot = path.join(tmpRoot, 'never-created');
            const mgr = new IndexManager_1.IndexManager({ rootDir: ghostRoot, scanInterval: 100000 });
            yield mgr.initialize();
            try {
                assert.equal(mgr.listIndexes().length, 0);
            }
            finally {
                yield mgr.shutdown();
            }
        }));
        it('picks up indexes created after initialize via the periodic timer', () => __awaiter(void 0, void 0, void 0, function* () {
            const mgr = new IndexManager_1.IndexManager({ rootDir: tmpRoot, scanInterval: 50 });
            yield mgr.initialize();
            try {
                assert.equal(mgr.listIndexes().length, 0);
                const newIndex = path.join(tmpRoot, 'late-arrival');
                yield new LocalIndex_1.LocalIndex(newIndex).createIndex();
                // Wait for the scanner to tick.
                yield new Promise(r => setTimeout(r, 250));
                const names = mgr.listIndexes().map(m => m.name);
                assert.ok(names.includes('late-arrival'), `expected late-arrival in ${JSON.stringify(names)}`);
            }
            finally {
                yield mgr.shutdown();
            }
        }));
        it('loads a document index when a catalog file is present', () => __awaiter(void 0, void 0, void 0, function* () {
            const docDir = path.join(tmpRoot, 'docs');
            const docIndex = new LocalDocumentIndex_1.LocalDocumentIndex({ folderPath: docDir });
            yield docIndex.createIndex();
            // createIndex on a document index writes catalog.json via loadIndexData,
            // but only when something prompts it. Touch the catalog to be sure.
            yield docIndex.isCatalogCreated();
            const mgr = new IndexManager_1.IndexManager({ rootDir: tmpRoot, scanInterval: 100000 });
            yield mgr.initialize();
            try {
                const managed = mgr.getIndex('docs');
                assert.ok(managed, 'docs index should be loaded');
                assert.equal(managed.isDocumentIndex, true);
            }
            finally {
                yield mgr.shutdown();
            }
        }));
    });
    describe('createIndex', () => {
        it('throws when no rootDir is configured and not in single mode', () => __awaiter(void 0, void 0, void 0, function* () {
            const mgr = new IndexManager_1.IndexManager({});
            yield mgr.initialize();
            try {
                yield assert.rejects(mgr.createIndex('orphan', 'json', false), /no root directory configured/);
            }
            finally {
                yield mgr.shutdown();
            }
        }));
        it('throws when the name is already loaded', () => __awaiter(void 0, void 0, void 0, function* () {
            const mgr = new IndexManager_1.IndexManager({ rootDir: tmpRoot, scanInterval: 100000 });
            yield mgr.initialize();
            try {
                yield mgr.createIndex('dup', 'json', false);
                yield assert.rejects(mgr.createIndex('dup', 'json', false), /already exists/);
            }
            finally {
                yield mgr.shutdown();
            }
        }));
        it('creates a document index using the supplied chunking config', () => __awaiter(void 0, void 0, void 0, function* () {
            const mgr = new IndexManager_1.IndexManager({ rootDir: tmpRoot, scanInterval: 100000 });
            yield mgr.initialize();
            try {
                const managed = yield mgr.createIndex('docidx', 'json', true, {
                    version: 1,
                    chunkSize: 256,
                    chunkOverlap: 16,
                });
                assert.equal(managed.isDocumentIndex, true);
                assert.ok(managed.index instanceof LocalDocumentIndex_1.LocalDocumentIndex);
            }
            finally {
                yield mgr.shutdown();
            }
        }));
        it('honors the protobuf format flag', () => __awaiter(void 0, void 0, void 0, function* () {
            const mgr = new IndexManager_1.IndexManager({ rootDir: tmpRoot, scanInterval: 100000 });
            yield mgr.initialize();
            try {
                const managed = yield mgr.createIndex('pbidx', 'protobuf', false);
                assert.equal(managed.format, 'protobuf');
                assert.equal(managed.index.codec.extension, '.pb');
            }
            finally {
                yield mgr.shutdown();
            }
        }));
    });
    describe('requireIndex / requireDocumentIndex', () => {
        it('requireIndex throws for unknown names in multi-index mode', () => __awaiter(void 0, void 0, void 0, function* () {
            const mgr = new IndexManager_1.IndexManager({ rootDir: tmpRoot, scanInterval: 100000 });
            yield mgr.initialize();
            try {
                assert.throws(() => mgr.requireIndex('missing'), /Index not found/);
            }
            finally {
                yield mgr.shutdown();
            }
        }));
        it('requireDocumentIndex throws when the named index is not a document index', () => __awaiter(void 0, void 0, void 0, function* () {
            const mgr = new IndexManager_1.IndexManager({ rootDir: tmpRoot, scanInterval: 100000 });
            yield mgr.initialize();
            try {
                yield mgr.createIndex('flat', 'json', false);
                assert.throws(() => mgr.requireDocumentIndex('flat'), /not a document index/);
            }
            finally {
                yield mgr.shutdown();
            }
        }));
        it('requireDocumentIndex returns both wrappers for a real document index', () => __awaiter(void 0, void 0, void 0, function* () {
            const mgr = new IndexManager_1.IndexManager({ rootDir: tmpRoot, scanInterval: 100000 });
            yield mgr.initialize();
            try {
                yield mgr.createIndex('docs', 'json', true);
                const { managed, docIndex } = mgr.requireDocumentIndex('docs');
                assert.equal(managed.isDocumentIndex, true);
                assert.ok(docIndex instanceof LocalDocumentIndex_1.LocalDocumentIndex);
            }
            finally {
                yield mgr.shutdown();
            }
        }));
    });
    describe('deleteIndex', () => {
        it('removes a loaded index from memory and from disk', () => __awaiter(void 0, void 0, void 0, function* () {
            const mgr = new IndexManager_1.IndexManager({ rootDir: tmpRoot, scanInterval: 100000 });
            yield mgr.initialize();
            try {
                yield mgr.createIndex('disposable', 'json', false);
                const folderPath = path.join(tmpRoot, 'disposable');
                assert.ok(fs.existsSync(folderPath));
                yield mgr.deleteIndex('disposable');
                assert.equal(mgr.getIndex('disposable'), undefined);
                assert.equal(fs.existsSync(folderPath), false);
            }
            finally {
                yield mgr.shutdown();
            }
        }));
        it('throws when deleting an unknown index', () => __awaiter(void 0, void 0, void 0, function* () {
            const mgr = new IndexManager_1.IndexManager({ rootDir: tmpRoot, scanInterval: 100000 });
            yield mgr.initialize();
            try {
                yield assert.rejects(mgr.deleteIndex('nope'), /Index not found/);
            }
            finally {
                yield mgr.shutdown();
            }
        }));
    });
});
//# sourceMappingURL=IndexManager.spec.js.map