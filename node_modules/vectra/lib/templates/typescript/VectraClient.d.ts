/**
 * Vectra gRPC client — thin idiomatic wrapper over generated stubs.
 *
 * Usage:
 *   import { VectraClient } from './VectraClient';
 *
 *   const client = new VectraClient();
 *   const results = await client.queryDocuments('my-index', 'search query');
 *   client.close();
 *
 * Generate stubs first:
 *   npm install @grpc/grpc-js @grpc/proto-loader
 *   // Proto is loaded dynamically — no separate codegen step required.
 */
export interface MetadataValue {
    stringValue?: string;
    numberValue?: number;
    boolValue?: boolean;
}
export interface ItemResult {
    id: string;
    metadata: Record<string, string | number | boolean>;
    vector: number[];
    norm: number;
    score: number;
}
export interface DocumentResult {
    uri: string;
    documentId: string;
    score: number;
    chunks: Array<{
        text: string;
        score: number;
        tokenCount: number;
    }>;
}
export interface IndexInfo {
    name: string;
    format: string;
    isDocumentIndex: boolean;
}
export interface IndexStats {
    version: number;
    format: string;
    itemCount: number;
    metadataConfigCount: number;
}
export interface CatalogStats {
    version: number;
    documentCount: number;
    chunkCount: number;
    metadataCounts: Record<string, number>;
}
export interface HealthcheckResult {
    status: string;
    uptimeSeconds: number;
    loadedIndexes: string[];
}
export interface QueryDocumentsOptions {
    maxDocuments?: number;
    maxChunks?: number;
    filter?: Record<string, any>;
    useBm25?: boolean;
}
export interface QueryItemsOptions {
    text?: string;
    vector?: number[];
    topK?: number;
    filter?: Record<string, any>;
}
export declare class VectraClient {
    private readonly _client;
    constructor(host?: string, port?: number);
    close(): void;
    createIndex(name: string, options?: {
        format?: string;
        isDocumentIndex?: boolean;
        chunkSize?: number;
        chunkOverlap?: number;
    }): Promise<void>;
    deleteIndex(name: string): Promise<void>;
    listIndexes(): Promise<IndexInfo[]>;
    insertItem(index: string, options: {
        text?: string;
        vector?: number[];
        metadata?: Record<string, string | number | boolean>;
        id?: string;
    }): Promise<string>;
    upsertItem(index: string, id: string, options: {
        text?: string;
        vector?: number[];
        metadata?: Record<string, string | number | boolean>;
    }): Promise<string>;
    getItem(index: string, id: string): Promise<ItemResult | null>;
    deleteItem(index: string, id: string): Promise<void>;
    listItems(index: string, filter?: Record<string, any>): Promise<ItemResult[]>;
    queryItems(index: string, options: QueryItemsOptions): Promise<ItemResult[]>;
    queryDocuments(index: string, query: string, options?: QueryDocumentsOptions): Promise<DocumentResult[]>;
    upsertDocument(index: string, uri: string, text: string, options?: {
        docType?: string;
        metadata?: Record<string, string | number | boolean>;
    }): Promise<string>;
    deleteDocument(index: string, uri: string): Promise<void>;
    listDocuments(index: string): Promise<Array<{
        uri: string;
        documentId: string;
    }>>;
    getIndexStats(index: string): Promise<IndexStats>;
    getCatalogStats(index: string): Promise<CatalogStats>;
    healthcheck(): Promise<HealthcheckResult>;
    shutdown(): Promise<void>;
    private _unary;
}
//# sourceMappingURL=VectraClient.d.ts.map