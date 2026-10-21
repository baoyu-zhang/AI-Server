import { EmbeddingsModel, EmbeddingsResponse } from "./types";
import { TransformersTokenizer } from "./TransformersTokenizer";
/**
 * Configuration options for TransformersEmbeddings.
 */
export interface TransformersEmbeddingsOptions {
    /**
     * Optional. Model name/path to use for embeddings.
     * @remarks
     * Common models:
     * - 'Xenova/all-MiniLM-L6-v2' (384 dimensions, fast, good quality)
     * - 'Xenova/bge-small-en-v1.5' (384 dimensions, better quality)
     * - 'Xenova/bge-base-en-v1.5' (768 dimensions, best quality)
     * @default 'Xenova/all-MiniLM-L6-v2'
     */
    model?: string;
    /**
     * Optional. Maximum number of tokens that can be sent to the embedding model.
     * @remarks
     * This affects batching behavior in LocalDocumentIndex.
     * Most small models support 512 tokens.
     * @default 512
     */
    maxTokens?: number;
    /**
     * Optional. Device to run inference on.
     * @remarks
     * - 'auto': Automatically select the best available device
     * - 'gpu': Use GPU (WebGPU in browser, CUDA in Node.js if available)
     * - 'cpu': Use CPU (most compatible)
     * - 'wasm': Use WebAssembly
     * @default 'auto'
     */
    device?: 'auto' | 'gpu' | 'cpu' | 'wasm';
    /**
     * Optional. Data type for model weights.
     * @remarks
     * - 'fp32': Full precision (best quality, largest size)
     * - 'fp16': Half precision (good quality, smaller)
     * - 'q8': 8-bit quantization (good quality, smaller)
     * - 'q4': 4-bit quantization (fastest, smallest, lower quality)
     * @default 'fp32'
     */
    dtype?: 'fp32' | 'fp16' | 'q8' | 'q4';
    /**
     * Optional. Whether to normalize embeddings to unit length.
     * @default true
     */
    normalize?: boolean;
    /**
     * Optional. Pooling strategy for token embeddings.
     * @remarks
     * - 'mean': Mean pooling (default, recommended)
     * - 'cls': Use [CLS] token embedding
     * @default 'mean'
     */
    pooling?: 'mean' | 'cls';
    /**
     * Optional. Callback for tracking model download/load progress.
     */
    progressCallback?: (progress: {
        status: string;
        progress?: number;
        file?: string;
    }) => void;
}
/**
 * An embeddings model using Transformers.js for local, offline inference.
 * @remarks
 * Requires @huggingface/transformers as a peer dependency.
 * Use the static `create()` method to instantiate.
 *
 * @example
 * ```typescript
 * const embeddings = await TransformersEmbeddings.create({
 *     model: 'Xenova/all-MiniLM-L6-v2'
 * });
 *
 * const index = new LocalDocumentIndex({
 *     folderPath: 'my-index',
 *     embeddings: embeddings,
 *     tokenizer: embeddings.getTokenizer()
 * });
 * ```
 */
export declare class TransformersEmbeddings implements EmbeddingsModel {
    private readonly _extractor;
    private readonly _tokenizer;
    private readonly _options;
    readonly maxTokens: number;
    /**
     * Private constructor - use TransformersEmbeddings.create() instead.
     */
    private constructor();
    /**
     * Creates a new TransformersEmbeddings instance.
     * @param options Configuration options.
     * @returns Promise resolving to initialized TransformersEmbeddings instance.
     * @throws Error if @huggingface/transformers is not installed.
     */
    static create(options?: TransformersEmbeddingsOptions): Promise<TransformersEmbeddings>;
    /**
     * Returns a tokenizer that uses the same tokenization as this embedding model.
     * @remarks
     * Use this tokenizer with LocalDocumentIndex to ensure text chunking
     * aligns with the embedding model's token boundaries.
     * @returns TransformersTokenizer instance.
     */
    getTokenizer(): TransformersTokenizer;
    /**
     * Creates embeddings for the given inputs.
     * @param inputs Text inputs to create embeddings for.
     * @returns EmbeddingsResponse with status and generated embeddings.
     */
    createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse>;
    /**
     * Returns the model name being used.
     */
    get model(): string;
}
//# sourceMappingURL=TransformersEmbeddings.d.ts.map