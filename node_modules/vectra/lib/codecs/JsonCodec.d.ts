import { IndexData, MetadataTypes } from '../types';
import { DocumentCatalog, IndexCodec } from './IndexCodec';
/**
 * JSON codec — default serialization format.
 * @remarks
 * Wraps the existing JSON.stringify/JSON.parse behavior. This preserves
 * full backward compatibility with indexes created before the codec
 * abstraction was introduced.
 */
export declare class JsonCodec implements IndexCodec {
    readonly extension = ".json";
    serializeIndex(data: IndexData): Buffer;
    deserializeIndex(buffer: Buffer): IndexData;
    serializeCatalog(catalog: DocumentCatalog): Buffer;
    deserializeCatalog(buffer: Buffer): DocumentCatalog;
    serializeMetadata(metadata: Record<string, MetadataTypes>): Buffer;
    deserializeMetadata(buffer: Buffer): Record<string, MetadataTypes>;
}
//# sourceMappingURL=JsonCodec.d.ts.map