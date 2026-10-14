/** Execute business expressions on a normal worker turn, rather than a V8
 * interrupt inside another function's partially constructed scope. The result
 * box preserves Promise identity when awaitPromise is false and uses the same
 * Inspector session for remote objects. No expression is replayed on failure. */
export async function scheduledEvaluate(
  raw: (method: string, params?: any) => Promise<any>,
  args: any,
) {
  const box = await raw("Runtime.evaluate", {
    expression: `__runnerScheduleEvaluation(${JSON.stringify(args)})`,
    contextId: args.contextId,
    uniqueContextId: args.uniqueContextId,
    objectGroup: args.objectGroup,
    awaitPromise: true,
    returnByValue: false,
    silent: args.silent,
  });
  if (box.exceptionDetails || !box.result?.objectId) return box;
  try {
    return await raw("Runtime.callFunctionOn", {
      objectId: box.result.objectId,
      functionDeclaration:
        "function(){if(this.threw)throw this.value;return this.value;}",
      returnByValue: args.returnByValue,
      generatePreview: args.generatePreview,
      objectGroup: args.objectGroup,
      awaitPromise: args.awaitPromise,
      serializationOptions: args.serializationOptions,
      // The original expression already had its normal exception pause. Do not
      // pause a second time while transferring a caught error to the frontend.
      silent: true,
    });
  } finally {
    await raw("Runtime.releaseObject", { objectId: box.result.objectId }).catch(
      () => {},
    );
  }
}
