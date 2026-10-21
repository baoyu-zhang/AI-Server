import { FileStorage } from '../storage';
import { IndexCodec } from './IndexCodec';
export type FormatName = 'json' | 'protobuf';
/**
 * Detects the codec in use for an existing index folder.
 * @remarks
 * Checks for `index.json` and `index.pb` files. If both exist, throws an
 * error directing the user to re-run migration. If neither exists, throws.
 * @param folderPath Path to the index folder.
 * @param storage Storage backend to use.
 * @returns The detected codec.
 */
export declare function detectCodec(folderPath: string, storage: FileStorage): Promise<IndexCodec>;
export interface MigrateOptions {
    to: FormatName;
    storage?: FileStorage;
}
/**
 * Migrates an index folder from one serialization format to another.
 * @param folderPath Path to the index folder.
 * @param options Migration options.
 */
export declare function migrateIndex(folderPath: string, options: MigrateOptions): Promise<void>;
//# sourceMappingURL=migrateIndex.d.ts.map