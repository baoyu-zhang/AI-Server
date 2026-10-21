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
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = require("node:assert");
const pathUtils_1 = __importDefault(require("./utils/pathUtils"));
const mocha_1 = require("mocha");
const LocalDocumentModule = __importStar(require("../src/LocalDocument"));
const LocalDocument = (_a = LocalDocumentModule.LocalDocument) !== null && _a !== void 0 ? _a : LocalDocumentModule.default;
if (!LocalDocument) {
    throw new Error('Unable to import LocalDocument (neither named "LocalDocument" nor default export found).');
}
(0, mocha_1.describe)("LocalDocument", () => {
    let calls;
    let indexStub;
    let storageStub;
    let tokenizerStub;
    let doc;
    const folderPath = "/folder";
    const id = "doc1";
    const uri = "file:///doc1";
    (0, mocha_1.beforeEach)(() => {
        calls = [];
        storageStub = {
            readFile: (filePath) => __awaiter(void 0, void 0, void 0, function* () {
                calls.push({ method: "readFile", args: [filePath] });
                if (filePath.endsWith(".txt")) {
                    return Buffer.from("hello world", "utf8");
                }
                if (filePath.endsWith(".json")) {
                    return Buffer.from(JSON.stringify({ key: "value" }), "utf8");
                }
                throw new Error("File not found");
            }),
            pathExists: (filePath) => __awaiter(void 0, void 0, void 0, function* () {
                calls.push({ method: "pathExists", args: [filePath] });
                return filePath.endsWith(".json");
            }),
        };
        tokenizerStub = {
            encode: (text) => {
                calls.push({ method: "encode", args: [text] });
                return Array.from(text);
            },
        };
        indexStub = {
            folderPath,
            storage: storageStub,
            tokenizer: tokenizerStub,
        };
        doc = new LocalDocument(indexStub, id, uri);
    });
    (0, mocha_1.it)("constructor and getters", () => {
        node_assert_1.strict.equal(doc.id, id);
        node_assert_1.strict.equal(doc.uri, uri);
        node_assert_1.strict.equal(doc.folderPath, folderPath);
    });
    (0, mocha_1.describe)("loadText", () => {
        (0, mocha_1.it)("loads and caches text", () => __awaiter(void 0, void 0, void 0, function* () {
            const text1 = yield doc.loadText();
            const text2 = yield doc.loadText();
            node_assert_1.strict.equal(text1, "hello world");
            node_assert_1.strict.equal(text2, "hello world");
            const readFileCalls = calls.filter((c) => c.method === "readFile");
            node_assert_1.strict.equal(readFileCalls.length, 1);
            node_assert_1.strict.equal(readFileCalls[0].args[0], pathUtils_1.default.join(folderPath, `${id}.txt`));
        }));
        (0, mocha_1.it)("throws on read error with uri in message", () => __awaiter(void 0, void 0, void 0, function* () {
            storageStub.readFile = (filePath) => __awaiter(void 0, void 0, void 0, function* () {
                calls.push({ method: "readFile", args: [filePath] });
                throw new Error("read error");
            });
            const doc2 = new LocalDocument(indexStub, id, uri);
            yield node_assert_1.strict.rejects(() => doc2.loadText(), (err) => String(err.message).includes(`Error reading text file for document "${uri}":`));
        }));
    });
    (0, mocha_1.describe)("hasMetadata", () => {
        (0, mocha_1.it)("returns true if metadata exists, using correct path", () => __awaiter(void 0, void 0, void 0, function* () {
            const result = yield doc.hasMetadata();
            node_assert_1.strict.equal(result, true);
            const pe = calls.find((c) => c.method === "pathExists");
            node_assert_1.strict.ok(pe);
            node_assert_1.strict.equal(pe.args[0], pathUtils_1.default.join(folderPath, `${id}.json`));
        }));
        (0, mocha_1.it)("returns false if metadata does not exist", () => __awaiter(void 0, void 0, void 0, function* () {
            storageStub.pathExists = (filePath) => __awaiter(void 0, void 0, void 0, function* () {
                calls.push({ method: "pathExists", args: [filePath] });
                return false;
            });
            const doc2 = new LocalDocument(indexStub, id, uri);
            const result = yield doc2.hasMetadata();
            node_assert_1.strict.equal(result, false);
        }));
    });
    (0, mocha_1.describe)("loadMetadata", () => {
        (0, mocha_1.it)("loads and caches metadata, using correct path", () => __awaiter(void 0, void 0, void 0, function* () {
            const meta1 = yield doc.loadMetadata();
            const meta2 = yield doc.loadMetadata();
            node_assert_1.strict.deepEqual(meta1, { key: "value" });
            node_assert_1.strict.equal(meta1, meta2);
            const jsonCalls = calls.filter((c) => c.method === "readFile" && c.args[0].endsWith(".json"));
            node_assert_1.strict.equal(jsonCalls.length, 1);
            node_assert_1.strict.equal(jsonCalls[0].args[0], pathUtils_1.default.join(folderPath, `${id}.json`));
        }));
        (0, mocha_1.it)("throws on read error with uri in message", () => __awaiter(void 0, void 0, void 0, function* () {
            storageStub.readFile = (filePath) => __awaiter(void 0, void 0, void 0, function* () {
                calls.push({ method: "readFile", args: [filePath] });
                if (filePath.endsWith(".json"))
                    throw new Error("read error");
                return Buffer.from("ok", "utf8");
            });
            const doc2 = new LocalDocument(indexStub, id, uri);
            yield node_assert_1.strict.rejects(() => doc2.loadMetadata(), (err) => String(err.message).includes(`Error reading metadata for document "${uri}":`));
        }));
        (0, mocha_1.it)("throws on parse error with uri in message", () => __awaiter(void 0, void 0, void 0, function* () {
            storageStub.readFile = (filePath) => __awaiter(void 0, void 0, void 0, function* () {
                calls.push({ method: "readFile", args: [filePath] });
                if (filePath.endsWith(".json"))
                    return Buffer.from("{", "utf8");
                return Buffer.from("ok", "utf8");
            });
            const doc2 = new LocalDocument(indexStub, id, uri);
            yield node_assert_1.strict.rejects(() => doc2.loadMetadata(), (err) => String(err.message).includes(`Error parsing metadata for document "${uri}":`));
        }));
    });
    (0, mocha_1.describe)("getLength", () => {
        (0, mocha_1.it)("uses tokenizer.encode for small text (≤ 40,000 chars)", () => __awaiter(void 0, void 0, void 0, function* () {
            tokenizerStub.encode = (text) => {
                calls.push({ method: "encode", args: [text] });
                return new Array(5);
            };
            storageStub.readFile = (filePath) => __awaiter(void 0, void 0, void 0, function* () {
                calls.push({ method: "readFile", args: [filePath] });
                return Buffer.from("small text", "utf8");
            });
            const doc2 = new LocalDocument(indexStub, id, uri);
            const length = yield doc2.getLength();
            node_assert_1.strict.equal(length, 5);
            node_assert_1.strict.ok(calls.some((c) => c.method === "encode"));
        }));
        (0, mocha_1.it)("estimates length for large text (> 40,000 chars) without encoding", () => __awaiter(void 0, void 0, void 0, function* () {
            const largeText = "a".repeat(40001);
            storageStub.readFile = (filePath) => __awaiter(void 0, void 0, void 0, function* () {
                calls.push({ method: "readFile", args: [filePath] });
                return Buffer.from(largeText, "utf8");
            });
            tokenizerStub.encode = () => {
                throw new Error("encode should not be called for large text");
            };
            const doc2 = new LocalDocument(indexStub, id, uri);
            const length = yield doc2.getLength();
            node_assert_1.strict.equal(length, Math.ceil(40001 / 4));
        }));
        (0, mocha_1.it)("reuses cached text across calls (no extra reads)", () => __awaiter(void 0, void 0, void 0, function* () {
            tokenizerStub.encode = (text) => new Array(text.length);
            storageStub.readFile = (filePath) => __awaiter(void 0, void 0, void 0, function* () {
                calls.push({ method: "readFile", args: [filePath] });
                return Buffer.from("small text", "utf8");
            });
            const doc2 = new LocalDocument(indexStub, id, uri);
            const length1 = yield doc2.getLength();
            const length2 = yield doc2.getLength();
            node_assert_1.strict.equal(length1, length2);
            const readFileCalls = calls.filter((c) => c.method === "readFile");
            node_assert_1.strict.equal(readFileCalls.length, 1);
            node_assert_1.strict.equal(readFileCalls[0].args[0], pathUtils_1.default.join(folderPath, `${id}.txt`));
        }));
    });
});
//# sourceMappingURL=LocalDocument.spec.js.map