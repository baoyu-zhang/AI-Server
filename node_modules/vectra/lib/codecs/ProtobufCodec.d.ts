import { IndexData, MetadataTypes } from '../types';
import { DocumentCatalog, IndexCodec } from './IndexCodec';
/**
 * Protocol Buffers codec — opt-in binary format.
 * @remarks
 * Vectors are stored as packed float32 arrays (~50% smaller than JSON).
 * Norms are stored as float64 to avoid compounding rounding error.
 * Requires the `protobufjs` package to be installed.
 */
export declare class ProtobufCodec implements IndexCodec {
    readonly extension = ".pb";
    constructor();
    serializeIndex(data: IndexData): Buffer;
    deserializeIndex(buffer: Buffer): IndexData;
    serializeCatalog(catalog: DocumentCatalog): Buffer;
    deserializeCatalog(buffer: Buffer): DocumentCatalog;
    serializeMetadata(metadata: Record<string, MetadataTypes>): Buffer;
    deserializeMetadata(buffer: Buffer): Record<string, MetadataTypes>;
}
//# sourceMappingURL=ProtobufCodec.d.ts.map