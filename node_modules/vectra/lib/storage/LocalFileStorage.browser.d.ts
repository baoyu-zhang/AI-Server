/**
 * Browser stub for LocalFileStorage.
 * This module throws an error if LocalFileStorage is used in a browser environment.
 * Use IndexedDBStorage or VirtualFileStorage instead.
 */
import { FileStorage, FileDetails } from "./FileStorage";
export declare class LocalFileStorage implements FileStorage {
    constructor();
    createFile(): Promise<void>;
    createFolder(): Promise<void>;
    deleteFile(): Promise<void>;
    deleteFolder(): Promise<void>;
    getDetails(): Promise<FileDetails>;
    listFiles(): Promise<FileDetails[]>;
    pathExists(): Promise<boolean>;
    readFile(): Promise<Buffer>;
    upsertFile(): Promise<void>;
}
//# sourceMappingURL=LocalFileStorage.browser.d.ts.map