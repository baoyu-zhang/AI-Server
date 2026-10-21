"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransformersTokenizer = void 0;
/**
 * A tokenizer wrapper for Transformers.js models.
 * @remarks
 * This tokenizer uses the same tokenizer as the embedding model,
 * ensuring consistency between text splitting and embedding generation.
 *
 * Obtain an instance via TransformersEmbeddings.getTokenizer().
 */
class TransformersTokenizer {
    /**
     * Creates a new TransformersTokenizer.
     * @param tokenizer The underlying Transformers.js tokenizer.
     * @remarks
     * Typically created via TransformersEmbeddings.getTokenizer().
     */
    constructor(tokenizer) {
        this._tokenizer = tokenizer;
    }
    /**
     * Encodes text into token IDs.
     * @param text The text to encode.
     * @returns Array of token IDs.
     */
    encode(text) {
        var _a, _b, _c;
        const encoded = this._tokenizer(text);
        // Transformers.js returns an object with input_ids as BigInt64Array or similar
        const inputIds = (_c = (_b = (_a = encoded.input_ids) === null || _a === void 0 ? void 0 : _a.data) !== null && _b !== void 0 ? _b : encoded.input_ids) !== null && _c !== void 0 ? _c : encoded;
        return Array.from(inputIds).map((id) => Number(id));
    }
    /**
     * Decodes token IDs back into text.
     * @param tokens Array of token IDs.
     * @returns Decoded text string.
     */
    decode(tokens) {
        return this._tokenizer.decode(tokens, { skip_special_tokens: true });
    }
}
exports.TransformersTokenizer = TransformersTokenizer;
//# sourceMappingURL=TransformersTokenizer.js.map