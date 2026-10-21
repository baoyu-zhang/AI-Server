import { EventEmitter } from 'events';
import { LocalDocumentIndex } from './LocalDocumentIndex';
/**
 * Configuration for FolderWatcher.
 */
export interface FolderWatcherConfig {
    /**
     * The LocalDocumentIndex to sync files into.
     */
    index: LocalDocumentIndex;
    /**
     * List of folder or file paths to watch.
     */
    paths: string[];
    /**
     * Optional. File extensions to include (e.g., ['.txt', '.md', '.html']).
     * @remarks
     * If not specified, all files are included.
     */
    extensions?: string[];
    /**
     * Optional. Debounce interval in milliseconds for file change events.
     * @remarks
     * Default is 500ms. Multiple rapid changes to the same file are collapsed into one sync.
     */
    debounceMs?: number;
}
/**
 * Events emitted by FolderWatcher.
 *
 * - `sync` — emitted after a file is synced. Args: `(uri: string, action: 'added' | 'updated' | 'deleted')`
 * - `error` — emitted when a sync operation fails. Args: `(error: Error, uri: string)`
 * - `ready` — emitted after the initial sync completes.
 */
export interface FolderWatcherEvents {
    sync: [uri: string, action: 'added' | 'updated' | 'deleted'];
    error: [error: Error, uri: string];
    ready: [];
}
/**
 * Watches folders for file changes and automatically syncs them into a LocalDocumentIndex.
 *
 * @remarks
 * Uses Node.js `fs.watch` for efficient filesystem monitoring with debouncing.
 * Performs an initial full sync on start, then watches for incremental changes.
 */
export declare class FolderWatcher extends EventEmitter {
    private readonly _index;
    private readonly _paths;
    private readonly _extensions?;
    private readonly _debounceMs;
    private readonly _tracked;
    private readonly _pending;
    private readonly _watchers;
    private readonly _dirWatchers;
    private _running;
    /**
     * Creates a new FolderWatcher instance.
     * @param config Configuration for the watcher.
     */
    constructor(config: FolderWatcherConfig);
    /**
     * Returns true if the watcher is currently running.
     */
    get isRunning(): boolean;
    /**
     * Returns the number of tracked files.
     */
    get trackedFileCount(): number;
    /**
     * Starts the watcher: performs an initial sync and then watches for changes.
     */
    start(): Promise<void>;
    /**
     * Stops the watcher and cleans up all resources.
     */
    stop(): Promise<void>;
    /**
     * Performs a full sync: scans all watched paths and upserts/deletes as needed.
     * @returns Number of files synced (added + updated + deleted).
     */
    sync(): Promise<number>;
    private _initialSync;
    private _shouldInclude;
    private _collectFiles;
    private _syncFile;
    private _deleteFile;
    /**
     * Walks a directory tree and installs a non-recursive `fs.watch` on every
     * directory it contains. Non-recursive watching avoids a known libuv bug on
     * Windows (`Assertion failed: !_wcsnicmp` in `fs-event.c`) that fires when
     * `fs.watch(..., { recursive: true })` receives events whose paths libuv's
     * Windows backend can't normalize back to the watch root.
     */
    private _watchDirectoryTree;
    private _addDirectoryWatch;
    /**
     * Dispatch a single change event from one of the per-directory watchers.
     * - File path: feed to the existing debounced file-sync pipeline.
     * - New subdirectory: install watchers for it and sync its contents.
     * - Path that used to be a watched subdirectory and no longer exists:
     *   tear down its watchers (and any descendants) and mark affected
     *   tracked files for deletion.
     */
    private _handleEvent;
    private _processEvent;
    private _stopWatchingDir;
    private _watchFile;
    private _debouncedSync;
}
//# sourceMappingURL=FolderWatcher.d.ts.map