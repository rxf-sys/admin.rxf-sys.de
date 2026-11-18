/** Limits how many tasks run at once. A finishing task hands its slot straight to the next waiter. */
export class Semaphore {
  #active = 0;
  readonly #waiting: (() => void)[] = [];
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    else this.#active++;
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active--;
    }
  }
}
