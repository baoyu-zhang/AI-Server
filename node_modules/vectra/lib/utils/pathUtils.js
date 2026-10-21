"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pathUtils = void 0;
/**
 * Universal path utilities that work in Node, Browser, and Electron.
 * Replaces Node's 'path' module for cross-platform compatibility.
 */
exports.pathUtils = {
    /**
     * Path separator. Always '/' for consistency across platforms.
     */
    sep: '/',
    /**
     * Join path segments together.
     */
    join(...parts) {
        return parts
            .map((part, i) => {
            if (i === 0)
                return part.replace(/[/\\]+$/, '');
            return part.replace(/^[/\\]+|[/\\]+$/g, '');
        })
            .filter(Boolean)
            .join('/');
    },
    /**
     * Get the last portion of a path.
     */
    basename(filePath, ext) {
        const base = filePath.split(/[/\\]/).pop() || '';
        if (ext && base.endsWith(ext)) {
            return base.slice(0, -ext.length);
        }
        return base;
    },
    /**
     * Get the directory name of a path.
     */
    dirname(filePath) {
        const parts = filePath.split(/[/\\]/);
        parts.pop();
        return parts.join('/') || '.';
    },
    /**
     * Get the extension of the path.
     */
    extname(filePath) {
        const base = exports.pathUtils.basename(filePath);
        const dotIndex = base.lastIndexOf('.');
        return dotIndex > 0 ? base.slice(dotIndex) : '';
    },
    /**
     * Normalize a path, resolving '..' and '.' segments.
     */
    normalize(filePath) {
        const isAbsolute = filePath.startsWith('/') || /^[a-zA-Z]:/.test(filePath);
        const parts = filePath.split(/[/\\]/);
        const result = [];
        for (const part of parts) {
            if (part === '..') {
                result.pop();
            }
            else if (part !== '.' && part !== '') {
                result.push(part);
            }
        }
        return (isAbsolute && !(/^[a-zA-Z]:/.test(filePath)) ? '/' : '') + result.join('/');
    },
    /**
     * Determine if a path is absolute.
     */
    isAbsolute(filePath) {
        return filePath.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(filePath);
    },
    /**
     * Get the relative path from one path to another.
     */
    relative(from, to) {
        const fromParts = exports.pathUtils.normalize(from).split('/').filter(Boolean);
        const toParts = exports.pathUtils.normalize(to).split('/').filter(Boolean);
        // Find common prefix
        let commonLength = 0;
        while (commonLength < fromParts.length &&
            commonLength < toParts.length &&
            fromParts[commonLength] === toParts[commonLength]) {
            commonLength++;
        }
        // Build relative path
        const upCount = fromParts.length - commonLength;
        const relativeParts = [
            ...Array(upCount).fill('..'),
            ...toParts.slice(commonLength)
        ];
        return relativeParts.join('/') || '.';
    }
};
exports.default = exports.pathUtils;
//# sourceMappingURL=pathUtils.js.map