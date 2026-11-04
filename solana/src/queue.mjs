/** Bounded work queue; callers must persist a gap/recover when submit returns false. */
export class BoundedQueue {
  constructor({
    capacity = 1000,
    concurrency = 2,
    metrics,
    onError = () => {},
  } = {}) {
    if (
      !Number.isInteger(capacity) ||
      capacity < 1 ||
      !Number.isInteger(concurrency) ||
      concurrency < 1
    )
      throw Error("INVALID_QUEUE_CONFIG");
    Object.assign(this, { capacity, concurrency, metrics, onError });
    this.pending = [];
    this.active = 0;
    this.accepting = true;
    this.waiters = [];
  }
  get depth() {
    return this.pending.length + this.active;
  }
  update() {
    this.metrics?.set("queue_depth", this.depth);
    this.metrics?.set("queue_active", this.active);
  }
  submit(task) {
    if (!this.accepting || this.depth >= this.capacity) {
      this.metrics?.inc("queue_overflows");
      return false;
    }
    if (typeof task !== "function") throw Error("INVALID_QUEUE_TASK");
    this.pending.push(task);
    this.update();
    this.pump();
    return true;
  }
  pump() {
    while (this.pending.length && this.active < this.concurrency) {
      const task = this.pending.shift();
      this.active++;
      this.update();
      Promise.resolve()
        .then(task)
        .catch((error) => {
          this.metrics?.inc("queue_task_failures");
          try {
            this.onError(error);
          } catch {
            this.metrics?.inc("queue_error_handler_failures");
          }
        })
        .finally(() => {
          this.active--;
          this.update();
          this.pump();
          if (!this.depth)
            this.waiters.splice(0).forEach((resolve) => resolve());
        });
    }
  }
  drain() {
    return this.depth
      ? new Promise((resolve) => this.waiters.push(resolve))
      : Promise.resolve();
  }
  stop() {
    this.accepting = false;
    return this.drain();
  }
}
