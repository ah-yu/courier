import { App, Modal } from "obsidian";

/**
 * Base modal that collects user input and returns a promise.
 * Closes resolve with null when the modal is dismissed via X/Escape.
 */
export abstract class PromiseModal<T> extends Modal {
  private resolvePromise!: (result: T | null) => void;
  private readonly promise: Promise<T | null>;

  constructor(app: App) {
    super(app);
    this.promise = new Promise<T | null>((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  /** Returns a promise that resolves with user input, or null if cancelled/dismissed. */
  getResult(): Promise<T | null> {
    return this.promise;
  }

  /** Subclasses call this with the user's input on confirm. */
  protected resolve(result: T): void {
    this.resolvePromise(result);
    this.close();
  }

  /** Subclasses call this on cancel, or it's called automatically via onClose. */
  protected cancel(): void {
    this.resolvePromise(null);
    this.close();
  }

  override onClose(): void {
    // Resolve with null if dismissed via X button or Escape key
    this.resolvePromise(null);
    super.onClose();
  }
}
