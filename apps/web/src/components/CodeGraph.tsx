import { memo, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D, { type ForceGraphMethods as Methods3D } from 'react-force-graph-3d';
import ForceGraph2D, { type ForceGraphMethods as Methods2D } from 'react-force-graph-2d';
import * as THREE from 'three';
import { Maximize2, Minus, Plus, RotateCcw, Focus, Layers3, MousePointer2 } from 'lucide-react';
import { KIND_META, type CodeEdge, type CodeNode, type Snapshot } from '../lib/types';

type Positioned = CodeNode & { x: number; y: number; z: number; fx: number; fy: number; fz: number };
type GraphMode = '3d' | '2d';

function labelCanvas(node: CodeNode, selected: boolean) {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 188;
  const ctx = canvas.getContext('2d')!;
  const color = KIND_META[node.kind]?.color || '#92a0ad';
  ctx.shadowColor = selected ? '#d5f78a55' : '#00000077'; ctx.shadowBlur = selected ? 22 : 12;
  ctx.fillStyle = selected ? '#222d23' : '#191f24'; ctx.strokeStyle = selected ? '#d5f78a' : color + '65'; ctx.lineWidth = selected ? 3 : 2;
  ctx.beginPath(); ctx.roundRect(12, 12, 616, 160, 20); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
  ctx.fillStyle = color + '20'; ctx.beginPath(); ctx.roundRect(34, 44, 66, 66, 14); ctx.fill();
  ctx.fillStyle = color; ctx.font = 'bold 37px monospace'; ctx.textAlign = 'center'; ctx.fillText(KIND_META[node.kind]?.short || '◇', 67, 90); ctx.textAlign = 'left';
  ctx.fillStyle = '#eef2f1'; ctx.font = '500 58px -apple-system, BlinkMacSystemFont, sans-serif';
  const name = node.name.length > 15 ? node.name.slice(0, 14) + '…' : node.name; ctx.fillText(name, 122, 82);
  ctx.fillStyle = '#8e9a9f'; ctx.font = '31px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText(node.kind === 'repository' ? 'repository' : node.entry ? 'entry point' : KIND_META[node.kind]?.label.toLowerCase() || node.kind, 123, 133);
  if (node.entry) { ctx.fillStyle = '#d5f78a'; ctx.beginPath(); ctx.arc(593, 48, 7, 0, Math.PI * 2); ctx.fill(); }
  return canvas;
}

function layout(snapshot: Snapshot, selectedId: string, focus: boolean, showData: boolean) {
  const all = snapshot.graph.nodes;
  const selected = all.find(n => n.id === selectedId);
  const visible = new Set<string>();
  const positions = new Map<string, [number, number, number]>();
  if (focus && selected) {
    visible.add(selected.id); positions.set(selected.id, [0, 0, 25]);
    const incoming: string[] = [], outgoing: string[] = [];
    for (const edge of snapshot.graph.edges) {
      if (edge.kind === 'contains') continue;
      if (edge.source === selected.id && edge.target !== selected.id && !outgoing.includes(edge.target)) outgoing.push(edge.target);
      if (edge.target === selected.id && edge.source !== selected.id && !incoming.includes(edge.source)) incoming.push(edge.source);
    }
    incoming.slice(0, 12).forEach((id, i, list) => { visible.add(id); positions.set(id, [-210, (i - (list.length - 1) / 2) * 75, -15]); });
    outgoing.slice(0, 12).forEach((id, i, list) => { visible.add(id); positions.set(id, [210, (i - (list.length - 1) / 2) * 75, 10 + (i % 3) * 9]); });
    if (visible.size === 1) {
      const children = all.filter(n => n.parentId === selected.id).slice(0, 10);
      children.forEach((node, i) => { visible.add(node.id); positions.set(node.id, [210, (i - (children.length - 1) / 2) * 70, 0]); });
    }
  } else {
    const root = all.find(n => n.kind === 'repository');
    if (root) { visible.add(root.id); positions.set(root.id, [-55, 0, 45]); }
    const files = all.filter(n => n.kind === 'file').slice(0, 18);
    files.forEach((file, i) => {
      const angle = i / files.length * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(angle) * 225 - 35, y = Math.sin(angle) * 170;
      visible.add(file.id); positions.set(file.id, [x, y, (i % 3 - 1) * 30]);
      const children = all.filter(n => n.parentId === file.id && (showData || n.kind !== 'constant'));
      const principal = children.find(n => n.entry) || children.find(n => n.kind === 'class') || children.find(n => n.kind === 'function') || children[0];
      const symbols = new Set([principal?.id, ...(selected?.path === file.path ? [selected.id] : []), ...(showData ? children.filter(n => n.kind === 'constant').slice(0, 2).map(n => n.id) : [])]);
      let offset = 0;
      for (const id of symbols) if (id) { visible.add(id); positions.set(id, [x + Math.cos(angle) * 155, y + Math.sin(angle) * 100 + offset * 53, 10 + (i % 3) * 24]); offset++; }
    });
    if (selected && !visible.has(selected.id)) { visible.add(selected.id); positions.set(selected.id, [0, -270, 40]); }
  }
  const nodes: Positioned[] = all.filter(n => visible.has(n.id)).map(node => {
    const [x, y, z] = positions.get(node.id) || [0, 0, 0];
    return { ...node, x, y, z, fx: x, fy: y, fz: z };
  });
  const links = snapshot.graph.edges.filter(edge => visible.has(edge.source) && visible.has(edge.target)).map(edge => ({ ...edge }));
  return { nodes, links };
}

export const CodeGraph = memo(function CodeGraph({ snapshot, selectedId, onSelect, mode, setMode, focus, setFocus, showData }: {
  snapshot: Snapshot; selectedId: string; onSelect: (id: string) => void;
  mode: GraphMode; setMode: (mode: GraphMode) => void; focus: boolean; setFocus: (focus: boolean) => void; showData: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const graph3 = useRef<Methods3D<Positioned, CodeEdge> | undefined>(undefined);
  const graph2 = useRef<Methods2D<Positioned, CodeEdge> | undefined>(undefined);
  const [size, setSize] = useState({ width: 800, height: 700 });
  const [hovered, setHovered] = useState<CodeNode | null>(null);
  const [ready, setReady] = useState(false);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const data = useMemo(() => layout(snapshot, selectedId, focus, showData), [snapshot, selectedId, focus, showData]);
  const objects = useMemo(() => {
    const result = new Map<string, THREE.Sprite>();
    for (const node of data.nodes) {
      const texture = new THREE.CanvasTexture(labelCanvas(node, node.id === selectedId)); texture.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
      sprite.scale.set(node.kind === 'repository' ? 175 : 156, node.kind === 'repository' ? 51.4 : 45.8, 1);
      result.set(node.id, sprite);
    }
    return result;
  }, [data, selectedId]);
  useEffect(() => () => { objects.forEach(sprite => { sprite.material.map?.dispose(); sprite.material.dispose(); }); }, [objects]);
  useEffect(() => {
    const observer = new ResizeObserver(entries => { const { width, height } = entries[0].contentRect; setSize({ width, height }); });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  function fit(duration = reducedMotion ? 0 : 450) {
    if (!data.nodes.length) return;
    const minX = Math.min(...data.nodes.map(n => n.x)) - 90, maxX = Math.max(...data.nodes.map(n => n.x)) + 90;
    const minY = Math.min(...data.nodes.map(n => n.y)) - 40, maxY = Math.max(...data.nodes.map(n => n.y)) + 40;
    const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 + (mode === '3d' ? 28 : -28), z: 0 };
    if (mode === '3d' && graph3.current) {
      const camera = graph3.current.camera() as THREE.PerspectiveCamera;
      const tangent = Math.tan((camera.fov || 50) * Math.PI / 360);
      const availableHeight = Math.max(180, size.height - 220), availableWidth = Math.max(220, size.width - 65);
      const distance = Math.max((maxY - minY) / (2 * tangent) * size.height / availableHeight, (maxX - minX) / (2 * tangent * size.width / size.height) * size.width / availableWidth) + 50;
      graph3.current.cameraPosition({ x: center.x + 10, y: center.y + 8, z: distance }, center, duration);
    } else if (graph2.current) {
      graph2.current.centerAt(center.x, center.y, duration);
      graph2.current.zoom(Math.min((size.width - 60) / (maxX - minX), (size.height - 225) / (maxY - minY)), duration);
    }
  }
  useEffect(() => {
    setReady(false);
    const timer = setTimeout(() => { fit(0); setReady(true); }, 160);
    return () => clearTimeout(timer);
  }, [snapshot.id, mode, focus, focus ? selectedId : '', size.width, size.height]);
  const linkColor = (edge: CodeEdge) => edge.kind === 'calls' ? '#7ba48f' : edge.kind === 'imports' ? '#58718e' : '#3b464d';
  const shared = { graphData: data, width: size.width, height: size.height, backgroundColor: '#10141600', cooldownTicks: 0, nodeLabel: () => '', onNodeClick: (node: Positioned) => onSelect(node.id), onNodeHover: (node: Positioned | null) => { setHovered(node); if (container.current) container.current.style.cursor = node ? 'pointer' : 'grab'; }, linkColor, linkDirectionalArrowLength: (edge: CodeEdge) => edge.kind === 'contains' ? 0 : 4, linkDirectionalArrowRelPos: 0.81, linkCurvature: (edge: CodeEdge) => edge.kind === 'calls' ? 0.15 : 0.05, linkWidth: (edge: CodeEdge) => edge.kind === 'calls' ? 1.1 : 0.65 };
  return <div className={`code-graph ${ready ? 'graph-ready' : ''}`} ref={container} aria-label="Interactive code graph. Use the explorer for keyboard navigation.">
    <div className="graph-grid" />
    {mode === '3d' ? <ForceGraph3D<Positioned, CodeEdge> ref={graph3} {...shared} nodeThreeObject={node => objects.get(node.id)!} nodeVal={25} linkOpacity={0.65} showNavInfo={false} enableNodeDrag={false} controlType="orbit" /> : <ForceGraph2D<Positioned, CodeEdge> ref={graph2} {...shared} enableNodeDrag={false} nodeCanvasObject={(node, ctx) => {
      const canvas = objects.get(node.id)?.material.map?.image as HTMLCanvasElement | undefined;
      if (canvas) ctx.drawImage(canvas, node.x - 78, node.y - 22.9, 156, 45.8);
    }} nodePointerAreaPaint={(node, color, ctx) => { ctx.fillStyle = color; ctx.fillRect(node.x - 78, node.y - 22.9, 156, 45.8); }} />}
    <div className="graph-topline"><div><span className="eyebrow">THE BIG PICTURE</span><h1>{focus ? 'A closer look.' : 'See how it all connects.'}</h1><p>{focus ? 'The selected node and its immediate relationships.' : 'Follow the connections. Find your way through the code.'}</p></div><div className="view-switch" aria-label="Graph dimension"><button className={mode === '2d' ? 'active' : ''} onClick={() => setMode('2d')}>2D</button><button className={mode === '3d' ? 'active' : ''} onClick={() => setMode('3d')}>3D<span className="tiny-dot" /></button></div></div>
    <div className="graph-bottomline"><span><MousePointer2 size={13} />Click a node to explore <span className="hint-separator">·</span> Scroll to zoom</span><span>{data.nodes.length} of {snapshot.graph.nodes.length} nodes visible</span></div>
    <div className="graph-controls"><button className={`icon-button ${focus ? 'active' : ''}`} aria-label={focus ? 'Show repository overview' : 'Focus on selected node'} title="Focus selected node" onClick={() => setFocus(!focus)}>{focus ? <Layers3 size={17} /> : <Focus size={17} />}</button><div className="control-divider" /><button className="icon-button" aria-label="Zoom in" onClick={() => { if (mode === '2d' && graph2.current) graph2.current.zoom(graph2.current.zoom() * 1.3, 250); else if (graph3.current) { const camera = graph3.current.camera().position; graph3.current.cameraPosition({ x: camera.x * 0.8, y: camera.y * 0.8, z: camera.z * 0.8 }, undefined, 250); } }}><Plus size={17} /></button><button className="icon-button" aria-label="Zoom out" onClick={() => { if (mode === '2d' && graph2.current) graph2.current.zoom(graph2.current.zoom() / 1.3, 250); else if (graph3.current) { const camera = graph3.current.camera().position; graph3.current.cameraPosition({ x: camera.x * 1.25, y: camera.y * 1.25, z: camera.z * 1.25 }, undefined, 250); } }}><Minus size={17} /></button><button className="icon-button" aria-label="Fit graph to screen" title="Fit view" onClick={() => fit()}><Maximize2 size={16} /></button><button className="icon-button" aria-label="Reset graph view" onClick={() => { setFocus(false); fit(); }}><RotateCcw size={15} /></button></div>
    {hovered && <div className="graph-hover-label"><span style={{ color: KIND_META[hovered.kind].color }}>{KIND_META[hovered.kind].label}</span><strong>{hovered.name}</strong><span>{hovered.path || 'Repository root'}</span></div>}
  </div>;
});
