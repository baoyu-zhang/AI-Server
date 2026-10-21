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
Object.defineProperty(exports, "__esModule", { value: true });
exports.fromProtoMetadata = fromProtoMetadata;
exports.toProtoMetadata = toProtoMetadata;
exports.parseFilterJson = parseFilterJson;
exports.grpcError = grpcError;
exports.wrapHandler = wrapHandler;
const grpc = __importStar(require("@grpc/grpc-js"));
/**
 * Converts proto MetadataValue map to a plain JS record.
 */
function fromProtoMetadata(protoMeta) {
    var _a, _b, _c;
    const result = {};
    if (!protoMeta)
        return result;
    for (const [key, val] of Object.entries(protoMeta)) {
        if (val && typeof val === 'object') {
            if ('string_value' in val || 'stringValue' in val) {
                result[key] = (_a = val.string_value) !== null && _a !== void 0 ? _a : val.stringValue;
            }
            else if ('number_value' in val || 'numberValue' in val) {
                result[key] = (_b = val.number_value) !== null && _b !== void 0 ? _b : val.numberValue;
            }
            else if ('bool_value' in val || 'boolValue' in val) {
                result[key] = (_c = val.bool_value) !== null && _c !== void 0 ? _c : val.boolValue;
            }
        }
    }
    return result;
}
/**
 * Converts a plain JS metadata record to proto MetadataValue map.
 */
function toProtoMetadata(meta) {
    const result = {};
    if (!meta)
        return result;
    for (const [key, val] of Object.entries(meta)) {
        if (typeof val === 'string') {
            result[key] = { string_value: val };
        }
        else if (typeof val === 'number') {
            result[key] = { number_value: val };
        }
        else if (typeof val === 'boolean') {
            result[key] = { bool_value: val };
        }
    }
    return result;
}
/**
 * Parses the filter_json field from a MetadataFilter proto message.
 */
function parseFilterJson(filter) {
    if (!filter || !filter.filter_json || filter.filter_json === '') {
        return undefined;
    }
    try {
        return JSON.parse(filter.filter_json);
    }
    catch (_a) {
        throw grpcError(grpc.status.INVALID_ARGUMENT, 'Invalid filter_json: must be valid JSON');
    }
}
/**
 * Creates a gRPC ServiceError with the given status code and message.
 */
function grpcError(code, message) {
    const err = new Error(message);
    err.code = code;
    err.details = message;
    err.metadata = new grpc.Metadata();
    return err;
}
/**
 * Wraps an async handler function with standard error mapping.
 */
function wrapHandler(handler) {
    return (call, callback) => {
        handler(call)
            .then(result => callback(null, result))
            .catch(err => {
            if (err && typeof err.code === 'number') {
                callback(err);
            }
            else {
                const message = (err === null || err === void 0 ? void 0 : err.message) || 'Internal server error';
                if (message.includes('not found') || message.includes('does not exist')) {
                    callback(grpcError(grpc.status.NOT_FOUND, message));
                }
                else if (message.includes('already exists')) {
                    callback(grpcError(grpc.status.ALREADY_EXISTS, message));
                }
                else if (message.includes('not a document index')) {
                    callback(grpcError(grpc.status.FAILED_PRECONDITION, message));
                }
                else {
                    callback(grpcError(grpc.status.INTERNAL, message));
                }
            }
        });
    };
}
//# sourceMappingURL=helpers.js.map