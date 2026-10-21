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
exports.detectCodec = detectCodec;
exports.migrateIndex = migrateIndex;
const pathUtils_1 = require("../utils/pathUtils");
const storage_1 = require("../storage");
const JsonCodec_1 = require("./JsonCodec");
const ProtobufCodec_1 = require("./ProtobufCodec");
function codecForFormat(format) {
    return format === 'protobuf' ? new ProtobufCodec_1.ProtobufCodec() : new JsonCodec_1.JsonCodec();
}
/**
 * Detects the codec in use for an existing index folder.
 * @remarks
 * Checks for `index.json` and `index.pb` files. If both exist, throws an
 * error directing the user to re-run migration. If neither exists, throws.
 * @param folderPath Path to the index folder.
 * @param storage Storage backend to use.
 * @returns The detected codec.
 */
function detectCodec(folderPath, storage) {
    return __awaiter(this, void 0, void 0, function* () {
        const hasJson = yield storage.pathExists(pathUtils_1.pathUtils.join(folderPath, 'index.json'));
        const hasPb = yield storage.pathExists(pathUtils_1.pathUtils.join(folderPath, 'index.pb'));
        if (hasJson && hasPb) {
            throw new Error('Both index.json and index.pb found — the index may be in a partially migrated state. ' +
                'Run `vectra migrate` or `migrateIndex()` to complete the migration.');
        }
        if (hasPb)
            return new ProtobufCodec_1.ProtobufCodec();
        if (hasJson)
            return new JsonCodec_1.JsonCodec();
        throw new Error('No index file found (expected index.json or index.pb).');
    });
}
/**
 * Migrates an index folder from one serialization format to another.
 * @param folderPath Path to the index folder.
 * @param options Migration options.
 */
function migrateIndex(folderPath, options) {
    return __awaiter(this, void 0, void 0, function* () {
        const storage = options.storage || new storage_1.LocalFileStorage();
        const targetCodec = codecForFormat(options.to);
        // Detect current format
        const sourceCodec = yield detectCodec(folderPath, storage);
        if (sourceCodec.extension === targetCodec.extension) {
            return; // Already in target format
        }
        // --- Migrate index file ---
        const sourceIndexPath = pathUtils_1.pathUtils.join(folderPath, `index${sourceCodec.extension}`);
        const targetIndexPath = pathUtils_1.pathUtils.join(folderPath, `index${targetCodec.extension}`);
        const indexBuffer = yield storage.readFile(sourceIndexPath);
        const indexData = sourceCodec.deserializeIndex(indexBuffer);
        // Rewrite external metadata file references
        for (const item of indexData.items) {
            if (item.metadataFile && item.metadataFile.endsWith(sourceCodec.extension)) {
                const baseName = item.metadataFile.slice(0, -sourceCodec.extension.length);
                const oldMetaPath = pathUtils_1.pathUtils.join(folderPath, item.metadataFile);
                const newMetaFile = `${baseName}${targetCodec.extension}`;
                const newMetaPath = pathUtils_1.pathUtils.join(folderPath, newMetaFile);
                // Read, re-serialize, write
                const metaBuf = yield storage.readFile(oldMetaPath);
                const metadata = sourceCodec.deserializeMetadata(metaBuf);
                yield storage.upsertFile(newMetaPath, targetCodec.serializeMetadata(metadata));
                // Update reference
                item.metadataFile = newMetaFile;
            }
        }
        // Write new index
        yield storage.upsertFile(targetIndexPath, targetCodec.serializeIndex(indexData));
        // --- Migrate catalog if present ---
        const sourceCatalogPath = pathUtils_1.pathUtils.join(folderPath, `catalog${sourceCodec.extension}`);
        const targetCatalogPath = pathUtils_1.pathUtils.join(folderPath, `catalog${targetCodec.extension}`);
        if (yield storage.pathExists(sourceCatalogPath)) {
            const catalogBuffer = yield storage.readFile(sourceCatalogPath);
            const catalog = sourceCodec.deserializeCatalog(catalogBuffer);
            // Migrate per-document metadata files
            for (const docId of Object.values(catalog.idToUri ? catalog.idToUri : {})) {
                // Document metadata uses documentId as filename base
            }
            // Actually the document IDs are the keys of idToUri
            for (const docId of Object.keys(catalog.idToUri)) {
                const oldDocMetaPath = pathUtils_1.pathUtils.join(folderPath, `${docId}${sourceCodec.extension}`);
                if (yield storage.pathExists(oldDocMetaPath)) {
                    const docMetaBuf = yield storage.readFile(oldDocMetaPath);
                    const docMeta = sourceCodec.deserializeMetadata(docMetaBuf);
                    const newDocMetaPath = pathUtils_1.pathUtils.join(folderPath, `${docId}${targetCodec.extension}`);
                    yield storage.upsertFile(newDocMetaPath, targetCodec.serializeMetadata(docMeta));
                    yield storage.deleteFile(oldDocMetaPath);
                }
            }
            yield storage.upsertFile(targetCatalogPath, targetCodec.serializeCatalog(catalog));
            yield storage.deleteFile(sourceCatalogPath);
        }
        // --- Clean up old files (after new files are safely written) ---
        // Delete old external metadata files
        for (const item of sourceCodec.deserializeIndex(indexBuffer).items) {
            if (item.metadataFile) {
                const oldMetaPath = pathUtils_1.pathUtils.join(folderPath, item.metadataFile);
                if (yield storage.pathExists(oldMetaPath)) {
                    yield storage.deleteFile(oldMetaPath);
                }
            }
        }
        // Delete old index file last
        yield storage.deleteFile(sourceIndexPath);
    });
}
//# sourceMappingURL=migrateIndex.js.map