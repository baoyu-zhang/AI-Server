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
exports.LocalEmbeddings = void 0;
/**
 * An `EmbeddingsModel` that runs locally using `@huggingface/transformers`.
 * @remarks
 * Requires the `@huggingface/transformers` package to be installed.
 * The pipeline is lazily initialized on the first call to `createEmbeddings()`.
 * Models are downloaded and cached locally on first use.
 */
class LocalEmbeddings {
    /**
     * Creates a new `LocalEmbeddings` instance.
     * @param options Optional configuration.
     */
    constructor(options) {
        var _a, _b;
        this._pipeline = null;
        this._pipelinePromise = null;
        this._modelName = (_a = options === null || options === void 0 ? void 0 : options.model) !== null && _a !== void 0 ? _a : 'Xenova/all-MiniLM-L6-v2';
        this.maxTokens = (_b = options === null || options === void 0 ? void 0 : options.maxTokens) !== null && _b !== void 0 ? _b : 256;
    }
    /**
     * The model name used for embeddings.
     */
    get model() {
        return this._modelName;
    }
    /**
     * Creates embeddings for the given inputs.
     * @param inputs Text inputs to create embeddings for.
     * @returns A `EmbeddingsResponse` with a status and the generated embeddings or a message when an error occurs.
     */
    createEmbeddings(inputs) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const pipe = yield this.getPipeline();
                const inputArray = Array.isArray(inputs) ? inputs : [inputs];
                const output = [];
                for (const input of inputArray) {
                    const result = yield pipe(input, {
                        pooling: 'mean',
                        normalize: true,
                    });
                    output.push(Array.from(result.data));
                }
                return { status: 'success', output };
            }
            catch (err) {
                return {
                    status: 'error',
                    message: err instanceof Error ? err.message : String(err),
                };
            }
        });
    }
    /**
     * @private
     * Lazily initializes and returns the transformer.js pipeline.
     * Uses a singleton promise to prevent duplicate initialization.
     */
    getPipeline() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._pipeline) {
                return this._pipeline;
            }
            if (!this._pipelinePromise) {
                this._pipelinePromise = this.initPipeline();
            }
            return this._pipelinePromise;
        });
    }
    /**
     * @private
     */
    initPipeline() {
        return __awaiter(this, void 0, void 0, function* () {
            let transformers;
            try {
                transformers = require('@huggingface/transformers');
            }
            catch (_a) {
                throw new Error('The @huggingface/transformers package is required for local embeddings. ' +
                    'Install it with: npm install @huggingface/transformers');
            }
            this._pipeline = yield transformers.pipeline('feature-extraction', this._modelName);
            return this._pipeline;
        });
    }
}
exports.LocalEmbeddings = LocalEmbeddings;
//# sourceMappingURL=LocalEmbeddings.js.map