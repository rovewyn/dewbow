import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, CircleAlert, Monitor, Search, X } from "lucide-react";
import { Button } from "@dewbow/ui/ui";
import { Input } from "@dewbow/ui/ui";
import type { SessionTreeModel, SessionTreeNode } from "./model";
import "./session-tree.css";

interface SessionTreeViewProps {
  model: SessionTreeModel;
  search: string;
  onSearchChange: (value: string) => void;
  onSelect: (sessionId: string) => void;
  error?: string;
}

export function SessionTreeView({ model, search, onSearchChange, onSelect, error }: SessionTreeViewProps) {
  const id = useId();
  const tree = useRef<HTMLUListElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const knownHosts = useRef(new Set<string>());
  const revealedPath = useRef("");
  const [expanded, setExpanded] = useState(new Set<string>());
  const [searchCollapsed, setSearchCollapsed] = useState(new Set<string>());
  const [focused, setFocused] = useState<string | null>(null);
  const hostKey = JSON.stringify(model.hostIds);
  const selectionKey = JSON.stringify([model.selected?.id, model.selectedPath]);
  useEffect(() => {
    const hosts: string[] = JSON.parse(hostKey);
    const newHosts = hosts.filter(host => !knownHosts.current.has(host));
    hosts.forEach(host => knownHosts.current.add(host));
    if (newHosts.length) setExpanded(previous => new Set([...previous, ...newHosts]));
  }, [hostKey]);
  useEffect(() => {
    // Reveal a newly selected path once. Polling must not reopen a manually collapsed branch.
    if (revealedPath.current === selectionKey) return;
    revealedPath.current = selectionKey;
    const [, path]: [string | null, string[]] = JSON.parse(selectionKey);
    if (path.length) setExpanded(previous => new Set([...previous, ...path]));
  }, [selectionKey]);
  useEffect(() => { setSearchCollapsed(new Set()); }, [model.query]);
  const isOpen = (node: SessionTreeNode) => model.query ? !searchCollapsed.has(node.id) : expanded.has(node.id);
  const visible: { node: SessionTreeNode; parentId: string | null }[] = [];
  function collect(nodes: SessionTreeNode[], parentId: string | null) {
    for (const node of nodes) {
      visible.push({ node, parentId });
      if (isOpen(node)) collect(node.children, node.id);
    }
  }
  collect(model.nodes, null);
  const tabStop = visible.some(item => item.node.id === focused) ? focused :
    visible.find(item => item.node.id === model.selected?.id)?.node.id ?? visible[0]?.node.id;
  function focusNode(nodeId: string, preventScroll = false) {
    setFocused(nodeId);
    const element = [...(tree.current?.querySelectorAll<HTMLElement>("[data-tree-node]") ?? [])]
      .find(item => item.dataset.treeNode === nodeId);
    element?.focus({ preventScroll });
  }
  function toggle(node: SessionTreeNode) {
    const update = (previous: Set<string>) => {
      const next = new Set(previous);
      next.has(node.id) ? next.delete(node.id) : next.add(node.id);
      return next;
    };
    if (model.query) setSearchCollapsed(update); else setExpanded(update);
    focusNode(node.id, true);
  }
  function activate(node: SessionTreeNode) {
    if (node.sessionId) onSelect(node.sessionId); else if (node.children.length) toggle(node);
    focusNode(node.id, true);
  }
  function navigate(event: KeyboardEvent<HTMLLIElement>, node: SessionTreeNode) {
    // Nested tree items bubble key events; only the focused item handles navigation.
    if (event.target !== event.currentTarget) return;
    const index = visible.findIndex(item => item.node.id === node.id);
    let target: string | undefined;
    switch (event.key) {
      case "ArrowDown": target = visible[index + 1]?.node.id; break;
      case "ArrowUp": target = visible[index - 1]?.node.id; break;
      case "Home": target = visible[0]?.node.id; break;
      case "End": target = visible.at(-1)?.node.id; break;
      case "ArrowRight":
        if (node.children.length && !isOpen(node)) toggle(node);
        else target = node.children[0]?.id;
        break;
      case "ArrowLeft":
        if (node.children.length && isOpen(node)) toggle(node);
        else target = visible[index]?.parentId ?? undefined;
        break;
      case "Enter": case " ": activate(node); break;
      default: return;
    }
    event.preventDefault(); event.stopPropagation();
    if (target) focusNode(target);
  }
  function title(node: SessionTreeNode) {
    const index = model.query ? node.title.toLowerCase().indexOf(model.query) : -1;
    if (index < 0) return node.title;
    return <>{node.title.slice(0, index)}<mark>{node.title.slice(index, index + model.query.length)}</mark>{node.title.slice(index + model.query.length)}</>;
  }
  function renderNode(node: SessionTreeNode, depth: number) {
    const open = isOpen(node), host = node.kind === "host";
    const selected = node.id === model.selected?.id;
    const tooltip = [node.title, node.statusLabel, ...node.metadata, node.parentWarning].filter(Boolean).join("\n");
    const ancestor = Boolean(model.query && !host && !node.searchText.includes(model.query));
    return <li key={node.id} role="treeitem" data-tree-node={node.id} tabIndex={tabStop === node.id ? 0 : -1}
      aria-label={`${node.title}, ${node.statusLabel}${node.parentWarning ? `, ${node.parentWarning}` : ""}`}
      aria-expanded={node.children.length ? open : undefined} aria-selected={host ? undefined : selected}
      onFocus={event => { if (event.target === event.currentTarget) setFocused(node.id); }}
      onKeyDown={event => navigate(event, node)} className={host ? "session-tree-host" : undefined}>
      <div className={`session-tree-row${selected ? " is-selected" : ""}${ancestor ? " is-ancestor" : ""}`} style={{ paddingInlineStart: host ? 8 : 24 + depth * 16 }}>
        {host ? <Button variant="ghost" className="session-tree-host-button" tabIndex={-1} title={tooltip} onClick={() => activate(node)}>
          {node.children.length ? (open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />) : <span className="session-tree-leaf-space" />}<Monitor aria-hidden="true" />
          <span className="session-tree-title">{node.title}</span>
          <span className={`session-tree-host-status tone-${node.statusTone}`}><span aria-hidden="true" className="session-tree-dot" />{node.statusLabel}</span>
        </Button> : <>
          {node.children.length ? <Button variant="ghost" size="icon-xs" className="session-tree-toggle" tabIndex={-1}
            aria-label={`${open ? "Collapse" : "Expand"} ${node.title}`} onClick={() => toggle(node)}>
            {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </Button> : <span className="session-tree-leaf-space" />}
          <Button variant="ghost" className="session-tree-select" tabIndex={-1} title={tooltip}
            aria-current={selected ? "true" : undefined} onClick={() => activate(node)}>
            <span className="session-tree-title">{title(node)}</span>
            {node.parentWarning && <CircleAlert aria-label={node.parentWarning} className="session-tree-warning" />}
            {node.statusLabel !== "Idle" && <span className={`session-tree-state tone-${node.statusTone}`}>{node.statusLabel}</span>}
          </Button>
        </>}
      </div>
      {node.children.length > 0 && <ul role="group" hidden={!open}>{node.children.map(child => renderNode(child, host ? 0 : depth + 1))}</ul>}
    </li>;
  }
  return <div className="session-tree-view">
    <div className="session-tree-heading"><h2 id={`${id}-heading`}>Sessions</h2><span>{model.hostIds.length} host{model.hostIds.length === 1 ? "" : "s"}</span></div>
    <div className="session-tree-search">
      <label htmlFor={`${id}-search`} className="sr-only">Find a conversation by name, directory, or ID</label>
      <Search aria-hidden="true" className="session-tree-search-icon" />
      <Input ref={input} id={`${id}-search`} type="search" placeholder="Search sessions" value={search}
        onChange={event => onSearchChange(event.target.value)} onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onSearchChange(""); }
        }} />
      {search && <Button variant="ghost" size="icon-xs" className="session-tree-clear" aria-label="Clear search"
        onClick={() => { onSearchChange(""); input.current?.focus(); }}><X aria-hidden="true" /></Button>}
    </div>
    <div className="session-tree-search-status" role="status">{model.query ? `${model.matchCount} matching session${model.matchCount === 1 ? "" : "s"}` : ""}</div>
    {error && <p className="session-tree-error" role="status">{error}</p>}
    {model.nodes.length > 0 && <ul ref={tree} role="tree" aria-labelledby={`${id}-heading`} className="session-tree-nodes">
      {model.nodes.map(node => renderNode(node, 0))}
    </ul>}
    {!model.hostIds.length ? <p className="session-tree-empty">No local host is available. Run dewbow doctor to check the daemon.</p> :
      model.query && !model.matchCount ? <p className="session-tree-empty">No sessions found.</p> :
      !model.sessionCount && <p className="session-tree-empty">Create a session on this machine.</p>}
    {model.selected && <div className="session-tree-selection" role="status">
      <span>Selected session</span><strong>{model.selected.title}</strong>
      <span>{model.selected.metadata.slice(0, 3).join(" · ")}{model.query && !model.selected.searchText.includes(model.query) ? " · Not a search match" : ""}</span>
    </div>}
  </div>;
}
