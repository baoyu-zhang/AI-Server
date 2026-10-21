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
Object.defineProperty(exports, "__esModule", { value: true });
const assert = __importStar(require("assert"));
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
describe('vectra generate', () => {
    let tmpDir;
    const projectRoot = process.cwd();
    beforeEach(() => __awaiter(void 0, void 0, void 0, function* () {
        tmpDir = yield fs.mkdtemp(path.join(os.tmpdir(), 'vectra-gen-'));
    }));
    afterEach(() => __awaiter(void 0, void 0, void 0, function* () {
        yield fs.rm(tmpDir, { recursive: true, force: true });
    }));
    const languages = ['python', 'csharp', 'rust', 'go', 'java', 'typescript'];
    for (const lang of languages) {
        it(`should generate ${lang} bindings`, () => __awaiter(void 0, void 0, void 0, function* () {
            const outputDir = path.join(tmpDir, lang);
            const binPath = path.join(projectRoot, 'bin', 'vectra.js');
            (0, child_process_1.execSync)(`node "${binPath}" generate --language ${lang} --output "${outputDir}"`, {
                cwd: projectRoot,
                timeout: 15000,
            });
            // Verify proto file was copied
            const protoPath = path.join(outputDir, 'vectra_service.proto');
            const protoStat = yield fs.stat(protoPath);
            assert.ok(protoStat.isFile(), 'vectra_service.proto should exist');
            // Verify README was copied
            const readmePath = path.join(outputDir, 'README.md');
            const readmeStat = yield fs.stat(readmePath);
            assert.ok(readmeStat.isFile(), 'README.md should exist');
            // Language-specific checks
            const files = yield fs.readdir(outputDir);
            if (lang === 'python') {
                assert.ok(files.includes('vectra_client.py'), 'should have vectra_client.py');
            }
            else if (lang === 'csharp') {
                assert.ok(files.includes('VectraClient.cs'), 'should have VectraClient.cs');
            }
            else if (lang === 'rust') {
                assert.ok(files.includes('lib.rs'), 'should have lib.rs');
                assert.ok(files.includes('Cargo.toml'), 'should have Cargo.toml');
                assert.ok(files.includes('build.rs'), 'should have build.rs');
            }
            else if (lang === 'go') {
                assert.ok(files.includes('vectra_client.go'), 'should have vectra_client.go');
            }
            else if (lang === 'java') {
                assert.ok(files.includes('VectraClient.java'), 'should have VectraClient.java');
            }
            else if (lang === 'typescript') {
                assert.ok(files.includes('VectraClient.ts'), 'should have VectraClient.ts');
            }
        }));
    }
    it('should create output directory if it does not exist', () => __awaiter(void 0, void 0, void 0, function* () {
        const outputDir = path.join(tmpDir, 'nested', 'deep', 'dir');
        const binPath = path.join(projectRoot, 'bin', 'vectra.js');
        (0, child_process_1.execSync)(`node "${binPath}" generate --language python --output "${outputDir}"`, {
            cwd: projectRoot,
            timeout: 15000,
        });
        const files = yield fs.readdir(outputDir);
        assert.ok(files.includes('vectra_service.proto'));
        assert.ok(files.includes('vectra_client.py'));
    }));
});
//# sourceMappingURL=vectra-cli.generate.spec.js.map