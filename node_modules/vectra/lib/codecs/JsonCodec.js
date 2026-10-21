"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonCodec = void 0;
/**
 * JSON codec — default serialization format.
 * @remarks
 * Wraps the existing JSON.stringify/JSON.parse behavior. This preserves
 * full backward compatibility with indexes created before the codec
 * abstraction was introduced.
 */
class JsonCodec {
    constructor() {
        this.extension = '.json';
    }
    serializeIndex(data) {
        return Buffer.from(JSON.stringify(data), 'utf-8');
    }
    deserializeIndex(buffer) {
        return JSON.parse(buffer.toString('utf-8'));
    }
    serializeCatalog(catalog) {
        return Buffer.from(JSON.stringify(catalog), 'utf-8');
    }
    deserializeCatalog(buffer) {
        return JSON.parse(buffer.toString('utf-8'));
    }
    serializeMetadata(metadata) {
        return Buffer.from(JSON.stringify(metadata), 'utf-8');
    }
    deserializeMetadata(buffer) {
        return JSON.parse(buffer.toString('utf-8'));
    }
}
exports.JsonCodec = JsonCodec;
//# sourceMappingURL=JsonCodec.js.map