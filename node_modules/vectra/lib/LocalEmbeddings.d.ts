import { EmbeddingsModel, EmbeddingsResponse } from "./types";
/**
 * Options for configuring a `LocalEmbeddings` instance.
 */
export interface LocalEmbeddingsOptions {
    /**
     * Optional. Model name to use for embeddings.
     * @remarks
     * Defaults to `Xenova/all-MiniLM-L6-v2`. Any model compatible with the
     * `feature-extraction` pipeline from `@huggingface/transformers` can be used.
     */
    model?: string;
    /**
     * Optional. Maximum number of tokens the model supports.
     * @remarks
     * Defaults to 256 for the default model. Adjust when using a model with a
     * different context window.
     */
    maxTokens?: number;
}
/**
 * An `EmbeddingsModel` that runs locally using `@huggingface/transformers`.
 * @remarks
 * Requires the `@huggingface/transformers` package to be installed.
 * The pipeline is lazily initialized on the first call to `createEmbeddings()`.
 * Models are downloaded and cached locally on first use.
 */
export declare class LocalEmbeddings implements EmbeddingsModel {
    readonly maxTokens: number;
    private readonly _modelName;
    private _pipeline;
    private _pipelinePromise;
    /**
     * Creates a new `LocalEmbeddings` instance.
     * @param options Optional configuration.
     */
    constructor(options?: LocalEmbeddingsOptions);
    /**
     * The model name used for embeddings.
     */
    get model(): string;
    /**
     * Creates embeddings for the given inputs.
     * @param inputs Text inputs to create embeddings for.
     * @returns A `EmbeddingsResponse` with a status and the generated embeddings or a message when an error occurs.
     */
    createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse>;
    /**
     * @private
     * Lazily initializes and returns the transformer.js pipeline.
     * Uses a singleton promise to prevent duplicate initialization.
     */
    private getPipeline;
    /**
     * @private
     */
    private initPipeline;
}
//# sourceMappingURL=LocalEmbeddings.d.ts.map