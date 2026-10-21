import { FileDetails, FileStorage, ListFilesFilter } from "./FileStorage";
/**
 * An in-memory `FileStorage` implementation.
 */
export declare class VirtualFileStorage implements FileStorage {
    private readonly _entries;
    private normalizeKey;
    createFile(filePath: string, content: Buffer | string): Promise<void>;
    createFolder(folderPath: string): Promise<void>;
    deleteFile(filePath: string): Promise<void>;
    deleteFolder(folderPath: string): Promise<void>;
    getDetails(fileOrFolderPath: string): Promise<FileDetails>;
    listFiles(folderPath: string, filter?: ListFilesFilter): Promise<FileDetails[]>;
    pathExists(fileOrFolderPath: string): Promise<boolean>;
    readFile(filePath: string): Promise<Buffer>;
    upsertFile(filePath: string, content: Buffer | string): Promise<void>;
}
//# sourceMappingURL=VirtualFileStorage.d.ts.map