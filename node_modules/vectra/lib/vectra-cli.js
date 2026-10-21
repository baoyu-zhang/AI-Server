"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = run;
const fs = __importStar(require("fs/promises"));
const fsSync = __importStar(require("fs"));
const path = __importStar(require("path"));
const yargs_1 = __importDefault(require("yargs/yargs"));
const helpers_1 = require("yargs/helpers");
const LocalDocumentIndex_1 = require("./LocalDocumentIndex");
const WebFetcher_1 = require("./WebFetcher");
const OpenAIEmbeddings_1 = require("./OpenAIEmbeddings");
const internals_1 = require("./internals");
const FileFetcher_1 = require("./FileFetcher");
const LocalFileStorage_1 = require("./storage/LocalFileStorage");
const VirtualFileStorage_1 = require("./storage/VirtualFileStorage");
const codecs_1 = require("./codecs");
const VectraServer_1 = require("./server/VectraServer");
const FolderWatcher_1 = require("./FolderWatcher");
function getStorage(args) {
    if (args.storage === 'virtual') {
        return new VirtualFileStorage_1.VirtualFileStorage();
    }
    else {
        return new LocalFileStorage_1.LocalFileStorage(args.storageRoot);
    }
}
function getCodecFromFormat(format) {
    if (format === 'protobuf')
        return new codecs_1.ProtobufCodec();
    if (format === 'json')
        return new codecs_1.JsonCodec();
    return undefined; // default
}
function run() {
    return __awaiter(this, void 0, void 0, function* () {
        // prettier-ignore
        const args = yield (0, yargs_1.default)((0, helpers_1.hideBin)(process.argv))
            .scriptName('vectra')
            .option('storage', {
            describe: 'storage backend to use',
            choices: ['local', 'virtual'],
            default: 'local'
        })
            .option('storage-root', {
            describe: 'root folder for local storage (only applies if storage=local)',
            type: 'string'
        })
            .command('create <index>', `create a new local index`, (yargs) => {
            return yargs.option('format', {
                describe: 'serialization format for the index',
                choices: ['json', 'protobuf'],
                default: 'json'
            });
        }, (args) => __awaiter(this, void 0, void 0, function* () {
            const folderPath = args.index;
            const storage = getStorage(args);
            const codec = getCodecFromFormat(args.format);
            const index = new LocalDocumentIndex_1.LocalDocumentIndex({ folderPath, storage, codec });
            const formatLabel = args.format === 'protobuf' ? 'protobuf' : 'json';
            console.log(internals_1.Colorize.output(`creating ${formatLabel} index at ${folderPath}`));
            yield index.createIndex({ version: 1, deleteIfExists: true });
        }))
            .command('delete <index>', `delete an existing local index`, {}, (args) => __awaiter(this, void 0, void 0, function* () {
            const folderPath = args.index;
            console.log(internals_1.Colorize.output(`deleting index at ${folderPath}`));
            const storage = getStorage(args);
            const codec = yield (0, codecs_1.detectCodec)(folderPath, storage).catch(() => undefined);
            const index = new LocalDocumentIndex_1.LocalDocumentIndex({ folderPath, storage, codec });
            yield index.deleteIndex();
        }))
            .command('add <index>', `adds one or more web pages to an index`, (yargs) => {
            return yargs
                .option('keys', {
                alias: 'k',
                describe: 'path of a JSON file containing the model keys to use for generating embeddings',
                type: 'string'
            })
                .option('uri', {
                alias: 'u',
                array: true,
                describe: 'http/https link to a web page to add',
                type: 'string'
            })
                .option('list', {
                alias: 'l',
                describe: 'path to a file containing a list of web pages to add',
                type: 'string'
            })
                .option('cookie', {
                alias: 'c',
                describe: 'optional cookies to add to web fetch requests',
                type: 'string'
            })
                .option('chunk-size', {
                alias: 'cs',
                describe: 'size of the generated chunks in tokens (defaults to 512)',
                type: 'number',
                default: 512
            })
                .check((argv) => {
                if (Array.isArray(argv.uri) && argv.uri.length > 0) {
                    return true;
                }
                else if (typeof argv.list == 'string' && argv.list.trim().length > 0) {
                    return true;
                }
                else {
                    throw new Error(`you must specify either one or more "--uri <link>" for the pages to add or a "--list <file path>" for a file containing the list of pages to add.`);
                }
            })
                .demandOption(['keys']);
        }, (args) => __awaiter(this, void 0, void 0, function* () {
            console.log(internals_1.Colorize.title('Adding Web Pages to Index'));
            // Get embedding options
            const options = JSON.parse(yield fs.readFile(args.keys, 'utf-8'));
            if (options.apiKey && !options.model) {
                options.model = 'text-embedding-ada-002';
                options.maxTokens = 8000;
            }
            // Create embeddings
            const embeddings = new OpenAIEmbeddings_1.OpenAIEmbeddings(options);
            // Initialize index
            const folderPath = args.index;
            const storage = getStorage(args);
            const codec = yield (0, codecs_1.detectCodec)(folderPath, storage).catch(() => undefined);
            const index = new LocalDocumentIndex_1.LocalDocumentIndex({
                folderPath,
                embeddings,
                chunkingConfig: {
                    chunkSize: args.chunkSize
                },
                storage,
                codec
            });
            // Get list of url's
            const uris = yield getItemList(args.uri, args.list, 'web page');
            // Fetch documents
            const fileFetcher = new FileFetcher_1.FileFetcher();
            const webFetcher = args.cookie ? new WebFetcher_1.WebFetcher({ headers: { "cookie": args.cookie } }) : new WebFetcher_1.WebFetcher();
            for (const path of uris) {
                try {
                    console.log(internals_1.Colorize.progress(`fetching ${path}`));
                    const fetcher = path.startsWith('http') ? webFetcher : fileFetcher;
                    yield fetcher.fetch(path, (uri, text, docType) => __awaiter(this, void 0, void 0, function* () {
                        console.log(internals_1.Colorize.replaceLine(internals_1.Colorize.progress(`indexing ${uri}`)));
                        yield index.upsertDocument(uri, text, docType);
                        console.log(internals_1.Colorize.replaceLine(internals_1.Colorize.success(`added ${uri}`)));
                        return true;
                    }));
                }
                catch (err) {
                    console.log(internals_1.Colorize.replaceLine(internals_1.Colorize.error(`Error adding: ${path}\n${err.message}`)));
                }
            }
        }))
            .command('remove <index>', `removes one or more documents from an index`, (yargs) => {
            return yargs
                .option('uri', {
                alias: 'u',
                array: true,
                describe: 'uri of a document to remove',
                type: 'string'
            })
                .option('list', {
                alias: 'l',
                describe: 'path to a file containing a list of documents to remove',
                type: 'string'
            })
                .check((argv) => {
                if (Array.isArray(argv.uri) && argv.uri.length > 0) {
                    return true;
                }
                else if (typeof argv.list == 'string' && argv.list.trim().length > 0) {
                    return true;
                }
                else {
                    throw new Error(`you must specify either one or more "--uri <link>" for the pages to add or a "--list <file path>" for a file containing the list of pages to add.`);
                }
            });
        }, (args) => __awaiter(this, void 0, void 0, function* () {
            // Initialize index
            const folderPath = args.index;
            const storage = getStorage(args);
            const codec = yield (0, codecs_1.detectCodec)(folderPath, storage).catch(() => undefined);
            const index = new LocalDocumentIndex_1.LocalDocumentIndex({ folderPath, storage, codec });
            // Get list of uri's
            const uris = yield getItemList(args.uri, args.list, 'document');
            // Remove documents
            for (const uri of uris) {
                console.log(`removing ${uri}`);
                yield index.deleteDocument(uri);
            }
        }))
            .command('stats <index>', `prints the stats for a local index`, (yargs) => {
            return yargs;
        }, (args) => __awaiter(this, void 0, void 0, function* () {
            const folderPath = args.index;
            const storage = getStorage(args);
            // Auto-detect format from files on disk
            const codec = yield (0, codecs_1.detectCodec)(folderPath, storage);
            const index = new LocalDocumentIndex_1.LocalDocumentIndex({ folderPath, storage, codec });
            const stats = yield index.getCatalogStats();
            console.log(internals_1.Colorize.title('Index Stats'));
            console.log(internals_1.Colorize.output(stats));
        }))
            .command('migrate <index>', `migrate an index between serialization formats`, (yargs) => {
            return yargs.option('to', {
                describe: 'target format',
                choices: ['json', 'protobuf'],
                demandOption: true
            });
        }, (args) => __awaiter(this, void 0, void 0, function* () {
            const folderPath = args.index;
            const storage = getStorage(args);
            const to = args.to;
            console.log(internals_1.Colorize.output(`migrating index at ${folderPath} to ${to} format`));
            yield (0, codecs_1.migrateIndex)(folderPath, { to, storage });
            console.log(internals_1.Colorize.output(`migration complete`));
        }))
            .command('query <index> <query>', `queries a local index`, (yargs) => {
            return yargs
                .option('keys', {
                alias: 'k',
                describe: 'path of a JSON file containing the model keys to use for generating embeddings'
            })
                .option('document-count', {
                alias: 'dc',
                describe: 'max number of documents to return (defaults to 10)',
                type: 'number',
                default: 10
            })
                .option('chunk-count', {
                alias: 'cc',
                describe: 'max number of chunks to return (defaults to 50)',
                type: 'number',
                default: 50
            })
                .option('section-count', {
                alias: 'sc',
                describe: 'max number of document sections to render (defaults to 1)',
                type: 'number',
                default: 1
            })
                .option('tokens', {
                alias: 't',
                describe: 'max number of tokens to render for each document section (defaults to 2000)',
                type: 'number',
                default: 2000
            })
                .option('format', {
                alias: 'f',
                describe: `format of the rendered results. Defaults to 'sections'`,
                choices: ['sections', 'stats', 'chunks'],
                default: 'sections'
            })
                .option('overlap', {
                alias: 'o',
                describe: `whether to add overlapping chunks to sections.`,
                type: 'boolean',
                default: true
            })
                .option('bm25', {
                alias: 'b',
                describe: 'Use Okapi-bm25 keyword search alogrithm to perform hybrid search - semantic + keyword. Displayed in blue during search.',
                type: 'boolean',
                default: false
            })
                .demandOption(['keys']);
        }, (args) => __awaiter(this, void 0, void 0, function* () {
            console.log(internals_1.Colorize.title('Querying Index'));
            // Get embedding options
            const options = JSON.parse(yield fs.readFile(args.keys, 'utf-8'));
            if (options.apiKey && !options.model) {
                options.model = 'text-embedding-ada-002';
                options.maxTokens = 8000;
            }
            // Create embeddings
            const embeddings = new OpenAIEmbeddings_1.OpenAIEmbeddings(options);
            // Initialize index
            const folderPath = args.index;
            const storage = getStorage(args);
            const codec = yield (0, codecs_1.detectCodec)(folderPath, storage).catch(() => undefined);
            const index = new LocalDocumentIndex_1.LocalDocumentIndex({
                folderPath,
                embeddings,
                storage,
                codec
            });
            // Query index
            const query = args.query;
            const results = yield index.queryDocuments(query, {
                maxDocuments: args.documentCount,
                maxChunks: args.chunkCount,
                isBm25: args.bm25,
            });
            // Render results
            for (const result of results) {
                console.log(internals_1.Colorize.output(result.uri));
                console.log(internals_1.Colorize.value('score', result.score));
                console.log(internals_1.Colorize.value('chunks', result.chunks.length));
                if (args.format == 'sections') {
                    const sections = yield result.renderSections(args.tokens, args.sectionCount, args.overlap);
                    console.log(sections.length);
                    for (let i = 0; i < sections.length; i++) {
                        const section = sections[i];
                        const isBm25 = sections[i].isBm25;
                        console.log(isBm25);
                        console.log(internals_1.Colorize.title(args.sectionCount == 1 ? 'Section' : `Section ${i + 1}`));
                        console.log(internals_1.Colorize.value('score', section.score));
                        console.log(internals_1.Colorize.value('tokens', section.tokenCount));
                        console.log(internals_1.Colorize.output(section.text, isBm25));
                    }
                }
                else if (args.format == 'chunks') {
                    const text = yield result.loadText();
                    for (let i = 0; i < result.chunks.length; i++) {
                        const chunk = result.chunks[i];
                        const startPos = chunk.item.metadata.startPos;
                        const endPos = chunk.item.metadata.endPos;
                        const isBm25 = Boolean(chunk.item.metadata.isBm25);
                        console.log(internals_1.Colorize.title(`Chunk ${i + 1}`));
                        console.log(internals_1.Colorize.value('score', chunk.score));
                        console.log(internals_1.Colorize.value('startPos', startPos));
                        console.log(internals_1.Colorize.value('endPos', endPos));
                        console.log(internals_1.Colorize.output(text.substring(startPos, endPos + 1), isBm25));
                    }
                }
            }
        }))
            .command('watch <index>', 'watch folders and automatically sync file changes into the index', (yargs) => {
            return yargs
                .option('keys', {
                alias: 'k',
                describe: 'path of a JSON file containing the model keys to use for generating embeddings',
                type: 'string'
            })
                .option('uri', {
                alias: 'u',
                array: true,
                describe: 'folder or file path to watch',
                type: 'string'
            })
                .option('list', {
                alias: 'l',
                describe: 'path to a file containing a list of folders/files to watch',
                type: 'string'
            })
                .option('extensions', {
                alias: 'e',
                array: true,
                describe: 'file extensions to include (e.g., .txt .md .html)',
                type: 'string'
            })
                .option('chunk-size', {
                alias: 'cs',
                describe: 'size of the generated chunks in tokens (defaults to 512)',
                type: 'number',
                default: 512
            })
                .option('debounce', {
                describe: 'debounce interval in milliseconds (defaults to 500)',
                type: 'number',
                default: 500
            })
                .check((argv) => {
                if (Array.isArray(argv.uri) && argv.uri.length > 0) {
                    return true;
                }
                else if (typeof argv.list == 'string' && argv.list.trim().length > 0) {
                    return true;
                }
                else {
                    throw new Error(`you must specify either one or more "--uri <path>" for the folders/files to watch or a "--list <file path>" for a file containing the paths.`);
                }
            })
                .demandOption(['keys']);
        }, (args) => __awaiter(this, void 0, void 0, function* () {
            console.log(internals_1.Colorize.title('Vectra Watch Mode'));
            // Get embedding options
            const options = JSON.parse(yield fs.readFile(args.keys, 'utf-8'));
            if (options.apiKey && !options.model) {
                options.model = 'text-embedding-ada-002';
                options.maxTokens = 8000;
            }
            // Create embeddings
            const embeddings = new OpenAIEmbeddings_1.OpenAIEmbeddings(options);
            // Initialize index
            const folderPath = args.index;
            const storage = getStorage(args);
            const codec = yield (0, codecs_1.detectCodec)(folderPath, storage).catch(() => undefined);
            const index = new LocalDocumentIndex_1.LocalDocumentIndex({
                folderPath,
                embeddings,
                chunkingConfig: {
                    chunkSize: args.chunkSize
                },
                storage,
                codec
            });
            // Get list of paths to watch
            const watchPaths = yield getItemList(args.uri, args.list, 'path');
            // Create watcher
            const watcher = new FolderWatcher_1.FolderWatcher({
                index,
                paths: watchPaths,
                extensions: args.extensions,
                debounceMs: args.debounce
            });
            // Wire up events
            watcher.on('sync', (uri, action) => {
                if (action === 'deleted') {
                    console.log(internals_1.Colorize.warning(`removed ${uri}`));
                }
                else {
                    console.log(internals_1.Colorize.success(`${action} ${uri}`));
                }
            });
            watcher.on('error', (err, uri) => {
                console.log(internals_1.Colorize.error(`Error syncing ${uri}: ${err.message}`));
            });
            // Start watching
            console.log(internals_1.Colorize.progress(`performing initial sync...`));
            yield watcher.start();
            console.log(internals_1.Colorize.success(`initial sync complete (${watcher.trackedFileCount} files tracked)`));
            console.log(internals_1.Colorize.output(`watching for changes... (press Ctrl+C to stop)`));
            // Handle graceful shutdown
            const handleSignal = () => __awaiter(this, void 0, void 0, function* () {
                console.log(internals_1.Colorize.output('\nStopping watcher...'));
                yield watcher.stop();
                process.exit(0);
            });
            process.on('SIGINT', handleSignal);
            process.on('SIGTERM', handleSignal);
        }))
            .command('generate', 'generate language bindings for the gRPC service', (yargs) => {
            return yargs
                .option('language', {
                alias: 'l',
                describe: 'target language for the generated bindings',
                choices: ['python', 'csharp', 'rust', 'go', 'java', 'typescript'],
                demandOption: true
            })
                .option('output', {
                alias: 'o',
                describe: 'output directory for the generated files',
                type: 'string',
                demandOption: true
            });
        }, (args) => __awaiter(this, void 0, void 0, function* () {
            const language = args.language;
            const outputDir = path.resolve(args.output);
            // Locate the proto file — check lib/ first (installed package), then project root
            const protoSearchPaths = [
                path.join(__dirname, '..', 'proto', 'vectra_service.proto'),
                path.join(__dirname, '..', '..', 'proto', 'vectra_service.proto'),
            ];
            let protoSource;
            for (const p of protoSearchPaths) {
                if (fsSync.existsSync(p)) {
                    protoSource = p;
                    break;
                }
            }
            if (!protoSource) {
                console.error(internals_1.Colorize.error('Could not locate vectra_service.proto'));
                process.exit(1);
            }
            // Locate the template directory
            const templateSearchPaths = [
                path.join(__dirname, '..', 'src', 'templates', language),
                path.join(__dirname, 'templates', language),
            ];
            let templateDir;
            for (const p of templateSearchPaths) {
                if (fsSync.existsSync(p)) {
                    templateDir = p;
                    break;
                }
            }
            if (!templateDir) {
                console.error(internals_1.Colorize.error(`Could not locate template for language: ${language}`));
                process.exit(1);
            }
            // Create output directory
            yield fs.mkdir(outputDir, { recursive: true });
            // Copy proto file
            const protoDest = path.join(outputDir, 'vectra_service.proto');
            yield fs.copyFile(protoSource, protoDest);
            console.log(internals_1.Colorize.success(`copied vectra_service.proto`));
            // Copy all template files
            const templateFiles = yield fs.readdir(templateDir);
            for (const file of templateFiles) {
                const src = path.join(templateDir, file);
                const stat = yield fs.stat(src);
                if (stat.isFile()) {
                    const dest = path.join(outputDir, file);
                    yield fs.copyFile(src, dest);
                    console.log(internals_1.Colorize.success(`copied ${file}`));
                }
            }
            console.log(internals_1.Colorize.output(`\nGenerated ${language} bindings in ${outputDir}`));
            // Print next steps
            const nextSteps = {
                python: [
                    'Next steps:',
                    '  pip install grpcio grpcio-tools',
                    '  python -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. vectra_service.proto',
                ].join('\n'),
                csharp: [
                    'Next steps:',
                    '  dotnet add package Grpc.Net.Client',
                    '  dotnet add package Google.Protobuf',
                    '  dotnet add package Grpc.Tools',
                    '  Add <Protobuf Include="vectra_service.proto" GrpcServices="Client" /> to your .csproj',
                ].join('\n'),
                rust: [
                    'Next steps:',
                    '  Ensure protoc is installed (apt install protobuf-compiler / brew install protobuf)',
                    '  cargo build  (tonic-build generates stubs automatically)',
                ].join('\n'),
                go: [
                    'Next steps:',
                    '  go install google.golang.org/protobuf/cmd/protoc-gen-go@latest',
                    '  go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest',
                    '  protoc --go_out=. --go-grpc_out=. vectra_service.proto',
                    '  Update the import path in vectra_client.go to match your module',
                ].join('\n'),
                java: [
                    'Next steps:',
                    '  Place vectra_service.proto in src/main/proto/',
                    '  Add gRPC dependencies to your build tool (see README.md for Gradle/Maven)',
                    '  Build to generate stubs automatically',
                ].join('\n'),
                typescript: [
                    'Next steps:',
                    '  npm install @grpc/grpc-js @grpc/proto-loader',
                    '  No codegen needed — proto is loaded dynamically at runtime',
                    '  import { VectraClient } from \'./VectraClient\';',
                ].join('\n'),
            };
            console.log(internals_1.Colorize.output(nextSteps[language]));
        }))
            .command('serve [index]', 'start the gRPC server to serve indexes', (yargs) => {
            return yargs
                .positional('index', {
                describe: 'path to a single index directory (mutually exclusive with --root)',
                type: 'string'
            })
                .option('root', {
                describe: 'directory containing multiple index subdirectories',
                type: 'string'
            })
                .option('port', {
                alias: 'p',
                describe: 'port to bind the gRPC server on',
                type: 'number',
                default: 50051
            })
                .option('daemon', {
                describe: 'fork to background as a daemon process',
                type: 'boolean',
                default: false
            })
                .option('pid-file', {
                describe: 'path to PID file (daemon mode only)',
                type: 'string'
            })
                .option('keys', {
                alias: 'k',
                describe: 'path to a JSON file containing the model keys for embeddings',
                type: 'string'
            })
                .check((argv) => {
                if (!argv.index && !argv.root) {
                    throw new Error('You must provide either an <index> path or --root <dir>');
                }
                if (argv.index && argv.root) {
                    throw new Error('<index> and --root are mutually exclusive');
                }
                return true;
            });
        }, (args) => __awaiter(this, void 0, void 0, function* () {
            // Load embeddings if keys provided
            let embeddings;
            if (args.keys) {
                const options = JSON.parse(yield fs.readFile(args.keys, 'utf-8'));
                if (options.apiKey && !options.model) {
                    options.model = 'text-embedding-ada-002';
                    options.maxTokens = 8000;
                }
                embeddings = new OpenAIEmbeddings_1.OpenAIEmbeddings(options);
            }
            const server = new VectraServer_1.VectraServer({
                port: args.port,
                indexPath: args.index,
                rootDir: args.root,
                embeddings,
            });
            if (args.daemon) {
                // Daemon mode: fork a child process
                const { spawn } = require('child_process');
                const cliArgs = process.argv.slice(2).filter(a => a !== '--daemon');
                const child = spawn(process.execPath, [process.argv[1], ...cliArgs], {
                    detached: true,
                    stdio: 'ignore',
                });
                child.unref();
                // Write PID file
                const pidFile = args.pidFile || path.join(args.root || path.dirname(args.index), '.vectra.pid');
                yield fs.writeFile(pidFile, String(child.pid));
                console.log(internals_1.Colorize.output(`Vectra server started as daemon (PID: ${child.pid})`));
                console.log(internals_1.Colorize.output(`PID file: ${pidFile}`));
                process.exit(0);
            }
            else {
                // Foreground mode
                const port = yield server.start();
                console.log(internals_1.Colorize.output(`Vectra gRPC server listening on 127.0.0.1:${port}`));
                const loaded = server.indexManager.listIndexes();
                if (loaded.length > 0) {
                    console.log(internals_1.Colorize.output(`Loaded indexes:`));
                    for (const idx of loaded) {
                        console.log(internals_1.Colorize.output(`  - ${idx.name} (${idx.format}, ${idx.isDocumentIndex ? 'document' : 'item'})`));
                    }
                }
                else {
                    console.log(internals_1.Colorize.output(`No indexes loaded yet. Use CreateIndex RPC or add index directories.`));
                }
                // Handle graceful shutdown
                const handleSignal = () => __awaiter(this, void 0, void 0, function* () {
                    console.log(internals_1.Colorize.output('\nShutting down...'));
                    yield server.shutdown();
                    process.exit(0);
                });
                process.on('SIGINT', handleSignal);
                process.on('SIGTERM', handleSignal);
            }
        }))
            .command('stop', 'stop a running Vectra daemon', (yargs) => {
            return yargs.option('pid-file', {
                describe: 'path to PID file',
                type: 'string',
                demandOption: true
            });
        }, (args) => __awaiter(this, void 0, void 0, function* () {
            const pidFile = args.pidFile;
            if (!fsSync.existsSync(pidFile)) {
                console.log(internals_1.Colorize.error(`PID file not found: ${pidFile}`));
                process.exit(1);
            }
            const pid = parseInt(yield fs.readFile(pidFile, 'utf-8'), 10);
            if (isNaN(pid)) {
                console.log(internals_1.Colorize.error(`Invalid PID in file: ${pidFile}`));
                process.exit(1);
            }
            try {
                // Send SIGTERM for graceful shutdown
                process.kill(pid, 'SIGTERM');
                console.log(internals_1.Colorize.output(`Sent SIGTERM to PID ${pid}`));
                // Wait up to 10s for process to exit
                const deadline = Date.now() + 10000;
                while (Date.now() < deadline) {
                    try {
                        process.kill(pid, 0); // check if process exists
                        yield new Promise(r => setTimeout(r, 500));
                    }
                    catch (_a) {
                        // Process no longer exists
                        break;
                    }
                }
                // Check if still alive and force kill
                try {
                    process.kill(pid, 0);
                    process.kill(pid, 'SIGKILL');
                    console.log(internals_1.Colorize.output(`Force-killed PID ${pid}`));
                }
                catch (_b) {
                    // Already dead
                }
                // Remove PID file
                yield fs.unlink(pidFile).catch(() => { });
                console.log(internals_1.Colorize.output('Vectra server stopped'));
            }
            catch (err) {
                if (err.code === 'ESRCH') {
                    console.log(internals_1.Colorize.output(`Process ${pid} not running. Cleaning up PID file.`));
                    yield fs.unlink(pidFile).catch(() => { });
                }
                else {
                    console.log(internals_1.Colorize.error(`Failed to stop server: ${err.message}`));
                    process.exit(1);
                }
            }
        }))
            .help()
            .demandCommand()
            .parseAsync();
    });
}
function getItemList(items, listFile, uriType) {
    return __awaiter(this, void 0, void 0, function* () {
        if (Array.isArray(items) && items.length > 0) {
            return items;
        }
        else if (typeof listFile == 'string' && listFile.trim().length > 0) {
            const list = yield fs.readFile(listFile, 'utf-8');
            return list.split('\n').map((item) => item.trim()).filter((item) => item.length > 0);
        }
        else {
            throw new Error(`you must specify either one or more "--uri <${uriType}>" for the items or a "--list <file path>" for a file containing the items.`);
        }
    });
}
//# sourceMappingURL=vectra-cli.js.map