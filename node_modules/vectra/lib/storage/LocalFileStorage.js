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
exports.LocalFileStorage = void 0;
const FileStorageUtilities_1 = require("./FileStorageUtilities");
const promises_1 = __importDefault(require("fs/promises"));
const path = __importStar(require("node:path"));
/**
 * A `FileStorage` implementation that uses the local file system.
 */
class LocalFileStorage {
    /**
     * Creates a new `LocalFileStorage` instance.
     * @param rootFolder Optional. Root folder to use for file operations. If not provided, paths passed to operations should be fully qualified.
     */
    constructor(rootFolder) {
        this._rootFolder = rootFolder;
    }
    createFile(filePath, content) {
        return __awaiter(this, void 0, void 0, function* () {
            // Convert content to buffer if it's a string
            if (typeof content == 'string') {
                content = Buffer.from(content, 'utf8');
            }
            // Write the file
            yield promises_1.default.writeFile(this.getFullPath(filePath), content, { flag: 'wx' });
        });
    }
    createFolder(folderPath) {
        return __awaiter(this, void 0, void 0, function* () {
            yield promises_1.default.mkdir(this.getFullPath(folderPath), { recursive: true });
        });
    }
    deleteFile(filePath) {
        return __awaiter(this, void 0, void 0, function* () {
            yield promises_1.default.unlink(this.getFullPath(filePath));
        });
    }
    deleteFolder(folderPath) {
        return __awaiter(this, void 0, void 0, function* () {
            yield promises_1.default.rm(this.getFullPath(folderPath), { recursive: true });
        });
    }
    getDetails(fileOrFolderPath) {
        return __awaiter(this, void 0, void 0, function* () {
            const stats = yield promises_1.default.stat(this.getFullPath(fileOrFolderPath));
            return {
                name: path.basename(fileOrFolderPath),
                path: fileOrFolderPath,
                isFolder: stats.isDirectory(),
                fileType: stats.isFile() ? FileStorageUtilities_1.FileStorageUtilities.getFileType(fileOrFolderPath) : undefined
            };
        });
    }
    listFiles(folderPath, _filter) {
        return __awaiter(this, void 0, void 0, function* () {
            const folder = this.getFullPath(folderPath);
            const list = yield promises_1.default.readdir(folder, { withFileTypes: true });
            return list.map((entry) => {
                return {
                    name: entry.name,
                    path: path.join(folder, entry.name),
                    isFolder: entry.isDirectory(),
                    fileType: entry.isFile() ? FileStorageUtilities_1.FileStorageUtilities.getFileType(entry.name) : undefined
                };
            });
        });
    }
    pathExists(fileOrFolderPath) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield promises_1.default.access(this.getFullPath(fileOrFolderPath));
                return true;
            }
            catch (err) {
                return false;
            }
        });
    }
    readFile(filePath) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield promises_1.default.readFile(this.getFullPath(filePath));
        });
    }
    upsertFile(filePath, content) {
        return __awaiter(this, void 0, void 0, function* () {
            // Convert content to buffer if it's a string
            if (typeof content == 'string') {
                content = Buffer.from(content, 'utf8');
            }
            // Write the file
            yield promises_1.default.writeFile(this.getFullPath(filePath), content, { flag: 'w' });
        });
    }
    getFullPath(relativePath) {
        if (!this._rootFolder) {
            return relativePath.length > 0 ? relativePath : '.';
        }
        else if (relativePath.length == 0) {
            return this._rootFolder;
        }
        else {
            return path.join(this._rootFolder, relativePath);
        }
    }
}
exports.LocalFileStorage = LocalFileStorage;
//# sourceMappingURL=LocalFileStorage.js.map