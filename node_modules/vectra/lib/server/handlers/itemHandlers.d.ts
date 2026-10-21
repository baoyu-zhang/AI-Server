import * as grpc from '@grpc/grpc-js';
import { IndexManager } from '../IndexManager';
import { EmbeddingsModel } from '../../types';
export declare function createItemHandlers(manager: IndexManager, embeddings?: EmbeddingsModel): {
    InsertItem: grpc.handleUnaryCall<any, {
        id: string;
    }>;
    UpsertItem: grpc.handleUnaryCall<any, {
        id: string;
    }>;
    BatchInsertItems: grpc.handleUnaryCall<any, {
        ids: string[];
    }>;
    GetItem: grpc.handleUnaryCall<any, {
        item: {
            id: string;
            metadata: Record<string, any>;
            vector: number[];
            norm: number;
            score: number;
        };
    }>;
    DeleteItem: grpc.handleUnaryCall<any, {}>;
    ListItems: grpc.handleUnaryCall<any, {
        items: {
            id: string;
            metadata: Record<string, any>;
            vector: number[];
            norm: number;
            score: number;
        }[];
    }>;
};
//# sourceMappingURL=itemHandlers.d.ts.map