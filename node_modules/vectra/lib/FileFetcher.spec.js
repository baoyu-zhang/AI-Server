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
const assert_1 = require("assert");
const sinon = __importStar(require("sinon"));
const node_fs_1 = __importDefault(require("node:fs"));
const path = __importStar(require("path"));
const FileFetcher_1 = require("./FileFetcher");
describe('FileFetcher', () => {
    let fetcher;
    let statStub;
    let readdirStub;
    let readFileStub;
    beforeEach(() => {
        statStub = sinon.stub(node_fs_1.default.promises, 'stat');
        readdirStub = sinon.stub(node_fs_1.default.promises, 'readdir');
        readFileStub = sinon.stub(node_fs_1.default.promises, 'readFile');
        fetcher = new FileFetcher_1.FileFetcher();
    });
    afterEach(() => {
        sinon.restore();
    });
    it('resolves true when the path does not exist and does not call onDocument', () => __awaiter(void 0, void 0, void 0, function* () {
        statStub.rejects(new Error('not found'));
        const onDocument = sinon.fake.resolves(true);
        const result = yield fetcher.fetch('/nonexistent', onDocument);
        assert_1.strict.equal(result, true);
        assert_1.strict.equal(onDocument.callCount, 0);
    }));
    it('recurses a flat directory and calls fetch for each file', () => __awaiter(void 0, void 0, void 0, function* () {
        statStub.callsFake((uri) => __awaiter(void 0, void 0, void 0, function* () {
            if (uri === '/dir')
                return { isDirectory: () => true };
            if (uri === path.join('/dir', 'file1.txt'))
                return { isDirectory: () => false };
            if (uri === path.join('/dir', 'file2.md'))
                return { isDirectory: () => false };
            return { isDirectory: () => false };
        }));
        readdirStub.callsFake((uri) => __awaiter(void 0, void 0, void 0, function* () {
            if (uri === '/dir')
                return ['file1.txt', 'file2.md'];
            return [];
        }));
        readFileStub.resolves('content');
        const fetchSpy = sinon.spy(fetcher, 'fetch');
        const onDocument = sinon.fake.resolves(true);
        const result = yield fetcher.fetch('/dir', onDocument);
        assert_1.strict.equal(result, true);
        assert_1.strict.equal(fetchSpy.callCount, 3); // root + 2 files
        (0, assert_1.strict)(fetchSpy.calledWith(path.join('/dir', 'file1.txt'), sinon.match.func));
        (0, assert_1.strict)(fetchSpy.calledWith(path.join('/dir', 'file2.md'), sinon.match.func));
        assert_1.strict.equal(onDocument.callCount, 2);
        (0, assert_1.strict)(onDocument.calledWith(path.join('/dir', 'file1.txt'), 'content', 'txt'));
        (0, assert_1.strict)(onDocument.calledWith(path.join('/dir', 'file2.md'), 'content', 'md'));
    }));
    it('reads a file and passes correct args to onDocument (uri, text, docType)', () => __awaiter(void 0, void 0, void 0, function* () {
        statStub.resolves({ isDirectory: () => false });
        readFileStub.resolves('file content');
        const onDocument = sinon.fake.resolves(true);
        const result = yield fetcher.fetch('/file.txt', onDocument);
        assert_1.strict.equal(result, true);
        assert_1.strict.equal(onDocument.callCount, 1);
        const [uri, text, docType] = onDocument.firstCall.args;
        assert_1.strict.equal(uri, '/file.txt');
        assert_1.strict.equal(text, 'file content');
        assert_1.strict.equal(docType, 'txt');
    }));
    it('handles file with no extension by using last path segment as docType', () => __awaiter(void 0, void 0, void 0, function* () {
        statStub.resolves({ isDirectory: () => false });
        readFileStub.resolves('content');
        const onDocument = sinon.fake.resolves(true);
        const result = yield fetcher.fetch('/file', onDocument);
        assert_1.strict.equal(result, true);
        assert_1.strict.equal(onDocument.callCount, 1);
        const [uri, text, docType] = onDocument.firstCall.args;
        assert_1.strict.equal(uri, '/file');
        assert_1.strict.equal(text, 'content');
        assert_1.strict.equal(docType, 'file');
    }));
    it('awaits onDocument and returns its boolean result (true)', () => __awaiter(void 0, void 0, void 0, function* () {
        statStub.resolves({ isDirectory: () => false });
        readFileStub.resolves('text');
        const onDocumentTrue = sinon.fake.resolves(true);
        const resultTrue = yield fetcher.fetch('/file.txt', onDocumentTrue);
        assert_1.strict.equal(resultTrue, true);
    }));
    it('awaits onDocument and returns its boolean result (false)', () => __awaiter(void 0, void 0, void 0, function* () {
        statStub.resolves({ isDirectory: () => false });
        readFileStub.resolves('text');
        const onDocumentFalse = sinon.fake.resolves(false);
        const resultFalse = yield fetcher.fetch('/file.txt', onDocumentFalse);
        assert_1.strict.equal(resultFalse, false);
    }));
    it('propagates a rejection from onDocument as a rejected promise', () => __awaiter(void 0, void 0, void 0, function* () {
        statStub.resolves({ isDirectory: () => false });
        readFileStub.resolves('text');
        const onDocument = sinon.fake.rejects(new Error('fail'));
        yield assert_1.strict.rejects(() => fetcher.fetch('/file.txt', onDocument), /fail/);
    }));
    it('recurses nested directories and processes files at multiple depths', () => __awaiter(void 0, void 0, void 0, function* () {
        statStub.callsFake((uri) => __awaiter(void 0, void 0, void 0, function* () {
            if (uri === '/dir' || uri === path.join('/dir', 'subdir'))
                return { isDirectory: () => true };
            return { isDirectory: () => false };
        }));
        readdirStub.callsFake((uri) => __awaiter(void 0, void 0, void 0, function* () {
            if (uri === '/dir')
                return ['file1.txt', 'subdir'];
            if (uri === path.join('/dir', 'subdir'))
                return ['file2.md'];
            return [];
        }));
        readFileStub.resolves('content');
        const onDocument = sinon.fake.resolves(true);
        const result = yield fetcher.fetch('/dir', onDocument);
        assert_1.strict.equal(result, true);
        assert_1.strict.equal(onDocument.callCount, 2);
        (0, assert_1.strict)(onDocument.calledWith(path.join('/dir', 'file1.txt'), 'content', 'txt'));
        (0, assert_1.strict)(onDocument.calledWith(path.join('/dir', 'subdir', 'file2.md'), 'content', 'md'));
    }));
    it('handles an empty directory (no onDocument calls, resolves true)', () => __awaiter(void 0, void 0, void 0, function* () {
        statStub.resolves({ isDirectory: () => true });
        readdirStub.resolves([]);
        const onDocument = sinon.fake.resolves(true);
        const result = yield fetcher.fetch('/emptydir', onDocument);
        assert_1.strict.equal(result, true);
        assert_1.strict.equal(onDocument.callCount, 0);
    }));
    it('recurses directories that contain only subdirectories (no onDocument calls)', () => __awaiter(void 0, void 0, void 0, function* () {
        statStub.callsFake((uri) => __awaiter(void 0, void 0, void 0, function* () {
            if (uri === '/dir' ||
                uri === path.join('/dir', 'subdir1') ||
                uri === path.join('/dir', 'subdir2')) {
                return { isDirectory: () => true };
            }
            return { isDirectory: () => false };
        }));
        readdirStub.callsFake((uri) => __awaiter(void 0, void 0, void 0, function* () {
            if (uri === '/dir')
                return ['subdir1', 'subdir2'];
            if (uri === path.join('/dir', 'subdir1'))
                return [];
            if (uri === path.join('/dir', 'subdir2'))
                return [];
            return [];
        }));
        const onDocument = sinon.fake.resolves(true);
        const result = yield fetcher.fetch('/dir', onDocument);
        assert_1.strict.equal(result, true);
        assert_1.strict.equal(onDocument.callCount, 0);
    }));
    it('rejects when readdir fails for a directory', () => __awaiter(void 0, void 0, void 0, function* () {
        statStub.resolves({ isDirectory: () => true });
        readdirStub.rejects(new Error('fail'));
        const onDocument = sinon.fake.resolves(true);
        yield assert_1.strict.rejects(() => fetcher.fetch('/dir', onDocument), /fail/);
    }));
    it('rejects when readFile fails for a file', () => __awaiter(void 0, void 0, void 0, function* () {
        statStub.resolves({ isDirectory: () => false });
        readFileStub.rejects(new Error('fail'));
        const onDocument = sinon.fake.resolves(true);
        yield assert_1.strict.rejects(() => fetcher.fetch('/file.txt', onDocument), /fail/);
    }));
    it('extracts docType from multi-part extensions (file.tar.gz -> gz)', () => __awaiter(void 0, void 0, void 0, function* () {
        statStub.resolves({ isDirectory: () => false });
        readFileStub.resolves('content');
        const onDocument = sinon.fake.resolves(true);
        const result = yield fetcher.fetch('/file.tar.gz', onDocument);
        assert_1.strict.equal(result, true);
        assert_1.strict.equal(onDocument.callCount, 1);
        const [, , docType] = onDocument.firstCall.args;
        assert_1.strict.equal(docType, 'gz');
    }));
    it('returns false when any child in a directory returns false (aggregates to allOk=false)', () => __awaiter(void 0, void 0, void 0, function* () {
        statStub.callsFake((uri) => __awaiter(void 0, void 0, void 0, function* () {
            if (uri === '/dir')
                return { isDirectory: () => true };
            return { isDirectory: () => false };
        }));
        readdirStub.callsFake((uri) => __awaiter(void 0, void 0, void 0, function* () {
            if (uri === '/dir')
                return ['good.txt', 'bad.txt'];
            return [];
        }));
        readFileStub.resolves('content');
        const onDocument = sinon.stub();
        onDocument.callsFake((uri) => __awaiter(void 0, void 0, void 0, function* () {
            if (uri === path.join('/dir', 'bad.txt'))
                return false;
            return true;
        }));
        const result = yield fetcher.fetch('/dir', onDocument);
        assert_1.strict.equal(result, false);
        assert_1.strict.equal(onDocument.callCount, 2);
        (0, assert_1.strict)(onDocument.calledWith(path.join('/dir', 'good.txt'), 'content', 'txt'));
        (0, assert_1.strict)(onDocument.calledWith(path.join('/dir', 'bad.txt'), 'content', 'txt'));
    }));
});
//# sourceMappingURL=FileFetcher.spec.js.map