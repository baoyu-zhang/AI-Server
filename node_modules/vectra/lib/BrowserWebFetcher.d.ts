import { TextFetcher } from './types';
/**
 * Configuration options for BrowserWebFetcher.
 */
export interface BrowserWebFetcherConfig {
    /**
     * Optional. Whether to convert HTML to a simplified text/markdown format.
     * @remarks
     * Defaults to `true`.
     */
    htmlToMarkdown?: boolean;
    /**
     * Optional. Additional headers to include in requests.
     */
    headers?: Record<string, string>;
    /**
     * Optional. Request mode for fetch.
     * @remarks
     * Defaults to 'cors'.
     */
    mode?: RequestMode;
    /**
     * Optional. Credentials mode for fetch.
     * @remarks
     * Defaults to 'same-origin'.
     */
    credentials?: RequestCredentials;
}
/**
 * Browser-compatible web fetcher using the native Fetch API.
 * @remarks
 * This fetcher works in browsers and Electron renderer processes.
 * Uses DOMParser instead of cheerio for HTML parsing.
 */
export declare class BrowserWebFetcher implements TextFetcher {
    private readonly _config;
    private static readonly ALLOWED_CONTENT_TYPES;
    /**
     * Creates a new `BrowserWebFetcher` instance.
     * @param config Optional configuration options.
     */
    constructor(config?: BrowserWebFetcherConfig);
    /**
     * Fetches content from a URL and passes it to the document handler.
     * @param uri URL to fetch.
     * @param onDocument Callback to handle the fetched document.
     * @returns Promise that resolves to the return value of onDocument.
     */
    fetch(uri: string, onDocument: (uri: string, text: string, docType?: string) => Promise<boolean>): Promise<boolean>;
    /**
     * Converts HTML to a simplified markdown-like format using DOMParser.
     */
    private htmlToMarkdown;
    /**
     * Recursively processes DOM nodes to extract text content.
     */
    private processNode;
    /**
     * Processes child nodes of an element.
     */
    private processChildren;
    /**
     * Gets clean text content from an element.
     */
    private getTextContent;
    /**
     * Processes a table element to markdown format.
     */
    private processTable;
    /**
     * Maps MIME type to document type.
     */
    private getDocTypeFromMime;
}
//# sourceMappingURL=BrowserWebFetcher.d.ts.map