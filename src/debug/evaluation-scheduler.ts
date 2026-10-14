import * as inspector from "node:inspector";

/** The local session only evaluates on an ordinary worker turn. Breakpoints and
 * resume stay on the external WebSocket session, so pausing never requires a
 * same-thread JS listener to resume itself. Native REPL semantics are retained. */
export function installEvaluationScheduler(context: any) {
  const session = new inspector.Session();
  session.connect();
  session.post("Runtime.enable");
  const values = new Map<number, any>();
  let sequence = 0;
  const post = (method: string, params: any): Promise<any> =>
    new Promise((resolve, reject) => {
      session.post(method as any, params, (error, result) =>
        error ? reject(error) : resolve(result),
      );
    });
  Object.defineProperty(context, "__runnerStoreEvaluationValue", {
    value: (id: number, value: any) => {
      if (values.has(id)) values.set(id, value);
    },
  });
  Object.defineProperty(context, "__runnerScheduleEvaluation", {
    value: (args: any) =>
      new Promise((resolve) =>
        setImmediate(async () => {
          const id = ++sequence;
          const group = "wxapp-evaluation-" + id;
          values.set(id, undefined);
          try {
            const { timeout, ...parameters } = args;
            const response = await post("Runtime.evaluate", {
              ...parameters,
              objectGroup: group,
              returnByValue: false,
              generatePreview: false,
              serializationOptions: undefined,
              awaitPromise: false,
            });
            const result = response.result;
            if (result?.objectId) {
              const transfer = await post("Runtime.callFunctionOn", {
                objectId: result.objectId,
                functionDeclaration: `function(){globalThis.__runnerStoreEvaluationValue(${id},this)}`,
                silent: true,
              });
              if (transfer.exceptionDetails)
                throw Error("Inspector result transfer failed");
            } else if (result?.unserializableValue) {
              const literal = result.unserializableValue;
              values.set(
                id,
                literal.endsWith("n")
                  ? BigInt(literal.slice(0, -1))
                  : Number(literal),
              );
            } else values.set(id, result?.value);
            resolve({
              value: values.get(id),
              threw: !!response.exceptionDetails,
            });
          } catch (value) {
            resolve({ value, threw: true });
          } finally {
            values.delete(id);
            await post("Runtime.releaseObjectGroup", {
              objectGroup: group,
            }).catch(() => {});
          }
        }),
      ),
  });
  return () => session.disconnect();
}
