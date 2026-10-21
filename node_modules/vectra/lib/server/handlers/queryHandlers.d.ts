import * as grpc from '@grpc/grpc-js';
import { IndexManager } from '../IndexManager';
import { EmbeddingsModel } from '../../types';
export declare function createQueryHandlers(manager: IndexManager, embeddings?: EmbeddingsModel): {
    QueryItems: grpc.handleUnaryCall<any, {
        results: {
            id: string;
            metadata: Record<string, any>;
            vector: number[];
            norm: number;
            score: number;
        }[];
    }>;
    QueryDocuments: grpc.handleUnaryCall<any, {
        results: {
            uri: string;
            document_id: string;
            chunks: {
                text: string;
                score: number;
                token_count: number;
            }[];
            score: number;
        }[];
    }>;
};
//# sourceMappingURL=queryHandlers.d.ts.map