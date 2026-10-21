import * as grpc from '@grpc/grpc-js';
import { IndexManager } from '../IndexManager';
export declare function createLifecycleHandlers(manager: IndexManager, startTime: number, onShutdown: () => void): {
    Healthcheck: grpc.handleUnaryCall<any, {
        status: string;
        uptime_seconds: number;
        loaded_indexes: number;
    }>;
    Shutdown: grpc.handleUnaryCall<any, {}>;
};
//# sourceMappingURL=lifecycleHandlers.d.ts.map