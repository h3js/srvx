import type { WorkerOptions } from "node:worker_threads";

import { Worker } from "node:worker_threads";

const workerBootstrap = /* JavaScript */ `
  import { createRequire } from "node:module";
  import { workerData } from "node:worker_threads";

  const filename = "${import.meta.url}";
  const require = createRequire(filename);
  const { createJiti } = require("jiti");
  const jiti = createJiti(workerData.__ts_worker_filename);

  jiti.import(workerData.__ts_worker_filename);
`;

export class TypeScriptWorker extends Worker {
  constructor(filename: string | URL, options: WorkerOptions = {}) {
    options.workerData ??= {};
    options.workerData.__ts_worker_filename = filename.toString();
    super(new URL(`data:text/javascript,${workerBootstrap}`), options);
  }
}
