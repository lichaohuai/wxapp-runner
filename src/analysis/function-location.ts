/** Follow only Inspector-reported identities; never execute getters or parse toString. */
export async function inspectorFunctionLocation(
  objectId: string,
  properties: (objectId: string) => Promise<any>,
) {
  const visited = new Set<string>(),
    wrappers: string[] = [];
  for (let i = 0; i < 8; i++) {
    if (visited.has(objectId))
      return { wrappers, reason: "Inspector wrapper cycle" };
    visited.add(objectId);
    const p = await properties(objectId);
    const location = p.internalProperties?.find(
      (x: any) => x.name === "[[FunctionLocation]]",
    )?.value?.value;
    if (location) return { location, wrappers };
    const target = p.internalProperties?.find(
      (x: any) =>
        [
          "[[Target]]",
          "[[TargetFunction]]",
          "[[BoundTargetFunction]]",
        ].includes(x.name) && x.value?.objectId,
    );
    if (!target)
      return {
        wrappers,
        reason: "Inspector did not provide a function location or target",
      };
    wrappers.push(target.name);
    objectId = target.value.objectId;
  }
  return { wrappers, reason: "Inspector wrapper depth limit (8)" };
}
