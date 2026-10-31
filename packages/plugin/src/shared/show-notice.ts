import { Notice } from "obsidian";

/**
 * Show a transient Obsidian notice.
 *
 * `Notice` renders itself when constructed and a caller never needs the object, so every
 * use site would be a bare `new Notice(...)` statement — which `no-new` rejects. One
 * function keeps that construction in a single place; the returned object exists only
 * because the constructor's result has to be used, not because a caller wants it.
 */
export const showNotice = (message: string): Notice => new Notice(message);
