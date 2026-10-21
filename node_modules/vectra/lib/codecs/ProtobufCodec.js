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
exports.ProtobufCodec = void 0;
const path = __importStar(require("path"));
let protobuf;
function loadProtobuf() {
    if (!protobuf) {
        try {
            protobuf = require('protobufjs');
        }
        catch (_a) {
            throw new Error("ProtobufCodec requires the 'protobufjs' package. Install it with: npm install protobufjs");
        }
    }
    return protobuf;
}
// Cached proto root — loaded once per process
let cachedRoot;
function getRoot() {
    if (!cachedRoot) {
        const pb = loadProtobuf();
        cachedRoot = pb.loadSync(path.join(__dirname, 'schemas', 'index.proto'));
    }
    return cachedRoot;
}
/** Convert MetadataTypes value to protobuf MetadataValue shape */
function toProtoMetadataValue(value) {
    if (typeof value === 'string')
        return { stringValue: value };
    if (typeof value === 'number')
        return { numberValue: value };
    if (typeof value === 'boolean')
        return { boolValue: value };
    return { stringValue: String(value) };
}
/** Convert protobuf MetadataValue back to MetadataTypes */
function fromProtoMetadataValue(mv) {
    if (mv.stringValue !== undefined && mv.stringValue !== '')
        return mv.stringValue;
    if (mv.numberValue !== undefined && mv.numberValue !== 0)
        return mv.numberValue;
    if (mv.boolValue !== undefined && mv.boolValue !== false)
        return mv.boolValue;
    // Disambiguate zero-value fields by checking which oneof field is set
    if (mv.value === 'boolValue')
        return false;
    if (mv.value === 'numberValue')
        return 0;
    if (mv.value === 'stringValue')
        return '';
    // Fallback — proto3 defaults make this tricky; prefer string empty
    return '';
}
/** Convert JS IndexItem to proto-friendly shape */
function toProtoItem(item) {
    const metadata = {};
    if (item.metadata) {
        for (const [k, v] of Object.entries(item.metadata)) {
            metadata[k] = toProtoMetadataValue(v);
        }
    }
    const out = {
        id: item.id,
        metadata,
        vector: item.vector,
        norm: item.norm,
    };
    if (item.metadataFile) {
        out.metadataFile = item.metadataFile;
    }
    return out;
}
/** Convert proto IndexItem back to JS IndexItem */
function fromProtoItem(pi) {
    const metadata = {};
    if (pi.metadata) {
        for (const [k, v] of Object.entries(pi.metadata)) {
            metadata[k] = fromProtoMetadataValue(v);
        }
    }
    // proto packed float → JS number[]; ensure plain array
    const vector = pi.vector ? Array.from(pi.vector) : [];
    const item = {
        id: pi.id,
        metadata,
        vector,
        norm: pi.norm,
    };
    if (pi.metadataFile) {
        item.metadataFile = pi.metadataFile;
    }
    return item;
}
/**
 * Protocol Buffers codec — opt-in binary format.
 * @remarks
 * Vectors are stored as packed float32 arrays (~50% smaller than JSON).
 * Norms are stored as float64 to avoid compounding rounding error.
 * Requires the `protobufjs` package to be installed.
 */
class ProtobufCodec {
    constructor() {
        this.extension = '.pb';
        // Eagerly validate that protobufjs is available
        loadProtobuf();
    }
    serializeIndex(data) {
        var _a, _b;
        const root = getRoot();
        const IndexDataMsg = root.lookupType('IndexData');
        const payload = {
            version: data.version,
            metadataConfig: {
                indexed: (_b = (_a = data.metadata_config) === null || _a === void 0 ? void 0 : _a.indexed) !== null && _b !== void 0 ? _b : [],
            },
            items: data.items.map(toProtoItem),
        };
        const err = IndexDataMsg.verify(payload);
        if (err)
            throw new Error(`Protobuf verify error: ${err}`);
        const message = IndexDataMsg.create(payload);
        return Buffer.from(IndexDataMsg.encode(message).finish());
    }
    deserializeIndex(buffer) {
        var _a, _b;
        const root = getRoot();
        const IndexDataMsg = root.lookupType('IndexData');
        const decoded = IndexDataMsg.decode(new Uint8Array(buffer));
        const obj = IndexDataMsg.toObject(decoded, {
            longs: Number,
            enums: String,
            defaults: true,
            oneofs: true,
        });
        return {
            version: obj.version,
            metadata_config: {
                indexed: (_b = (_a = obj.metadataConfig) === null || _a === void 0 ? void 0 : _a.indexed) !== null && _b !== void 0 ? _b : [],
            },
            items: (obj.items || []).map(fromProtoItem),
        };
    }
    serializeCatalog(catalog) {
        const root = getRoot();
        const CatalogMsg = root.lookupType('DocumentCatalog');
        const payload = {
            version: catalog.version,
            count: catalog.count,
            uriToId: catalog.uriToId,
            idToUri: catalog.idToUri,
        };
        if (catalog.uriToHash) {
            payload.uriToHash = catalog.uriToHash;
        }
        const err = CatalogMsg.verify(payload);
        if (err)
            throw new Error(`Protobuf verify error: ${err}`);
        const message = CatalogMsg.create(payload);
        return Buffer.from(CatalogMsg.encode(message).finish());
    }
    deserializeCatalog(buffer) {
        const root = getRoot();
        const CatalogMsg = root.lookupType('DocumentCatalog');
        const decoded = CatalogMsg.decode(new Uint8Array(buffer));
        const obj = CatalogMsg.toObject(decoded, {
            longs: Number,
            enums: String,
            defaults: true,
            oneofs: true,
        });
        const catalog = {
            version: obj.version,
            count: obj.count,
            uriToId: obj.uriToId || {},
            idToUri: obj.idToUri || {},
        };
        if (obj.uriToHash && Object.keys(obj.uriToHash).length > 0) {
            catalog.uriToHash = obj.uriToHash;
        }
        return catalog;
    }
    serializeMetadata(metadata) {
        // Metadata is a flat key-value map. We encode it as a JSON buffer
        // wrapped in a simple length-prefixed envelope to stay self-describing
        // while keeping the main index binary.
        //
        // We reuse the IndexItem metadata map encoding for consistency:
        // encode as { entries: map<string, MetadataValue> }.
        // However, since there's no standalone proto message for this,
        // we just use JSON for external metadata files — the size savings
        // from protobuf on small metadata objects are negligible.
        return Buffer.from(JSON.stringify(metadata), 'utf-8');
    }
    deserializeMetadata(buffer) {
        return JSON.parse(buffer.toString('utf-8'));
    }
}
exports.ProtobufCodec = ProtobufCodec;
//# sourceMappingURL=ProtobufCodec.js.map