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
exports.LocalIndex = void 0;
const pathUtils_1 = require("./utils/pathUtils");
const uuid_1 = require("uuid");
const ItemSelector_1 = require("./ItemSelector");
const LocalDocument_1 = require("./LocalDocument");
const wink_bm25_text_search_1 = __importDefault(require("wink-bm25-text-search"));
const wink_nlp_1 = __importDefault(require("wink-nlp"));
const wink_eng_lite_web_model_1 = __importDefault(require("wink-eng-lite-web-model"));
const storage_1 = require("./storage");
const codecs_1 = require("./codecs");
/**
 * Local vector index instance.
 * @remarks
 * This class is used to create, update, and query a local vector index.
 * Each index is a folder on disk containing an index.json file and an optional set of metadata files.
 */
class LocalIndex {
    /**
     * Creates a new instance of LocalIndex.
     * @param folderPath Path to the index folder.
     * @param indexName Optional index file name. Defaults to 'index' + codec.extension.
     * @param storage Optional file storage instance. Defaults to LocalFileStorage.
     * @param codec Optional codec for serialization. Defaults to JsonCodec.
     * @param options Optional constructor options for dependency injection.
     */
    constructor(folderPath, indexName, storage, codec, options) {
        this._indexName = 'index.json';
        this._folderPath = folderPath;
        this._codec = codec || new codecs_1.JsonCodec();
        if (indexName) {
            this._indexName = indexName;
        }
        else {
            this._indexName = `index${this._codec.extension}`;
        }
        this._storage = storage || new storage_1.LocalFileStorage();
        this._bm25Factory = (options === null || options === void 0 ? void 0 : options.bm25Factory) || (() => (0, wink_bm25_text_search_1.default)());
        this._docReader = (options === null || options === void 0 ? void 0 : options.docReader) || ((docId) => __awaiter(this, void 0, void 0, function* () {
            const doc = new LocalDocument_1.LocalDocument(this, docId, '');
            return yield doc.loadText();
        }));
    }
    /** Path to the index folder. */
    get folderPath() {
        return this._folderPath;
    }
    /** Name of the index file. */
    get indexName() {
        return this._indexName;
    }
    /** Storage provider used to store the index. */
    get storage() {
        return this._storage;
    }
    /** Codec used for serialization. */
    get codec() {
        return this._codec;
    }
    /**
     * Begins an update to the index.
     * @remarks
     * This method loads the index into memory and prepares it for updates.
     */
    beginUpdate() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._update) {
                throw new Error('Update already in progress');
            }
            yield this.loadIndexData();
            // Shallow copy: the items array is duplicated so splices/pushes don't
            // touch _data, but individual IndexItem objects are shared by reference.
            // Mutating an item in place would alias into _data, so addItemToUpdate's
            // upsert path replaces items instead of mutating them.
            this._update = {
                version: this._data.version,
                metadata_config: this._data.metadata_config,
                items: this._data.items.slice(),
            };
        });
    }
    /**
     * Cancels an update to the index.
     * @remarks
     * This method discards any changes made to the index since the update began.
     */
    cancelUpdate() {
        this._update = undefined;
    }
    /**
     * Creates a new index.
     * @remarks
     * This method creates a new folder on disk containing an index.json file.
     * @param config Index configuration.
     */
    createIndex() {
        return __awaiter(this, arguments, void 0, function* (config = { version: 1 }) {
            var _a;
            // Delete if exists
            if (yield this.isIndexCreated()) {
                if (config.deleteIfExists) {
                    yield this.deleteIndex();
                }
                else {
                    throw new Error('Index already exists');
                }
            }
            try {
                // Create folder for index
                yield this.storage.createFolder(this._folderPath);
                // Initialize index.json file
                this._data = {
                    version: config.version,
                    metadata_config: (_a = config.metadata_config) !== null && _a !== void 0 ? _a : {},
                    items: []
                };
                yield this.storage.upsertFile(pathUtils_1.pathUtils.join(this._folderPath, this._indexName), this._codec.serializeIndex(this._data));
            }
            catch (_b) {
                yield this.deleteIndex();
                throw new Error('Error creating index');
            }
        });
    }
    /**
     * Deletes the index.
     * @remarks
     * This method deletes the index folder from disk.
     */
    deleteIndex() {
        return __awaiter(this, void 0, void 0, function* () {
            this._data = undefined;
            return yield this.storage.deleteFolder(this._folderPath);
        });
    }
    /**
     * Deletes an item from the index.
     * @param id ID of item to delete.
     */
    deleteItem(id) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._update) {
                const index = this._update.items.findIndex(i => i.id === id);
                if (index >= 0) {
                    this._update.items.splice(index, 1);
                }
            }
            else {
                yield this.beginUpdate();
                const index = this._update.items.findIndex(i => i.id === id);
                if (index >= 0) {
                    this._update.items.splice(index, 1);
                }
                yield this.endUpdate();
            }
        });
    }
    /**
     * Deletes a batch of items from the index in a single O(N) pass over the
     * items array.
     * @remarks
     * Functionally equivalent to calling `deleteItem` for each id, but avoids the
     * O(N·M) cost of repeated linear scans + splices when removing many items.
     * Like `deleteItem`, ids that don't exist are silently ignored.
     * @param ids IDs of items to delete.
     */
    deleteItems(ids) {
        return __awaiter(this, void 0, void 0, function* () {
            const idSet = ids instanceof Set ? ids : new Set(ids);
            if (idSet.size === 0) {
                return;
            }
            if (this._update) {
                this._update.items = this._update.items.filter(i => !idSet.has(i.id));
            }
            else {
                yield this.beginUpdate();
                this._update.items = this._update.items.filter(i => !idSet.has(i.id));
                yield this.endUpdate();
            }
        });
    }
    /**
     * Ends an update to the index.
     * @remarks
     * This method saves the index to disk.
     */
    endUpdate() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this._update) {
                throw new Error('No update in progress');
            }
            try {
                // Save index
                yield this.storage.upsertFile(pathUtils_1.pathUtils.join(this._folderPath, this._indexName), this._codec.serializeIndex(this._update));
                this._data = this._update;
                this._update = undefined;
            }
            catch (err) {
                throw new Error(`Error saving index: ${err.toString()}`);
            }
        });
    }
    /**
     * Loads an index from disk and returns its stats.
     * @returns Index stats.
     */
    getIndexStats() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.loadIndexData();
            return {
                version: this._data.version,
                metadata_config: this._data.metadata_config,
                items: this._data.items.length
            };
        });
    }
    /**
     * Returns an item from the index given its ID.
     * @param id ID of the item to retrieve.
     * @returns Item or undefined if not found.
     */
    getItem(id) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.loadIndexData();
            return this._data.items.find(i => i.id === id);
        });
    }
    /**
     * Adds an item to the index.
     * @remarks
     * A new update is started if one is not already in progress. If an item with the same ID
     * already exists, an error will be thrown.
     * @param item Item to insert.
     * @returns Inserted item.
     */
    insertItem(item) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._update) {
                return yield this.addItemToUpdate(item, true);
            }
            else {
                yield this.beginUpdate();
                const newItem = yield this.addItemToUpdate(item, true);
                yield this.endUpdate();
                return newItem;
            }
        });
    }
    /**
     * Adds a batch of items to the index.
     * @remarks
     * Batch update requires no update to be in progress. This is necessary so that if any one
     * insert operation fails, the entire update can be safely cancelled. This prevents partial
     * updates from being applied to the local index.
     * @param items Items to insert.
     * @returns Inserted items.
     */
    batchInsertItems(items) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.beginUpdate();
            try {
                const newItems = [];
                for (const item of items) {
                    const newItem = yield this.addItemToUpdate(item, true);
                    newItems.push(newItem);
                }
                yield this.endUpdate();
                return newItems;
            }
            catch (e) {
                // cancels this update to prevent partial batch updates. allows error to bubble up.
                yield this.cancelUpdate();
                throw e;
            }
        });
    }
    /** Returns true if the index exists. */
    isIndexCreated() {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.storage.pathExists(pathUtils_1.pathUtils.join(this._folderPath, this._indexName));
        });
    }
    /**
     * Returns all items in the index.
     * @remarks
     * This method loads the index into memory and returns all its items. A copy of the items
     * array is returned so no modifications should be made to the array.
     * @returns Array of all items in the index.
     */
    listItems() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.loadIndexData();
            return this._data.items.slice();
        });
    }
    /**
     * Returns all items in the index matching the filter.
     * @remarks
     * This method loads the index into memory and returns all its items matching the filter.
     * @param filter Filter to apply.
     * @returns Array of items matching the filter.
     */
    listItemsByMetadata(filter) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.loadIndexData();
            return this._data.items.filter(i => ItemSelector_1.ItemSelector.select(i.metadata, filter));
        });
    }
    /**
     * Finds the top k items in the index that are most similar to the vector.
     * @remarks
     * This method loads the index into memory and returns the top k items that are most similar.
     * An optional filter can be applied to the metadata of the items.
     * @param vector Vector to query against.
     * @param query Query string (used when isBm25=true).
     * @param topK Number of items to return.
     * @param filter Optional. Filter to apply.
     * @param isBm25 Optional. If true, append BM25 keyword results to semantic results.
     * @returns Similar items to the vector that match the supplied filter.
     */
    queryItems(vector, query, topK, filter, isBm25) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d;
            yield this.loadIndexData();
            // Filter items
            let items = this._data.items;
            if (filter) {
                items = items.filter(i => ItemSelector_1.ItemSelector.select(i.metadata, filter));
            }
            // Find top K by cosine similarity using a bounded min-heap of size K.
            // For N items this is O(N log K) vs the previous O(N log N) full sort.
            const norm = ItemSelector_1.ItemSelector.normalize(vector);
            const k = Math.min(topK, items.length);
            const heap = [];
            const siftUp = (start) => {
                let i = start;
                while (i > 0) {
                    const parent = (i - 1) >> 1;
                    if (heap[parent].distance > heap[i].distance) {
                        const tmp = heap[parent];
                        heap[parent] = heap[i];
                        heap[i] = tmp;
                        i = parent;
                    }
                    else
                        break;
                }
            };
            const siftDown = () => {
                let i = 0;
                const n = heap.length;
                while (true) {
                    const l = (i << 1) + 1;
                    const r = l + 1;
                    let smallest = i;
                    if (l < n && heap[l].distance < heap[smallest].distance)
                        smallest = l;
                    if (r < n && heap[r].distance < heap[smallest].distance)
                        smallest = r;
                    if (smallest === i)
                        break;
                    const tmp = heap[i];
                    heap[i] = heap[smallest];
                    heap[smallest] = tmp;
                    i = smallest;
                }
            };
            for (let i = 0; i < items.length; i++) {
                const distance = ItemSelector_1.ItemSelector.normalizedCosineSimilarity(vector, norm, items[i].vector, items[i].norm);
                if (heap.length < k) {
                    heap.push({ index: i, distance });
                    siftUp(heap.length - 1);
                }
                else if (k > 0 && distance > heap[0].distance) {
                    heap[0] = { index: i, distance };
                    siftDown();
                }
            }
            heap.sort((a, b) => b.distance - a.distance);
            // Find top k
            const top = heap.map(d => {
                return {
                    item: Object.assign({}, items[d.index]),
                    score: d.distance
                };
            });
            // Load external metadata in parallel — each file is independent, and the
            // top-K size is small, so this is bounded fan-out.
            yield Promise.all(top.map((item) => __awaiter(this, void 0, void 0, function* () {
                if (item.item.metadataFile) {
                    const metadataPath = pathUtils_1.pathUtils.join(this._folderPath, item.item.metadataFile);
                    const metadataBuffer = yield this.storage.readFile(metadataPath);
                    item.item.metadata = this._codec.deserializeMetadata(metadataBuffer);
                }
            })));
            // Perform bm25 search only if enabled. Avoid duplicate chunks that are already selected during semantic search.
            if (isBm25) {
                const itemSet = new Set();
                for (const r of top)
                    itemSet.add(r.item.id);
                // Set up BM25 engine
                yield this.setupBm25();
                // Add docs if we have necessary metadata; guard everything to avoid crashes
                for (let i = 0; i < items.length; i++) {
                    if (!itemSet.has(items[i].id)) {
                        const item = items[i];
                        const md = item.metadata || {};
                        if (md.documentId != undefined && md.startPos != undefined && md.endPos != undefined) {
                            try {
                                const currDocTxt = yield this._docReader(String(md.documentId));
                                const startPos = Number(md.startPos);
                                const endPos = Number(md.endPos);
                                const chunkText = currDocTxt.substring(startPos, endPos + 1);
                                (_b = (_a = this._bm25Engine).addDoc) === null || _b === void 0 ? void 0 : _b.call(_a, { body: chunkText }, i);
                            }
                            catch (_e) {
                                // Ignore load or engine errors for BM25 doc prep
                            }
                        }
                    }
                }
                (_d = (_c = this._bm25Engine).consolidate) === null || _d === void 0 ? void 0 : _d.call(_c);
                const results = yield this.bm25Search(query, items, topK);
                results.forEach((res) => {
                    var _a;
                    // Support both [index, score] tuples and { item, score } objects
                    if (Array.isArray(res)) {
                        const idx = res[0];
                        const score = res[1];
                        if (items[idx]) {
                            top.push({
                                item: Object.assign({}, Object.assign(Object.assign({}, items[idx]), { metadata: Object.assign(Object.assign({}, items[idx].metadata), { isBm25: true }) })),
                                score
                            });
                        }
                    }
                    else if (res && typeof res === 'object' && 'item' in res && 'score' in res) {
                        const objItem = Object.assign({}, Object.assign(Object.assign({}, (res.item || {})), { metadata: Object.assign(Object.assign({}, (((_a = res.item) === null || _a === void 0 ? void 0 : _a.metadata) || {})), { isBm25: true }) }));
                        top.push({ item: objItem, score: res.score });
                    }
                });
            }
            return top;
        });
    }
    /**
     * Adds or replaces an item in the index.
     * @remarks
     * A new update is started if one is not already in progress. If an item with the same ID
     * already exists, it will be replaced.
     * @param item Item to insert or replace.
     * @returns Upserted item.
     */
    upsertItem(item) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._update) {
                return yield this.addItemToUpdate(item, false);
            }
            else {
                yield this.beginUpdate();
                const newItem = yield this.addItemToUpdate(item, false);
                yield this.endUpdate();
                return newItem;
            }
        });
    }
    /** Ensures that the index has been loaded into memory. */
    loadIndexData() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._data) {
                return;
            }
            if (!(yield this.isIndexCreated())) {
                throw new Error('Index does not exist');
            }
            const data = yield this.storage.readFile(pathUtils_1.pathUtils.join(this._folderPath, this.indexName));
            this._data = this._codec.deserializeIndex(data);
        });
    }
    addItemToUpdate(item, unique) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            // Ensure vector is provided
            if (!item.vector) {
                throw new Error('Vector is required');
            }
            // Ensure unique
            const id = (_a = item.id) !== null && _a !== void 0 ? _a : (0, uuid_1.v4)();
            if (unique) {
                const existing = this._update.items.find(i => i.id === id);
                if (existing) {
                    throw new Error(`Item with id ${id} already exists`);
                }
            }
            // Check for indexed metadata
            let metadata = {};
            let metadataFile;
            const indexedKeys = (_b = this._update.metadata_config.indexed) !== null && _b !== void 0 ? _b : [];
            if (indexedKeys.length > 0 && item.metadata) {
                // Copy only indexed metadata
                const indexedOnly = {};
                for (const key of indexedKeys) {
                    if (Object.prototype.hasOwnProperty.call(item.metadata, key)) {
                        indexedOnly[key] = item.metadata[key];
                    }
                }
                // Determine if there are any non-indexed keys
                const hasNonIndexed = Object.keys(item.metadata).some(k => !indexedKeys.includes(k));
                // Always store only indexed keys in the index
                metadata = indexedOnly;
                // Write full metadata externally only if there are non-indexed keys present
                if (hasNonIndexed) {
                    metadataFile = `${(0, uuid_1.v4)()}${this._codec.extension}`;
                    const metadataPath = pathUtils_1.pathUtils.join(this._folderPath, metadataFile);
                    yield this.storage.upsertFile(metadataPath, this._codec.serializeMetadata(item.metadata));
                }
            }
            else if (item.metadata) {
                metadata = item.metadata;
            }
            // Create new item
            const newItem = {
                id: id,
                metadata: metadata,
                vector: item.vector,
                norm: ItemSelector_1.ItemSelector.normalize(item.vector)
            };
            if (metadataFile) {
                newItem.metadataFile = metadataFile;
            }
            // Add item to index
            if (!unique) {
                const existingIdx = this._update.items.findIndex(i => i.id === id);
                if (existingIdx >= 0) {
                    // Replace instead of mutating: items are shared by reference with
                    // _data after beginUpdate's shallow clone, so in-place mutation would
                    // alias into the committed snapshot.
                    const existing = this._update.items[existingIdx];
                    const updated = Object.assign(Object.assign({}, existing), { metadata: newItem.metadata, vector: newItem.vector, norm: newItem.norm, metadataFile: newItem.metadataFile });
                    this._update.items[existingIdx] = updated;
                    return updated;
                }
            }
            this._update.items.push(newItem);
            return newItem;
        });
    }
    setupBm25() {
        return __awaiter(this, void 0, void 0, function* () {
            this._bm25Engine = this._bm25Factory();
            const nlp = (0, wink_nlp_1.default)(wink_eng_lite_web_model_1.default);
            const its = nlp.its;
            const prepTask = function (text) {
                const tokens = [];
                nlp.readDoc(text)
                    .tokens()
                    // Use only words ignoring punctuations etc and from them remove stop words
                    .filter((t) => (t.out(its.type) === 'word' && !t.out(its.stopWordFlag)))
                    // Handle negation and extract stem of the word
                    .each((t) => tokens.push((t.out(its.negationFlag)) ? '!' + t.out(its.stem) : t.out(its.stem)));
                return tokens;
            };
            this._bm25Engine.defineConfig({ fldWeights: { body: 1 } });
            // Step II: Define PrepTasks pipe.
            this._bm25Engine.definePrepTasks([prepTask]);
        });
    }
    bm25Search(searchQuery, _items, topK) {
        return __awaiter(this, void 0, void 0, function* () {
            const results = this._bm25Engine.search(searchQuery);
            return results.slice(0, topK);
        });
    }
}
exports.LocalIndex = LocalIndex;
//# sourceMappingURL=LocalIndex.js.map