import * as grpc from '@grpc/grpc-js';
import { IndexManager } from './IndexManager';
import { EmbeddingsModel } from '../types';
export interface VectraServerConfig {
    /** Port to bind the gRPC server on (default: 50051). */
    port?: number;
    /** Single index path (mutually exclusive with rootDir). */
    indexPath?: string;
    /** Root directory containing multiple index subdirectories. */
    rootDir?: string;
    /** Embeddings model for server-side embedding computation. */
    embeddings?: EmbeddingsModel;
    /** Polling interval in ms for auto-detecting new indexes (default: 3000). */
    scanInterval?: number;
}
/**
 * gRPC server that exposes Vectra indexes over the VectraService proto.
 */
export declare class VectraServer {
    private readonly _config;
    private readonly _indexManager;
    private _server?;
    private _startTime;
    private _shutdownPromise?;
    constructor(config: VectraServerConfig);
    /** The underlying IndexManager. */
    get indexManager(): IndexManager;
    /** The underlying gRPC server instance. */
    get server(): grpc.Server | undefined;
    /**
     * Starts the gRPC server and loads indexes.
     * @returns The port the server is listening on.
     */
    start(): Promise<number>;
    /**
     * Gracefully shuts down the server with a 5s draining timeout.
     */
    shutdown(): Promise<void>;
}
//# sourceMappingURL=VectraServer.d.ts.map