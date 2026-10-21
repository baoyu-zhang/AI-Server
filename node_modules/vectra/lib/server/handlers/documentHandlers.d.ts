import * as grpc from '@grpc/grpc-js';
import { IndexManager } from '../IndexManager';
export declare function createDocumentHandlers(manager: IndexManager): {
    UpsertDocument: grpc.handleUnaryCall<any, {
        document_id: string;
    }>;
    DeleteDocument: grpc.handleUnaryCall<any, {}>;
    ListDocuments: grpc.handleUnaryCall<any, {
        documents: {
            uri: string;
            document_id: string;
        }[];
    }>;
};
//# sourceMappingURL=documentHandlers.d.ts.map