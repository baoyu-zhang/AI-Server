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
const node_assert_1 = __importDefault(require("node:assert"));
const sinon_1 = __importDefault(require("sinon"));
const OpenAIEmbeddings_1 = require("./OpenAIEmbeddings");
describe('OpenAIEmbeddings', () => {
    let sandbox;
    let fetchStub;
    function makeFetchResponse(status, data, statusText = '') {
        return {
            status,
            statusText,
            ok: status >= 200 && status < 300,
            headers: new Headers(),
            json: () => __awaiter(this, void 0, void 0, function* () { return data; }),
            text: () => __awaiter(this, void 0, void 0, function* () { return JSON.stringify(data); }),
        };
    }
    const successData = {
        object: 'list',
        model: 'any',
        data: [
            { index: 0, object: 'embedding', embedding: [0.1, 0.2] }
        ],
        usage: { prompt_tokens: 1, total_tokens: 1 }
    };
    beforeEach(() => {
        sandbox = sinon_1.default.createSandbox();
        fetchStub = sandbox.stub(globalThis, 'fetch');
    });
    afterEach(() => {
        sandbox.restore();
    });
    it('Azure: trims trailing slash, enforces https, defaults apiVersion and maxTokens', () => {
        const inst = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            azureApiKey: 'key',
            azureEndpoint: 'https://example.com/',
            azureDeployment: 'dep'
        });
        const opts = inst.options;
        node_assert_1.default.strictEqual(opts.azureEndpoint, 'https://example.com');
        node_assert_1.default.strictEqual(opts.azureApiVersion, '2023-05-15');
        node_assert_1.default.strictEqual(inst.maxTokens, 500);
        // Private enum: ClientType.AzureOpenAI == 1
        node_assert_1.default.strictEqual(inst._clientType, 1);
    });
    it('Azure: throws for non-https endpoint', () => {
        node_assert_1.default.throws(() => {
            new OpenAIEmbeddings_1.OpenAIEmbeddings({
                azureApiKey: 'key',
                azureEndpoint: 'http://example.com',
                azureDeployment: 'dep'
            });
        }, /Client created with an invalid endpoint of 'http:\/\/example.com'. The endpoint must be a valid HTTPS url\./);
    });
    it('OSS: selects OSS client type, defaults retryPolicy, respects maxTokens', () => {
        const inst = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            ossModel: 'oss-emb',
            ossEndpoint: 'https://oss.example.com',
            maxTokens: 1234
        });
        const opts = inst.options;
        node_assert_1.default.deepStrictEqual(opts.retryPolicy, [2000, 5000]);
        node_assert_1.default.strictEqual(inst.maxTokens, 1234);
        // Private enum: ClientType.OSS == 2
        node_assert_1.default.strictEqual(inst._clientType, 2);
    });
    it('OpenAI: selects OpenAI client type and defaults retryPolicy', () => {
        const inst = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            apiKey: 'sk',
            model: 'text-embedding-3-small'
        });
        const opts = inst.options;
        node_assert_1.default.deepStrictEqual(opts.retryPolicy, [2000, 5000]);
        // Private enum: ClientType.OpenAI == 0
        node_assert_1.default.strictEqual(inst._clientType, 0);
    });
    it('Azure: URL formation and dimensions passthrough', () => __awaiter(void 0, void 0, void 0, function* () {
        fetchStub.resolves(makeFetchResponse(200, successData));
        const inst = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            azureApiKey: 'key',
            azureEndpoint: 'https://example.com/',
            azureDeployment: 'dep',
            dimensions: 256
        });
        yield inst.createEmbeddings('hello');
        const [url, init] = fetchStub.getCall(0).args;
        node_assert_1.default.strictEqual(url, 'https://example.com/openai/deployments/dep/embeddings?api-version=2023-05-15');
        const body = JSON.parse(init.body);
        node_assert_1.default.strictEqual(body.input, 'hello');
        node_assert_1.default.strictEqual(body.dimensions, 256);
    }));
    it('OSS: URL formation and model injection', () => __awaiter(void 0, void 0, void 0, function* () {
        fetchStub.resolves(makeFetchResponse(200, successData));
        const inst = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            ossModel: 'oss-emb',
            ossEndpoint: 'https://oss.example.com'
        });
        yield inst.createEmbeddings('text');
        const [url, init] = fetchStub.getCall(0).args;
        node_assert_1.default.strictEqual(url, 'https://oss.example.com/v1/embeddings');
        const body = JSON.parse(init.body);
        node_assert_1.default.strictEqual(body.input, 'text');
        node_assert_1.default.strictEqual(body.model, 'oss-emb');
    }));
    it('OpenAI: URL formation (default endpoint) and model injection', () => __awaiter(void 0, void 0, void 0, function* () {
        fetchStub.resolves(makeFetchResponse(200, successData));
        const inst = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            apiKey: 'sk',
            model: 'm'
        });
        yield inst.createEmbeddings('x');
        const [url, init] = fetchStub.getCall(0).args;
        node_assert_1.default.strictEqual(url, 'https://api.openai.com/v1/embeddings');
        const body = JSON.parse(init.body);
        node_assert_1.default.strictEqual(body.model, 'm');
    }));
    it('OpenAI: URL formation (custom endpoint)', () => __awaiter(void 0, void 0, void 0, function* () {
        fetchStub.resolves(makeFetchResponse(200, successData));
        const inst = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            apiKey: 'sk',
            model: 'm',
            endpoint: 'https://custom'
        });
        yield inst.createEmbeddings('x');
        const [url] = fetchStub.getCall(0).args;
        node_assert_1.default.strictEqual(url, 'https://custom/v1/embeddings');
    }));
    it('Azure: headers include Content-Type, User-Agent, api-key', () => __awaiter(void 0, void 0, void 0, function* () {
        fetchStub.resolves(makeFetchResponse(200, successData));
        const inst = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            azureApiKey: 'key',
            azureEndpoint: 'https://example.com/',
            azureDeployment: 'dep'
        });
        yield inst.createEmbeddings('x');
        const [, init] = fetchStub.getCall(0).args;
        const headers = new Headers(init.headers);
        node_assert_1.default.strictEqual(headers.get('Content-Type'), 'application/json');
        node_assert_1.default.strictEqual(headers.get('User-Agent'), 'AlphaWave');
        node_assert_1.default.strictEqual(headers.get('api-key'), 'key');
    }));
    it('OpenAI: headers include Authorization and OpenAI-Organization when provided', () => __awaiter(void 0, void 0, void 0, function* () {
        fetchStub.resolves(makeFetchResponse(200, successData));
        const inst = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            apiKey: 'sk',
            model: 'm',
            organization: 'org1'
        });
        yield inst.createEmbeddings('x');
        const [, init] = fetchStub.getCall(0).args;
        const headers = new Headers(init.headers);
        node_assert_1.default.strictEqual(headers.get('Authorization'), 'Bearer sk');
        node_assert_1.default.strictEqual(headers.get('OpenAI-Organization'), 'org1');
    }));
    it('Respects pre-supplied headers from requestConfig and does not overwrite them', () => __awaiter(void 0, void 0, void 0, function* () {
        fetchStub.resolves(makeFetchResponse(200, successData));
        const inst = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            apiKey: 'sk',
            model: 'm',
            requestConfig: {
                headers: {
                    'Content-Type': 'application/x-custom',
                    'User-Agent': 'MyUA',
                    'X-Custom': '1'
                }
            }
        });
        yield inst.createEmbeddings('x');
        const [, init] = fetchStub.getCall(0).args;
        const headers = new Headers(init.headers);
        node_assert_1.default.strictEqual(headers.get('Content-Type'), 'application/x-custom'); // preserved
        node_assert_1.default.strictEqual(headers.get('User-Agent'), 'MyUA'); // preserved
        node_assert_1.default.strictEqual(headers.get('X-Custom'), '1'); // preserved
        node_assert_1.default.strictEqual(headers.get('Authorization'), 'Bearer sk'); // added
    }));
    it('429 retry path obeys retryPolicy delays and eventually succeeds', () => __awaiter(void 0, void 0, void 0, function* () {
        const clock = sandbox.useFakeTimers();
        const resp429 = makeFetchResponse(429, {});
        const resp200 = makeFetchResponse(200, successData);
        fetchStub.onCall(0).resolves(resp429);
        fetchStub.onCall(1).resolves(resp429);
        fetchStub.onCall(2).resolves(resp200);
        const inst = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            apiKey: 'sk',
            model: 'm',
            retryPolicy: [10, 20]
        });
        const p = inst.createEmbeddings('x');
        yield clock.tickAsync(10);
        yield clock.tickAsync(20);
        const result = yield p;
        node_assert_1.default.strictEqual(fetchStub.callCount, 3);
        node_assert_1.default.strictEqual(result.status, 'success');
        clock.restore();
    }));
    it('429 with empty retryPolicy returns rate_limited', () => __awaiter(void 0, void 0, void 0, function* () {
        const resp429 = makeFetchResponse(429, {});
        fetchStub.resolves(resp429);
        const inst = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            apiKey: 'sk',
            model: 'm',
            retryPolicy: []
        });
        const result = yield inst.createEmbeddings('x');
        node_assert_1.default.strictEqual(result.status, 'rate_limited');
        node_assert_1.default.ok((result.message || '').includes('rate limit'));
    }));
    it('Success maps embeddings sorted by index', () => __awaiter(void 0, void 0, void 0, function* () {
        const data = {
            object: 'list',
            model: 'any',
            data: [
                { index: 2, object: 'embedding', embedding: [3] },
                { index: 0, object: 'embedding', embedding: [1] },
                { index: 1, object: 'embedding', embedding: [2] }
            ],
            usage: { prompt_tokens: 1, total_tokens: 1 }
        };
        fetchStub.resolves(makeFetchResponse(200, data));
        const inst = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            apiKey: 'sk',
            model: 'm'
        });
        const result = yield inst.createEmbeddings(['a', 'b', 'c']);
        node_assert_1.default.strictEqual(result.status, 'success');
        node_assert_1.default.deepStrictEqual(result.output, [[1], [2], [3]]);
    }));
    it('Non-429 error returns status error with message', () => __awaiter(void 0, void 0, void 0, function* () {
        fetchStub.resolves(makeFetchResponse(500, {}, 'Internal Server Error'));
        const inst = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            apiKey: 'sk',
            model: 'm'
        });
        const result = yield inst.createEmbeddings('x');
        node_assert_1.default.strictEqual(result.status, 'error');
        node_assert_1.default.strictEqual(result.message, 'The embeddings API returned an error status of 500: Internal Server Error');
    }));
    it('logRequests true logs request and response details', () => __awaiter(void 0, void 0, void 0, function* () {
        fetchStub.resolves(makeFetchResponse(200, successData));
        const logSpy = sandbox.stub(console, 'log');
        const inst = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            apiKey: 'sk',
            model: 'm',
            logRequests: true
        });
        yield inst.createEmbeddings('x');
        node_assert_1.default.ok(logSpy.callCount >= 4);
    }));
    it('Input handling: string preserved in body', () => __awaiter(void 0, void 0, void 0, function* () {
        fetchStub.resolves(makeFetchResponse(200, successData));
        const inst = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            apiKey: 'sk',
            model: 'm'
        });
        yield inst.createEmbeddings('hello');
        const [, init] = fetchStub.getCall(0).args;
        const body = JSON.parse(init.body);
        node_assert_1.default.strictEqual(body.input, 'hello');
    }));
    it('Input handling: string[] preserved in body', () => __awaiter(void 0, void 0, void 0, function* () {
        fetchStub.resolves(makeFetchResponse(200, successData));
        const inst = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            apiKey: 'sk',
            model: 'm'
        });
        yield inst.createEmbeddings(['a', 'b']);
        const [, init] = fetchStub.getCall(0).args;
        const body = JSON.parse(init.body);
        node_assert_1.default.deepStrictEqual(body.input, ['a', 'b']);
    }));
    it('maxTokens default and override', () => {
        const instDefault = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            apiKey: 'sk',
            model: 'm'
        });
        node_assert_1.default.strictEqual(instDefault.maxTokens, 500);
        const instOverride = new OpenAIEmbeddings_1.OpenAIEmbeddings({
            apiKey: 'sk',
            model: 'm',
            maxTokens: 1024
        });
        node_assert_1.default.strictEqual(instOverride.maxTokens, 1024);
    });
});
//# sourceMappingURL=OpenAIEmbeddings.spec.js.map