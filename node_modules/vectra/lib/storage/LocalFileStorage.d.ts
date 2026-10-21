import { FileDetails, FileStorage, ListFilesFilter } from "./FileStorage";
/**
 * A `FileStorage` implementation that uses the local file system.
 */
export declare class LocalFileStorage implements FileStorage {
    private _rootFolder;
    /**
     * Creates a new `LocalFileStorage` instance.
     * @param rootFolder Optional. Root folder to use for file operations. If not provided, paths passed to operations should be fully qualified.
     */
    constructor(rootFolder?: string);
    createFile(filePath: string, content: Buffer | string): Promise<void>;
    createFolder(folderPath: string): Promise<void>;
    deleteFile(filePath: string): Promise<void>;
    deleteFolder(folderPath: string): Promise<void>;
    getDetails(fileOrFolderPath: string): Promise<FileDetails>;
    listFiles(folderPath: string, _filter?: ListFilesFilter | undefined): Promise<FileDetails[]>;
    pathExists(fileOrFolderPath: string): Promise<boolean>;
    readFile(filePath: string): Promise<Buffer>;
    upsertFile(filePath: string, content: Buffer | string): Promise<void>;
    private getFullPath;
}
//# sourceMappingURL=LocalFileStorage.d.ts.map