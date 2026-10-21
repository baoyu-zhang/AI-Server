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
exports.LocalDocumentIndex = void 0;
const pathUtils_1 = require("./utils/pathUtils");
const uuid_1 = require("uuid");
const GPT3Tokenizer_1 = require("./GPT3Tokenizer");
const LocalIndex_1 = require("./LocalIndex");
const TextSplitter_1 = require("./TextSplitter");
const LocalDocumentResult_1 = require("./LocalDocumentResult");
const LocalDocument_1 = require("./LocalDocument");
const contentHash_1 = require("./internals/contentHash");
/**
 * Represents a local index of documents stored on disk.
 */
class LocalDocumentIndex extends LocalIndex_1.LocalIndex {
    /**
     * Creates a new `LocalDocumentIndex` instance.
     * @param config Configuration settings for the document index.
     */
    constructor(config) {
        var _a, _b;
        super(config.folderPath, config.indexName, config.storage, config.codec);
        this._embeddings = config.embeddings;
        this._chunkingConfig = Object.assign({
            keepSeparators: true,
            chunkSize: 512,
            chunkOverlap: 0,
        }, config.chunkingConfig);
        this._tokenizer = (_b = (_a = config.tokenizer) !== null && _a !== void 0 ? _a : this._chunkingConfig.tokenizer) !== null && _b !== void 0 ? _b : new GPT3Tokenizer_1.GPT3Tokenizer();
        this._chunkingConfig.tokenizer = this._tokenizer;
    }
    /**
     * Returns the embeddings model used by the index (if configured.)
     */
    get embeddings() {
        return this._embeddings;
    }
    /**
     * Returns the tokenizer used by the index.
     */
    get tokenizer() {
        return this._tokenizer;
    }
    /**
     * Returns true if the document catalog exists.
     */
    /** Name of the catalog file (derived from codec extension). */
    get _catalogName() {
        return `catalog${this.codec.extension}`;
    }
    isCatalogCreated() {
        return __awaiter(this, void 0, void 0, function* () {
            return this.storage.pathExists(pathUtils_1.pathUtils.join(this.folderPath, this._catalogName));
        });
    }
    /**
     * Returns the document ID for the given URI.
     * @param uri URI of the document to lookup.
     * @returns Document ID or undefined if not found.
     */
    getDocumentId(uri) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            yield this.loadIndexData();
            return (_a = this._catalog) === null || _a === void 0 ? void 0 : _a.uriToId[uri];
        });
    }
    /**
     * Returns the document URI for the given ID.
     * @param documentId ID of the document to lookup.
     * @returns Document URI or undefined if not found.
     */
    getDocumentUri(documentId) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            yield this.loadIndexData();
            return (_a = this._catalog) === null || _a === void 0 ? void 0 : _a.idToUri[documentId];
        });
    }
    /**
     * Loads the document catalog from disk and returns its stats.
     * @returns Catalog stats.
     */
    getCatalogStats() {
        return __awaiter(this, void 0, void 0, function* () {
            const stats = yield this.getIndexStats();
            return {
                version: this._catalog.version,
                documents: this._catalog.count,
                chunks: stats.items,
                metadata_config: stats.metadata_config
            };
        });
    }
    /**
     * Deletes a document from the index.
     * @param uri URI of the document to delete.
     */
    deleteDocument(uri) {
        return __awaiter(this, void 0, void 0, function* () {
            // Lookup document ID
            const documentId = yield this.getDocumentId(uri);
            if (documentId == undefined) {
                return;
            }
            // Delete document chunks from index and remove from catalog
            yield this.beginUpdate();
            try {
                // Get list of chunks for document and delete in a single pass.
                const chunks = yield this.listItemsByMetadata({ documentId });
                yield this.deleteItems(chunks.map(c => c.id));
                // Remove entry from catalog
                delete this._newCatalog.uriToId[uri];
                delete this._newCatalog.idToUri[documentId];
                if (this._newCatalog.uriToHash) {
                    delete this._newCatalog.uriToHash[uri];
                }
                this._newCatalog.count--;
                // Commit changes
                yield this.endUpdate();
            }
            catch (err) {
                // Cancel update and raise error
                this.cancelUpdate();
                throw new Error(`Error deleting document "${uri}": ${err.toString()}`);
            }
            // Delete text file from disk
            try {
                yield this.storage.deleteFile(pathUtils_1.pathUtils.join(this.folderPath, `${documentId}.txt`));
            }
            catch (err) {
                throw new Error(`Error removing text file for document "${uri}" from disk: ${err.toString()}`);
            }
            // Delete metadata file from disk
            try {
                yield this.storage.deleteFile(pathUtils_1.pathUtils.join(this.folderPath, `${documentId}${this.codec.extension}`));
            }
            catch (err) {
                // Ignore error
            }
        });
    }
    /**
     * Adds a document to the catalog.
     * @remarks
     * A new update is started if one is not already in progress. If a document with the same uri
     * already exists, it will be replaced — unless its stored content hash matches the new content,
     * in which case the call is a no-op and the existing document handle is returned. Pass
     * `options.force = true` to bypass the hash check and force a re-embed (useful after rotating
     * the embeddings model).
     * @param uri - Document URI
     * @param text - Document text
     * @param docType - Optional. Document type
     * @param metadata - Optional. Document metadata to index
     * @param options - Optional. `force: true` skips the skip-if-unchanged check.
     * @returns Inserted document
     */
    upsertDocument(uri, text, docType, metadata, options) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            // Ensure embeddings configured
            if (!this._embeddings) {
                throw new Error(`Embeddings model not configured.`);
            }
            // Compute hash of the inputs that determine the stored chunks/vectors.
            const newHash = (0, contentHash_1.computeContentHash)(text, docType, metadata);
            // Check for existing document ID
            let documentId = yield this.getDocumentId(uri);
            if (documentId != undefined) {
                // Short-circuit: if content + metadata is unchanged, skip the
                // expensive re-embed and return a handle to the existing document.
                if (!(options === null || options === void 0 ? void 0 : options.force)) {
                    const existingHash = (_b = (_a = this._catalog) === null || _a === void 0 ? void 0 : _a.uriToHash) === null || _b === void 0 ? void 0 : _b[uri];
                    if (existingHash === newHash) {
                        return new LocalDocument_1.LocalDocument(this, documentId, uri);
                    }
                }
                // Delete existing document
                yield this.deleteDocument(uri);
            }
            else {
                // Generate new document ID
                documentId = (0, uuid_1.v4)();
            }
            // Initialize text splitter settings
            const config = Object.assign({ docType }, this._chunkingConfig);
            if (config.docType == undefined) {
                // Populate docType based on extension
                const pos = uri.lastIndexOf('.');
                if (pos >= 0) {
                    const ext = uri.substring(pos + 1).toLowerCase();
                    config.docType = ext;
                }
            }
            // Split text into chunks
            const splitter = new TextSplitter_1.TextSplitter(config);
            const chunks = splitter.split(text);
            // Break chunks into batches for embedding generation
            let totalTokens = 0;
            const chunkBatches = [];
            let currentBatch = [];
            for (const chunk of chunks) {
                totalTokens += chunk.tokens.length;
                if (totalTokens > this._embeddings.maxTokens) {
                    chunkBatches.push(currentBatch);
                    currentBatch = [];
                    totalTokens = chunk.tokens.length;
                }
                currentBatch.push(chunk.text.replace(/\n/g, ' '));
            }
            if (currentBatch.length > 0) {
                chunkBatches.push(currentBatch);
            }
            // Generate embeddings for chunks
            const embeddings = [];
            for (const batch of chunkBatches) {
                let response;
                try {
                    response = yield this._embeddings.createEmbeddings(batch);
                }
                catch (err) {
                    throw new Error(`Error generating embeddings: ${err.toString()}`);
                }
                // Check for error
                if (response.status != 'success') {
                    throw new Error(`Error generating embeddings: ${response.message}`);
                }
                // Add embeddings to output
                for (const embedding of response.output) {
                    embeddings.push(embedding);
                }
            }
            // Add document chunks to index
            yield this.beginUpdate();
            try {
                // Add chunks to index
                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    const embedding = embeddings[i];
                    const chunkMetadata = Object.assign({
                        documentId,
                        startPos: chunk.startPos,
                        endPos: chunk.endPos,
                    }, metadata);
                    yield this.insertItem({
                        id: (0, uuid_1.v4)(),
                        metadata: chunkMetadata,
                        vector: embedding,
                    });
                }
                // Save metadata file to disk
                if (metadata != undefined) {
                    yield this.storage.upsertFile(pathUtils_1.pathUtils.join(this.folderPath, `${documentId}${this.codec.extension}`), this.codec.serializeMetadata(metadata));
                }
                // Save text file to disk
                yield this.storage.upsertFile(pathUtils_1.pathUtils.join(this.folderPath, `${documentId}.txt`), text);
                // Add entry to catalog
                this._newCatalog.uriToId[uri] = documentId;
                this._newCatalog.idToUri[documentId] = uri;
                this._newCatalog.uriToHash = (_c = this._newCatalog.uriToHash) !== null && _c !== void 0 ? _c : {};
                this._newCatalog.uriToHash[uri] = newHash;
                this._newCatalog.count++;
                // Commit changes
                yield this.endUpdate();
            }
            catch (err) {
                // Cancel update and raise error
                this.cancelUpdate();
                throw new Error(`Error adding document "${uri}": ${err.toString()}`);
            }
            // Return document
            return new LocalDocument_1.LocalDocument(this, documentId, uri);
        });
    }
    /**
     * Returns all documents in the index.
     * @remarks
     * Each document will contain all of the documents indexed chunks.
     * @returns Array of documents.
     */
    listDocuments() {
        return __awaiter(this, void 0, void 0, function* () {
            // Sort chunks by document ID
            const docs = {};
            const chunks = yield this.listItems();
            chunks.forEach(chunk => {
                const metadata = chunk.metadata;
                if (docs[metadata.documentId] == undefined) {
                    docs[metadata.documentId] = [];
                }
                docs[metadata.documentId].push({ item: chunk, score: 1.0 });
            });
            // Create document results
            const results = [];
            for (const documentId in docs) {
                const uri = yield this.getDocumentUri(documentId);
                const documentResult = new LocalDocumentResult_1.LocalDocumentResult(this, documentId, uri, docs[documentId], this._tokenizer);
                results.push(documentResult);
            }
            return results;
        });
    }
    /**
     * Queries the index for documents similar to the given query.
     * @param query Text to query for.
     * @param options Optional. Query options.
     * @returns Array of document results.
     */
    queryDocuments(query, options) {
        return __awaiter(this, void 0, void 0, function* () {
            // Ensure embeddings configured
            if (!this._embeddings) {
                throw new Error(`Embeddings model not configured.`);
            }
            // Ensure options are defined
            options = Object.assign({
                maxDocuments: 10,
                maxChunks: 50,
            }, options);
            // Generate embeddings for query
            let embeddings;
            try {
                embeddings = yield this._embeddings.createEmbeddings(query.replace(/\n/g, ' '));
            }
            catch (err) {
                throw new Error(`Error generating embeddings for query: ${err.toString()}`);
            }
            // Check for error
            if (embeddings.status != 'success') {
                throw new Error(`Error generating embeddings for query: ${embeddings.message}`);
            }
            // Query index for chunks
            const results = yield this.queryItems(embeddings.output[0], query, options.maxChunks, options.filter, options.isBm25);
            // Group chunks by document
            const documentChunks = {};
            for (const result of results) {
                const metadata = result.item.metadata;
                if (documentChunks[metadata.documentId] == undefined) {
                    documentChunks[metadata.documentId] = [];
                }
                documentChunks[metadata.documentId].push(result);
            }
            // Create a document result for each document
            const documentResults = [];
            for (const documentId in documentChunks) {
                const chunks = documentChunks[documentId];
                const uri = yield this.getDocumentUri(documentId);
                const documentResult = new LocalDocumentResult_1.LocalDocumentResult(this, documentId, uri, chunks, this._tokenizer);
                documentResults.push(documentResult);
            }
            // Sort document results by score and return top results
            return documentResults.sort((a, b) => b.score - a.score).slice(0, options.maxDocuments);
        });
    }
    // Overrides
    beginUpdate() {
        const _super = Object.create(null, {
            beginUpdate: { get: () => super.beginUpdate }
        });
        return __awaiter(this, void 0, void 0, function* () {
            yield _super.beginUpdate.call(this);
            this._newCatalog = Object.assign({}, this._catalog);
        });
    }
    cancelUpdate() {
        super.cancelUpdate();
        this._newCatalog = undefined;
    }
    createIndex(config) {
        const _super = Object.create(null, {
            createIndex: { get: () => super.createIndex }
        });
        return __awaiter(this, void 0, void 0, function* () {
            yield _super.createIndex.call(this, config);
            yield this.loadIndexData();
        });
    }
    endUpdate() {
        const _super = Object.create(null, {
            endUpdate: { get: () => super.endUpdate }
        });
        return __awaiter(this, void 0, void 0, function* () {
            yield _super.endUpdate.call(this);
            try {
                // Save catalog
                yield this.storage.upsertFile(pathUtils_1.pathUtils.join(this.folderPath, this._catalogName), this.codec.serializeCatalog(this._newCatalog));
                this._catalog = this._newCatalog;
                this._newCatalog = undefined;
            }
            catch (err) {
                throw new Error(`Error saving document catalog: ${err.toString()}`);
            }
        });
    }
    loadIndexData() {
        const _super = Object.create(null, {
            loadIndexData: { get: () => super.loadIndexData }
        });
        return __awaiter(this, void 0, void 0, function* () {
            yield _super.loadIndexData.call(this);
            if (this._catalog) {
                return;
            }
            const catalogPath = pathUtils_1.pathUtils.join(this.folderPath, this._catalogName);
            if (yield this.isCatalogCreated()) {
                // Load catalog
                const buffer = yield this.storage.readFile(catalogPath);
                this._catalog = this.codec.deserializeCatalog(buffer);
            }
            else {
                try {
                    // Initialize catalog
                    this._catalog = {
                        version: 1,
                        count: 0,
                        uriToId: {},
                        idToUri: {},
                    };
                    yield this.storage.upsertFile(catalogPath, this.codec.serializeCatalog(this._catalog));
                }
                catch (err) {
                    throw new Error(`Error creating document catalog: ${err.toString()}`);
                }
            }
        });
    }
}
exports.LocalDocumentIndex = LocalDocumentIndex;
//# sourceMappingURL=LocalDocumentIndex.js.map