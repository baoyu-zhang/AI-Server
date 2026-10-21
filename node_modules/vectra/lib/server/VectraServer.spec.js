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
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const grpc = __importStar(require("@grpc/grpc-js"));
const protoLoader = __importStar(require("@grpc/proto-loader"));
const VectraServer_1 = require("./VectraServer");
const TEST_ROOT = path.join(__dirname, '..', '..', '.test-server-root');
const PROTO_PATH = path.join(__dirname, '..', '..', 'proto', 'vectra_service.proto');
function loadClient(port) {
    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
        keepCase: true,
        longs: Number,
        enums: String,
        defaults: true,
        oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(packageDefinition);
    return new proto.vectra.VectraService(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
}
function rpc(client, method, request) {
    return new Promise((resolve, reject) => {
        client[method](request, (err, response) => {
            if (err)
                reject(err);
            else
                resolve(response);
        });
    });
}
function cleanTestDir() {
    if (fs.existsSync(TEST_ROOT)) {
        fs.rmSync(TEST_ROOT, { recursive: true });
    }
    fs.mkdirSync(TEST_ROOT, { recursive: true });
}
describe('VectraServer', function () {
    this.timeout(30000);
    let server;
    let client;
    let port;
    before(() => __awaiter(this, void 0, void 0, function* () {
        cleanTestDir();
        server = new VectraServer_1.VectraServer({
            port: 0, // random available port
            rootDir: TEST_ROOT,
            scanInterval: 500,
        });
        port = yield server.start();
        client = loadClient(port);
    }));
    after(() => __awaiter(this, void 0, void 0, function* () {
        if (client) {
            client.close();
        }
        if (server) {
            yield server.shutdown();
        }
        if (fs.existsSync(TEST_ROOT)) {
            fs.rmSync(TEST_ROOT, { recursive: true });
        }
    }));
    describe('Lifecycle RPCs', () => {
        it('should respond to Healthcheck', () => __awaiter(this, void 0, void 0, function* () {
            const res = yield rpc(client, 'Healthcheck', {});
            assert.strictEqual(res.status, 'ok');
            assert.strictEqual(typeof res.uptime_seconds, 'number');
            assert.strictEqual(typeof res.loaded_indexes, 'number');
        }));
    });
    describe('Index Management RPCs', () => {
        it('should create an index', () => __awaiter(this, void 0, void 0, function* () {
            yield rpc(client, 'CreateIndex', {
                index_name: 'test-index',
                format: 'json',
                is_document_index: false,
            });
            const list = yield rpc(client, 'ListIndexes', {});
            const names = list.indexes.map((i) => i.name);
            assert.ok(names.includes('test-index'), `Expected test-index in ${JSON.stringify(names)}`);
        }));
        it('should fail to create a duplicate index', () => __awaiter(this, void 0, void 0, function* () {
            try {
                yield rpc(client, 'CreateIndex', {
                    index_name: 'test-index',
                    format: 'json',
                    is_document_index: false,
                });
                assert.fail('Expected ALREADY_EXISTS error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.ALREADY_EXISTS);
            }
        }));
        it('should list indexes', () => __awaiter(this, void 0, void 0, function* () {
            const res = yield rpc(client, 'ListIndexes', {});
            assert.ok(Array.isArray(res.indexes));
            assert.ok(res.indexes.length >= 1);
        }));
    });
    describe('Item Operations RPCs', () => {
        const testVector = new Array(3).fill(0).map((_, i) => (i + 1) * 0.1);
        it('should insert an item', () => __awaiter(this, void 0, void 0, function* () {
            const res = yield rpc(client, 'InsertItem', {
                index_name: 'test-index',
                vector: testVector,
                metadata: {
                    category: { string_value: 'test' },
                    score: { number_value: 0.95 },
                },
                id: 'item-1',
            });
            assert.strictEqual(res.id, 'item-1');
        }));
        it('should get an item by id', () => __awaiter(this, void 0, void 0, function* () {
            const res = yield rpc(client, 'GetItem', {
                index_name: 'test-index',
                id: 'item-1',
            });
            assert.ok(res.item);
            assert.strictEqual(res.item.id, 'item-1');
            assert.ok(res.item.vector.length > 0);
        }));
        it('should return NOT_FOUND for missing item', () => __awaiter(this, void 0, void 0, function* () {
            try {
                yield rpc(client, 'GetItem', {
                    index_name: 'test-index',
                    id: 'nonexistent',
                });
                assert.fail('Expected NOT_FOUND error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.NOT_FOUND);
            }
        }));
        it('should upsert an item', () => __awaiter(this, void 0, void 0, function* () {
            const newVector = new Array(3).fill(0).map((_, i) => (i + 1) * 0.2);
            const res = yield rpc(client, 'UpsertItem', {
                index_name: 'test-index',
                id: 'item-1',
                vector: newVector,
                metadata: {
                    category: { string_value: 'updated' },
                },
            });
            assert.strictEqual(res.id, 'item-1');
            // Verify update
            const getRes = yield rpc(client, 'GetItem', {
                index_name: 'test-index',
                id: 'item-1',
            });
            assert.strictEqual(getRes.item.metadata.category.string_value, 'updated');
        }));
        it('should batch insert items', () => __awaiter(this, void 0, void 0, function* () {
            const res = yield rpc(client, 'BatchInsertItems', {
                index_name: 'test-index',
                items: [
                    { vector: [0.1, 0.2, 0.3], metadata: { tag: { string_value: 'a' } }, id: 'batch-1' },
                    { vector: [0.4, 0.5, 0.6], metadata: { tag: { string_value: 'b' } }, id: 'batch-2' },
                ],
            });
            assert.strictEqual(res.ids.length, 2);
            assert.ok(res.ids.includes('batch-1'));
            assert.ok(res.ids.includes('batch-2'));
        }));
        it('should list items', () => __awaiter(this, void 0, void 0, function* () {
            const res = yield rpc(client, 'ListItems', {
                index_name: 'test-index',
            });
            assert.ok(res.items.length >= 3); // item-1, batch-1, batch-2
        }));
        it('should delete an item', () => __awaiter(this, void 0, void 0, function* () {
            yield rpc(client, 'DeleteItem', {
                index_name: 'test-index',
                id: 'batch-2',
            });
            // Verify it's gone
            try {
                yield rpc(client, 'GetItem', {
                    index_name: 'test-index',
                    id: 'batch-2',
                });
                assert.fail('Expected NOT_FOUND');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.NOT_FOUND);
            }
        }));
    });
    describe('Query RPCs', () => {
        it('should query items by vector', () => __awaiter(this, void 0, void 0, function* () {
            const res = yield rpc(client, 'QueryItems', {
                index_name: 'test-index',
                vector: [0.1, 0.2, 0.3],
                top_k: 5,
            });
            assert.ok(Array.isArray(res.results));
            assert.ok(res.results.length > 0);
            // Results should have scores
            assert.ok(typeof res.results[0].score === 'number');
        }));
    });
    describe('Stats RPCs', () => {
        it('should get index stats', () => __awaiter(this, void 0, void 0, function* () {
            const res = yield rpc(client, 'GetIndexStats', {
                index_name: 'test-index',
            });
            assert.strictEqual(res.version, 1);
            assert.strictEqual(res.format, 'json');
            assert.ok(typeof res.item_count === 'number');
        }));
    });
    describe('Error handling', () => {
        it('should return NOT_FOUND for unknown index', () => __awaiter(this, void 0, void 0, function* () {
            try {
                yield rpc(client, 'GetIndexStats', {
                    index_name: 'no-such-index',
                });
                assert.fail('Expected NOT_FOUND');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.NOT_FOUND);
            }
        }));
        it('should return INVALID_ARGUMENT for missing required fields', () => __awaiter(this, void 0, void 0, function* () {
            try {
                yield rpc(client, 'InsertItem', {
                    index_name: 'test-index',
                    // no text or vector
                });
                assert.fail('Expected INVALID_ARGUMENT');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
            }
        }));
        it('should return FAILED_PRECONDITION for non-document index on document ops', () => __awaiter(this, void 0, void 0, function* () {
            try {
                yield rpc(client, 'ListDocuments', {
                    index_name: 'test-index',
                });
                assert.fail('Expected FAILED_PRECONDITION');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.FAILED_PRECONDITION);
            }
        }));
    });
    describe('Index deletion', () => {
        it('should delete an index', () => __awaiter(this, void 0, void 0, function* () {
            yield rpc(client, 'DeleteIndex', {
                index_name: 'test-index',
            });
            const list = yield rpc(client, 'ListIndexes', {});
            const names = list.indexes.map((i) => i.name);
            assert.ok(!names.includes('test-index'));
        }));
    });
    describe('Auto-detect new indexes', () => {
        it('should detect indexes created on disk', function () {
            return __awaiter(this, void 0, void 0, function* () {
                // Create an index directly on disk (outside the gRPC API)
                const indexDir = path.join(TEST_ROOT, 'auto-detected');
                fs.mkdirSync(indexDir, { recursive: true });
                fs.writeFileSync(path.join(indexDir, 'index.json'), JSON.stringify({
                    version: 1,
                    metadata_config: {},
                    items: [],
                }));
                // Wait for the scanner to pick it up
                yield new Promise(r => setTimeout(r, 1500));
                const list = yield rpc(client, 'ListIndexes', {});
                const names = list.indexes.map((i) => i.name);
                assert.ok(names.includes('auto-detected'), `Expected auto-detected in ${JSON.stringify(names)}`);
            });
        });
    });
    describe('Server accessors', () => {
        it('exposes the underlying gRPC server and IndexManager via getters', () => {
            assert.ok(server.server, 'server getter should return the gRPC server');
            assert.ok(server.indexManager, 'indexManager getter should return the manager');
        });
    });
    describe('Handler argument validation', () => {
        it('CreateIndex returns INVALID_ARGUMENT when index_name is missing', () => __awaiter(this, void 0, void 0, function* () {
            try {
                yield rpc(client, 'CreateIndex', { format: 'json', is_document_index: false });
                assert.fail('Expected INVALID_ARGUMENT');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
            }
        }));
        it('DeleteIndex returns INVALID_ARGUMENT when index_name is missing', () => __awaiter(this, void 0, void 0, function* () {
            try {
                yield rpc(client, 'DeleteIndex', {});
                assert.fail('Expected INVALID_ARGUMENT');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
            }
        }));
    });
    describe('Shutdown RPC', () => {
        // Placed last because it triggers server shutdown asynchronously; the
        // top-level after() hook just awaits the same shutdown promise.
        it('Shutdown RPC schedules graceful server shutdown', () => __awaiter(this, void 0, void 0, function* () {
            const res = yield rpc(client, 'Shutdown', {});
            assert.deepEqual(res, {});
            // Give nextTick a chance to fire the onShutdown callback.
            yield new Promise(r => setTimeout(r, 50));
        }));
    });
});
describe('VectraServer (isolated lifecycle)', function () {
    this.timeout(10000);
    it('shutdown() is idempotent — concurrent calls share a single shutdown', () => __awaiter(this, void 0, void 0, function* () {
        const dir = path.join(__dirname, '..', '..', '.test-server-idem');
        if (fs.existsSync(dir))
            fs.rmSync(dir, { recursive: true });
        fs.mkdirSync(dir, { recursive: true });
        try {
            const s = new VectraServer_1.VectraServer({ port: 0, rootDir: dir, scanInterval: 1000 });
            yield s.start();
            const mgr = s.indexManager;
            let mgrShutdownCalls = 0;
            const realShutdown = mgr.shutdown.bind(mgr);
            mgr.shutdown = () => __awaiter(this, void 0, void 0, function* () { mgrShutdownCalls++; yield realShutdown(); });
            yield Promise.all([s.shutdown(), s.shutdown(), s.shutdown()]);
            assert.equal(mgrShutdownCalls, 1, 'indexManager.shutdown should fire exactly once');
            assert.equal(s.server, undefined, 'server should be cleared after shutdown');
        }
        finally {
            if (fs.existsSync(dir))
                fs.rmSync(dir, { recursive: true });
        }
    }));
    it('shutdown() is a no-op when start() was never called', () => __awaiter(this, void 0, void 0, function* () {
        const dir = path.join(__dirname, '..', '..', '.test-server-nostart');
        if (fs.existsSync(dir))
            fs.rmSync(dir, { recursive: true });
        fs.mkdirSync(dir, { recursive: true });
        try {
            const s = new VectraServer_1.VectraServer({ port: 0, rootDir: dir });
            yield s.shutdown(); // should not throw
            assert.equal(s.server, undefined);
        }
        finally {
            if (fs.existsSync(dir))
                fs.rmSync(dir, { recursive: true });
        }
    }));
    it('start() rejects when binding an already-bound port', () => __awaiter(this, void 0, void 0, function* () {
        const dirA = path.join(__dirname, '..', '..', '.test-server-bindA');
        const dirB = path.join(__dirname, '..', '..', '.test-server-bindB');
        for (const d of [dirA, dirB]) {
            if (fs.existsSync(d))
                fs.rmSync(d, { recursive: true });
            fs.mkdirSync(d, { recursive: true });
        }
        const a = new VectraServer_1.VectraServer({ port: 0, rootDir: dirA });
        const portA = yield a.start();
        const b = new VectraServer_1.VectraServer({ port: portA, rootDir: dirB });
        try {
            yield assert.rejects(b.start());
        }
        finally {
            yield a.shutdown();
            yield b.shutdown().catch(() => { });
            for (const d of [dirA, dirB]) {
                if (fs.existsSync(d))
                    fs.rmSync(d, { recursive: true });
            }
        }
    }));
});
//# sourceMappingURL=VectraServer.spec.js.map