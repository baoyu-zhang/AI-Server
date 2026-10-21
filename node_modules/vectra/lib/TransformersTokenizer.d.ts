import { PreTrainedTokenizer } from "@huggingface/transformers";
import { Tokenizer } from "./types";
/**
 * A tokenizer wrapper for Transformers.js models.
 * @remarks
 * This tokenizer uses the same tokenizer as the embedding model,
 * ensuring consistency between text splitting and embedding generation.
 *
 * Obtain an instance via TransformersEmbeddings.getTokenizer().
 */
export declare class TransformersTokenizer implements Tokenizer {
    private readonly _tokenizer;
    /**
     * Creates a new TransformersTokenizer.
     * @param tokenizer The underlying Transformers.js tokenizer.
     * @remarks
     * Typically created via TransformersEmbeddings.getTokenizer().
     */
    constructor(tokenizer: PreTrainedTokenizer);
    /**
     * Encodes text into token IDs.
     * @param text The text to encode.
     * @returns Array of token IDs.
     */
    encode(text: string): number[];
    /**
     * Decodes token IDs back into text.
     * @param tokens Array of token IDs.
     * @returns Decoded text string.
     */
    decode(tokens: number[]): string;
}
//# sourceMappingURL=TransformersTokenizer.d.ts.map