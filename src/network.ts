// Render the dylib's network_tail records into a scannable text view.
// Each record one line by default; pass full=true for headers + body previews.

export interface NetRecord {
  id: number;
  url: string;
  method: string;
  request_headers?: Record<string, string>;
  request_body_size?: number;
  request_body_preview?: string;
  request_body_binary?: boolean;
  request_body_truncated?: boolean;
  status?: number;
  mime?: string;
  response_headers?: Record<string, string>;
  response_body_size?: number;
  response_body_preview?: string;
  response_body_binary?: boolean;
  response_body_truncated?: boolean;
  started_at_ms: number;
  ended_at_ms?: number;
  duration_ms?: number;
  ttfb_ms?: number;
  error?: string;
  error_code?: number;
  error_domain?: string;
}

function fmtBytes(n: number | undefined): string {
  if (n === undefined || n < 0) return "?";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function fmtStatus(r: NetRecord): string {
  if (r.error) return `ERR(${r.error_code ?? "?"})`;
  if (r.status === undefined) return "...";
  return String(r.status);
}

function trunc(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

export interface RenderOpts {
  full?: boolean;            // include headers + body previews
  maxBodyChars?: number;
}

export function renderNetTail(records: NetRecord[], opts: RenderOpts = {}): string {
  if (records.length === 0) return "(no records captured yet)";
  const lines: string[] = [];
  lines.push(`# ${records.length} record(s)`);
  for (const r of records) {
    const status = fmtStatus(r);
    const dur = r.duration_ms !== undefined ? `${r.duration_ms}ms` : "in-flight";
    const ttfb = r.ttfb_ms !== undefined ? ` ttfb=${r.ttfb_ms}ms` : "";
    const reqSize = r.request_body_size && r.request_body_size > 0 ? ` reqB=${fmtBytes(r.request_body_size)}` : "";
    const resSize = r.response_body_size !== undefined ? ` resB=${fmtBytes(r.response_body_size)}` : "";
    const mime = r.mime ? ` ${r.mime}` : "";
    lines.push(`#${r.id} ${r.method} ${status} ${dur}${ttfb}${reqSize}${resSize}${mime}  ${trunc(r.url, 120)}`);
    if (r.error) lines.push(`    error: ${r.error} (${r.error_domain ?? "?"})`);
    if (opts.full) {
      if (r.request_headers && Object.keys(r.request_headers).length > 0) {
        lines.push("    request_headers:");
        for (const [k, v] of Object.entries(r.request_headers)) lines.push(`      ${k}: ${v}`);
      }
      if (r.request_body_preview) {
        const max = opts.maxBodyChars ?? 800;
        lines.push(`    request_body${r.request_body_truncated ? " (truncated)" : ""}${r.request_body_binary ? " (binary)" : ""}:`);
        lines.push(indent(trunc(r.request_body_preview, max), "      "));
      }
      if (r.response_headers && Object.keys(r.response_headers).length > 0) {
        lines.push("    response_headers:");
        for (const [k, v] of Object.entries(r.response_headers)) lines.push(`      ${k}: ${v}`);
      }
      if (r.response_body_preview) {
        const max = opts.maxBodyChars ?? 800;
        lines.push(`    response_body${r.response_body_truncated ? " (truncated)" : ""}${r.response_body_binary ? " (binary)" : ""}:`);
        lines.push(indent(trunc(r.response_body_preview, max), "      "));
      }
    }
  }
  return lines.join("\n");
}

function indent(s: string, pad: string): string {
  return s.split("\n").map(l => pad + l).join("\n");
}
