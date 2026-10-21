"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContentTypeMap = exports.FileExt = exports.PlainTextFileExt = exports.CodeFileExt = exports.TextDocumentFileExt = exports.DocumentFileExt = exports.BinaryFileExt = exports.DatabaseFileExt = exports.SystemFileExt = exports.ArchiveFileExt = exports.ModelFileExt = exports.MediaFileExt = exports.AudioFileExt = exports.VideoFileExt = exports.ImageFileExt = void 0;
exports.ImageFileExt = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'tif', 'webp', 'svg', 'heic', 'heif'];
exports.VideoFileExt = ['mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm', 'mpg', 'mpeg', '3gp'];
exports.AudioFileExt = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'wma', 'aiff', 'alac'];
exports.MediaFileExt = [...exports.ImageFileExt, ...exports.VideoFileExt, ...exports.AudioFileExt];
exports.ModelFileExt = ['obj', 'fbx', 'stl', 'dae', 'ply', '3ds', 'gltf', 'glb'];
exports.ArchiveFileExt = ['zip', 'tar', 'gz', '7z', 'rar', 'tgz'];
exports.SystemFileExt = ['exe', 'dll', 'bin', 'iso', 'dmg', 'msi', 'deb', 'rpm', 'apk', 'appimage', 'rom', 'efi'];
exports.DatabaseFileExt = ['sqlite', 'sql', 'mdb', 'accdb'];
exports.BinaryFileExt = [...exports.MediaFileExt, ...exports.ModelFileExt, ...exports.ArchiveFileExt, ...exports.SystemFileExt, ...exports.DatabaseFileExt];
exports.DocumentFileExt = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'tex'];
exports.TextDocumentFileExt = ['txt', 'csv', 'log', 'md', 'rst'];
exports.CodeFileExt = ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'cs', 'php', 'go', 'rb', 'rs', 'swift', 'kt', 'dart', 'sh', 'bash', 'ps1', 'bat', 'cmd', 'html', 'css', 'scss', 'sass', 'less', 'xml', 'json', 'yaml', 'yml', 'ini', 'conf', 'cfg', 'env'];
exports.PlainTextFileExt = [...exports.TextDocumentFileExt, ...exports.CodeFileExt];
exports.FileExt = [...exports.BinaryFileExt, ...exports.DocumentFileExt, ...exports.PlainTextFileExt];
exports.ContentTypeMap = {
    "text/html": "html",
    "text/plain": "txt",
    "text/css": "css",
    "text/javascript": "js",
    "application/json": "json",
    "application/xml": "xml",
    "application/javascript": "js",
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "application/zip": "zip",
    "application/octet-stream": "bin",
    "audio/mpeg": "mp3",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "text/csv": "csv",
};
//# sourceMappingURL=FileType.js.map