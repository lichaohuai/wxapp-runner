// WAServiceMainContext 3.17.3, module 8435: native storage stores a string
// plus a case-sensitive type tag. Keep this wire shape separate from wx data.
export function encodeStorageData(value: any) {
  const dataType = Object.prototype.toString.call(value).slice(8, -1);
  const data =
    dataType === "Array" || dataType === "Object"
      ? JSON.stringify(value)
      : ["String", "Number", "Boolean"].includes(dataType)
        ? String(value)
        : dataType === "Date"
          ? String(value.getTime())
          : dataType === "Undefined"
            ? "undefined"
            : dataType === "Null"
              ? "null"
              : "";
  if (typeof data !== "string")
    throw Error("storage value cannot be serialized");
  return { data, dataType };
}

export function decodeStorageData(value: { data: string; dataType: string }) {
  const { data, dataType } = value;
  if (typeof data !== "string" || typeof dataType !== "string")
    throw Error("invalid storage data/dataType");
  switch (dataType) {
    case "String":
      return data;
    case "Array":
    case "Object":
      return JSON.parse(data);
    case "Number":
      return parseFloat(data);
    case "Boolean":
      return data === "true";
    case "Date":
      return new Date(parseInt(data, 10));
    case "Undefined":
      return undefined;
    case "Null":
      return null;
    default:
      return "";
  }
}
