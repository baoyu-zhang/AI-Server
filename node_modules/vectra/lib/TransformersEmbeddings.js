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
exports.TransformersEmbeddings = void 0;
const TransformersTokenizer_1 = require("./TransformersTokenizer");
const transformersLoader_1 = require("./internals/transformersLoader");
const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
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
class TransformersEmbeddings {
    /**
     * Private constructor - use TransformersEmbeddings.create() instead.
     */
    constructor(extractor, tokenizer, options) {
        this._extractor = extractor;
        this._tokenizer = tokenizer;
        this._options = options;
        this.maxTokens = options.maxTokens;
    }
    /**
     * Creates a new TransformersEmbeddings instance.
     * @param options Configuration options.
     * @returns Promise resolving to initialized TransformersEmbeddings instance.
     * @throws Error if @huggingface/transformers is not installed.
     */
    static create(options) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f;
            // Dynamically import via the loader seam so tests can substitute a
            // mock without monkey-patching the @huggingface/transformers module
            // (whose ESM exports are non-configurable in 4.x).
            const transformers = yield (0, transformersLoader_1.loadTransformers)();
            const { pipeline } = transformers;
            // Apply defaults
            const opts = {
                model: (_a = options === null || options === void 0 ? void 0 : options.model) !== null && _a !== void 0 ? _a : DEFAULT_MODEL,
                maxTokens: (_b = options === null || options === void 0 ? void 0 : options.maxTokens) !== null && _b !== void 0 ? _b : 512,
                device: (_c = options === null || options === void 0 ? void 0 : options.device) !== null && _c !== void 0 ? _c : 'auto',
                dtype: (_d = options === null || options === void 0 ? void 0 : options.dtype) !== null && _d !== void 0 ? _d : 'fp32',
                normalize: (_e = options === null || options === void 0 ? void 0 : options.normalize) !== null && _e !== void 0 ? _e : true,
                pooling: (_f = options === null || options === void 0 ? void 0 : options.pooling) !== null && _f !== void 0 ? _f : 'mean',
                progressCallback: options === null || options === void 0 ? void 0 : options.progressCallback
            };
            // Build pipeline options
            const pipelineOptions = {
                device: opts.device,
                dtype: opts.dtype
            };
            if (opts.progressCallback) {
                pipelineOptions.progress_callback = opts.progressCallback;
            }
            // Load the feature extraction pipeline
            const extractor = yield pipeline('feature-extraction', opts.model, pipelineOptions);
            // Load the tokenizer separately for use with TextSplitter
            const tokenizer = extractor.tokenizer;
            return new TransformersEmbeddings(extractor, tokenizer, opts);
        });
    }
    /**
     * Returns a tokenizer that uses the same tokenization as this embedding model.
     * @remarks
     * Use this tokenizer with LocalDocumentIndex to ensure text chunking
     * aligns with the embedding model's token boundaries.
     * @returns TransformersTokenizer instance.
     */
    getTokenizer() {
        return new TransformersTokenizer_1.TransformersTokenizer(this._tokenizer);
    }
    /**
     * Creates embeddings for the given inputs.
     * @param inputs Text inputs to create embeddings for.
     * @returns EmbeddingsResponse with status and generated embeddings.
     */
    createEmbeddings(inputs) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const inputArray = Array.isArray(inputs) ? inputs : [inputs];
                // Process all inputs in a single batch
                const output = yield this._extractor(inputArray, {
                    pooling: this._options.pooling,
                    normalize: this._options.normalize
                });
                const [batchSize, embeddingDim] = output.dims;
                const data = output.data;
                // Slice the flat array into individual embeddings
                const embeddings = [];
                for (let i = 0; i < batchSize; i++) {
                    const start = i * embeddingDim;
                    const end = start + embeddingDim;
                    embeddings.push(Array.from(data.slice(start, end)));
                }
                return {
                    status: 'success',
                    output: embeddings,
                    model: this._options.model
                };
            }
            catch (error) {
                return {
                    status: 'error',
                    message: `Error generating embeddings: ${error.message}`
                };
            }
        });
    }
    /**
     * Returns the model name being used.
     */
    get model() {
        return this._options.model;
    }
}
exports.TransformersEmbeddings = TransformersEmbeddings;
//# sourceMappingURL=TransformersEmbeddings.js.map