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
exports.BrowserWebFetcher = void 0;
/**
 * Browser-compatible web fetcher using the native Fetch API.
 * @remarks
 * This fetcher works in browsers and Electron renderer processes.
 * Uses DOMParser instead of cheerio for HTML parsing.
 */
class BrowserWebFetcher {
    /**
     * Creates a new `BrowserWebFetcher` instance.
     * @param config Optional configuration options.
     */
    constructor(config) {
        this._config = Object.assign({ htmlToMarkdown: true, mode: 'cors', credentials: 'same-origin' }, config);
    }
    /**
     * Fetches content from a URL and passes it to the document handler.
     * @param uri URL to fetch.
     * @param onDocument Callback to handle the fetched document.
     * @returns Promise that resolves to the return value of onDocument.
     */
    fetch(uri, onDocument) {
        return __awaiter(this, void 0, void 0, function* () {
            const response = yield fetch(uri, {
                method: 'GET',
                headers: this._config.headers,
                mode: this._config.mode,
                credentials: this._config.credentials
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const contentType = response.headers.get('content-type') || 'text/plain';
            const mimeType = contentType.split(';')[0].trim().toLowerCase();
            // Validate content type
            if (!BrowserWebFetcher.ALLOWED_CONTENT_TYPES.some(allowed => mimeType.includes(allowed))) {
                throw new Error(`Unsupported content type: ${contentType}`);
            }
            const text = yield response.text();
            // Handle HTML content
            if (mimeType.includes('text/html') && this._config.htmlToMarkdown) {
                const markdown = this.htmlToMarkdown(text, uri);
                return onDocument(uri, markdown, 'md');
            }
            // Determine doc type from content type
            const docType = this.getDocTypeFromMime(mimeType);
            return onDocument(uri, text, docType);
        });
    }
    /**
     * Converts HTML to a simplified markdown-like format using DOMParser.
     */
    htmlToMarkdown(html, baseUrl) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        // Remove unwanted elements
        const removeSelectors = ['script', 'style', 'noscript', 'iframe', 'svg', 'canvas'];
        removeSelectors.forEach(selector => {
            doc.querySelectorAll(selector).forEach(el => el.remove());
        });
        // Convert relative URLs to absolute
        doc.querySelectorAll('a[href]').forEach(el => {
            const href = el.getAttribute('href');
            if (href && !href.startsWith('http') && !href.startsWith('//') && !href.startsWith('#')) {
                try {
                    el.setAttribute('href', new URL(href, baseUrl).toString());
                }
                catch (_a) {
                    // Leave as-is if URL parsing fails
                }
            }
        });
        // Process the body
        const body = doc.body;
        if (!body) {
            return html;
        }
        const lines = [];
        this.processNode(body, lines);
        // Clean up the result
        let result = lines.join('\n');
        // Remove excessive newlines
        result = result.replace(/\n{3,}/g, '\n\n');
        // Trim leading/trailing whitespace
        result = result.trim();
        return result;
    }
    /**
     * Recursively processes DOM nodes to extract text content.
     */
    processNode(node, lines) {
        var _a;
        if (node.nodeType === Node.TEXT_NODE) {
            const text = (_a = node.textContent) === null || _a === void 0 ? void 0 : _a.trim();
            if (text) {
                lines.push(text);
            }
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
            return;
        }
        const el = node;
        const tagName = el.tagName.toLowerCase();
        // Handle specific elements
        switch (tagName) {
            case 'h1':
                lines.push('');
                lines.push(`# ${this.getTextContent(el)}`);
                lines.push('');
                return;
            case 'h2':
                lines.push('');
                lines.push(`## ${this.getTextContent(el)}`);
                lines.push('');
                return;
            case 'h3':
                lines.push('');
                lines.push(`### ${this.getTextContent(el)}`);
                lines.push('');
                return;
            case 'h4':
                lines.push('');
                lines.push(`#### ${this.getTextContent(el)}`);
                lines.push('');
                return;
            case 'h5':
                lines.push('');
                lines.push(`##### ${this.getTextContent(el)}`);
                lines.push('');
                return;
            case 'h6':
                lines.push('');
                lines.push(`###### ${this.getTextContent(el)}`);
                lines.push('');
                return;
            case 'p':
                lines.push('');
                this.processChildren(el, lines);
                lines.push('');
                return;
            case 'br':
                lines.push('');
                return;
            case 'hr':
                lines.push('');
                lines.push('---');
                lines.push('');
                return;
            case 'a':
                const href = el.getAttribute('href');
                const text = this.getTextContent(el);
                if (href && text) {
                    lines.push(`[${text}](${href})`);
                }
                else if (text) {
                    lines.push(text);
                }
                return;
            case 'strong':
            case 'b':
                lines.push(`**${this.getTextContent(el)}**`);
                return;
            case 'em':
            case 'i':
                lines.push(`*${this.getTextContent(el)}*`);
                return;
            case 'code':
                lines.push(`\`${this.getTextContent(el)}\``);
                return;
            case 'pre':
                lines.push('');
                lines.push('```');
                lines.push(this.getTextContent(el));
                lines.push('```');
                lines.push('');
                return;
            case 'blockquote':
                lines.push('');
                const quoteText = this.getTextContent(el);
                quoteText.split('\n').forEach(line => {
                    lines.push(`> ${line}`);
                });
                lines.push('');
                return;
            case 'ul':
            case 'ol':
                lines.push('');
                el.querySelectorAll(':scope > li').forEach((li, index) => {
                    const prefix = tagName === 'ol' ? `${index + 1}.` : '-';
                    lines.push(`${prefix} ${this.getTextContent(li)}`);
                });
                lines.push('');
                return;
            case 'table':
                lines.push('');
                this.processTable(el, lines);
                lines.push('');
                return;
            case 'img':
                const alt = el.getAttribute('alt') || 'image';
                const src = el.getAttribute('src');
                if (src) {
                    lines.push(`![${alt}](${src})`);
                }
                return;
            default:
                // For other elements, process children
                this.processChildren(el, lines);
        }
    }
    /**
     * Processes child nodes of an element.
     */
    processChildren(el, lines) {
        el.childNodes.forEach(child => {
            this.processNode(child, lines);
        });
    }
    /**
     * Gets clean text content from an element.
     */
    getTextContent(el) {
        return (el.textContent || '').replace(/\s+/g, ' ').trim();
    }
    /**
     * Processes a table element to markdown format.
     */
    processTable(table, lines) {
        const rows = table.querySelectorAll('tr');
        let isFirstRow = true;
        rows.forEach(row => {
            const cells = row.querySelectorAll('th, td');
            const cellContents = [];
            cells.forEach(cell => {
                cellContents.push(this.getTextContent(cell));
            });
            if (cellContents.length > 0) {
                lines.push(`| ${cellContents.join(' | ')} |`);
                // Add separator after header row
                if (isFirstRow) {
                    lines.push(`| ${cellContents.map(() => '---').join(' | ')} |`);
                    isFirstRow = false;
                }
            }
        });
    }
    /**
     * Maps MIME type to document type.
     */
    getDocTypeFromMime(mimeType) {
        const mimeMap = {
            'text/html': 'html',
            'text/plain': undefined,
            'text/markdown': 'md',
            'text/xml': 'xml',
            'application/json': 'json',
            'application/xml': 'xml',
            'application/javascript': 'js'
        };
        for (const [mime, docType] of Object.entries(mimeMap)) {
            if (mimeType.includes(mime)) {
                return docType;
            }
        }
        return undefined;
    }
}
exports.BrowserWebFetcher = BrowserWebFetcher;
BrowserWebFetcher.ALLOWED_CONTENT_TYPES = [
    'text/html',
    'application/json',
    'application/xml',
    'application/javascript',
    'text/plain',
    'text/markdown',
    'text/xml'
];
//# sourceMappingURL=BrowserWebFetcher.js.map