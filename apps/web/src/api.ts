export const api = async (path: string, method = "GET", payload?: unknown) => {
  const response = await fetch(path, {
    method,
    headers: { "x-koolezt-actor": "web-user", ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.message ?? "Request failed");
  return json;
};
