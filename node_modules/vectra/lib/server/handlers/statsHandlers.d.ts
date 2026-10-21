import * as grpc from '@grpc/grpc-js';
import { IndexManager } from '../IndexManager';
export declare function createStatsHandlers(manager: IndexManager): {
    GetIndexStats: grpc.handleUnaryCall<any, {
        version: number;
        format: string;
        item_count: number;
        metadata_config_count: number;
    }>;
    GetCatalogStats: grpc.handleUnaryCall<any, {
        version: number;
        document_count: number;
        chunk_count: number;
        metadata_counts: {};
    }>;
};
//# sourceMappingURL=statsHandlers.d.ts.map