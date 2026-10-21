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
const pathUtils_1 = __importDefault(require("./utils/pathUtils"));
const node_assert_1 = require("node:assert");
const mocha_1 = require("mocha");
const LocalDocumentIndex_1 = require("./LocalDocumentIndex");
const contentHash_1 = require("./internals/contentHash");
class FakeEmbeddings {
    constructor() {
        this.maxTokens = 10;
        this.createEmbeddingsCalls = [];
        this.createEmbeddingsResponses = [];
    }
    createEmbeddings(inputs) {
        return __awaiter(this, void 0, void 0, function* () {
            this.createEmbeddingsCalls.push(inputs);
            if (this.createEmbeddingsResponses.length > 0) {
                return this.createEmbeddingsResponses.shift();
            }
            const arr = Array.isArray(inputs) ? inputs : [inputs];
            return { status: 'success', output: arr.map(() => [0.1, 0.2]) };
        });
    }
}
class SimpleTokenizer {
    encode(text) {
        return Array.from(text).map(ch => ch.charCodeAt(0));
    }
    decode(tokens) {
        return tokens.map(t => String.fromCharCode(t)).join('');
    }
}
class FakeStorage {
    constructor() {
        this.files = new Map();
        this.folders = new Set();
        this.pathExistsCalls = [];
        this.readFileCalls = [];
        this.upsertFileCalls = [];
        this.deleteFileCalls = [];
        this.createdFolders = [];
        this.deletedFolders = [];
        this.createdFiles = [];
    }
    createFile(filePath, content) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.files.has(filePath))
                throw new Error('File already exists');
            this.createdFiles.push(filePath);
            const text = Buffer.isBuffer(content) ? content.toString('utf8') : content;
            this.files.set(filePath, text);
        });
    }
    createFolder(folderPath) {
        return __awaiter(this, void 0, void 0, function* () {
            this.createdFolders.push(folderPath);
            this.folders.add(folderPath);
        });
    }
    deleteFile(filePath) {
        return __awaiter(this, void 0, void 0, function* () {
            this.deleteFileCalls.push(filePath);
            if (!this.files.has(filePath)) {
                throw new Error('File not found');
            }
            this.files.delete(filePath);
        });
    }
    deleteFolder(folderPath) {
        return __awaiter(this, void 0, void 0, function* () {
            this.deletedFolders.push(folderPath);
            for (const key of [...this.files.keys()]) {
                if (key.startsWith(folderPath))
                    this.files.delete(key);
            }
            this.folders.delete(folderPath);
        });
    }
    getDetails(fileOrFolderPath) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.folders.has(fileOrFolderPath)) {
                return { name: pathUtils_1.default.basename(fileOrFolderPath), path: fileOrFolderPath, isFolder: true };
            }
            if (this.files.has(fileOrFolderPath)) {
                return { name: pathUtils_1.default.basename(fileOrFolderPath), path: fileOrFolderPath, isFolder: false };
            }
            throw new Error('Path not found');
        });
    }
    listFiles(folderPath_1) {
        return __awaiter(this, arguments, void 0, function* (folderPath, filter = 'all') {
            const results = [];
            for (const f of this.folders) {
                const parent = pathUtils_1.default.dirname(f);
                if (parent === folderPath) {
                    if (filter === 'all' || filter === 'folders') {
                        results.push({ name: pathUtils_1.default.basename(f), path: f, isFolder: true });
                    }
                }
            }
            for (const f of this.files.keys()) {
                const parent = pathUtils_1.default.dirname(f);
                if (parent === folderPath) {
                    if (filter === 'all' || filter === 'files') {
                        results.push({ name: pathUtils_1.default.basename(f), path: f, isFolder: false });
                    }
                }
            }
            return results;
        });
    }
    pathExists(fileOrFolderPath) {
        return __awaiter(this, void 0, void 0, function* () {
            this.pathExistsCalls.push(fileOrFolderPath);
            return this.files.has(fileOrFolderPath) || this.folders.has(fileOrFolderPath);
        });
    }
    readFile(filePath) {
        return __awaiter(this, void 0, void 0, function* () {
            this.readFileCalls.push(filePath);
            if (!this.files.has(filePath))
                throw new Error('File not found');
            return Buffer.from(this.files.get(filePath), 'utf8');
        });
    }
    upsertFile(filePath, content) {
        return __awaiter(this, void 0, void 0, function* () {
            const text = Buffer.isBuffer(content) ? content.toString('utf8') : content;
            this.upsertFileCalls.push({ path: filePath, content: text });
            this.files.set(filePath, text);
        });
    }
}
(0, mocha_1.describe)('LocalDocumentIndex', () => {
    let storage;
    let embeddings;
    let tokenizer;
    let index;
    const folderPath = '/fake/path';
    const indexJsonPath = pathUtils_1.default.join(folderPath, 'index.json');
    (0, mocha_1.beforeEach)(() => {
        storage = new FakeStorage();
        embeddings = new FakeEmbeddings();
        tokenizer = new SimpleTokenizer();
        storage.files.set(indexJsonPath, JSON.stringify({ version: 1, metadata_config: {}, items: [] }));
        const config = { folderPath, embeddings, tokenizer, storage };
        index = new LocalDocumentIndex_1.LocalDocumentIndex(config);
    });
    (0, mocha_1.describe)('constructor and getters', () => {
        (0, mocha_1.it)('uses defaults when not provided (GPT3Tokenizer, undefined embeddings)', () => {
            const idx = new LocalDocumentIndex_1.LocalDocumentIndex({ folderPath });
            node_assert_1.strict.equal(idx.tokenizer.constructor.name, 'GPT3Tokenizer');
            node_assert_1.strict.equal(idx.embeddings, undefined);
        });
        (0, mocha_1.it)('uses provided tokenizer and embeddings', () => {
            const fakeTok = new SimpleTokenizer();
            const idx = new LocalDocumentIndex_1.LocalDocumentIndex({ folderPath, tokenizer: fakeTok, embeddings, storage });
            node_assert_1.strict.equal(idx.tokenizer, fakeTok);
            node_assert_1.strict.equal(idx.embeddings, embeddings);
        });
    });
    (0, mocha_1.describe)('isCatalogCreated', () => {
        (0, mocha_1.it)('returns true if catalog.json exists at correct path', () => __awaiter(void 0, void 0, void 0, function* () {
            const catalogPath = pathUtils_1.default.join(folderPath, 'catalog.json');
            storage.files.set(catalogPath, '{}');
            const exists = yield index.isCatalogCreated();
            node_assert_1.strict.equal(exists, true);
            node_assert_1.strict.equal(storage.pathExistsCalls[0], catalogPath);
        }));
        (0, mocha_1.it)('returns false if catalog.json does not exist', () => __awaiter(void 0, void 0, void 0, function* () {
            const exists = yield index.isCatalogCreated();
            node_assert_1.strict.equal(exists, false);
        }));
    });
    (0, mocha_1.describe)('loadIndexData', () => {
        (0, mocha_1.it)('early returns if catalog already loaded (no catalog read)', () => __awaiter(void 0, void 0, void 0, function* () {
            index._catalog = { version: 1, count: 0, uriToId: {}, idToUri: {} };
            yield index.loadIndexData(); // base will read index.json; catalog should not be read
            const catalogPath = pathUtils_1.default.join(folderPath, 'catalog.json');
            const catalogReads = storage.readFileCalls.filter(p => p === catalogPath).length;
            node_assert_1.strict.equal(catalogReads, 0);
        }));
        (0, mocha_1.it)('loads existing catalog from storage', () => __awaiter(void 0, void 0, void 0, function* () {
            const catalogPath = pathUtils_1.default.join(folderPath, 'catalog.json');
            const catalogData = JSON.stringify({ version: 1, count: 2, uriToId: { a: 'id1' }, idToUri: { id1: 'a' } });
            storage.files.set(catalogPath, catalogData);
            const loaded = new LocalDocumentIndex_1.LocalDocumentIndex({ folderPath, storage, tokenizer });
            (storage.files).set(indexJsonPath, JSON.stringify({ version: 1, metadata_config: {}, items: [] }));
            yield loaded.loadIndexData();
            node_assert_1.strict.deepEqual(loaded._catalog, JSON.parse(catalogData));
        }));
        (0, mocha_1.it)('creates new catalog if none exists and persists it', () => __awaiter(void 0, void 0, void 0, function* () {
            const newIndex = new LocalDocumentIndex_1.LocalDocumentIndex({ folderPath, storage, tokenizer });
            yield newIndex.loadIndexData();
            const catalogPath = pathUtils_1.default.join(folderPath, 'catalog.json');
            (0, node_assert_1.strict)(storage.upsertFileCalls.some(c => c.path === catalogPath));
            const catalog = newIndex._catalog;
            node_assert_1.strict.equal(catalog.version, 1);
            node_assert_1.strict.equal(catalog.count, 0);
            node_assert_1.strict.deepEqual(catalog.uriToId, {});
            node_assert_1.strict.deepEqual(catalog.idToUri, {});
        }));
        (0, mocha_1.it)('wraps error when failing to create catalog', () => __awaiter(void 0, void 0, void 0, function* () {
            const failing = new LocalDocumentIndex_1.LocalDocumentIndex({ folderPath, storage, tokenizer });
            const orig = storage.upsertFile.bind(storage);
            storage.upsertFile = (p, c) => __awaiter(void 0, void 0, void 0, function* () {
                if (p.endsWith('catalog.json'))
                    throw new Error('disk error');
                return orig(p, c);
            });
            yield node_assert_1.strict.rejects(failing.loadIndexData(), /Error creating document catalog: Error: disk error/);
        }));
    });
    (0, mocha_1.describe)('getDocumentId and getDocumentUri', () => {
        (0, mocha_1.beforeEach)(() => {
            index._catalog = { version: 1, count: 1, uriToId: { doc1: 'id1' }, idToUri: { id1: 'doc1' } };
        });
        (0, mocha_1.it)('returns id for known uri', () => __awaiter(void 0, void 0, void 0, function* () {
            node_assert_1.strict.equal(yield index.getDocumentId('doc1'), 'id1');
        }));
        (0, mocha_1.it)('returns undefined for unknown uri', () => __awaiter(void 0, void 0, void 0, function* () {
            node_assert_1.strict.equal(yield index.getDocumentId('nope'), undefined);
        }));
        (0, mocha_1.it)('returns uri for known id', () => __awaiter(void 0, void 0, void 0, function* () {
            node_assert_1.strict.equal(yield index.getDocumentUri('id1'), 'doc1');
        }));
        (0, mocha_1.it)('returns undefined for unknown id', () => __awaiter(void 0, void 0, void 0, function* () {
            node_assert_1.strict.equal(yield index.getDocumentUri('nope'), undefined);
        }));
    });
    (0, mocha_1.describe)('getCatalogStats', () => {
        (0, mocha_1.it)('returns catalog stats merged with index stats', () => __awaiter(void 0, void 0, void 0, function* () {
            index._catalog = { version: 1, count: 2, uriToId: {}, idToUri: {} };
            index.getIndexStats = () => __awaiter(void 0, void 0, void 0, function* () { return ({ items: 5, metadata_config: { indexed: ['a'] } }); });
            const stats = yield index.getCatalogStats();
            node_assert_1.strict.equal(stats.version, 1);
            node_assert_1.strict.equal(stats.documents, 2);
            node_assert_1.strict.equal(stats.chunks, 5);
            node_assert_1.strict.deepEqual(stats.metadata_config, { indexed: ['a'] });
        }));
    });
    (0, mocha_1.describe)('deleteDocument', () => {
        (0, mocha_1.it)('returns early if document not found', () => __awaiter(void 0, void 0, void 0, function* () {
            const result = yield index.deleteDocument('missing');
            node_assert_1.strict.equal(result, undefined);
        }));
        (0, mocha_1.it)('successfully deletes chunks, updates catalog, and removes files', () => __awaiter(void 0, void 0, void 0, function* () {
            const uri = 'doc://one';
            const documentId = 'id-1';
            index._catalog = { version: 1, count: 1, uriToId: { [uri]: documentId }, idToUri: { [documentId]: uri } };
            storage.files.set(pathUtils_1.default.join(folderPath, `${documentId}.txt`), 'hello');
            storage.files.set(pathUtils_1.default.join(folderPath, `${documentId}.json`), '{"k":"v"}');
            index.listItemsByMetadata = () => __awaiter(void 0, void 0, void 0, function* () { return [{ id: 'chunk-1', metadata: { documentId } }]; });
            index.deleteItem = () => __awaiter(void 0, void 0, void 0, function* () { });
            yield index.deleteDocument(uri);
            (0, node_assert_1.strict)(!storage.files.has(pathUtils_1.default.join(folderPath, `${documentId}.txt`)));
            (0, node_assert_1.strict)(!storage.files.has(pathUtils_1.default.join(folderPath, `${documentId}.json`)));
            node_assert_1.strict.equal(index._catalog.count, 0);
            node_assert_1.strict.equal(index._catalog.uriToId[uri], undefined);
            node_assert_1.strict.equal(index._catalog.idToUri[documentId], undefined);
        }));
        (0, mocha_1.it)('cancels update and throws when batch chunk deletion fails', () => __awaiter(void 0, void 0, void 0, function* () {
            const uri = 'doc://err';
            const documentId = 'id-err';
            index._catalog = { version: 1, count: 1, uriToId: { [uri]: documentId }, idToUri: { [documentId]: uri } };
            index.listItemsByMetadata = () => __awaiter(void 0, void 0, void 0, function* () { return [{ id: 'chunk-1', metadata: { documentId } }]; });
            index.deleteItems = () => __awaiter(void 0, void 0, void 0, function* () { throw new Error('delete error'); });
            yield node_assert_1.strict.rejects(index.deleteDocument(uri), /Error deleting document "doc:\/\/err": Error: delete error/);
        }));
        (0, mocha_1.it)('wraps error when deleting text file fails and ignores metadata deletion failures', () => __awaiter(void 0, void 0, void 0, function* () {
            const uri = 'doc://bad-delete';
            const documentId = 'id-text-err';
            index._catalog = { version: 1, count: 1, uriToId: { [uri]: documentId }, idToUri: { [documentId]: uri } };
            index.listItemsByMetadata = () => __awaiter(void 0, void 0, void 0, function* () { return []; });
            index.deleteItem = () => __awaiter(void 0, void 0, void 0, function* () { });
            const originalDelete = storage.deleteFile.bind(storage);
            storage.deleteFile = (filePath) => __awaiter(void 0, void 0, void 0, function* () {
                if (filePath.endsWith('.txt'))
                    throw new Error('delete text error');
                return originalDelete(filePath);
            });
            yield node_assert_1.strict.rejects(index.deleteDocument(uri), /Error removing text file for document "doc:\/\/bad-delete" from disk: Error: delete text error/);
            index._catalog = { version: 1, count: 1, uriToId: { [uri]: documentId }, idToUri: { [documentId]: uri } };
            storage.files.set(pathUtils_1.default.join(folderPath, `${documentId}.txt`), 'x');
            storage.files.set(pathUtils_1.default.join(folderPath, `${documentId}.json`), '{}');
            storage.deleteFile = (filePath) => __awaiter(void 0, void 0, void 0, function* () {
                if (filePath.endsWith('.json'))
                    throw new Error('delete json error');
                return originalDelete(filePath);
            });
            yield index.deleteDocument(uri);
            (0, node_assert_1.strict)(!storage.files.has(pathUtils_1.default.join(folderPath, `${documentId}.txt`)));
        }));
    });
    (0, mocha_1.describe)('upsertDocument', () => {
        (0, mocha_1.it)('throws if embeddings not configured', () => __awaiter(void 0, void 0, void 0, function* () {
            const idx = new LocalDocumentIndex_1.LocalDocumentIndex({ folderPath, storage, tokenizer });
            yield node_assert_1.strict.rejects(idx.upsertDocument('uri', 'text'), /Embeddings model not configured/);
        }));
        (0, mocha_1.it)('deletes existing document when re-inserting same uri', () => __awaiter(void 0, void 0, void 0, function* () {
            const uri = 'doc://exists';
            const existingId = 'doc-1';
            index._catalog = { version: 1, count: 1, uriToId: { [uri]: existingId }, idToUri: { [existingId]: uri } };
            let deleteCalled = false;
            index.deleteDocument = () => __awaiter(void 0, void 0, void 0, function* () { deleteCalled = true; });
            index.insertItem = () => __awaiter(void 0, void 0, void 0, function* () { });
            embeddings.createEmbeddingsResponses.push({ status: 'success', output: [[0.01, 0.02]] });
            const doc = yield index.upsertDocument(uri, 'hello world');
            (0, node_assert_1.strict)(deleteCalled);
            node_assert_1.strict.equal(doc.uri, uri);
        }));
        (0, mocha_1.it)('infers docType from uri when not provided and writes files, updates catalog', () => __awaiter(void 0, void 0, void 0, function* () {
            index.insertItem = () => __awaiter(void 0, void 0, void 0, function* () { });
            embeddings.createEmbeddingsResponses.push({ status: 'success', output: [[0.1, 0.2]] });
            const metadata = { author: 'test' };
            const doc = yield index.upsertDocument('file.md', 'content here', undefined, metadata);
            const textPath = pathUtils_1.default.join(folderPath, `${doc.id}.txt`);
            const metaPath = pathUtils_1.default.join(folderPath, `${doc.id}.json`);
            (0, node_assert_1.strict)(storage.files.has(textPath));
            (0, node_assert_1.strict)(storage.files.has(metaPath));
            node_assert_1.strict.equal(index._catalog.count, 1);
            node_assert_1.strict.equal(index._catalog.idToUri[doc.id], 'file.md');
            node_assert_1.strict.equal(index._catalog.uriToId['file.md'], doc.id);
        }));
        (0, mocha_1.it)('batches chunk embeddings using embeddings.maxTokens and calls createEmbeddings per batch', () => __awaiter(void 0, void 0, void 0, function* () {
            const longText = 'a '.repeat(30);
            const calls = [];
            embeddings.createEmbeddings = (inputs) => __awaiter(void 0, void 0, void 0, function* () {
                calls.push(inputs);
                const arr = Array.isArray(inputs) ? inputs : [inputs];
                return { status: 'success', output: arr.map(() => [0.1, 0.2]) };
            });
            index.insertItem = () => __awaiter(void 0, void 0, void 0, function* () { });
            yield index.upsertDocument('file.txt', longText);
            (0, node_assert_1.strict)(calls.length > 1);
        }));
        (0, mocha_1.it)('wraps embedding generation errors and non-success statuses', () => __awaiter(void 0, void 0, void 0, function* () {
            embeddings.createEmbeddings = () => __awaiter(void 0, void 0, void 0, function* () { throw new Error('fail'); });
            yield node_assert_1.strict.rejects(index.upsertDocument('u', 't'), /Error generating embeddings: Error: fail/);
            embeddings.createEmbeddings = () => __awaiter(void 0, void 0, void 0, function* () { return ({ status: 'error', message: 'bad' }); });
            yield node_assert_1.strict.rejects(index.upsertDocument('u', 't'), /Error generating embeddings: bad/);
        }));
        (0, mocha_1.it)('cancels update and throws when insertItem fails', () => __awaiter(void 0, void 0, void 0, function* () {
            embeddings.createEmbeddingsResponses.push({ status: 'success', output: [[0.1, 0.2]] });
            index.insertItem = () => __awaiter(void 0, void 0, void 0, function* () { throw new Error('insert error'); });
            yield node_assert_1.strict.rejects(index.upsertDocument('u', 't'), /Error adding document "u": Error: insert error/);
        }));
        (0, mocha_1.it)('writes content hash to catalog on successful add', () => __awaiter(void 0, void 0, void 0, function* () {
            index.insertItem = () => __awaiter(void 0, void 0, void 0, function* () { });
            const text = 'fresh content';
            const doc = yield index.upsertDocument('new.txt', text);
            const expectedHash = (0, contentHash_1.computeContentHash)(text, undefined, undefined);
            node_assert_1.strict.equal(index._catalog.uriToHash['new.txt'], expectedHash);
            node_assert_1.strict.equal(doc.uri, 'new.txt');
        }));
    });
    (0, mocha_1.describe)('upsertDocument skip-if-unchanged', () => {
        const uri = 'doc://unchanged';
        const existingId = 'doc-existing';
        const text = 'identical content';
        const metadata = { author: 'alice', tag: 'spec' };
        (0, mocha_1.beforeEach)(() => {
            const hash = (0, contentHash_1.computeContentHash)(text, 'md', metadata);
            index._catalog = {
                version: 1,
                count: 1,
                uriToId: { [uri]: existingId },
                idToUri: { [existingId]: uri },
                uriToHash: { [uri]: hash },
            };
        });
        (0, mocha_1.it)('short-circuits when content + metadata + docType are unchanged', () => __awaiter(void 0, void 0, void 0, function* () {
            let deleteCalled = false;
            index.deleteDocument = () => __awaiter(void 0, void 0, void 0, function* () { deleteCalled = true; });
            index.insertItem = () => __awaiter(void 0, void 0, void 0, function* () { });
            const callsBefore = embeddings.createEmbeddingsCalls.length;
            const upsertCallsBefore = storage.upsertFileCalls.length;
            const doc = yield index.upsertDocument(uri, text, 'md', metadata);
            node_assert_1.strict.equal(deleteCalled, false, 'deleteDocument should not be called');
            node_assert_1.strict.equal(embeddings.createEmbeddingsCalls.length, callsBefore, 'no embeddings calls expected');
            node_assert_1.strict.equal(storage.upsertFileCalls.length, upsertCallsBefore, 'no file writes expected');
            node_assert_1.strict.equal(doc.id, existingId);
            node_assert_1.strict.equal(doc.uri, uri);
        }));
        (0, mocha_1.it)('re-embeds when text changes', () => __awaiter(void 0, void 0, void 0, function* () {
            index.deleteDocument = () => __awaiter(void 0, void 0, void 0, function* () { });
            index.insertItem = () => __awaiter(void 0, void 0, void 0, function* () { });
            const callsBefore = embeddings.createEmbeddingsCalls.length;
            yield index.upsertDocument(uri, 'different content', 'md', metadata);
            (0, node_assert_1.strict)(embeddings.createEmbeddingsCalls.length > callsBefore, 'embeddings should be called');
            const newHash = (0, contentHash_1.computeContentHash)('different content', 'md', metadata);
            node_assert_1.strict.equal(index._catalog.uriToHash[uri], newHash);
        }));
        (0, mocha_1.it)('re-embeds when metadata changes (text identical)', () => __awaiter(void 0, void 0, void 0, function* () {
            index.deleteDocument = () => __awaiter(void 0, void 0, void 0, function* () { });
            index.insertItem = () => __awaiter(void 0, void 0, void 0, function* () { });
            const callsBefore = embeddings.createEmbeddingsCalls.length;
            const changedMetadata = { author: 'bob', tag: 'spec' };
            yield index.upsertDocument(uri, text, 'md', changedMetadata);
            (0, node_assert_1.strict)(embeddings.createEmbeddingsCalls.length > callsBefore);
            const newHash = (0, contentHash_1.computeContentHash)(text, 'md', changedMetadata);
            node_assert_1.strict.equal(index._catalog.uriToHash[uri], newHash);
        }));
        (0, mocha_1.it)('re-embeds when docType changes (text + metadata identical)', () => __awaiter(void 0, void 0, void 0, function* () {
            index.deleteDocument = () => __awaiter(void 0, void 0, void 0, function* () { });
            index.insertItem = () => __awaiter(void 0, void 0, void 0, function* () { });
            const callsBefore = embeddings.createEmbeddingsCalls.length;
            yield index.upsertDocument(uri, text, 'txt', metadata);
            (0, node_assert_1.strict)(embeddings.createEmbeddingsCalls.length > callsBefore);
            const newHash = (0, contentHash_1.computeContentHash)(text, 'txt', metadata);
            node_assert_1.strict.equal(index._catalog.uriToHash[uri], newHash);
        }));
        (0, mocha_1.it)('force: true re-embeds even when hash matches', () => __awaiter(void 0, void 0, void 0, function* () {
            index.deleteDocument = () => __awaiter(void 0, void 0, void 0, function* () { });
            index.insertItem = () => __awaiter(void 0, void 0, void 0, function* () { });
            const callsBefore = embeddings.createEmbeddingsCalls.length;
            yield index.upsertDocument(uri, text, 'md', metadata, { force: true });
            (0, node_assert_1.strict)(embeddings.createEmbeddingsCalls.length > callsBefore, 'force should bypass short-circuit');
            const newHash = (0, contentHash_1.computeContentHash)(text, 'md', metadata);
            node_assert_1.strict.equal(index._catalog.uriToHash[uri], newHash);
        }));
        (0, mocha_1.it)('metadata key order does not break the short-circuit', () => __awaiter(void 0, void 0, void 0, function* () {
            let deleteCalled = false;
            index.deleteDocument = () => __awaiter(void 0, void 0, void 0, function* () { deleteCalled = true; });
            index.insertItem = () => __awaiter(void 0, void 0, void 0, function* () { });
            const reordered = { tag: 'spec', author: 'alice' };
            const callsBefore = embeddings.createEmbeddingsCalls.length;
            yield index.upsertDocument(uri, text, 'md', reordered);
            node_assert_1.strict.equal(deleteCalled, false);
            node_assert_1.strict.equal(embeddings.createEmbeddingsCalls.length, callsBefore);
        }));
        (0, mocha_1.it)('old catalog without uriToHash bootstraps on first upsert, then short-circuits', () => __awaiter(void 0, void 0, void 0, function* () {
            // Reset catalog to pre-upgrade shape (no uriToHash).
            index._catalog = {
                version: 1,
                count: 1,
                uriToId: { [uri]: existingId },
                idToUri: { [existingId]: uri },
            };
            let deleteCount = 0;
            index.deleteDocument = () => __awaiter(void 0, void 0, void 0, function* () { deleteCount++; });
            index.insertItem = () => __awaiter(void 0, void 0, void 0, function* () { });
            // First upsert: no hash present → falls through to re-embed, populates hash.
            const callsBefore1 = embeddings.createEmbeddingsCalls.length;
            yield index.upsertDocument(uri, text, 'md', metadata);
            node_assert_1.strict.equal(deleteCount, 1);
            (0, node_assert_1.strict)(embeddings.createEmbeddingsCalls.length > callsBefore1);
            const expectedHash = (0, contentHash_1.computeContentHash)(text, 'md', metadata);
            node_assert_1.strict.equal(index._catalog.uriToHash[uri], expectedHash);
            // Second upsert with identical content: hash matches → short-circuit.
            const callsBefore2 = embeddings.createEmbeddingsCalls.length;
            yield index.upsertDocument(uri, text, 'md', metadata);
            node_assert_1.strict.equal(deleteCount, 1, 'second call must not delete');
            node_assert_1.strict.equal(embeddings.createEmbeddingsCalls.length, callsBefore2, 'second call must not embed');
        }));
        (0, mocha_1.it)('clears hash entry on deleteDocument', () => __awaiter(void 0, void 0, void 0, function* () {
            var _a;
            storage.files.set(pathUtils_1.default.join(folderPath, `${existingId}.txt`), 'x');
            storage.files.set(pathUtils_1.default.join(folderPath, `${existingId}.json`), '{}');
            index.listItemsByMetadata = () => __awaiter(void 0, void 0, void 0, function* () { return []; });
            index.deleteItem = () => __awaiter(void 0, void 0, void 0, function* () { });
            yield index.deleteDocument(uri);
            node_assert_1.strict.equal((_a = index._catalog.uriToHash) === null || _a === void 0 ? void 0 : _a[uri], undefined);
        }));
    });
    (0, mocha_1.describe)('listDocuments', () => {
        (0, mocha_1.it)('returns empty list when no chunks', () => __awaiter(void 0, void 0, void 0, function* () {
            index.listItems = () => __awaiter(void 0, void 0, void 0, function* () { return []; });
            const docs = yield index.listDocuments();
            node_assert_1.strict.deepEqual(docs, []);
        }));
        (0, mocha_1.it)('groups chunks per document and produces LocalDocumentResult', () => __awaiter(void 0, void 0, void 0, function* () {
            const docId = 'idx-1';
            const uri = 'doc://1';
            index._catalog = { version: 1, count: 1, uriToId: { [uri]: docId }, idToUri: { [docId]: uri } };
            index.listItems = () => __awaiter(void 0, void 0, void 0, function* () {
                return [
                    { id: 'c1', metadata: { documentId: docId, startPos: 0, endPos: 9 }, vector: [0], norm: 1 },
                    { id: 'c2', metadata: { documentId: docId, startPos: 10, endPos: 19 }, vector: [0], norm: 1 },
                ];
            });
            const docs = yield index.listDocuments();
            node_assert_1.strict.equal(docs.length, 1);
            node_assert_1.strict.equal(docs[0].id, docId);
            node_assert_1.strict.equal(docs[0].uri, uri);
            node_assert_1.strict.ok(docs[0].score >= 0);
        }));
    });
    (0, mocha_1.describe)('queryDocuments', () => {
        (0, mocha_1.it)('throws if embeddings not configured', () => __awaiter(void 0, void 0, void 0, function* () {
            const idx = new LocalDocumentIndex_1.LocalDocumentIndex({ folderPath, storage, tokenizer });
            yield node_assert_1.strict.rejects(idx.queryDocuments('q'), /Embeddings model not configured/);
        }));
        (0, mocha_1.it)('uses default options, normalizes query for embeddings, and forwards to queryItems', () => __awaiter(void 0, void 0, void 0, function* () {
            let received;
            embeddings.createEmbeddingsResponses.push({ status: 'success', output: [[0.5, 0.6]] });
            index.queryItems = (emb, q, maxChunks, filter, isBm25) => __awaiter(void 0, void 0, void 0, function* () {
                received = { emb, query: q, maxChunks, filter, isBm25 };
                return [];
            });
            yield index.queryDocuments('a\nb\nc');
            (0, node_assert_1.strict)(received);
            node_assert_1.strict.equal(received.query, 'a\nb\nc');
            node_assert_1.strict.equal(received.maxChunks, 50);
            node_assert_1.strict.equal(received.filter, undefined);
            node_assert_1.strict.equal(received.isBm25, undefined);
            const lastEmbCall = embeddings.createEmbeddingsCalls.pop().toString();
            node_assert_1.strict.equal(lastEmbCall, 'a b c');
        }));
        (0, mocha_1.it)('wraps errors in query embedding generation and non-success status', () => __awaiter(void 0, void 0, void 0, function* () {
            embeddings.createEmbeddings = () => __awaiter(void 0, void 0, void 0, function* () { throw new Error('fail'); });
            yield node_assert_1.strict.rejects(index.queryDocuments('q'), /Error generating embeddings for query: Error: fail/);
            embeddings.createEmbeddings = () => __awaiter(void 0, void 0, void 0, function* () { return ({ status: 'error', message: 'bad' }); });
            yield node_assert_1.strict.rejects(index.queryDocuments('q'), /Error generating embeddings for query: bad/);
        }));
        (0, mocha_1.it)('groups results by document, sorts by score, returns top N, and forwards filter/isBm25', () => __awaiter(void 0, void 0, void 0, function* () {
            embeddings.createEmbeddingsResponses.push({ status: 'success', output: [[0.9, 0.8]] });
            const docId1 = 'd1', docId2 = 'd2';
            index._catalog = { version: 1, count: 2, uriToId: {}, idToUri: { [docId1]: 'u1', [docId2]: 'u2' } };
            let forwarded = { filter: undefined, isBm25: undefined };
            index.queryItems = (_e, q, k, f, isBm25) => __awaiter(void 0, void 0, void 0, function* () {
                forwarded.filter = f;
                forwarded.isBm25 = isBm25;
                return [
                    { item: { id: 'c1', metadata: { documentId: docId1 }, vector: [0], norm: 1 }, score: 0.85 },
                    { item: { id: 'c2', metadata: { documentId: docId2 }, vector: [0], norm: 1 }, score: 0.95 },
                    { item: { id: 'c3', metadata: { documentId: docId1 }, vector: [0], norm: 1 }, score: 0.8 },
                ];
            });
            const results = yield index.queryDocuments('q', { maxDocuments: 1, filter: { key: 'v' }, isBm25: true });
            node_assert_1.strict.equal(results.length, 1);
            node_assert_1.strict.equal(results[0].id, docId2);
            node_assert_1.strict.deepEqual(forwarded.filter, { key: 'v' });
            node_assert_1.strict.equal(forwarded.isBm25, true);
        }));
    });
    (0, mocha_1.describe)('update transaction overrides', () => {
        (0, mocha_1.it)('beginUpdate clones catalog; cancelUpdate clears; endUpdate persists and clears new catalog', () => __awaiter(void 0, void 0, void 0, function* () {
            index._catalog = { version: 1, count: 0, uriToId: {}, idToUri: {} };
            yield index.beginUpdate();
            node_assert_1.strict.notEqual(index._newCatalog, index._catalog);
            node_assert_1.strict.deepEqual(index._newCatalog, index._catalog);
            index.cancelUpdate();
            node_assert_1.strict.equal(index._newCatalog, undefined);
            yield index.beginUpdate();
            index._newCatalog.count = 1;
            yield index.endUpdate();
            const catalogPath = pathUtils_1.default.join(folderPath, 'catalog.json');
            (0, node_assert_1.strict)(storage.upsertFileCalls.some(c => c.path === catalogPath));
            node_assert_1.strict.equal(index._newCatalog, undefined);
            node_assert_1.strict.equal(index._catalog.count, 1);
        }));
        (0, mocha_1.it)('endUpdate wraps storage errors when saving catalog', () => __awaiter(void 0, void 0, void 0, function* () {
            index._catalog = { version: 1, count: 0, uriToId: {}, idToUri: {} };
            yield index.beginUpdate();
            const orig = storage.upsertFile.bind(storage);
            storage.upsertFile = (p, c) => __awaiter(void 0, void 0, void 0, function* () {
                if (p.endsWith('index.json'))
                    return orig(p, c);
                if (p.endsWith('catalog.json'))
                    throw new Error('fail');
                return orig(p, c);
            });
            yield node_assert_1.strict.rejects(index.endUpdate(), /Error saving document catalog: Error: fail/);
            (0, node_assert_1.strict)(index._newCatalog);
        }));
        (0, mocha_1.it)('createIndex calls super then loads catalog', () => __awaiter(void 0, void 0, void 0, function* () {
            let loadCalled = false;
            index.loadIndexData = () => __awaiter(void 0, void 0, void 0, function* () { loadCalled = true; });
            yield index.createIndex({ version: 1, deleteIfExists: true }); // ensure we don't fail if index.json exists [[2]]
            (0, node_assert_1.strict)(loadCalled);
        }));
    });
    (0, mocha_1.describe)('file path correctness across operations', () => {
        (0, mocha_1.it)('uses correct joined paths for catalog, text, and metadata files', () => __awaiter(void 0, void 0, void 0, function* () {
            const uri = 'doc://paths.txt';
            const docId = 'id-paths';
            index._catalog = { version: 1, count: 1, uriToId: { [uri]: docId }, idToUri: { [docId]: uri } };
            storage.files.set(pathUtils_1.default.join(folderPath, `${docId}.txt`), 'text');
            storage.files.set(pathUtils_1.default.join(folderPath, `${docId}.json`), '{}');
            index.listItemsByMetadata = () => __awaiter(void 0, void 0, void 0, function* () { return []; });
            index.deleteItem = () => __awaiter(void 0, void 0, void 0, function* () { });
            yield index.deleteDocument(uri);
            (0, node_assert_1.strict)(storage.deleteFileCalls.includes(pathUtils_1.default.join(folderPath, `${docId}.txt`)));
            (0, node_assert_1.strict)(storage.deleteFileCalls.includes(pathUtils_1.default.join(folderPath, `${docId}.json`)));
            index.insertItem = () => __awaiter(void 0, void 0, void 0, function* () { });
            embeddings.createEmbeddingsResponses.push({ status: 'success', output: [[0.1, 0.2]] });
            const newDoc = yield index.upsertDocument(uri, 'text', 'txt', { key: 'value' });
            const metaPath = pathUtils_1.default.join(folderPath, `${newDoc.id}.json`);
            const textPath = pathUtils_1.default.join(folderPath, `${newDoc.id}.txt`);
            (0, node_assert_1.strict)(storage.upsertFileCalls.some(c => c.path === metaPath));
            (0, node_assert_1.strict)(storage.upsertFileCalls.some(c => c.path === textPath));
            yield index.beginUpdate();
            yield index.endUpdate();
            const catalogPath = pathUtils_1.default.join(folderPath, 'catalog.json');
            (0, node_assert_1.strict)(storage.upsertFileCalls.some(c => c.path === catalogPath));
        }));
    });
});
//# sourceMappingURL=LocalDocumentIndex.spec.js.map