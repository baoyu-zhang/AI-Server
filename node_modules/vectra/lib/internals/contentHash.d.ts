import { MetadataTypes } from '../types';
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
export declare function computeContentHash(text: string, docType?: string, metadata?: Record<string, MetadataTypes>): string;
//# sourceMappingURL=contentHash.d.ts.map