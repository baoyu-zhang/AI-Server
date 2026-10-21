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
Object.defineProperty(exports, "__esModule", { value: true });
const assert = __importStar(require("assert"));
const pathUtils_1 = require("./pathUtils");
describe('pathUtils', () => {
    describe('sep', () => {
        it('should be forward slash', () => {
            assert.strictEqual(pathUtils_1.pathUtils.sep, '/');
        });
    });
    describe('join', () => {
        it('should join simple segments', () => {
            assert.strictEqual(pathUtils_1.pathUtils.join('a', 'b', 'c'), 'a/b/c');
        });
        it('should strip trailing slashes from first segment', () => {
            assert.strictEqual(pathUtils_1.pathUtils.join('a/', 'b'), 'a/b');
        });
        it('should strip leading and trailing slashes from middle segments', () => {
            assert.strictEqual(pathUtils_1.pathUtils.join('a', '/b/', 'c'), 'a/b/c');
        });
        it('should handle backslashes', () => {
            assert.strictEqual(pathUtils_1.pathUtils.join('a\\', '\\b\\', 'c'), 'a/b/c');
        });
        it('should filter empty segments', () => {
            assert.strictEqual(pathUtils_1.pathUtils.join('a', '', 'b'), 'a/b');
        });
    });
    describe('basename', () => {
        it('should return last segment with forward slashes', () => {
            assert.strictEqual(pathUtils_1.pathUtils.basename('a/b/file.txt'), 'file.txt');
        });
        it('should return last segment with backslashes', () => {
            assert.strictEqual(pathUtils_1.pathUtils.basename('a\\b\\file.txt'), 'file.txt');
        });
        it('should strip extension when provided', () => {
            assert.strictEqual(pathUtils_1.pathUtils.basename('a/b/file.txt', '.txt'), 'file');
        });
        it('should not strip mismatched extension', () => {
            assert.strictEqual(pathUtils_1.pathUtils.basename('a/b/file.txt', '.md'), 'file.txt');
        });
        it('should handle path with no directory', () => {
            assert.strictEqual(pathUtils_1.pathUtils.basename('file.txt'), 'file.txt');
        });
    });
    describe('dirname', () => {
        it('should return directory with forward slashes', () => {
            assert.strictEqual(pathUtils_1.pathUtils.dirname('a/b/file.txt'), 'a/b');
        });
        it('should return directory with backslashes', () => {
            assert.strictEqual(pathUtils_1.pathUtils.dirname('a\\b\\file.txt'), 'a/b');
        });
        it('should return . for file with no directory', () => {
            assert.strictEqual(pathUtils_1.pathUtils.dirname('file.txt'), '.');
        });
    });
    describe('extname', () => {
        it('should return extension', () => {
            assert.strictEqual(pathUtils_1.pathUtils.extname('file.txt'), '.txt');
        });
        it('should return last extension for double extensions', () => {
            assert.strictEqual(pathUtils_1.pathUtils.extname('file.spec.ts'), '.ts');
        });
        it('should return empty string for no extension', () => {
            assert.strictEqual(pathUtils_1.pathUtils.extname('Makefile'), '');
        });
        it('should return empty string for dotfile', () => {
            assert.strictEqual(pathUtils_1.pathUtils.extname('.gitignore'), '');
        });
    });
    describe('normalize', () => {
        it('should resolve .. segments', () => {
            assert.strictEqual(pathUtils_1.pathUtils.normalize('a/b/../c'), 'a/c');
        });
        it('should resolve . segments', () => {
            assert.strictEqual(pathUtils_1.pathUtils.normalize('a/./b'), 'a/b');
        });
        it('should handle absolute paths', () => {
            assert.strictEqual(pathUtils_1.pathUtils.normalize('/a/b/../c'), '/a/c');
        });
        it('should handle Windows drive paths', () => {
            assert.strictEqual(pathUtils_1.pathUtils.normalize('C:\\a\\b\\..\\c'), 'C:/a/c');
        });
        it('should collapse multiple separators', () => {
            assert.strictEqual(pathUtils_1.pathUtils.normalize('a//b///c'), 'a/b/c');
        });
    });
    describe('isAbsolute', () => {
        it('should detect Unix absolute path', () => {
            assert.strictEqual(pathUtils_1.pathUtils.isAbsolute('/usr/bin'), true);
        });
        it('should detect Windows absolute path', () => {
            assert.strictEqual(pathUtils_1.pathUtils.isAbsolute('C:\\Users'), true);
        });
        it('should detect Windows path with forward slash', () => {
            assert.strictEqual(pathUtils_1.pathUtils.isAbsolute('C:/Users'), true);
        });
        it('should return false for relative path', () => {
            assert.strictEqual(pathUtils_1.pathUtils.isAbsolute('src/index.ts'), false);
        });
    });
    describe('relative', () => {
        it('should compute relative path between directories', () => {
            assert.strictEqual(pathUtils_1.pathUtils.relative('a/b', 'a/c'), '../c');
        });
        it('should compute relative path going up multiple levels', () => {
            assert.strictEqual(pathUtils_1.pathUtils.relative('a/b/c', 'a/d/e'), '../../d/e');
        });
        it('should return . for same path', () => {
            assert.strictEqual(pathUtils_1.pathUtils.relative('a/b', 'a/b'), '.');
        });
        it('should handle going deeper', () => {
            assert.strictEqual(pathUtils_1.pathUtils.relative('a', 'a/b/c'), 'b/c');
        });
        it('should handle completely different paths', () => {
            assert.strictEqual(pathUtils_1.pathUtils.relative('x/y', 'a/b'), '../../a/b');
        });
    });
});
//# sourceMappingURL=pathUtils.spec.js.map