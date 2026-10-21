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
exports.FileStorageUtilities = void 0;
const FileType_1 = require("./FileType");
const pathUtils_1 = require("../utils/pathUtils");
/**
 * Utility functions for working with FileStorage abstractions.
 */
class FileStorageUtilities {
    /**
     * Ensures that a folder exists in the given storage.
     * @param storage Storage to create the folder in.
     * @param folderPath Path to folder to ensure is created.
     */
    static ensureFolderExists(storage, folderPath) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!(yield storage.pathExists(folderPath))) {
                yield storage.createFolder(folderPath);
            }
        });
    }
    /**
     * Returns the file type of a file based on its extension.
     * @remarks
     * The file type is determined by the file extension. Only extensions found in the
     * `FileExt[]` array are returned.
     * @param filePath Path to file to get type for.
     * @returns The file type, or undefined if the file type is unknown.
     */
    static getFileType(filePath) {
        // Get extension from file
        const ext = pathUtils_1.pathUtils.extname(filePath).toLowerCase();
        if (ext.length > 1) {
            // Ensure the extension is valid
            const fileType = ext.substring(1);
            if (FileType_1.FileExt.includes(fileType)) {
                return fileType;
            }
        }
        return undefined;
    }
    /**
     * Maps a content type to a file type.
     * @param contentType Content type to map.
     * @returns File type, or undefined if the content type is unknown.
     */
    static getFileTypeFromContentType(contentType) {
        if (Object.prototype.hasOwnProperty.call(FileType_1.ContentTypeMap, contentType)) {
            return FileType_1.ContentTypeMap[contentType];
        }
        else {
            // Try to find a matching file type
            const parts = contentType.split('/');
            if (parts.length == 2) {
                const fileType = parts[1].includes('+') ? parts[1].split('+')[0] : parts[1];
                if (FileType_1.FileExt.includes(fileType)) {
                    return fileType;
                }
            }
        }
        return undefined;
    }
    /**
     * Deletes a file from storage if it exists.
     * @param storage Storage to delete the file from.
     * @param filePath Path to the file to delete.
     * @returns An Error if the file could not be deleted, otherwise undefined.
     */
    static tryDeleteFile(storage, filePath) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield storage.deleteFile(filePath);
                return undefined;
            }
            catch (err) {
                return err;
            }
        });
    }
}
exports.FileStorageUtilities = FileStorageUtilities;
//# sourceMappingURL=FileStorageUtilities.js.map