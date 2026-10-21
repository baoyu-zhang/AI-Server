import { LocalIndex } from '../LocalIndex';
import { LocalDocumentIndex } from '../LocalDocumentIndex';
import { EmbeddingsModel } from '../types';
export interface ManagedIndex {
    name: string;
    index: LocalIndex | LocalDocumentIndex;
    isDocumentIndex: boolean;
    format: string;
}
export interface IndexManagerConfig {
    /** Single index path (mutually exclusive with rootDir). */
    indexPath?: string;
    /** Root directory containing multiple index subdirectories. */
    rootDir?: string;
    /** Embeddings model for server-side embedding computation. */
    embeddings?: EmbeddingsModel;
    /** Polling interval in ms for auto-detecting new indexes (default: 3000). */
    scanInterval?: number;
}
/**
 * Manages loaded indexes for the gRPC server.
 * Supports single-index and multi-index modes with auto-detection of new indexes.
 */
export declare class IndexManager {
    private readonly _config;
    private readonly _indexes;
    private _scanTimer?;
    private _singleMode;
    constructor(config: IndexManagerConfig);
    /** Returns all currently loaded indexes. */
    get indexes(): Map<string, ManagedIndex>;
    /** Returns true if running in single-index mode. */
    get isSingleMode(): boolean;
    /**
     * Initializes the index manager: loads existing indexes and starts auto-detection.
     */
    initialize(): Promise<void>;
    /**
     * Shuts down the index manager: stops scanning and flushes all indexes.
     */
    shutdown(): Promise<void>;
    /**
     * Gets a managed index by name.
     * In single-index mode, any name (or empty string) returns the single index.
     */
    getIndex(name: string): ManagedIndex | undefined;
    /**
     * Gets a managed index, throwing NOT_FOUND-appropriate error if missing.
     */
    requireIndex(name: string): ManagedIndex;
    /**
     * Gets a managed document index, throwing if missing or not a document index.
     */
    requireDocumentIndex(name: string): {
        managed: ManagedIndex;
        docIndex: LocalDocumentIndex;
    };
    /**
     * Creates a new index on disk and loads it.
     */
    createIndex(name: string, format: string, isDocumentIndex: boolean, documentConfig?: {
        version?: number;
        chunkSize?: number;
        chunkOverlap?: number;
    }): Promise<ManagedIndex>;
    /**
     * Deletes an index from disk and unloads it.
     */
    deleteIndex(name: string): Promise<void>;
    /**
     * Lists all loaded indexes.
     */
    listIndexes(): ManagedIndex[];
    private loadSingleIndex;
    private scanRootDir;
    private loadIndex;
}
//# sourceMappingURL=IndexManager.d.ts.map