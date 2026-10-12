// Node's env-file quoting differs from JSON: normalize Windows path separators.
export const environment = values => Object.entries(values).map(([name, value]) => {
  const encoded = typeof value === "string" && /^(?:[a-z]:[\\/]|\\\\)/i.test(value) ? value.replaceAll("\\", "/") : value;
  return `${name}=${JSON.stringify(encoded)}`;
}).join("\n") + "\n";
