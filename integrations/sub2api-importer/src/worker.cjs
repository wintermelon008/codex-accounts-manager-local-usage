"use strict";

const {
  claimNextJob,
  completeClaim,
  failClaim,
  makeCompletedResult,
  makeFailedResult,
  readClaimedJob,
  writeResult
} = require("./queue.cjs");
const { importAndConfigureSub2ApiPayload } = require("./accountProvisioning.cjs");

async function processOutbox(configuration, options = {}) {
  const submit = options.submit ?? importAndConfigureSub2ApiPayload;
  const summary = { completed: 0, failed: 0, idle: false };
  for (;;) {
    const claim = await claimNextJob(configuration.queueDirectory);
    if (!claim) {
      summary.idle = summary.completed === 0 && summary.failed === 0;
      return summary;
    }
    let job;
    try {
      job = await readClaimedJob(claim);
      const result = await submit(configuration, job.payload);
      await writeResult(configuration.queueDirectory, makeCompletedResult(job, result));
      await completeClaim(claim);
      summary.completed += 1;
    } catch (error) {
      await writeResult(configuration.queueDirectory, makeFailedResult(job ?? { id: claim.id }, error));
      await failClaim(claim);
      summary.failed += 1;
    }
  }
}

module.exports = { processOutbox };
