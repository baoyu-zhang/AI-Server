import * as grpc from '@grpc/grpc-js';
import { MetadataTypes } from '../../types';
/**
 * Converts proto MetadataValue map to a plain JS record.
 */
export declare function fromProtoMetadata(protoMeta: Record<string, any> | undefined): Record<string, MetadataTypes>;
/**
 * Converts a plain JS metadata record to proto MetadataValue map.
 */
export declare function toProtoMetadata(meta: Record<string, MetadataTypes> | undefined): Record<string, any>;
/**
 * Parses the filter_json field from a MetadataFilter proto message.
 */
export declare function parseFilterJson(filter: any): Record<string, any> | undefined;
/**
 * Creates a gRPC ServiceError with the given status code and message.
 */
export declare function grpcError(code: grpc.status, message: string): grpc.ServiceError;
/**
 * Wraps an async handler function with standard error mapping.
 */
export declare function wrapHandler<TReq, TRes>(handler: (call: grpc.ServerUnaryCall<TReq, TRes>) => Promise<TRes>): grpc.handleUnaryCall<TReq, TRes>;
//# sourceMappingURL=helpers.d.ts.map