/**
 * Universal path utilities that work in Node, Browser, and Electron.
 * Replaces Node's 'path' module for cross-platform compatibility.
 */
export declare const pathUtils: {
    /**
     * Path separator. Always '/' for consistency across platforms.
     */
    sep: "/";
    /**
     * Join path segments together.
     */
    join(...parts: string[]): string;
    /**
     * Get the last portion of a path.
     */
    basename(filePath: string, ext?: string): string;
    /**
     * Get the directory name of a path.
     */
    dirname(filePath: string): string;
    /**
     * Get the extension of the path.
     */
    extname(filePath: string): string;
    /**
     * Normalize a path, resolving '..' and '.' segments.
     */
    normalize(filePath: string): string;
    /**
     * Determine if a path is absolute.
     */
    isAbsolute(filePath: string): boolean;
    /**
     * Get the relative path from one path to another.
     */
    relative(from: string, to: string): string;
};
export default pathUtils;
//# sourceMappingURL=pathUtils.d.ts.map