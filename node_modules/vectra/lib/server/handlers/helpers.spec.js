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
const grpc = __importStar(require("@grpc/grpc-js"));
const helpers_1 = require("./helpers");
describe('helpers', () => {
    describe('fromProtoMetadata', () => {
        it('should return empty object for undefined input', () => {
            const result = (0, helpers_1.fromProtoMetadata)(undefined);
            assert.deepStrictEqual(result, {});
        });
        it('should convert string_value fields', () => {
            const result = (0, helpers_1.fromProtoMetadata)({ name: { string_value: 'hello' } });
            assert.deepStrictEqual(result, { name: 'hello' });
        });
        it('should convert stringValue fields (camelCase)', () => {
            const result = (0, helpers_1.fromProtoMetadata)({ name: { stringValue: 'hello' } });
            assert.deepStrictEqual(result, { name: 'hello' });
        });
        it('should convert number_value fields', () => {
            const result = (0, helpers_1.fromProtoMetadata)({ score: { number_value: 0.95 } });
            assert.deepStrictEqual(result, { score: 0.95 });
        });
        it('should convert numberValue fields (camelCase)', () => {
            const result = (0, helpers_1.fromProtoMetadata)({ score: { numberValue: 0.95 } });
            assert.deepStrictEqual(result, { score: 0.95 });
        });
        it('should convert bool_value fields', () => {
            const result = (0, helpers_1.fromProtoMetadata)({ active: { bool_value: true } });
            assert.deepStrictEqual(result, { active: true });
        });
        it('should convert boolValue fields (camelCase)', () => {
            const result = (0, helpers_1.fromProtoMetadata)({ active: { boolValue: false } });
            assert.deepStrictEqual(result, { active: false });
        });
        it('should handle mixed types', () => {
            const result = (0, helpers_1.fromProtoMetadata)({
                name: { string_value: 'test' },
                count: { number_value: 42 },
                flag: { bool_value: true },
            });
            assert.deepStrictEqual(result, { name: 'test', count: 42, flag: true });
        });
        it('should skip non-object values', () => {
            const result = (0, helpers_1.fromProtoMetadata)({ bad: null });
            assert.deepStrictEqual(result, {});
        });
        it('should skip objects without recognized value keys', () => {
            const result = (0, helpers_1.fromProtoMetadata)({ weird: { unknown_key: 'x' } });
            assert.deepStrictEqual(result, {});
        });
    });
    describe('toProtoMetadata', () => {
        it('should return empty object for undefined input', () => {
            const result = (0, helpers_1.toProtoMetadata)(undefined);
            assert.deepStrictEqual(result, {});
        });
        it('should convert string values', () => {
            const result = (0, helpers_1.toProtoMetadata)({ name: 'hello' });
            assert.deepStrictEqual(result, { name: { string_value: 'hello' } });
        });
        it('should convert number values', () => {
            const result = (0, helpers_1.toProtoMetadata)({ score: 0.95 });
            assert.deepStrictEqual(result, { score: { number_value: 0.95 } });
        });
        it('should convert boolean values', () => {
            const result = (0, helpers_1.toProtoMetadata)({ active: true });
            assert.deepStrictEqual(result, { active: { bool_value: true } });
        });
        it('should handle mixed types', () => {
            const result = (0, helpers_1.toProtoMetadata)({ name: 'test', count: 42, flag: false });
            assert.deepStrictEqual(result, {
                name: { string_value: 'test' },
                count: { number_value: 42 },
                flag: { bool_value: false },
            });
        });
    });
    describe('parseFilterJson', () => {
        it('should return undefined for undefined input', () => {
            assert.strictEqual((0, helpers_1.parseFilterJson)(undefined), undefined);
        });
        it('should return undefined for null input', () => {
            assert.strictEqual((0, helpers_1.parseFilterJson)(null), undefined);
        });
        it('should return undefined for empty filter_json', () => {
            assert.strictEqual((0, helpers_1.parseFilterJson)({ filter_json: '' }), undefined);
        });
        it('should parse valid JSON filter', () => {
            const result = (0, helpers_1.parseFilterJson)({ filter_json: '{"category":"test"}' });
            assert.deepStrictEqual(result, { category: 'test' });
        });
        it('should parse complex filter', () => {
            const result = (0, helpers_1.parseFilterJson)({ filter_json: '{"$and":[{"score":{"$gte":0.5}},{"tag":"a"}]}' });
            assert.deepStrictEqual(result, { $and: [{ score: { $gte: 0.5 } }, { tag: 'a' }] });
        });
        it('should throw INVALID_ARGUMENT for invalid JSON', () => {
            try {
                (0, helpers_1.parseFilterJson)({ filter_json: '{bad json' });
                assert.fail('Expected error');
            }
            catch (err) {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
                assert.ok(err.message.includes('Invalid filter_json'));
            }
        });
    });
    describe('grpcError', () => {
        it('should create a ServiceError with code and message', () => {
            const err = (0, helpers_1.grpcError)(grpc.status.NOT_FOUND, 'Item not found');
            assert.strictEqual(err.code, grpc.status.NOT_FOUND);
            assert.strictEqual(err.message, 'Item not found');
            assert.strictEqual(err.details, 'Item not found');
            assert.ok(err.metadata instanceof grpc.Metadata);
        });
    });
    describe('wrapHandler', () => {
        function makeCall(request) {
            return { request };
        }
        it('should call callback with result on success', (done) => {
            const handler = (0, helpers_1.wrapHandler)((call) => __awaiter(void 0, void 0, void 0, function* () {
                return { value: call.request.input };
            }));
            handler(makeCall({ input: 42 }), (err, result) => {
                assert.strictEqual(err, null);
                assert.deepStrictEqual(result, { value: 42 });
                done();
            });
        });
        it('should pass through gRPC errors with code', (done) => {
            const handler = (0, helpers_1.wrapHandler)(() => __awaiter(void 0, void 0, void 0, function* () {
                throw (0, helpers_1.grpcError)(grpc.status.INVALID_ARGUMENT, 'bad input');
            }));
            handler(makeCall({}), (err) => {
                assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
                assert.strictEqual(err.message, 'bad input');
                done();
            });
        });
        it('should map "not found" errors to NOT_FOUND', (done) => {
            const handler = (0, helpers_1.wrapHandler)(() => __awaiter(void 0, void 0, void 0, function* () {
                throw new Error('Index not found: test');
            }));
            handler(makeCall({}), (err) => {
                assert.strictEqual(err.code, grpc.status.NOT_FOUND);
                done();
            });
        });
        it('should map "does not exist" errors to NOT_FOUND', (done) => {
            const handler = (0, helpers_1.wrapHandler)(() => __awaiter(void 0, void 0, void 0, function* () {
                throw new Error('File does not exist');
            }));
            handler(makeCall({}), (err) => {
                assert.strictEqual(err.code, grpc.status.NOT_FOUND);
                done();
            });
        });
        it('should map "already exists" errors to ALREADY_EXISTS', (done) => {
            const handler = (0, helpers_1.wrapHandler)(() => __awaiter(void 0, void 0, void 0, function* () {
                throw new Error('Index already exists: test');
            }));
            handler(makeCall({}), (err) => {
                assert.strictEqual(err.code, grpc.status.ALREADY_EXISTS);
                done();
            });
        });
        it('should map "not a document index" errors to FAILED_PRECONDITION', (done) => {
            const handler = (0, helpers_1.wrapHandler)(() => __awaiter(void 0, void 0, void 0, function* () {
                throw new Error('Index "test" is not a document index');
            }));
            handler(makeCall({}), (err) => {
                assert.strictEqual(err.code, grpc.status.FAILED_PRECONDITION);
                done();
            });
        });
        it('should map unknown errors to INTERNAL', (done) => {
            const handler = (0, helpers_1.wrapHandler)(() => __awaiter(void 0, void 0, void 0, function* () {
                throw new Error('something broke');
            }));
            handler(makeCall({}), (err) => {
                assert.strictEqual(err.code, grpc.status.INTERNAL);
                assert.ok(err.message.includes('something broke'));
                done();
            });
        });
        it('should handle errors with no message', (done) => {
            const handler = (0, helpers_1.wrapHandler)(() => __awaiter(void 0, void 0, void 0, function* () {
                throw {};
            }));
            handler(makeCall({}), (err) => {
                assert.strictEqual(err.code, grpc.status.INTERNAL);
                assert.ok(err.message.includes('Internal server error'));
                done();
            });
        });
    });
});
//# sourceMappingURL=helpers.spec.js.map