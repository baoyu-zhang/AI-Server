import { FileStorage } from "./FileStorage";
import { FileType } from "./FileType";
/**
 * Utility functions for working with FileStorage abstractions.
 */
export declare class FileStorageUtilities {
    /**
     * Ensures that a folder exists in the given storage.
     * @param storage Storage to create the folder in.
     * @param folderPath Path to folder to ensure is created.
     */
    static ensureFolderExists(storage: FileStorage, folderPath: string): Promise<void>;
    /**
     * Returns the file type of a file based on its extension.
     * @remarks
     * The file type is determined by the file extension. Only extensions found in the
     * `FileExt[]` array are returned.
     * @param filePath Path to file to get type for.
     * @returns The file type, or undefined if the file type is unknown.
     */
    static getFileType(filePath: string): FileType | undefined;
    /**
     * Maps a content type to a file type.
     * @param contentType Content type to map.
     * @returns File type, or undefined if the content type is unknown.
     */
    static getFileTypeFromContentType(contentType: string): FileType | undefined;
    /**
     * Deletes a file from storage if it exists.
     * @param storage Storage to delete the file from.
     * @param filePath Path to the file to delete.
     * @returns An Error if the file could not be deleted, otherwise undefined.
     */
    static tryDeleteFile(storage: FileStorage, filePath: string): Promise<Error | undefined>;
}
//# sourceMappingURL=FileStorageUtilities.d.ts.map