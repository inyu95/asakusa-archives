/** Google Visualization（gviz）レスポンスを行配列にパースする */
export function parseGvizRows(text) {
  const normalized = String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .trim();

  const marker = "google.visualization.Query.setResponse(";
  const start = normalized.indexOf(marker);
  if (start < 0) {
    throw new Error("SHEET_PRIVATE");
  }

  const jsonStart = start + marker.length;
  let end = normalized.lastIndexOf(");");
  if (end < jsonStart) {
    end = normalized.lastIndexOf(")");
  }
  if (end < jsonStart) {
    throw new Error("SHEET_PRIVATE");
  }

  const json = JSON.parse(normalized.slice(jsonStart, end));
  if (json.status === "error") {
    const detail =
      json.errors && json.errors[0]
        ? json.errors[0].detailed_message || json.errors[0].message
        : "";
    throw new Error(detail || "SHEET_ERROR");
  }

  return json.table && json.table.rows ? json.table.rows : [];
}
