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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const sinon_1 = __importDefault(require("sinon"));
const FileStorageUtilities_1 = require("./FileStorageUtilities");
describe('FileStorageUtilities', () => {
    afterEach(() => {
        sinon_1.default.restore();
    });
    describe('ensureFolderExists', () => {
        it('does not create the folder when it already exists', () => __awaiter(void 0, void 0, void 0, function* () {
            const folderPath = '/already/there';
            const storage = {
                pathExists: sinon_1.default.stub().resolves(true),
                createFolder: sinon_1.default.stub(),
            };
            yield FileStorageUtilities_1.FileStorageUtilities.ensureFolderExists(storage, folderPath);
            sinon_1.default.assert.calledOnceWithExactly(storage.pathExists, folderPath);
            sinon_1.default.assert.notCalled(storage.createFolder);
        }));
        it('creates the folder when it does not exist', () => __awaiter(void 0, void 0, void 0, function* () {
            const folderPath = '/needs/creation';
            const storage = {
                pathExists: sinon_1.default.stub().resolves(false),
                createFolder: sinon_1.default.stub().resolves(),
            };
            yield FileStorageUtilities_1.FileStorageUtilities.ensureFolderExists(storage, folderPath);
            sinon_1.default.assert.calledOnceWithExactly(storage.pathExists, folderPath);
            sinon_1.default.assert.calledOnceWithExactly(storage.createFolder, folderPath);
        }));
    });
    describe('getFileType', () => {
        it('returns type for known extension (lowercase)', () => {
            strict_1.default.strictEqual(FileStorageUtilities_1.FileStorageUtilities.getFileType('/any/path/file.txt'), 'txt');
        });
        it('returns type for known extension (case-insensitive)', () => {
            strict_1.default.strictEqual(FileStorageUtilities_1.FileStorageUtilities.getFileType('/any/path/FILE.TXT'), 'txt');
        });
        it('returns undefined for unknown extension', () => {
            strict_1.default.strictEqual(FileStorageUtilities_1.FileStorageUtilities.getFileType('/any/path/file.unknown'), undefined);
        });
        it('returns undefined when no extension', () => {
            strict_1.default.strictEqual(FileStorageUtilities_1.FileStorageUtilities.getFileType('/any/path/filename'), undefined);
        });
        it('returns undefined for trailing dot', () => {
            strict_1.default.strictEqual(FileStorageUtilities_1.FileStorageUtilities.getFileType('/any/path/file.'), undefined);
        });
    });
    describe('getFileTypeFromContentType', () => {
        it('returns mapped type when content type is directly mapped', () => {
            strict_1.default.strictEqual(FileStorageUtilities_1.FileStorageUtilities.getFileTypeFromContentType('text/plain'), 'txt');
        });
        it('falls back to subtype when not directly mapped', () => {
            // Not directly mapped but subtype is a known extension
            strict_1.default.strictEqual(FileStorageUtilities_1.FileStorageUtilities.getFileTypeFromContentType('application/png'), 'png');
        });
        it('handles "+" in subtype by using part before plus (may be unknown)', () => {
            strict_1.default.strictEqual(FileStorageUtilities_1.FileStorageUtilities.getFileTypeFromContentType('application/ld+json'), undefined);
        });
        it('returns undefined for invalid content type format (no slash)', () => {
            strict_1.default.strictEqual(FileStorageUtilities_1.FileStorageUtilities.getFileTypeFromContentType('invalid'), undefined);
        });
    });
    describe('tryDeleteFile', () => {
        it('returns undefined on successful delete', () => __awaiter(void 0, void 0, void 0, function* () {
            const filePath = '/tmp/success.bin';
            const storage = {
                deleteFile: sinon_1.default.stub().resolves(),
            };
            const result = yield FileStorageUtilities_1.FileStorageUtilities.tryDeleteFile(storage, filePath);
            sinon_1.default.assert.calledOnceWithExactly(storage.deleteFile, filePath);
            strict_1.default.strictEqual(result, undefined);
        }));
        it('returns the error on failed delete', () => __awaiter(void 0, void 0, void 0, function* () {
            const filePath = '/tmp/fail.bin';
            const error = new Error('boom');
            const storage = {
                deleteFile: sinon_1.default.stub().rejects(error),
            };
            const result = yield FileStorageUtilities_1.FileStorageUtilities.tryDeleteFile(storage, filePath);
            sinon_1.default.assert.calledOnceWithExactly(storage.deleteFile, filePath);
            strict_1.default.strictEqual(result, error);
        }));
    });
});
//# sourceMappingURL=FileStorageUtilities.spec.js.map