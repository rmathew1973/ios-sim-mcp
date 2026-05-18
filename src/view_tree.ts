// Render the dylib's view_tree RPC response into a compact text view designed
// to be scannable by an LLM. Mirrors the AX snapshot's "one line per node" feel
// so callers can reason about both trees the same way.

export interface ViewFrame { x: number; y: number; w: number; h: number; }

export interface ViewNode {
  v: string;                    // stable ref within this snapshot: v1, v2, ...
  class: string;                // Obj-C class name of the view
  frame: ViewFrame;             // in window coords
  alpha?: number;
  hidden?: boolean;
  interactive?: boolean;        // present only when false
  tag?: number;
  ax_id?: string;
  ax_label?: string;
  ax_value?: string;
  text?: string;                // UILabel.text / UIButton.currentTitle / etc.
  vc_class?: string;            // set when this view is a UIViewController's root view
  children?: ViewNode[];
  // Window-only:
  is_key_window?: boolean;
  root_vc_class?: string;
  presented_vc_class?: string;
}

export interface ViewTreeResult {
  windows: ViewNode[];
  total_nodes: number;
  hit_cap: boolean;
  max_nodes: number;
  max_depth: number;
}

export interface RenderViewTreeOpts {
  showFrames?: boolean;
  classFilter?: string;            // substring match
  axIdContains?: string;
  textContains?: string;
  maxLines?: number;
}

function fmtFrame(f: ViewFrame): string {
  return `(${Math.round(f.x)},${Math.round(f.y)} ${Math.round(f.w)}x${Math.round(f.h)})`;
}

function trunc(s: string, n: number): string {
  const oneline = s.replace(/\s+/g, " ").trim();
  return oneline.length > n ? oneline.slice(0, n - 1) + "…" : oneline;
}

function nodeMatchesFilters(n: ViewNode, opts: RenderViewTreeOpts): boolean {
  if (opts.classFilter && !n.class.toLowerCase().includes(opts.classFilter.toLowerCase())) return false;
  if (opts.axIdContains && !(n.ax_id ?? "").toLowerCase().includes(opts.axIdContains.toLowerCase())) return false;
  if (opts.textContains) {
    const hay = `${n.text ?? ""} ${n.ax_label ?? ""} ${n.ax_value ?? ""}`.toLowerCase();
    if (!hay.includes(opts.textContains.toLowerCase())) return false;
  }
  return true;
}

function subtreeHasMatch(n: ViewNode, opts: RenderViewTreeOpts): boolean {
  if (nodeMatchesFilters(n, opts)) return true;
  if (n.children) for (const c of n.children) if (subtreeHasMatch(c, opts)) return true;
  return false;
}

export function renderViewTree(tree: ViewTreeResult, opts: RenderViewTreeOpts = {}): string {
  const showFrames = opts.showFrames ?? true;
  const filtering = !!(opts.classFilter || opts.axIdContains || opts.textContains);
  const maxLines = opts.maxLines ?? 600;
  const lines: string[] = [];
  const cap = tree.hit_cap ? ` [HIT MAX_NODES=${tree.max_nodes}; raise max_nodes if more is needed]` : "";
  lines.push(`# view_tree: ${tree.total_nodes} nodes across ${tree.windows.length} window(s)${cap}`);

  let lineCount = 1;
  const pushLine = (s: string) => {
    if (lineCount >= maxLines) return false;
    lines.push(s); lineCount++; return true;
  };

  const renderNode = (n: ViewNode, depth: number, forceShow: boolean): boolean => {
    if (lineCount >= maxLines) return false;
    const passes = !filtering || forceShow || nodeMatchesFilters(n, opts);
    const childHas = n.children ? n.children.some(c => subtreeHasMatch(c, opts)) : false;
    const showSelf = !filtering || passes || childHas;
    if (showSelf) {
      const indent = "  ".repeat(Math.min(depth, 12));
      const frame = showFrames ? ` ${fmtFrame(n.frame)}` : "";
      const text = n.text ? ` "${trunc(n.text, 60)}"` : "";
      const axLabel = !n.text && n.ax_label ? ` ax="${trunc(n.ax_label, 50)}"` : "";
      const axValue = n.ax_value ? `  val="${trunc(n.ax_value, 40)}"` : "";
      const axId = n.ax_id ? ` #${n.ax_id}` : "";
      const vc = n.vc_class ? ` vc=${n.vc_class}` : "";
      const flags: string[] = [];
      if (n.alpha !== undefined && n.alpha < 0.999) flags.push(`α=${n.alpha.toFixed(2)}`);
      if (n.hidden) flags.push("HIDDEN");
      if (n.interactive === false) flags.push("no-tap");
      if (n.tag !== undefined && n.tag !== 0) flags.push(`tag=${n.tag}`);
      const flagStr = flags.length ? ` [${flags.join(" ")}]` : "";
      pushLine(`${indent}${n.v} ${n.class}${frame}${text}${axLabel}${axValue}${axId}${vc}${flagStr}`);
    }
    if (n.children) for (const c of n.children) renderNode(c, depth + 1, forceShow && passes);
    return true;
  };

  for (const win of tree.windows) {
    if (filtering && !subtreeHasMatch(win, opts)) continue;
    const tag = win.is_key_window ? " keyWindow" : "";
    const vc = win.root_vc_class ? ` rootVC=${win.root_vc_class}` : "";
    const presented = win.presented_vc_class && win.presented_vc_class !== win.root_vc_class
      ? ` presented=${win.presented_vc_class}` : "";
    pushLine(`\n[${win.class}${tag}${vc}${presented}]`);
    renderNode(win, 0, false);
  }

  if (filtering) lines.push(`\n(filtered: showing ancestors of matches for ${
    [
      opts.classFilter && `class~="${opts.classFilter}"`,
      opts.axIdContains && `ax_id~="${opts.axIdContains}"`,
      opts.textContains && `text~="${opts.textContains}"`,
    ].filter(Boolean).join(" + ")
  })`);
  if (lineCount >= maxLines) lines.push(`… truncated at ${maxLines} lines; raise max_lines or refine filters`);
  return lines.join("\n");
}
