/** Google Visualization（gviz）レスポンスをパースする */

function parseGvizJson(text) {
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

  return json;
}

/** @returns {{ rows: object[], cols: object[] }} */
export function parseGvizTable(text) {
  const json = parseGvizJson(text);
  return {
    rows: json.table && json.table.rows ? json.table.rows : [],
    cols: json.table && json.table.cols ? json.table.cols : [],
  };
}

/** 行配列のみ（後方互換） */
export function parseGvizRows(text) {
  return parseGvizTable(text).rows;
}
