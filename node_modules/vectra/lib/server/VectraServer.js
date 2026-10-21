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
exports.VectraServer = void 0;
const path = __importStar(require("path"));
const grpc = __importStar(require("@grpc/grpc-js"));
const protoLoader = __importStar(require("@grpc/proto-loader"));
const IndexManager_1 = require("./IndexManager");
const handlers_1 = require("./handlers");
const DRAIN_TIMEOUT_MS = 5000;
/**
 * gRPC server that exposes Vectra indexes over the VectraService proto.
 */
class VectraServer {
    constructor(config) {
        this._startTime = 0;
        this._config = config;
        const managerConfig = {
            indexPath: config.indexPath,
            rootDir: config.rootDir,
            embeddings: config.embeddings,
            scanInterval: config.scanInterval,
        };
        this._indexManager = new IndexManager_1.IndexManager(managerConfig);
    }
    /** The underlying IndexManager. */
    get indexManager() {
        return this._indexManager;
    }
    /** The underlying gRPC server instance. */
    get server() {
        return this._server;
    }
    /**
     * Starts the gRPC server and loads indexes.
     * @returns The port the server is listening on.
     */
    start() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            this._startTime = Date.now();
            // Load proto definition
            const protoPath = path.resolve(__dirname, '..', '..', 'proto', 'vectra_service.proto');
            const packageDefinition = protoLoader.loadSync(protoPath, {
                keepCase: true,
                longs: Number,
                enums: String,
                defaults: true,
                oneofs: true,
            });
            const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
            const vectraService = protoDescriptor.vectra.VectraService;
            // Initialize index manager
            yield this._indexManager.initialize();
            // Create gRPC server
            this._server = new grpc.Server();
            // Register all handler groups
            const indexHandlers = (0, handlers_1.createIndexHandlers)(this._indexManager);
            const itemHandlers = (0, handlers_1.createItemHandlers)(this._indexManager, this._config.embeddings);
            const queryHandlers = (0, handlers_1.createQueryHandlers)(this._indexManager, this._config.embeddings);
            const documentHandlers = (0, handlers_1.createDocumentHandlers)(this._indexManager);
            const statsHandlers = (0, handlers_1.createStatsHandlers)(this._indexManager);
            const lifecycleHandlers = (0, handlers_1.createLifecycleHandlers)(this._indexManager, this._startTime, () => this.shutdown());
            this._server.addService(vectraService.service, Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, indexHandlers), itemHandlers), queryHandlers), documentHandlers), statsHandlers), lifecycleHandlers));
            // Bind to localhost only
            const port = (_a = this._config.port) !== null && _a !== void 0 ? _a : 50051;
            const boundPort = yield new Promise((resolve, reject) => {
                this._server.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(), (err, actualPort) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve(actualPort);
                    }
                });
            });
            return boundPort;
        });
    }
    /**
     * Gracefully shuts down the server with a 5s draining timeout.
     */
    shutdown() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._shutdownPromise)
                return this._shutdownPromise;
            this._shutdownPromise = (() => __awaiter(this, void 0, void 0, function* () {
                // Stop index manager scanning
                yield this._indexManager.shutdown();
                if (!this._server)
                    return;
                // Try graceful shutdown with timeout
                yield new Promise((resolve) => {
                    const timer = setTimeout(() => {
                        this._server.forceShutdown();
                        resolve();
                    }, DRAIN_TIMEOUT_MS);
                    this._server.tryShutdown((err) => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
                this._server = undefined;
            }))();
            return this._shutdownPromise;
        });
    }
}
exports.VectraServer = VectraServer;
//# sourceMappingURL=VectraServer.js.map