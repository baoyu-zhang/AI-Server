"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FolderWatcher = void 0;
const events_1 = require("events");
const node_fs_1 = __importDefault(require("node:fs"));
const path = __importStar(require("path"));
/**
 * Watches folders for file changes and automatically syncs them into a LocalDocumentIndex.
 *
 * @remarks
 * Uses Node.js `fs.watch` for efficient filesystem monitoring with debouncing.
 * Performs an initial full sync on start, then watches for incremental changes.
 */
class FolderWatcher extends events_1.EventEmitter {
    /**
     * Creates a new FolderWatcher instance.
     * @param config Configuration for the watcher.
     */
    constructor(config) {
        var _a;
        super();
        this._tracked = new Map();
        this._pending = new Map();
        this._watchers = [];
        this._dirWatchers = new Map();
        this._running = false;
        this._index = config.index;
        this._paths = config.paths.map(p => path.resolve(p));
        this._extensions = config.extensions
            ? new Set(config.extensions.map(e => e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`))
            : undefined;
        this._debounceMs = (_a = config.debounceMs) !== null && _a !== void 0 ? _a : 500;
    }
    /**
     * Returns true if the watcher is currently running.
     */
    get isRunning() {
        return this._running;
    }
    /**
     * Returns the number of tracked files.
     */
    get trackedFileCount() {
        return this._tracked.size;
    }
    /**
     * Starts the watcher: performs an initial sync and then watches for changes.
     */
    start() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._running) {
                throw new Error('FolderWatcher is already running');
            }
            this._running = true;
            // Canonicalize watched paths. Windows `fs.watch` will crash inside
            // libuv with a `!_wcsnicmp` assertion in `fs-event.c` when given a
            // path containing an 8.3 short name (e.g., `STEVEN~1`) because
            // ReadDirectoryChangesW reports event filenames with their long-name
            // expansion and libuv's prefix check fails. `os.tmpdir()` is a common
            // source of short names in the wild. Resolving up front keeps the
            // tracked URIs, the initial sync, and the per-directory watchers all
            // consistent on the long-name form.
            for (let i = 0; i < this._paths.length; i++) {
                try {
                    this._paths[i] = yield node_fs_1.default.promises.realpath(this._paths[i]);
                }
                catch (_a) {
                    // Path doesn't exist yet — leave as-is; the watch loop will skip it.
                }
            }
            // Initial sync
            yield this._initialSync();
            this.emit('ready');
            // Set up watchers
            for (const watchPath of this._paths) {
                try {
                    const stat = yield node_fs_1.default.promises.stat(watchPath);
                    if (stat.isDirectory()) {
                        yield this._watchDirectoryTree(watchPath);
                    }
                    else if (stat.isFile()) {
                        this._watchFile(watchPath);
                    }
                }
                catch (_b) {
                    // Path doesn't exist — skip
                }
            }
        });
    }
    /**
     * Stops the watcher and cleans up all resources.
     */
    stop() {
        return __awaiter(this, void 0, void 0, function* () {
            this._running = false;
            // Close all watchers
            for (const watcher of this._watchers) {
                try {
                    watcher.close();
                }
                catch ( /* ignore */_a) { /* ignore */ }
            }
            this._watchers.length = 0;
            this._dirWatchers.clear();
            // Clear pending debounced operations
            for (const timeout of this._pending.values()) {
                clearTimeout(timeout);
            }
            this._pending.clear();
        });
    }
    /**
     * Performs a full sync: scans all watched paths and upserts/deletes as needed.
     * @returns Number of files synced (added + updated + deleted).
     */
    sync() {
        return __awaiter(this, void 0, void 0, function* () {
            let count = 0;
            // Collect current files on disk
            const currentFiles = new Map();
            for (const watchPath of this._paths) {
                yield this._collectFiles(watchPath, currentFiles);
            }
            // Upsert new or changed files
            for (const [filePath, mtimeMs] of currentFiles) {
                const tracked = this._tracked.get(filePath);
                if (!tracked || tracked.mtimeMs < mtimeMs) {
                    const ok = yield this._syncFile(filePath, mtimeMs);
                    if (ok)
                        count++;
                }
            }
            // Delete files that no longer exist
            for (const [filePath, tracked] of this._tracked) {
                if (!currentFiles.has(filePath)) {
                    const ok = yield this._deleteFile(tracked.uri);
                    if (ok)
                        count++;
                }
            }
            return count;
        });
    }
    // --- Private methods ---
    _initialSync() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.sync();
        });
    }
    _shouldInclude(filePath) {
        if (!this._extensions)
            return true;
        const ext = path.extname(filePath).toLowerCase();
        return this._extensions.has(ext);
    }
    _collectFiles(dirOrFile, out) {
        return __awaiter(this, void 0, void 0, function* () {
            let stat;
            try {
                stat = yield node_fs_1.default.promises.stat(dirOrFile);
            }
            catch (_a) {
                return;
            }
            if (stat.isFile()) {
                if (this._shouldInclude(dirOrFile)) {
                    out.set(dirOrFile, stat.mtimeMs);
                }
            }
            else if (stat.isDirectory()) {
                const entries = yield node_fs_1.default.promises.readdir(dirOrFile);
                for (const entry of entries) {
                    yield this._collectFiles(path.join(dirOrFile, entry), out);
                }
            }
        });
    }
    _syncFile(filePath, mtimeMs) {
        return __awaiter(this, void 0, void 0, function* () {
            const wasTracked = this._tracked.has(filePath);
            const action = wasTracked ? 'updated' : 'added';
            try {
                const text = yield node_fs_1.default.promises.readFile(filePath, 'utf-8');
                const ext = path.extname(filePath);
                const docType = ext ? ext.slice(1).toLowerCase() : undefined;
                yield this._index.upsertDocument(filePath, text, docType);
                this._tracked.set(filePath, { uri: filePath, mtimeMs });
                this.emit('sync', filePath, action);
                return true;
            }
            catch (err) {
                this.emit('error', err instanceof Error ? err : new Error(String(err)), filePath);
                return false;
            }
        });
    }
    _deleteFile(uri) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this._index.deleteDocument(uri);
                // Find and remove from tracked by URI
                for (const [filePath, tracked] of this._tracked) {
                    if (tracked.uri === uri) {
                        this._tracked.delete(filePath);
                        break;
                    }
                }
                this.emit('sync', uri, 'deleted');
                return true;
            }
            catch (err) {
                this.emit('error', err instanceof Error ? err : new Error(String(err)), uri);
                return false;
            }
        });
    }
    /**
     * Walks a directory tree and installs a non-recursive `fs.watch` on every
     * directory it contains. Non-recursive watching avoids a known libuv bug on
     * Windows (`Assertion failed: !_wcsnicmp` in `fs-event.c`) that fires when
     * `fs.watch(..., { recursive: true })` receives events whose paths libuv's
     * Windows backend can't normalize back to the watch root.
     */
    _watchDirectoryTree(rootDir) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this._running)
                return;
            this._addDirectoryWatch(rootDir);
            let entries;
            try {
                entries = yield node_fs_1.default.promises.readdir(rootDir, { withFileTypes: true });
            }
            catch (_a) {
                // Dir may have been removed mid-walk; nothing to recurse into.
                return;
            }
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    yield this._watchDirectoryTree(path.join(rootDir, entry.name));
                }
            }
        });
    }
    _addDirectoryWatch(dirPath) {
        if (this._dirWatchers.has(dirPath))
            return;
        try {
            const watcher = node_fs_1.default.watch(dirPath, (_eventType, filename) => {
                if (!this._running || !filename)
                    return;
                const fullPath = path.join(dirPath, filename);
                this._handleEvent(fullPath);
            });
            watcher.on('error', (err) => {
                this.emit('error', err, dirPath);
                // Clean up so we don't leak a dead handle in our maps.
                this._stopWatchingDir(dirPath);
            });
            this._dirWatchers.set(dirPath, watcher);
            this._watchers.push(watcher);
        }
        catch (err) {
            this.emit('error', err instanceof Error ? err : new Error(String(err)), dirPath);
        }
    }
    /**
     * Dispatch a single change event from one of the per-directory watchers.
     * - File path: feed to the existing debounced file-sync pipeline.
     * - New subdirectory: install watchers for it and sync its contents.
     * - Path that used to be a watched subdirectory and no longer exists:
     *   tear down its watchers (and any descendants) and mark affected
     *   tracked files for deletion.
     */
    _handleEvent(fullPath) {
        // fs.watch callbacks must return quickly; do the work async without
        // awaiting and route exceptions to the error event.
        void this._processEvent(fullPath).catch((err) => {
            this.emit('error', err instanceof Error ? err : new Error(String(err)), fullPath);
        });
    }
    _processEvent(fullPath) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this._running)
                return;
            let stat;
            try {
                stat = yield node_fs_1.default.promises.stat(fullPath);
            }
            catch (_a) {
                // Path no longer exists. If it was a watched subdir, tear down.
                if (this._dirWatchers.has(fullPath)) {
                    this._stopWatchingDir(fullPath);
                }
                // If a tracked file disappeared, debouncedSync will pick it up
                // (its timer stats, fails, and calls _deleteFile).
                if (this._tracked.has(fullPath)) {
                    this._debouncedSync(fullPath);
                }
                return;
            }
            if (stat.isDirectory()) {
                if (!this._dirWatchers.has(fullPath)) {
                    // New subdirectory: watch it (and any descendants) and sync
                    // files that already exist inside it.
                    yield this._watchDirectoryTree(fullPath);
                    const files = new Map();
                    yield this._collectFiles(fullPath, files);
                    for (const [filePath, mtimeMs] of files) {
                        if (!this._running)
                            return;
                        yield this._syncFile(filePath, mtimeMs);
                    }
                }
            }
            else if (stat.isFile() && this._shouldInclude(fullPath)) {
                this._debouncedSync(fullPath);
            }
        });
    }
    _stopWatchingDir(dirPath) {
        const prefix = dirPath + path.sep;
        const doomed = [];
        for (const watched of this._dirWatchers.keys()) {
            if (watched === dirPath || watched.startsWith(prefix)) {
                doomed.push(watched);
            }
        }
        for (const watched of doomed) {
            const watcher = this._dirWatchers.get(watched);
            if (watcher) {
                try {
                    watcher.close();
                }
                catch ( /* ignore */_a) { /* ignore */ }
                this._dirWatchers.delete(watched);
                const idx = this._watchers.indexOf(watcher);
                if (idx >= 0)
                    this._watchers.splice(idx, 1);
            }
        }
    }
    _watchFile(filePath) {
        try {
            const watcher = node_fs_1.default.watch(filePath, (eventType) => {
                if (!this._running)
                    return;
                this._debouncedSync(filePath);
            });
            watcher.on('error', (err) => {
                this.emit('error', err, filePath);
            });
            this._watchers.push(watcher);
        }
        catch (err) {
            this.emit('error', err instanceof Error ? err : new Error(String(err)), filePath);
        }
    }
    _debouncedSync(filePath) {
        // Cancel any pending sync for this file
        const existing = this._pending.get(filePath);
        if (existing) {
            clearTimeout(existing);
        }
        const timeout = setTimeout(() => __awaiter(this, void 0, void 0, function* () {
            this._pending.delete(filePath);
            if (!this._running)
                return;
            try {
                const stat = yield node_fs_1.default.promises.stat(filePath);
                if (stat.isFile()) {
                    yield this._syncFile(filePath, stat.mtimeMs);
                }
            }
            catch (_a) {
                // File was deleted
                if (this._tracked.has(filePath)) {
                    yield this._deleteFile(filePath);
                }
            }
        }), this._debounceMs);
        this._pending.set(filePath, timeout);
    }
}
exports.FolderWatcher = FolderWatcher;
//# sourceMappingURL=FolderWatcher.js.map