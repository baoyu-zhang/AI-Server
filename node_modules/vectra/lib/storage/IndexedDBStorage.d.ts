import { Buffer } from 'buffer';
import { FileDetails, FileStorage, ListFilesFilter } from "./FileStorage";
/**
 * Browser-compatible FileStorage implementation using IndexedDB.
 * @remarks
 * This storage backend works in browsers and Electron renderer processes.
 * Data persists across page reloads and browser sessions.
 */
export declare class IndexedDBStorage implements FileStorage {
    private readonly _dbName;
    private _db;
    /**
     * Creates a new `IndexedDBStorage` instance.
     * @param dbName Name of the IndexedDB database. Defaults to 'vectra-db'.
     */
    constructor(dbName?: string);
    /**
     * Opens or creates the IndexedDB database.
     */
    private getDB;
    /**
     * Normalizes a path for consistent storage.
     */
    private normalizePath;
    /**
     * Gets the parent path of a given path.
     */
    private getParentPath;
    createFile(filePath: string, content: Buffer | string): Promise<void>;
    createFolder(folderPath: string): Promise<void>;
    deleteFile(filePath: string): Promise<void>;
    deleteFolder(folderPath: string): Promise<void>;
    getDetails(fileOrFolderPath: string): Promise<FileDetails>;
    listFiles(folderPath: string, filter?: ListFilesFilter): Promise<FileDetails[]>;
    pathExists(fileOrFolderPath: string): Promise<boolean>;
    readFile(filePath: string): Promise<Buffer>;
    upsertFile(filePath: string, content: Buffer | string): Promise<void>;
    /**
     * Closes the database connection.
     */
    close(): void;
    /**
     * Deletes the entire database.
     */
    destroy(): Promise<void>;
}
//# sourceMappingURL=IndexedDBStorage.d.ts.map