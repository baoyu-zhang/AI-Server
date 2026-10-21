"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeContentHash = computeContentHash;
const crypto_1 = require("crypto");
/**
 * Canonical JSON encoding of a metadata object: keys sorted ascending, no
 * whitespace. Values are restricted to MetadataTypes (string | number | boolean),
 * so JSON.stringify is sufficient — there are no nested objects to recurse into.
 */
function canonicalMetadata(metadata) {
    const obj = metadata !== null && metadata !== void 0 ? metadata : {};
    const keys = Object.keys(obj).sort();
    const pairs = [];
    for (const k of keys) {
        pairs.push(`${JSON.stringify(k)}:${JSON.stringify(obj[k])}`);
    }
    return `{${pairs.join(',')}}`;
}
/**
 * Computes a stable SHA-256 hash over the inputs that determine the stored
 * chunks and vectors for a document: text body, docType, and metadata. Used by
 * `LocalDocumentIndex.upsertDocument` to short-circuit when content is
 * unchanged.
 *
 * `metadata: undefined` and `metadata: {}` hash identically (both canonicalize
 * to `{}`).
 *
 * @returns 64-character lowercase hex string.
 */
function computeContentHash(text, docType, metadata) {
    const hash = (0, crypto_1.createHash)('sha256');
    hash.update(text);
    hash.update('\0');
    hash.update(docType !== null && docType !== void 0 ? docType : '');
    hash.update('\0');
    hash.update(canonicalMetadata(metadata));
    return hash.digest('hex');
}
//# sourceMappingURL=contentHash.js.map