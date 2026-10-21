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
const node_assert_1 = require("node:assert");
const mocha_1 = require("mocha");
const sinon_1 = __importDefault(require("sinon"));
const transformersLoader_1 = require("./internals/transformersLoader");
(0, mocha_1.describe)('TransformersEmbeddings', () => {
    let TransformersEmbeddings;
    let mockExtractor;
    let mockTokenizer;
    let sandbox;
    let pipelineStub;
    (0, mocha_1.beforeEach)(() => __awaiter(void 0, void 0, void 0, function* () {
        sandbox = sinon_1.default.createSandbox();
        // Create mock tokenizer
        mockTokenizer = {
            __call__: sandbox.stub().returns({
                input_ids: { data: BigInt64Array.from([BigInt(1), BigInt(2), BigInt(3)]) }
            }),
            decode: sandbox.stub().returns('decoded text')
        };
        // Make it callable
        const callableTokenizer = Object.assign((...args) => mockTokenizer.__call__(...args), mockTokenizer);
        // Create mock extractor (feature extraction pipeline)
        mockExtractor = sandbox.stub().callsFake((inputs) => __awaiter(void 0, void 0, void 0, function* () {
            const inputArray = Array.isArray(inputs) ? inputs : [inputs];
            const batchSize = inputArray.length;
            const embeddingDim = 4;
            const data = new Float32Array(batchSize * embeddingDim);
            for (let i = 0; i < batchSize; i++) {
                data[i * embeddingDim] = 0.1;
                data[i * embeddingDim + 1] = 0.2;
                data[i * embeddingDim + 2] = 0.3;
                data[i * embeddingDim + 3] = 0.4;
            }
            return {
                data: data,
                dims: [batchSize, embeddingDim]
            };
        }));
        // Attach tokenizer to the mock extractor so pipeline result has .tokenizer
        mockExtractor.tokenizer = callableTokenizer;
        // Inject a mock module via the loader seam. We can't `sinon.stub` the
        // real @huggingface/transformers module because its 4.x ESM exports
        // are non-configurable.
        pipelineStub = sandbox.stub().resolves(mockExtractor);
        (0, transformersLoader_1._setTransformersLoader)(() => __awaiter(void 0, void 0, void 0, function* () { return ({ pipeline: pipelineStub }); }));
        // Import TransformersEmbeddings (uses the injected loader).
        const mod = yield Promise.resolve().then(() => __importStar(require('./TransformersEmbeddings')));
        TransformersEmbeddings = mod.TransformersEmbeddings;
    }));
    (0, mocha_1.afterEach)(() => {
        sandbox.restore();
        (0, transformersLoader_1._setTransformersLoader)(undefined);
    });
    (0, mocha_1.describe)('create()', () => {
        (0, mocha_1.it)('creates instance with default options', () => __awaiter(void 0, void 0, void 0, function* () {
            const embeddings = yield TransformersEmbeddings.create();
            node_assert_1.strict.equal(embeddings.maxTokens, 512, 'default maxTokens should be 512');
            node_assert_1.strict.equal(embeddings.model, 'Xenova/all-MiniLM-L6-v2', 'default model should be all-MiniLM-L6-v2');
            // Verify pipeline was called with correct arguments
            node_assert_1.strict.ok(pipelineStub.calledOnce, 'pipeline should be called once');
            node_assert_1.strict.equal(pipelineStub.firstCall.args[0], 'feature-extraction');
            node_assert_1.strict.equal(pipelineStub.firstCall.args[1], 'Xenova/all-MiniLM-L6-v2');
        }));
        (0, mocha_1.it)('creates instance with custom options', () => __awaiter(void 0, void 0, void 0, function* () {
            const embeddings = yield TransformersEmbeddings.create({
                model: 'Xenova/bge-small-en-v1.5',
                maxTokens: 256,
                device: 'cpu',
                normalize: false,
                pooling: 'cls'
            });
            node_assert_1.strict.equal(embeddings.maxTokens, 256);
            node_assert_1.strict.equal(embeddings.model, 'Xenova/bge-small-en-v1.5');
        }));
        (0, mocha_1.it)('implements EmbeddingsModel interface', () => __awaiter(void 0, void 0, void 0, function* () {
            const embeddings = yield TransformersEmbeddings.create();
            node_assert_1.strict.equal(typeof embeddings.maxTokens, 'number');
            node_assert_1.strict.equal(typeof embeddings.createEmbeddings, 'function');
        }));
    });
    (0, mocha_1.describe)('createEmbeddings()', () => {
        (0, mocha_1.it)('generates embeddings for single string', () => __awaiter(void 0, void 0, void 0, function* () {
            const embeddings = yield TransformersEmbeddings.create();
            const result = yield embeddings.createEmbeddings('hello world');
            node_assert_1.strict.equal(result.status, 'success');
            node_assert_1.strict.ok(result.output, 'output should be defined');
            node_assert_1.strict.equal(result.output.length, 1, 'should have one embedding');
            node_assert_1.strict.equal(result.output[0].length, 4, 'embedding should have 4 dimensions');
            const expected = [0.1, 0.2, 0.3, 0.4];
            result.output[0].forEach((val, i) => {
                node_assert_1.strict.ok(Math.abs(val - expected[i]) < 0.001, `value ${val} should be close to ${expected[i]}`);
            });
            node_assert_1.strict.equal(result.model, 'Xenova/all-MiniLM-L6-v2');
        }));
        (0, mocha_1.it)('generates embeddings for string array', () => __awaiter(void 0, void 0, void 0, function* () {
            const embeddings = yield TransformersEmbeddings.create();
            const result = yield embeddings.createEmbeddings(['hello', 'world']);
            node_assert_1.strict.equal(result.status, 'success');
            node_assert_1.strict.ok(result.output, 'output should be defined');
            node_assert_1.strict.equal(result.output.length, 2, 'should have two embeddings');
            node_assert_1.strict.equal(mockExtractor.callCount, 1);
            node_assert_1.strict.deepEqual(mockExtractor.firstCall.args[0], ['hello', 'world']);
        }));
        (0, mocha_1.it)('passes pooling and normalize options to extractor', () => __awaiter(void 0, void 0, void 0, function* () {
            const embeddings = yield TransformersEmbeddings.create({
                pooling: 'cls',
                normalize: false
            });
            yield embeddings.createEmbeddings('test');
            node_assert_1.strict.ok(mockExtractor.calledOnce);
            const options = mockExtractor.firstCall.args[1];
            node_assert_1.strict.equal(options.pooling, 'cls');
            node_assert_1.strict.equal(options.normalize, false);
        }));
        (0, mocha_1.it)('returns error status on failure', () => __awaiter(void 0, void 0, void 0, function* () {
            var _a;
            mockExtractor.rejects(new Error('Model inference failed'));
            const embeddings = yield TransformersEmbeddings.create();
            const result = yield embeddings.createEmbeddings('test');
            node_assert_1.strict.equal(result.status, 'error');
            node_assert_1.strict.ok((_a = result.message) === null || _a === void 0 ? void 0 : _a.includes('Model inference failed'));
        }));
        (0, mocha_1.it)('handles empty string input', () => __awaiter(void 0, void 0, void 0, function* () {
            const embeddings = yield TransformersEmbeddings.create();
            const result = yield embeddings.createEmbeddings('');
            node_assert_1.strict.equal(result.status, 'success');
            node_assert_1.strict.ok(result.output);
            node_assert_1.strict.equal(result.output.length, 1);
        }));
        (0, mocha_1.it)('handles empty array input', () => __awaiter(void 0, void 0, void 0, function* () {
            const embeddings = yield TransformersEmbeddings.create();
            const result = yield embeddings.createEmbeddings([]);
            node_assert_1.strict.equal(result.status, 'success');
            node_assert_1.strict.ok(result.output);
            node_assert_1.strict.equal(result.output.length, 0);
        }));
    });
    (0, mocha_1.describe)('getTokenizer()', () => {
        (0, mocha_1.it)('returns a TransformersTokenizer instance', () => __awaiter(void 0, void 0, void 0, function* () {
            const embeddings = yield TransformersEmbeddings.create();
            const tokenizer = embeddings.getTokenizer();
            node_assert_1.strict.ok(tokenizer, 'tokenizer should be defined');
            node_assert_1.strict.equal(typeof tokenizer.encode, 'function');
            node_assert_1.strict.equal(typeof tokenizer.decode, 'function');
        }));
        (0, mocha_1.it)('returns consistent tokenizer across calls', () => __awaiter(void 0, void 0, void 0, function* () {
            const embeddings = yield TransformersEmbeddings.create();
            const tokenizer1 = embeddings.getTokenizer();
            const tokenizer2 = embeddings.getTokenizer();
            node_assert_1.strict.ok(tokenizer1);
            node_assert_1.strict.ok(tokenizer2);
        }));
    });
});
//# sourceMappingURL=TransformersEmbeddings.spec.js.map