export type OpenedPage = {
  requestedUrl: string;
  finalUrl: string;
  httpStatus?: number;
  title: string;
  text: string;
  truncated: boolean;
  observed: {
    webdriver: boolean;
    userAgent: string;
    brands: string[];
    languages: string[];
    timezone: string;
    viewport: { width: number; height: number };
  };
};

export type BrowserErrorCode = "challenge" | "access_wall" | "empty_content" | "upstream_http" | "timeout" | "navigation_failed";

export type BrowserEnvelope =
  | { version: 1; ok: true; page: OpenedPage }
  | {
      version: 1;
      ok: false;
      error: BrowserErrorCode;
      message: string;
      finalUrl?: string;
      title?: string;
      marker?: string;
    };
