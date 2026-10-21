import { LocalDocument } from "./LocalDocument";
import { LocalDocumentIndex } from "./LocalDocumentIndex";
import { QueryResult, DocumentChunkMetadata, Tokenizer, DocumentTextSection } from "./types";
/**
 * Represents a search result for a document stored on disk.
 */
export declare class LocalDocumentResult extends LocalDocument {
    private readonly _chunks;
    private readonly _tokenizer;
    private readonly _score;
    static readonly CONNECTOR = "\n\n...\n\n";
    /**
     * @private
     * Internal constructor for `LocalDocumentResult` instances.
     */
    constructor(index: LocalDocumentIndex, id: string, uri: string, chunks: QueryResult<DocumentChunkMetadata>[], tokenizer: Tokenizer);
    /**
     * Returns the chunks of the document that matched the query.
     */
    get chunks(): QueryResult<DocumentChunkMetadata>[];
    /**
     * Returns the average score of the document result.
     */
    get score(): number;
    /**
     * Helper: robust check for BM25-marked chunks.
     */
    protected isBm25Chunk(chunk: QueryResult<DocumentChunkMetadata>): boolean;
    /**
     * A small, testable packer that mimics the old `renderAllSections()` behavior
     * but exposes the internal flush logic so all branches are coverable.
     */
    protected createAllSectionsPacker(): {
        flush: () => void;
        pushChunkTokens: (tokens: number[], score: number, isBm25Chunk: boolean) => void;
        getSections: () => DocumentTextSection[];
        __testSetState: (state: {
            currentTokens?: number[];
            currentScores?: number[];
            currentIsBm25AllTrue?: boolean;
        }) => void;
    };
    /**
     * Renders all of the results chunks as spans of text (sections.)
     * @remarks
     * - Chunks are sorted by document order.
     * - Multiple small chunks are packed into a single section up to maxTokens.
     * - Oversized chunks are split into multiple sections, each carrying the chunk's score.
     * - When multiple chunks are packed, section score is the arithmetic mean of packed chunks' scores.
     */
    renderAllSections(maxTokens: number): Promise<DocumentTextSection[]>;
    /**
     * Testable helper: build a single fallback section from the top-scoring chunk,
     * truncated to exactly maxTokens tokens.
     */
    protected buildFallbackTopChunkSection(docText: string, chunks: QueryResult<DocumentChunkMetadata>[], isBm25: boolean, maxTokens: number): DocumentTextSection[];
    /**
     * Internal helper: builds sections for either semantic or BM25 chunk lists using a heatmap.
     */
    protected buildSectionsFor(docText: string, chunks: QueryResult<DocumentChunkMetadata>[], isBm25: boolean, maxTokens: number, maxSections: number, overlappingChunks: boolean): DocumentTextSection[];
    /**
     * Renders the top spans of text (sections) of the document based on the query result.
     */
    renderSections(maxTokens: number, maxSections: number, overlappingChunks?: boolean): Promise<DocumentTextSection[]>;
}
//# sourceMappingURL=LocalDocumentResult.d.ts.map