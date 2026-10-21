import * as grpc from '@grpc/grpc-js';
import { IndexManager } from '../IndexManager';
export declare function createIndexHandlers(manager: IndexManager): {
    CreateIndex: grpc.handleUnaryCall<any, {}>;
    DeleteIndex: grpc.handleUnaryCall<any, {}>;
    ListIndexes: grpc.handleUnaryCall<any, {
        indexes: {
            name: string;
            format: string;
            is_document_index: boolean;
        }[];
    }>;
};
//# sourceMappingURL=indexHandlers.d.ts.map