import html from './page.html';

/** The page ships as one self-contained HTML file. Dev mode lets a local preview sign in without the CRM. */
export const PAGE = (dev: boolean): string => html.replace('__DEV__', dev ? 'true' : 'false');
