/**
 * The last page any list serves. Past it a client narrows the filter or asks
 * for a larger page; the bound also keeps the row offset a page implies small,
 * so a huge page number cannot make the query itself fail.
 */
export const MAX_PAGE = 100;
