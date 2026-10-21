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
exports.LocalDocument = void 0;
const pathUtils_1 = require("./utils/pathUtils");
/**
 * Represents an indexed document stored on disk.
 */
class LocalDocument {
    /**
     * Creates a new `LocalDocument` instance.
     * @param index Parent index that contains the document.
     * @param id ID of the document.
     * @param uri URI of the document.
     */
    constructor(index, id, uri) {
        this._index = index;
        this._id = id;
        this._uri = uri;
    }
    /**
     * Returns the folder path where the document is stored.
     */
    get folderPath() {
        return this._index.folderPath;
    }
    /**
     * Returns the ID of the document.
     */
    get id() {
        return this._id;
    }
    /**
     * Returns the URI of the document.
     */
    get uri() {
        return this._uri;
    }
    /**
     * Returns the length of the document in tokens.
     * @remarks
     * This value will be estimated for documents longer then 40k bytes.
     * @returns Length of the document in tokens.
     */
    getLength() {
        return __awaiter(this, void 0, void 0, function* () {
            const text = yield this.loadText();
            if (text.length <= 40000) {
                return this._index.tokenizer.encode(text).length;
            }
            else {
                return Math.ceil(text.length / 4);
            }
        });
    }
    /**
     * Determines if the document has additional metadata stored on disk.
     * @returns True if the document has metadata; otherwise, false.
     */
    hasMetadata() {
        return __awaiter(this, void 0, void 0, function* () {
            return this._index.storage.pathExists(pathUtils_1.pathUtils.join(this.folderPath, `${this.id}.json`));
        });
    }
    /**
     * Loads the metadata for the document from disk.
     * @returns Metadata for the document.
     */
    loadMetadata() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._metadata == undefined) {
                let json;
                try {
                    json = (yield this._index.storage.readFile(pathUtils_1.pathUtils.join(this.folderPath, `${this.id}.json`))).toString('utf-8');
                }
                catch (err) {
                    throw new Error(`Error reading metadata for document "${this.uri}": ${err.toString()}`);
                }
                try {
                    this._metadata = JSON.parse(json);
                }
                catch (err) {
                    throw new Error(`Error parsing metadata for document "${this.uri}": ${err.toString()}`);
                }
            }
            return this._metadata;
        });
    }
    /**
     * Loads the text for the document from disk.
     * @returns Text for the document.
     */
    loadText() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._text == undefined) {
                try {
                    this._text = (yield this._index.storage.readFile(pathUtils_1.pathUtils.join(this.folderPath, `${this.id}.txt`))).toString('utf-8');
                }
                catch (err) {
                    throw new Error(`Error reading text file for document "${this.uri}": ${err.toString()}`);
                }
            }
            return this._text;
        });
    }
}
exports.LocalDocument = LocalDocument;
//# sourceMappingURL=LocalDocument.js.map