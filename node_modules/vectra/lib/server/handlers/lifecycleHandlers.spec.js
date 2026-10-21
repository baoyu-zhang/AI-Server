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
const lifecycleHandlers_1 = require("./lifecycleHandlers");
const IndexManager_1 = require("../IndexManager");
function callHandler(handler, request) {
    return new Promise((resolve, reject) => {
        handler({ request }, (err, result) => {
            if (err)
                reject(err);
            else
                resolve(result);
        });
    });
}
describe('lifecycleHandlers', () => {
    let manager;
    beforeEach(() => {
        manager = sinon.createStubInstance(IndexManager_1.IndexManager);
        // Stub the indexes property
        sinon.stub(manager, 'indexes').get(() => new Map([['a', {}], ['b', {}]]));
    });
    afterEach(() => {
        sinon.restore();
    });
    describe('Healthcheck', () => {
        it('should return status ok with uptime and loaded indexes', () => __awaiter(void 0, void 0, void 0, function* () {
            const startTime = Date.now() - 5000; // started 5 seconds ago
            const handlers = (0, lifecycleHandlers_1.createLifecycleHandlers)(manager, startTime, () => { });
            const result = yield callHandler(handlers.Healthcheck, {});
            assert.strictEqual(result.status, 'ok');
            assert.ok(result.uptime_seconds >= 5);
            assert.strictEqual(result.loaded_indexes, 2);
        }));
        it('should report 0 uptime when just started', () => __awaiter(void 0, void 0, void 0, function* () {
            const startTime = Date.now();
            const handlers = (0, lifecycleHandlers_1.createLifecycleHandlers)(manager, startTime, () => { });
            const result = yield callHandler(handlers.Healthcheck, {});
            assert.strictEqual(result.uptime_seconds, 0);
        }));
    });
    describe('Shutdown', () => {
        it('should call onShutdown callback', () => __awaiter(void 0, void 0, void 0, function* () {
            const onShutdown = sinon.stub();
            const handlers = (0, lifecycleHandlers_1.createLifecycleHandlers)(manager, Date.now(), onShutdown);
            const result = yield callHandler(handlers.Shutdown, {});
            assert.deepStrictEqual(result, {});
            // onShutdown is called via process.nextTick, so wait a tick
            yield new Promise(resolve => process.nextTick(resolve));
            assert.ok(onShutdown.calledOnce);
        }));
    });
});
//# sourceMappingURL=lifecycleHandlers.spec.js.map