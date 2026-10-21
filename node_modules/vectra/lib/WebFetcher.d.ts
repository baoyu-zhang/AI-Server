import { TextFetcher } from './types';
export interface WebFetcherConfig {
    headers?: Record<string, string>;
    requestConfig?: RequestInit;
    htmlToMarkdown: boolean;
    summarizeHtml: boolean;
}
export declare class WebFetcher implements TextFetcher {
    private readonly _config;
    constructor(config?: Partial<WebFetcherConfig>);
    fetch(uri: string, onDocument: (uri: string, text: string, docType?: string) => Promise<boolean>): Promise<boolean>;
    private htmlToMarkdown;
}
//# sourceMappingURL=WebFetcher.d.ts.map