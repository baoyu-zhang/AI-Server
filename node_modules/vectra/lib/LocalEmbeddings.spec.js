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
const sinon = __importStar(require("sinon"));
const LocalEmbeddings_1 = require("./LocalEmbeddings");
describe('LocalEmbeddings', () => {
    let requireStub;
    let fakePipeline;
    let fakePipelineFn;
    beforeEach(() => {
        // Create a fake pipeline function that returns tensor-like results
        fakePipelineFn = sinon.stub();
        fakePipeline = sinon.stub().resolves(fakePipelineFn);
        // Stub require to intercept @huggingface/transformers
        requireStub = sinon.stub(module.constructor.prototype, 'require');
        requireStub.callThrough(); // Allow all other requires to pass through
        requireStub.withArgs('@huggingface/transformers').returns({
            pipeline: fakePipeline,
        });
    });
    afterEach(() => {
        sinon.restore();
    });
    describe('constructor', () => {
        it('should use default model and maxTokens', () => {
            const embeddings = new LocalEmbeddings_1.LocalEmbeddings();
            assert.strictEqual(embeddings.model, 'Xenova/all-MiniLM-L6-v2');
            assert.strictEqual(embeddings.maxTokens, 256);
        });
        it('should accept custom model name', () => {
            const embeddings = new LocalEmbeddings_1.LocalEmbeddings({ model: 'custom/model' });
            assert.strictEqual(embeddings.model, 'custom/model');
        });
        it('should accept custom maxTokens', () => {
            const embeddings = new LocalEmbeddings_1.LocalEmbeddings({ maxTokens: 512 });
            assert.strictEqual(embeddings.maxTokens, 512);
        });
    });
    describe('createEmbeddings', () => {
        it('should create embeddings for a single string input', () => __awaiter(void 0, void 0, void 0, function* () {
            const fakeVector = new Float32Array([0.1, 0.2, 0.3]);
            fakePipelineFn.resolves({ data: fakeVector });
            const embeddings = new LocalEmbeddings_1.LocalEmbeddings();
            const result = yield embeddings.createEmbeddings('hello world');
            assert.strictEqual(result.status, 'success');
            assert.ok(result.output);
            assert.strictEqual(result.output.length, 1);
            assert.deepStrictEqual(result.output[0], [0.10000000149011612, 0.20000000298023224, 0.30000001192092896]);
        }));
        it('should create embeddings for an array of inputs', () => __awaiter(void 0, void 0, void 0, function* () {
            const vec1 = new Float32Array([0.1, 0.2, 0.3]);
            const vec2 = new Float32Array([0.4, 0.5, 0.6]);
            fakePipelineFn.onFirstCall().resolves({ data: vec1 });
            fakePipelineFn.onSecondCall().resolves({ data: vec2 });
            const embeddings = new LocalEmbeddings_1.LocalEmbeddings();
            const result = yield embeddings.createEmbeddings(['hello', 'world']);
            assert.strictEqual(result.status, 'success');
            assert.ok(result.output);
            assert.strictEqual(result.output.length, 2);
        }));
        it('should call pipeline with mean pooling and normalize', () => __awaiter(void 0, void 0, void 0, function* () {
            const fakeVector = new Float32Array([0.5, 0.5]);
            fakePipelineFn.resolves({ data: fakeVector });
            const embeddings = new LocalEmbeddings_1.LocalEmbeddings();
            yield embeddings.createEmbeddings('test');
            assert.ok(fakePipelineFn.calledOnce);
            const [input, options] = fakePipelineFn.firstCall.args;
            assert.strictEqual(input, 'test');
            assert.deepStrictEqual(options, { pooling: 'mean', normalize: true });
        }));
        it('should initialize the pipeline with correct model name', () => __awaiter(void 0, void 0, void 0, function* () {
            const fakeVector = new Float32Array([0.5]);
            fakePipelineFn.resolves({ data: fakeVector });
            const embeddings = new LocalEmbeddings_1.LocalEmbeddings({ model: 'my/model' });
            yield embeddings.createEmbeddings('test');
            assert.ok(fakePipeline.calledOnce);
            const [task, model] = fakePipeline.firstCall.args;
            assert.strictEqual(task, 'feature-extraction');
            assert.strictEqual(model, 'my/model');
        }));
        it('should reuse the pipeline across calls', () => __awaiter(void 0, void 0, void 0, function* () {
            const fakeVector = new Float32Array([0.5]);
            fakePipelineFn.resolves({ data: fakeVector });
            const embeddings = new LocalEmbeddings_1.LocalEmbeddings();
            yield embeddings.createEmbeddings('first');
            yield embeddings.createEmbeddings('second');
            // Pipeline should only be created once
            assert.ok(fakePipeline.calledOnce);
            // But the pipeline function should be called twice
            assert.strictEqual(fakePipelineFn.callCount, 2);
        }));
        it('should return error status when pipeline fails', () => __awaiter(void 0, void 0, void 0, function* () {
            fakePipelineFn.rejects(new Error('Model not found'));
            const embeddings = new LocalEmbeddings_1.LocalEmbeddings();
            const result = yield embeddings.createEmbeddings('test');
            assert.strictEqual(result.status, 'error');
            assert.ok(result.message);
            assert.ok(result.message.includes('Model not found'));
        }));
    });
    describe('optional dependency', () => {
        it('should return error when @huggingface/transformers is not installed', () => __awaiter(void 0, void 0, void 0, function* () {
            requireStub.withArgs('@huggingface/transformers').throws(new Error('Cannot find module'));
            const embeddings = new LocalEmbeddings_1.LocalEmbeddings();
            const result = yield embeddings.createEmbeddings('test');
            assert.strictEqual(result.status, 'error');
            assert.ok(result.message);
            assert.ok(result.message.includes('@huggingface/transformers'));
            assert.ok(result.message.includes('npm install'));
        }));
    });
});
//# sourceMappingURL=LocalEmbeddings.spec.js.map