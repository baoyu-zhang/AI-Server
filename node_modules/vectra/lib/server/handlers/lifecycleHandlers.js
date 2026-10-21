"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLifecycleHandlers = createLifecycleHandlers;
const helpers_1 = require("./helpers");
function createLifecycleHandlers(manager, startTime, onShutdown) {
    return {
        Healthcheck: (0, helpers_1.wrapHandler)((_call) => __awaiter(this, void 0, void 0, function* () {
            const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
            return {
                status: 'ok',
                uptime_seconds: uptimeSeconds,
                loaded_indexes: manager.indexes.size,
            };
        })),
        Shutdown: (0, helpers_1.wrapHandler)((_call) => __awaiter(this, void 0, void 0, function* () {
            // Trigger graceful shutdown asynchronously
            process.nextTick(onShutdown);
            return {};
        })),
    };
}
//# sourceMappingURL=lifecycleHandlers.js.map