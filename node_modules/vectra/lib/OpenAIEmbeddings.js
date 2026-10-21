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
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIEmbeddings = void 0;
const internals_1 = require("./internals");
/**
 * A `PromptCompletionModel` for calling OpenAI and Azure OpenAI hosted models.
 * @remarks
 */
class OpenAIEmbeddings {
    /**
     * Creates a new `OpenAIClient` instance.
     * @param options Options for configuring an `OpenAIClient`.
     */
    constructor(options) {
        var _a;
        this.UserAgent = 'AlphaWave';
        this.maxTokens = (_a = options.maxTokens) !== null && _a !== void 0 ? _a : 500;
        // Check for azure config
        if (options.azureApiKey) {
            this._clientType = ClientType.AzureOpenAI;
            this.options = Object.assign({
                retryPolicy: [2000, 5000],
                azureApiVersion: '2023-05-15',
            }, options);
            // Cleanup and validate endpoint
            let endpoint = this.options.azureEndpoint.trim();
            if (endpoint.endsWith('/')) {
                endpoint = endpoint.substring(0, endpoint.length - 1);
            }
            if (!endpoint.toLowerCase().startsWith('https://')) {
                throw new Error(`Client created with an invalid endpoint of '${endpoint}'. The endpoint must be a valid HTTPS url.`);
            }
            this.options.azureEndpoint = endpoint;
        }
        else if (options.ossModel) {
            this._clientType = ClientType.OSS;
            this.options = Object.assign({
                retryPolicy: [2000, 5000]
            }, options);
        }
        else {
            this._clientType = ClientType.OpenAI;
            this.options = Object.assign({
                retryPolicy: [2000, 5000]
            }, options);
        }
    }
    /**
     * Creates embeddings for the given inputs using the OpenAI API.
     * @param model Name of the model to use (or deployment for Azure).
     * @param inputs Text inputs to create embeddings for.
     * @returns A `EmbeddingsResponse` with a status and the generated embeddings or a message when an error occurs.
     */
    createEmbeddings(inputs) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.options.logRequests) {
                console.log(internals_1.Colorize.title('EMBEDDINGS REQUEST:'));
                console.log(internals_1.Colorize.output(inputs));
            }
            const startTime = Date.now();
            const response = yield this.createEmbeddingRequest({
                input: inputs,
            });
            const data = yield response.json();
            if (this.options.logRequests) {
                console.log(internals_1.Colorize.title('RESPONSE:'));
                console.log(internals_1.Colorize.value('status', response.status));
                console.log(internals_1.Colorize.value('duration', Date.now() - startTime, 'ms'));
                console.log(internals_1.Colorize.output(data));
            }
            // Process response
            if (response.status < 300) {
                return { status: 'success', output: data.data.sort((a, b) => a.index - b.index).map((item) => item.embedding) };
            }
            else if (response.status == 429) {
                return { status: 'rate_limited', message: `The embeddings API returned a rate limit error.` };
            }
            else {
                return { status: 'error', message: `The embeddings API returned an error status of ${response.status}: ${response.statusText}` };
            }
        });
    }
    /**
     * @private
     */
    createEmbeddingRequest(request) {
        var _a;
        if (this.options.dimensions) {
            request.dimensions = this.options.dimensions;
        }
        if (this._clientType == ClientType.AzureOpenAI) {
            const options = this.options;
            const url = `${options.azureEndpoint}/openai/deployments/${options.azureDeployment}/embeddings?api-version=${options.azureApiVersion}`;
            return this.post(url, request);
        }
        else if (this._clientType == ClientType.OSS) {
            const options = this.options;
            const url = `${options.ossEndpoint}/v1/embeddings`;
            request.model = options.ossModel;
            return this.post(url, request);
        }
        else {
            const options = this.options;
            const url = `${(_a = options.endpoint) !== null && _a !== void 0 ? _a : 'https://api.openai.com'}/v1/embeddings`;
            request.model = options.model;
            return this.post(url, request);
        }
    }
    /**
     * @private
     */
    post(url_1, body_1) {
        return __awaiter(this, arguments, void 0, function* (url, body, retryCount = 0) {
            var _a, _b;
            // Initialize headers from requestConfig
            const baseHeaders = new Headers((_b = (_a = this.options.requestConfig) === null || _a === void 0 ? void 0 : _a.headers) !== null && _b !== void 0 ? _b : {});
            // Set defaults if not already provided
            if (!baseHeaders.has('Content-Type')) {
                baseHeaders.set('Content-Type', 'application/json');
            }
            if (!baseHeaders.has('User-Agent')) {
                baseHeaders.set('User-Agent', this.UserAgent);
            }
            // Set auth headers
            if (this._clientType == ClientType.AzureOpenAI) {
                const options = this.options;
                baseHeaders.set('api-key', options.azureApiKey);
            }
            else if (this._clientType == ClientType.OpenAI) {
                const options = this.options;
                baseHeaders.set('Authorization', `Bearer ${options.apiKey}`);
                if (options.organization) {
                    baseHeaders.set('OpenAI-Organization', options.organization);
                }
            }
            // Send request
            const response = yield fetch(url, Object.assign(Object.assign({}, this.options.requestConfig), { method: 'POST', headers: baseHeaders, body: JSON.stringify(body) }));
            // Check for rate limit error
            if (response.status == 429 && Array.isArray(this.options.retryPolicy) && retryCount < this.options.retryPolicy.length) {
                const delay = this.options.retryPolicy[retryCount];
                yield new Promise((resolve) => setTimeout(resolve, delay));
                return this.post(url, body, retryCount + 1);
            }
            else {
                return response;
            }
        });
    }
}
exports.OpenAIEmbeddings = OpenAIEmbeddings;
var ClientType;
(function (ClientType) {
    ClientType[ClientType["OpenAI"] = 0] = "OpenAI";
    ClientType[ClientType["AzureOpenAI"] = 1] = "AzureOpenAI";
    ClientType[ClientType["OSS"] = 2] = "OSS";
})(ClientType || (ClientType = {}));
//# sourceMappingURL=OpenAIEmbeddings.js.map