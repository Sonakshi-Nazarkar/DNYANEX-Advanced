import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { api } from '../services/api';
import {
  Claim,
  Conflict,
  GapOrMissingEvidence,
  DependencyGraphResponse,
  DependencyNode,
  DependencyNodeType,
  DriftAnalysisReport,
  DriftAlert,
  DriftCategory
} from '../types';
import {
  AlertTriangle,
  ShieldAlert,
  Flame,
  ArrowRight,
  ShieldCheck,
  Network,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  FileCode,
  Info,
  Search,
  RefreshCw,
  GitCompareArrows,
  CheckCircle2,
  UserCheck,
  Clock,
  Layers,
  ExternalLink
} from 'lucide-react';

const NODE_STYLE_MAP: Record<
  DependencyNodeType,
  { stroke: string; fillTint: string; text: string; label: string }
> = {
  OWNER: { stroke: '#6D28D9', fillTint: '#F5F0FF', text: 'text-[#6D28D9]', label: 'Owner' },
  DECISION: { stroke: '#8B5CF6', fillTint: '#FAF8FF', text: 'text-[#8B5CF6]', label: 'Decision' },
  DEPENDENCY: { stroke: '#7C3AED', fillTint: '#F5F0FF', text: 'text-[#7C3AED]', label: 'Dependency' },
  BLOCKER: { stroke: '#DC2626', fillTint: '#FEE2E2', text: 'text-[#DC2626]', label: 'Blocker' },
  TASK: { stroke: '#D97706', fillTint: '#FEF3C7', text: 'text-[#D97706]', label: 'Task' },
  RISK: { stroke: '#DC2626', fillTint: '#FEF2F2', text: 'text-[#DC2626]', label: 'Risk' }
};

const DRIFT_CATEGORY_LABELS: Record<DriftCategory, string> = {
  OUTDATED_CLAIM: 'Outdated Claim',
  CHANGED_RESPONSIBILITY: 'Changed Responsibility',
  UNRESOLVED_BLOCKER: 'Unresolved Blocker',
  CONFLICTING_UPDATE: 'Conflicting Update',
  CRITICAL_GAP: 'Critical Knowledge Gap'
};

export const RiskMatrix: React.FC = () => {
  const { activeProject, setActiveView, setSelectedClaim, addToast, refreshProjectData } = useApp();

  const [claims, setClaims] = useState<Claim[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [gaps, setGaps] = useState<GapOrMissingEvidence[]>([]);
  const [graphData, setGraphData] = useState<DependencyGraphResponse | null>(null);
  const [driftReport, setDriftReport] = useState<DriftAnalysisReport | null>(null);

  const [loading, setLoading] = useState(false);
  const [scanningDrift, setScanningDrift] = useState(false);
  const [actionAlertId, setActionAlertId] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'TOPOLOGY' | 'DRIFT' | 'RISKS' | 'GAPS'>('TOPOLOGY');

  // Graph interaction state
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [filterNodeType, setFilterNodeType] = useState<'ALL' | DependencyNodeType>('ALL');
  const [graphSearch, setGraphSearch] = useState<string>('');
  const [impactOnlyMode, setImpactOnlyMode] = useState<boolean>(false);
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>({});
  const draggingRef = useRef<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Drift filter state
  const [driftFilter, setDriftFilter] = useState<'ALL' | DriftCategory>('ALL');

  const loadAllIntelligence = async (projectId: string) => {
    try {
      setLoading(true);
      const [cData, confData, gData, depData, dReport] = await Promise.all([
        api.getClaims(projectId),
        api.getConflicts(projectId),
        api.getGaps(projectId),
        api.getDependencyGraph(projectId),
        api.getDriftAnalysis(projectId)
      ]);
      setClaims(cData);
      setConflicts(confData);
      setGaps(gData);
      setGraphData(depData);
      setDriftReport(dReport);

      const posMap: Record<string, { x: number; y: number }> = {};
      depData.nodes.forEach(n => {
        posMap[n.id] = { x: n.x, y: n.y };
      });
      setNodePositions(posMap);

      if (depData.nodes.length > 0) {
        const defaultNode =
          depData.nodes.find(n => n.node_type === 'DECISION') ||
          depData.nodes.find(n => n.node_type === 'BLOCKER') ||
          depData.nodes[0];
        setSelectedNodeId(prev =>
          prev && depData.nodes.some(n => n.id === prev) ? prev : defaultNode.id
        );
      }
    } catch (err: any) {
      addToast('error', 'Failed to load intelligence workspace', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!activeProject?.id) return;
    loadAllIntelligence(activeProject.id);
  }, [activeProject?.id]);

  // Compute Upstream Drivers & Transitive Downstream Blast Radius via BFS when a node is selected
  const {
    selectedNode,
    upstreamNodes,
    downstreamNodes,
    highlightedNodeIds,
    highlightedEdgeIds,
    directConnections
  } = useMemo(() => {
    if (!graphData || !selectedNodeId) {
      return {
        selectedNode: null as DependencyNode | null,
        upstreamNodes: [] as DependencyNode[],
        downstreamNodes: [] as DependencyNode[],
        highlightedNodeIds: new Set<string>(),
        highlightedEdgeIds: new Set<string>(),
        directConnections: [] as { edge: DependencyGraphResponse['edges'][number]; target: DependencyNode; direction: 'OUT' | 'IN' }[]
      };
    }

    const nodeMap = new Map<string, DependencyNode>(graphData.nodes.map(n => [n.id, n]));
    const sel = nodeMap.get(selectedNodeId) || null;
    if (!sel) {
      return {
        selectedNode: null,
        upstreamNodes: [],
        downstreamNodes: [],
        highlightedNodeIds: new Set<string>(),
        highlightedEdgeIds: new Set<string>(),
        directConnections: []
      };
    }

    // BFS Downstream (from -> to, plus bidirectional for CONFLICTS_WITH)
    const downstreamSet = new Set<string>();
    const downQueue = [sel.id];
    const seenDown = new Set([sel.id]);
    const activeEdges = new Set<string>();

    while (downQueue.length > 0) {
      const curr = downQueue.shift()!;
      for (const e of graphData.edges) {
        if (e.from === curr) {
          activeEdges.add(e.id);
          if (!seenDown.has(e.to)) {
            seenDown.add(e.to);
            downstreamSet.add(e.to);
            downQueue.push(e.to);
          }
        } else if (e.relation === 'CONFLICTS_WITH' && e.to === curr) {
          activeEdges.add(e.id);
          if (!seenDown.has(e.from)) {
            seenDown.add(e.from);
            downstreamSet.add(e.from);
            downQueue.push(e.from);
          }
        }
      }
    }

    // BFS Upstream (to -> from)
    const upstreamSet = new Set<string>();
    const upQueue = [sel.id];
    const seenUp = new Set([sel.id]);
    while (upQueue.length > 0) {
      const curr = upQueue.shift()!;
      for (const e of graphData.edges) {
        if (e.to === curr) {
          activeEdges.add(e.id);
          if (!seenUp.has(e.from)) {
            seenUp.add(e.from);
            upstreamSet.add(e.from);
            upQueue.push(e.from);
          }
        }
      }
    }

    const combinedHighlight = new Set<string>([sel.id, ...downstreamSet, ...upstreamSet]);
    const direct: { edge: DependencyGraphResponse['edges'][number]; target: DependencyNode; direction: 'OUT' | 'IN' }[] = [];
    for (const e of graphData.edges) {
      if (e.from === sel.id && nodeMap.has(e.to)) {
        direct.push({ edge: e, target: nodeMap.get(e.to)!, direction: 'OUT' });
      } else if (e.to === sel.id && nodeMap.has(e.from)) {
        direct.push({ edge: e, target: nodeMap.get(e.from)!, direction: 'IN' });
      }
    }

    return {
      selectedNode: sel,
      upstreamNodes: Array.from(upstreamSet).map(id => nodeMap.get(id)!).filter(Boolean),
      downstreamNodes: Array.from(downstreamSet).map(id => nodeMap.get(id)!).filter(Boolean),
      highlightedNodeIds: combinedHighlight,
      highlightedEdgeIds: activeEdges,
      directConnections: direct
    };
  }, [graphData, selectedNodeId]);

  const visibleNodes = useMemo(() => {
    if (!graphData) return [];
    const q = graphSearch.trim().toLowerCase();
    return graphData.nodes.filter(n => {
      if (filterNodeType !== 'ALL' && n.node_type !== filterNodeType) return false;
      if (impactOnlyMode && selectedNodeId && !highlightedNodeIds.has(n.id)) return false;
      if (q) {
        const hay = `${n.label} ${n.statement} ${n.owner || ''} ${n.source_name || ''}`.toLowerCase();
        return hay.includes(q);
      }
      return true;
    });
  }, [graphData, filterNodeType, impactOnlyMode, selectedNodeId, highlightedNodeIds, graphSearch]);

  const visibleNodeIdSet = useMemo(() => new Set(visibleNodes.map(n => n.id)), [visibleNodes]);

  // SVG Drag Handlers
  const toSvgCoords = (clientX: number, clientY: number) => {
    if (!svgRef.current) return { x: 0, y: 0 };
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 1120;
    const y = ((clientY - rect.top) / rect.height) * 620;
    return { x, y };
  };

  const handleNodePointerDown = (e: React.PointerEvent, nodeId: string) => {
    e.stopPropagation();
    setSelectedNodeId(nodeId);
    const pt = toSvgCoords(e.clientX, e.clientY);
    const currPos = nodePositions[nodeId] || { x: 0, y: 0 };
    draggingRef.current = {
      nodeId,
      offsetX: currPos.x - pt.x,
      offsetY: currPos.y - pt.y
    };
  };

  const handleSvgPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const pt = toSvgCoords(e.clientX, e.clientY);
    const clampedX = Math.max(95, Math.min(1025, pt.x + draggingRef.current.offsetX));
    const clampedY = Math.max(40, Math.min(580, pt.y + draggingRef.current.offsetY));
    const draggedId = draggingRef.current.nodeId;
    setNodePositions(prev => ({
      ...prev,
      [draggedId]: { x: clampedX, y: clampedY }
    }));
  };

  const handleSvgPointerUp = () => {
    draggingRef.current = null;
  };

  const resetGraphLayout = () => {
    if (!graphData) return;
    const posMap: Record<string, { x: number; y: number }> = {};
    graphData.nodes.forEach(n => {
      posMap[n.id] = { x: n.x, y: n.y };
    });
    setNodePositions(posMap);
    setZoomLevel(1);
    setFilterNodeType('ALL');
    setGraphSearch('');
    setImpactOnlyMode(false);
  };

  // Drift Intelligence Handlers
  const handleRunDriftScan = async () => {
    if (!activeProject) return;
    try {
      setScanningDrift(true);
      const report = await api.runDriftAnalysis(activeProject.id);
      setDriftReport(report);
      await refreshProjectData();
      addToast(
        report.summary.critical_count > 0 ? 'warning' : 'success',
        'Drift & Risk Scan Complete',
        `Detected ${report.summary.open_alerts} active alert(s) across ${report.sources_compared} source(s).`
      );
    } catch (err: any) {
      addToast('error', 'Drift Scan Failed', err.message);
    } finally {
      setScanningDrift(false);
    }
  };

  const handleQueueReverification = async (alert: DriftAlert) => {
    if (!activeProject) return;
    try {
      setActionAlertId(alert.id);
      const res = await api.queueDriftReverification(activeProject.id, alert.id);
      const updatedReport = await api.getDriftAnalysis(activeProject.id);
      setDriftReport(updatedReport);
      await refreshProjectData();
      addToast(
        'success',
        'Queued for Re-Verification',
        `${res.updated_claims.length} record(s) moved to PENDING in Human Review Desk.`
      );
    } catch (err: any) {
      addToast('error', 'Failed to queue re-verification', err.message);
    } finally {
      setActionAlertId(null);
    }
  };

  const handleResolveAlert = async (alert: DriftAlert) => {
    if (!activeProject) return;
    try {
      setActionAlertId(alert.id);
      await api.updateDriftAlertStatus(
        activeProject.id,
        alert.id,
        'RESOLVED',
        'Reviewed and verified against current project sources.'
      );
      const updatedReport = await api.getDriftAnalysis(activeProject.id);
      setDriftReport(updatedReport);
      await refreshProjectData();
      addToast('success', 'Drift Alert Resolved', alert.title);
    } catch (err: any) {
      addToast('error', 'Failed to resolve alert', err.message);
    } finally {
      setActionAlertId(null);
    }
  };

  const riskClaims = claims.filter(c => ['RISK', 'BLOCKER', 'DEPENDENCY'].includes(c.type));

  const visibleDriftAlerts = useMemo(() => {
    if (!driftReport) return [];
    if (driftFilter === 'ALL') return driftReport.alerts;
    return driftReport.alerts.filter(a => a.category === driftFilter);
  }, [driftReport, driftFilter]);

  return (
    <div className="p-4 sm:p-6 md:p-8 space-y-6 max-w-7xl mx-auto">
      {/* Page Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-6 border-b border-[#E9E2F5]">
        <div>
          <div className="flex items-center space-x-2 text-xs text-[#8B5CF6] font-semibold mb-1">
            <ShieldAlert className="w-4 h-4 text-[#8B5CF6]" />
            <span>Dependency Network & Knowledge Drift Engine</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-[#171717]">
            Knowledge Dependency Graph & Drift Intelligence
          </h1>
          <p className="text-xs sm:text-sm text-[#52525B] mt-1 max-w-3xl leading-relaxed">
            Trace how architectural decisions, owners, tasks, dependencies, blockers, and risks affect downstream deliverables—and detect outdated knowledge before publishing a handover.
          </p>
        </div>

        {/* View Switcher Tabs */}
        <div className="flex flex-wrap items-center bg-white border border-[#E9E2F5] p-1 rounded-xl self-start lg:self-auto shrink-0 gap-1">
          <button
            onClick={() => setActiveTab('TOPOLOGY')}
            className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'TOPOLOGY'
                ? 'bg-[#8B5CF6] text-white'
                : 'text-[#52525B] hover:text-[#171717]'
            }`}
          >
            <Network className="w-3.5 h-3.5" />
            <span>Dependency Graph</span>
          </button>
          <button
            onClick={() => setActiveTab('DRIFT')}
            className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'DRIFT'
                ? 'bg-[#8B5CF6] text-white'
                : 'text-[#52525B] hover:text-[#171717]'
            }`}
          >
            <GitCompareArrows className="w-3.5 h-3.5" />
            <span className="tabular-nums">
              Drift Intelligence ({driftReport?.summary.open_alerts ?? 0})
            </span>
          </button>
          <button
            onClick={() => setActiveTab('RISKS')}
            className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'RISKS'
                ? 'bg-[#8B5CF6] text-white'
                : 'text-[#52525B] hover:text-[#171717]'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            <span className="tabular-nums">Risks ({riskClaims.length})</span>
          </button>
          <button
            onClick={() => setActiveTab('GAPS')}
            className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'GAPS'
                ? 'bg-[#8B5CF6] text-white'
                : 'text-[#52525B] hover:text-[#171717]'
            }`}
          >
            <Flame className="w-3.5 h-3.5" />
            <span className="tabular-nums">Gaps ({gaps.length})</span>
          </button>
        </div>
      </div>

      {/* TAB 1: INTERACTIVE KNOWLEDGE DEPENDENCY GRAPH */}
      {activeTab === 'TOPOLOGY' && (
        <div className="space-y-4">
          {/* Controls Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-3.5 rounded-xl border border-[#E9E2F5]">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { id: 'ALL', label: 'All Components' },
                  { id: 'OWNER', label: `Owners (${graphData?.stats.owners || 0})` },
                  { id: 'DECISION', label: `Decisions (${graphData?.stats.decisions || 0})` },
                  { id: 'DEPENDENCY', label: `Dependencies (${graphData?.stats.dependencies || 0})` },
                  { id: 'BLOCKER', label: `Blockers (${graphData?.stats.blockers || 0})` },
                  { id: 'TASK', label: `Tasks (${graphData?.stats.tasks || 0})` },
                  { id: 'RISK', label: `Risks (${graphData?.stats.risks || 0})` }
                ] as const
              ).map(f => (
                <button
                  key={f.id}
                  onClick={() => setFilterNodeType(f.id)}
                  className={`px-2.5 py-1.5 text-xs rounded-lg font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                    filterNodeType === f.id
                      ? 'bg-[#8B5CF6] text-white'
                      : 'text-[#52525B] hover:text-[#171717] hover:bg-[#FAF8FF]'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-[#71717A] absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={graphSearch}
                  onChange={e => setGraphSearch(e.target.value)}
                  placeholder="Find component or owner..."
                  className="pl-8 pr-3 py-1.5 text-xs bg-[#FAF8FF] border border-[#E9E2F5] rounded-lg text-[#171717] placeholder-[#71717A] focus:outline-none focus:border-[#8B5CF6] w-48"
                />
              </div>

              <button
                onClick={() => setImpactOnlyMode(v => !v)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  impactOnlyMode
                    ? 'bg-[#F5F0FF] text-[#8B5CF6] border-[#8B5CF6]'
                    : 'bg-white text-[#52525B] border-[#E9E2F5] hover:text-[#171717]'
                }`}
              >
                {impactOnlyMode ? 'Showing Blast Radius Only' : 'Isolate Impact Path'}
              </button>

              <div className="flex items-center space-x-1">
                <span className="text-[11px] text-[#71717A] font-mono tabular-nums mr-1">
                  {Math.round(zoomLevel * 100)}%
                </span>
                <button
                  onClick={() => setZoomLevel(prev => Math.min(prev + 0.15, 1.5))}
                  aria-label="Zoom in"
                  className="p-1.5 text-[#52525B] hover:text-[#171717] bg-[#FAF8FF] rounded-md border border-[#E9E2F5] cursor-pointer"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setZoomLevel(prev => Math.max(prev - 0.15, 0.7))}
                  aria-label="Zoom out"
                  className="p-1.5 text-[#52525B] hover:text-[#171717] bg-[#FAF8FF] rounded-md border border-[#E9E2F5] cursor-pointer"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={resetGraphLayout}
                  aria-label="Reset layout and zoom"
                  title="Reset graph layout & filters"
                  className="p-1.5 text-[#52525B] hover:text-[#171717] bg-[#FAF8FF] rounded-md border border-[#E9E2F5] cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          {loading && !graphData ? (
            <div className="bg-white border border-[#E9E2F5] rounded-2xl p-12 text-center text-xs text-[#71717A]">
              Mapping project decisions, owners, tasks, dependencies, blockers, and risks...
            </div>
          ) : !graphData || graphData.nodes.length === 0 ? (
            <div className="bg-white border border-[#E9E2F5] rounded-2xl p-12 text-center space-y-3">
              <Network className="w-8 h-8 text-[#A78BFA] mx-auto" />
              <div className="text-sm font-bold text-[#171717]">No Knowledge Graph Components Yet</div>
              <p className="text-xs text-[#52525B] max-w-md mx-auto">
                Connect project sources and run AI Reconstruction to build an interactive dependency graph.
              </p>
              <button
                onClick={() => setActiveView('SOURCES')}
                className="px-4 py-2 rounded-xl bg-[#8B5CF6] text-white text-xs font-semibold cursor-pointer"
              >
                Go to Source Ingestion
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
              {/* Interactive Multi-Layer Graph Canvas */}
              <div className="lg:col-span-8 bg-[#FAF8FF] border border-[#E9E2F5] rounded-2xl overflow-hidden relative flex flex-col">
                {/* Column Guide Bar */}
                <div className="grid grid-cols-5 px-6 py-2.5 bg-white border-b border-[#E9E2F5] text-[11px] font-semibold text-[#52525B]">
                  <div>Owners</div>
                  <div>Decisions</div>
                  <div>Dependencies & Blockers</div>
                  <div>Tasks & Actions</div>
                  <div className="text-right">Risks & Issues</div>
                </div>

                <div className="px-4 py-2 flex items-center justify-between text-[11px] text-[#52525B] border-b border-[#E9E2F5] bg-[#FAF8FF]">
                  <span className="flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5 text-[#8B5CF6]" />
                    Click a node to inspect upstream drivers & downstream blast radius · Drag any node to reposition
                  </span>
                  <span className="font-mono tabular-nums text-[#71717A]">
                    {visibleNodes.length} nodes · {graphData.edges.length} links
                  </span>
                </div>

                <div className="flex-1 overflow-auto p-2">
                  <div
                    className="transition-transform duration-150 origin-top-left"
                    style={{ transform: `scale(${zoomLevel})` }}
                  >
                    <svg
                      ref={svgRef}
                      viewBox="0 0 1120 620"
                      className="w-full h-[560px] select-none touch-none"
                      style={{ minWidth: '860px' }}
                      onPointerMove={handleSvgPointerMove}
                      onPointerUp={handleSvgPointerUp}
                      onPointerLeave={handleSvgPointerUp}
                    >
                      <defs>
                        <marker
                          id="arrow-default"
                          viewBox="0 0 10 10"
                          refX="8"
                          refY="5"
                          markerWidth="6"
                          markerHeight="6"
                          orient="auto-start-reverse"
                        >
                          <path d="M 0 1 L 10 5 L 0 9 z" fill="#CBD5E1" />
                        </marker>
                        <marker
                          id="arrow-active"
                          viewBox="0 0 10 10"
                          refX="8"
                          refY="5"
                          markerWidth="6"
                          markerHeight="6"
                          orient="auto-start-reverse"
                        >
                          <path d="M 0 1 L 10 5 L 0 9 z" fill="#8B5CF6" />
                        </marker>
                        <marker
                          id="arrow-critical"
                          viewBox="0 0 10 10"
                          refX="8"
                          refY="5"
                          markerWidth="6"
                          markerHeight="6"
                          orient="auto-start-reverse"
                        >
                          <path d="M 0 1 L 10 5 L 0 9 z" fill="#DC2626" />
                        </marker>
                      </defs>

                      {/* Directed Edges */}
                      {graphData.edges.map(edge => {
                        if (!visibleNodeIdSet.has(edge.from) || !visibleNodeIdSet.has(edge.to)) {
                          return null;
                        }
                        const pFrom = nodePositions[edge.from];
                        const pTo = nodePositions[edge.to];
                        if (!pFrom || !pTo) return null;

                        const isHighlighted = highlightedEdgeIds.has(edge.id);
                        const isDimmed = Boolean(selectedNodeId) && !isHighlighted;
                        const isCrit = Boolean(edge.is_critical);

                        const startX = pFrom.x + (pTo.x > pFrom.x ? 78 : pTo.x < pFrom.x ? -78 : 0);
                        const startY = pFrom.y + (pTo.x === pFrom.x ? (pTo.y > pFrom.y ? 26 : -26) : 0);
                        const endX = pTo.x + (pTo.x > pFrom.x ? -82 : pTo.x < pFrom.x ? 82 : 0);
                        const endY = pTo.y + (pTo.x === pFrom.x ? (pTo.y > pFrom.y ? -28 : 28) : 0);

                        const ctrlX = (startX + endX) / 2;
                        const ctrlY = (startY + endY) / 2 - (pTo.x === pFrom.x ? 0 : 18);

                        const strokeColor = isCrit
                          ? '#DC2626'
                          : isHighlighted
                          ? '#8B5CF6'
                          : '#CBD5E1';

                        return (
                          <g key={edge.id} opacity={isDimmed ? 0.18 : isHighlighted ? 1 : 0.72}>
                            <path
                              d={`M ${startX} ${startY} Q ${ctrlX} ${ctrlY} ${endX} ${endY}`}
                              fill="none"
                              stroke={strokeColor}
                              strokeWidth={isHighlighted ? 2.25 : 1.35}
                              strokeDasharray={edge.relation === 'CONFLICTS_WITH' ? '5,4' : undefined}
                              markerEnd={
                                isCrit
                                  ? 'url(#arrow-critical)'
                                  : isHighlighted
                                  ? 'url(#arrow-active)'
                                  : 'url(#arrow-default)'
                              }
                            />
                            {isHighlighted && (
                              <g transform={`translate(${ctrlX}, ${ctrlY})`}>
                                <rect
                                  x={-48}
                                  y={-9}
                                  width={96}
                                  height={18}
                                  rx={4}
                                  fill="#FFFFFF"
                                  stroke={isCrit ? '#FECACA' : '#E9E2F5'}
                                  strokeWidth={1}
                                />
                                <text
                                  x={0}
                                  y={3}
                                  textAnchor="middle"
                                  fill={isCrit ? '#DC2626' : '#6D28D9'}
                                  fontSize="8.5"
                                  fontWeight="600"
                                >
                                  {edge.label.length > 18 ? edge.label.slice(0, 17) + '…' : edge.label}
                                </text>
                              </g>
                            )}
                          </g>
                        );
                      })}

                      {/* Interactive Nodes */}
                      {visibleNodes.map(node => {
                        const pos = nodePositions[node.id] || { x: node.x, y: node.y };
                        const style = NODE_STYLE_MAP[node.node_type];
                        const isSelected = selectedNodeId === node.id;
                        const isImpacted = highlightedNodeIds.has(node.id);
                        const isDimmed = Boolean(selectedNodeId) && !isImpacted;

                        return (
                          <g
                            key={node.id}
                            transform={`translate(${pos.x}, ${pos.y})`}
                            onPointerDown={e => handleNodePointerDown(e, node.id)}
                            className="cursor-grab active:cursor-grabbing"
                            opacity={isDimmed ? 0.28 : 1}
                          >
                            {isSelected && (
                              <rect
                                x={-86}
                                y={-31}
                                width={172}
                                height={62}
                                rx={13}
                                fill="none"
                                stroke="#8B5CF6"
                                strokeWidth={2}
                                opacity={0.45}
                              />
                            )}
                            <rect
                              x={-80}
                              y={-26}
                              width={160}
                              height={52}
                              rx={10}
                              fill="#FFFFFF"
                              stroke={isSelected ? '#8B5CF6' : style.stroke}
                              strokeWidth={isSelected ? 2.4 : 1.2}
                            />
                            <rect
                              x={-79}
                              y={-25}
                              width={158}
                              height={15}
                              rx={7}
                              fill={style.fillTint}
                            />
                            <text
                              x={-70}
                              y={-15}
                              fill={style.stroke}
                              fontSize="8"
                              fontWeight="700"
                              fontFamily="monospace"
                            >
                              {style.label.toUpperCase()}
                            </text>
                            <text
                              x={70}
                              y={-15}
                              textAnchor="end"
                              fill={node.severity === 'CRITICAL' ? '#DC2626' : '#71717A'}
                              fontSize="7.5"
                              fontWeight="700"
                              fontFamily="monospace"
                            >
                              {node.severity}
                            </text>
                            <text
                              x={0}
                              y={4}
                              textAnchor="middle"
                              fill="#171717"
                              fontSize="9.5"
                              fontWeight="700"
                            >
                              {node.label.length > 23 ? node.label.slice(0, 21) + '...' : node.label}
                            </text>
                            <text
                              x={0}
                              y={17}
                              textAnchor="middle"
                              fill="#52525B"
                              fontSize="7.5"
                            >
                              {node.subtitle.length > 26 ? node.subtitle.slice(0, 24) + '...' : node.subtitle}
                            </text>
                          </g>
                        );
                      })}
                    </svg>
                  </div>
                </div>
              </div>

              {/* Right-Side Impact & Blast-Radius Inspector */}
              <div className="lg:col-span-4 bg-white border border-[#E9E2F5] rounded-2xl p-5 flex flex-col justify-between space-y-4">
                {selectedNode ? (
                  <div className="space-y-4 overflow-y-auto max-h-[540px] pr-1">
                    {/* Unboxed Metadata Line */}
                    <div className="flex items-center justify-between text-xs pb-3 border-b border-[#E9E2F5]">
                      <div className="flex items-center gap-1.5 font-mono">
                        <span className={`font-bold ${NODE_STYLE_MAP[selectedNode.node_type].text}`}>
                          {selectedNode.node_type}
                        </span>
                        <span className="text-[#71717A]" aria-hidden="true">·</span>
                        <span
                          className={`font-bold ${
                            selectedNode.severity === 'CRITICAL'
                              ? 'text-[#DC2626]'
                              : selectedNode.severity === 'HIGH'
                              ? 'text-[#D97706]'
                              : 'text-[#52525B]'
                          }`}
                        >
                          {selectedNode.severity}
                        </span>
                      </div>
                      {selectedNode.reviewer_status && (
                        <span className="text-[11px] font-mono text-[#71717A]">
                          {selectedNode.reviewer_status}
                        </span>
                      )}
                    </div>

                    <div>
                      <h3 className="font-bold text-base text-[#171717] leading-snug">
                        {selectedNode.statement}
                      </h3>
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#52525B] mt-1.5">
                        <span>Owner: {selectedNode.owner || 'Unassigned'}</span>
                        {selectedNode.source_location && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">{selectedNode.source_location}</span>
                          </>
                        )}
                      </div>
                    </div>

                    {selectedNode.supporting_quote && (
                      <div className="bg-[#FAF8FF] p-3 rounded-xl border border-[#E9E2F5] text-xs space-y-1">
                        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#8B5CF6]">
                          <FileCode className="w-3.5 h-3.5" />
                          <span>Verbatim Source Evidence</span>
                        </div>
                        <blockquote className="italic text-[#171717] text-[11px] leading-relaxed">
                          "{selectedNode.supporting_quote}"
                        </blockquote>
                      </div>
                    )}

                    {/* Impact Blast Radius Summary */}
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="p-2.5 rounded-xl bg-[#FAF8FF] border border-[#E9E2F5]">
                        <div className="text-[11px] text-[#71717A]">Upstream Drivers</div>
                        <div className="text-lg font-bold font-mono tabular-nums text-[#171717]">
                          {upstreamNodes.length}
                        </div>
                      </div>
                      <div className="p-2.5 rounded-xl bg-[#F5F0FF] border border-[#E9E2F5]">
                        <div className="text-[11px] text-[#71717A]">Downstream Impacted</div>
                        <div className="text-lg font-bold font-mono tabular-nums text-[#8B5CF6]">
                          {downstreamNodes.length}
                        </div>
                      </div>
                    </div>

                    {/* Direct & Transitive Affected Components */}
                    <div className="space-y-2">
                      <div className="text-xs font-bold text-[#171717]">
                        Affected Components & Dependencies ({directConnections.length} direct, {downstreamNodes.length} downstream)
                      </div>
                      {downstreamNodes.length === 0 && upstreamNodes.length === 0 ? (
                        <p className="text-xs text-[#71717A]">
                          No upstream or downstream links mapped for this record yet.
                        </p>
                      ) : (
                        <div className="space-y-1.5 max-h-48 overflow-y-auto">
                          {directConnections.map(({ edge, target, direction }) => (
                            <button
                              key={`${edge.id}_${direction}`}
                              onClick={() => setSelectedNodeId(target.id)}
                              className="w-full text-left p-2.5 rounded-lg bg-[#FAF8FF] hover:bg-[#F5F0FF] border border-[#E9E2F5] transition-colors cursor-pointer"
                            >
                              <div className="flex items-center justify-between text-[11px] font-mono">
                                <span className={edge.is_critical ? 'text-[#DC2626] font-bold' : 'text-[#8B5CF6] font-semibold'}>
                                  {direction === 'OUT' ? `→ ${edge.label}` : `← ${edge.label}`}
                                </span>
                                <span className="text-[#71717A]">{target.node_type}</span>
                              </div>
                              <div className="text-xs font-medium text-[#171717] truncate mt-0.5">
                                {target.statement}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-12 text-[#71717A] text-xs">
                    Select any node to explore its dependency blast radius.
                  </div>
                )}

                {/* Bottom Action Controls */}
                <div className="pt-4 border-t border-[#E9E2F5] space-y-2">
                  {selectedNode?.claim_id && (
                    <button
                      onClick={() => {
                        const match = claims.find(c => c.id === selectedNode.claim_id);
                        if (match) setSelectedClaim(match);
                        setActiveView('CLAIM_LEDGER');
                      }}
                      className="w-full flex items-center justify-center space-x-2 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-semibold py-2.5 px-4 rounded-xl text-xs transition-colors cursor-pointer"
                    >
                      <span>Inspect in Claim Ledger</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => setActiveTab('DRIFT')}
                    className="w-full flex items-center justify-center space-x-2 bg-white hover:bg-[#FAF8FF] text-[#171717] border border-[#E9E2F5] font-semibold py-2.5 px-4 rounded-xl text-xs transition-colors cursor-pointer"
                  >
                    <GitCompareArrows className="w-3.5 h-3.5 text-[#8B5CF6]" />
                    <span>Open Drift & Risk Intelligence</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: KNOWLEDGE DRIFT & RISK INTELLIGENCE ENGINE */}
      {activeTab === 'DRIFT' && (
        <div className="space-y-6">
          {/* Action Header + Handover Safety Banner */}
          <div className="bg-white border border-[#E9E2F5] rounded-2xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs text-[#52525B] font-mono">
                <span>Engine: {driftReport?.model || 'Hybrid Structural + AI Drift Engine'}</span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">
                  {driftReport?.sources_compared || 0} sources compared ({driftReport?.modified_sources_count || 0} modified)
                </span>
              </div>
              <h2 className="text-base font-bold text-[#171717]">
                Source-to-Knowledge Drift Comparison & Re-Verification Queue
              </h2>
              <p className="text-xs text-[#52525B]">
                Compares newly added or edited project sources against previously verified claims to flag outdated specs, responsibility shifts, blockers, and contradictions.
              </p>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <button
                onClick={() => setActiveView('SOURCES')}
                className="px-3.5 py-2.5 rounded-xl bg-white border border-[#E9E2F5] hover:bg-[#FAF8FF] text-xs font-semibold text-[#171717] whitespace-nowrap cursor-pointer"
              >
                Update / Upload Source
              </button>
              <button
                onClick={handleRunDriftScan}
                disabled={scanningDrift}
                className="flex items-center space-x-2 bg-[#8B5CF6] hover:bg-[#7C3AED] disabled:opacity-50 text-white font-semibold px-4 py-2.5 rounded-xl text-xs whitespace-nowrap cursor-pointer transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${scanningDrift ? 'animate-spin' : ''}`} />
                <span>{scanningDrift ? 'Scanning Sources...' : 'Run AI Drift & Risk Scan'}</span>
              </button>
            </div>
          </div>

          {/* Tabular Summary Strip */}
          {driftReport && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {[
                { label: 'Active Alerts', value: driftReport.summary.open_alerts, tone: 'text-[#171717]' },
                { label: 'Critical Severity', value: driftReport.summary.critical_count, tone: 'text-[#DC2626]' },
                { label: 'Outdated Claims', value: driftReport.summary.outdated_claims_count, tone: 'text-[#D97706]' },
                { label: 'Changed Ownership', value: driftReport.summary.changed_responsibilities_count, tone: 'text-[#8B5CF6]' },
                {
                  label: 'Re-Verify Before Handover',
                  value: driftReport.summary.claims_needing_reverification.length,
                  tone: driftReport.summary.claims_needing_reverification.length > 0 ? 'text-[#DC2626]' : 'text-[#16A34A]'
                }
              ].map(m => (
                <div key={m.label} className="bg-white border border-[#E9E2F5] rounded-xl p-4">
                  <div className="text-[11px] text-[#71717A]">{m.label}</div>
                  <div className={`text-2xl font-bold font-mono tabular-nums mt-1 ${m.tone}`}>
                    {m.value}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Handover Safety Gate Status */}
          {driftReport && (
            <div
              className={`rounded-xl border p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs ${
                driftReport.summary.handover_safe_to_publish
                  ? 'bg-[#DCFCE7] border-[#BBF7D0] text-[#171717]'
                  : 'bg-[#FEE2E2] border-[#FECACA] text-[#171717]'
              }`}
            >
              <div className="flex items-start sm:items-center gap-2.5">
                {driftReport.summary.handover_safe_to_publish ? (
                  <CheckCircle2 className="w-4 h-4 text-[#16A34A] shrink-0 mt-0.5 sm:mt-0" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-[#DC2626] shrink-0 mt-0.5 sm:mt-0" />
                )}
                <div>
                  <span className="font-bold">
                    {driftReport.summary.handover_safe_to_publish
                      ? 'No Blocking Outdated-Claim Drift Detected'
                      : 'Handover Publication Blocked by Critical Knowledge Drift'}
                  </span>
                  <span className="text-[#52525B] ml-2">
                    {driftReport.summary.claims_needing_reverification.length > 0
                      ? `${driftReport.summary.claims_needing_reverification.length} record(s) recommended for re-verification before final handover.`
                      : 'Verified knowledge matches connected source revisions.'}
                  </span>
                </div>
              </div>
              <button
                onClick={() => setActiveView('REVIEW_DESK')}
                className="px-3 py-1.5 rounded-lg bg-white border border-[#E9E2F5] font-semibold text-xs text-[#171717] hover:bg-[#FAF8FF] whitespace-nowrap shrink-0 cursor-pointer"
              >
                Open Review Desk
              </button>
            </div>
          )}

          {/* Category Filter Segmented Control */}
          <div className="flex flex-wrap items-center gap-1.5 bg-white p-2 rounded-xl border border-[#E9E2F5]">
            {(
              [
                { id: 'ALL', label: 'All Alerts' },
                { id: 'OUTDATED_CLAIM', label: 'Outdated Claims' },
                { id: 'CHANGED_RESPONSIBILITY', label: 'Changed Responsibilities' },
                { id: 'UNRESOLVED_BLOCKER', label: 'Unresolved Blockers' },
                { id: 'CONFLICTING_UPDATE', label: 'Conflicting Updates' },
                { id: 'CRITICAL_GAP', label: 'Critical Gaps' }
              ] as const
            ).map(cat => (
              <button
                key={cat.id}
                onClick={() => setDriftFilter(cat.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  driftFilter === cat.id
                    ? 'bg-[#8B5CF6] text-white'
                    : 'text-[#52525B] hover:text-[#171717] hover:bg-[#FAF8FF]'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Alerts List */}
          <div className="space-y-4">
            {visibleDriftAlerts.length === 0 ? (
              <div className="bg-white border border-[#E9E2F5] rounded-2xl p-10 text-center space-y-2 text-xs text-[#71717A]">
                <ShieldCheck className="w-8 h-8 text-[#16A34A] mx-auto" />
                <div className="font-semibold text-[#171717]">No Drift Alerts in Selected Filter</div>
                <p>Run AI Drift & Risk Scan after uploading or modifying a source to check for new drift.</p>
              </div>
            ) : (
              visibleDriftAlerts.map(alert => {
                const isDone = alert.status === 'RESOLVED' || alert.status === 'DISMISSED';
                const isQueued = alert.status === 'REVERIFICATION_QUEUED';
                return (
                  <div
                    key={alert.id}
                    className={`bg-white rounded-2xl border p-5 space-y-4 transition-colors ${
                      alert.severity === 'CRITICAL' && !isDone
                        ? 'border-[#FECACA]'
                        : 'border-[#E9E2F5]'
                    }`}
                  >
                    <div className="flex flex-col md:flex-row md:items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
                          <span
                            className={`font-bold ${
                              alert.severity === 'CRITICAL'
                                ? 'text-[#DC2626]'
                                : alert.severity === 'HIGH'
                                ? 'text-[#D97706]'
                                : 'text-[#8B5CF6]'
                            }`}
                          >
                            {alert.severity}
                          </span>
                          <span className="text-[#71717A]" aria-hidden="true">·</span>
                          <span className="text-[#52525B] font-semibold">
                            {DRIFT_CATEGORY_LABELS[alert.category]}
                          </span>
                          {alert.affected_source_name && (
                            <>
                              <span className="text-[#71717A]" aria-hidden="true">·</span>
                              <span className="text-[#71717A]">{alert.affected_source_name}</span>
                            </>
                          )}
                          <span className="text-[#71717A]" aria-hidden="true">·</span>
                          <span
                            className={`font-bold ${
                              isDone
                                ? 'text-[#16A34A]'
                                : isQueued
                                ? 'text-[#8B5CF6]'
                                : 'text-[#D97706]'
                            }`}
                          >
                            Status: {alert.status}
                          </span>
                        </div>
                        <h3 className="text-sm font-bold text-[#171717]">{alert.title}</h3>
                        <p className="text-xs text-[#52525B] leading-relaxed">{alert.description}</p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {alert.affected_claim_ids.length > 0 && (
                          <button
                            onClick={() => {
                              const match = claims.find(c => c.id === alert.affected_claim_ids[0]);
                              if (match) setSelectedClaim(match);
                              setActiveView('CLAIM_LEDGER');
                            }}
                            className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-[#FAF8FF] hover:bg-[#F5F0FF] border border-[#E9E2F5] text-xs font-semibold text-[#171717] whitespace-nowrap cursor-pointer"
                          >
                            <ExternalLink className="w-3.5 h-3.5 text-[#8B5CF6]" />
                            <span>Inspect Claim</span>
                          </button>
                        )}

                        {alert.requires_reverification && alert.status === 'OPEN' && alert.affected_claim_ids.length > 0 && (
                          <button
                            onClick={() => handleQueueReverification(alert)}
                            disabled={actionAlertId === alert.id}
                            className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-[#8B5CF6] hover:bg-[#7C3AED] disabled:opacity-50 text-white text-xs font-semibold whitespace-nowrap cursor-pointer"
                          >
                            <Clock className="w-3.5 h-3.5" />
                            <span>Queue Re-Verification ({alert.affected_claim_ids.length})</span>
                          </button>
                        )}

                        {!isDone && (
                          <button
                            onClick={() => handleResolveAlert(alert)}
                            disabled={actionAlertId === alert.id}
                            className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-white hover:bg-[#FAF8FF] border border-[#E9E2F5] text-xs font-semibold text-[#16A34A] whitespace-nowrap cursor-pointer"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Resolve</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Side-by-Side Drift Comparison */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                      <div className="p-3 rounded-xl bg-[#FAF8FF] border border-[#E9E2F5] space-y-1">
                        <div className="text-[11px] font-semibold text-[#71717A]">
                          Previously Verified Knowledge
                        </div>
                        <p className="text-[#171717] leading-relaxed font-mono text-[11px]">
                          {alert.previous_evidence || 'No prior baseline quote'}
                        </p>
                      </div>
                      <div className="p-3 rounded-xl bg-[#F5F0FF] border border-[#E9E2F5] space-y-1">
                        <div className="text-[11px] font-semibold text-[#8B5CF6]">
                          Updated Source / Current State
                        </div>
                        <p className="text-[#171717] leading-relaxed font-mono text-[11px]">
                          {alert.new_evidence || 'No new evidence text recorded'}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t border-[#E9E2F5] text-xs">
                      <div className="text-[#52525B]">
                        <span className="font-semibold text-[#171717]">Recommended Action: </span>
                        {alert.recommended_action}
                      </div>
                      {alert.affected_claim_ids.length > 0 && (
                        <div className="font-mono text-[11px] text-[#71717A] shrink-0">
                          Records: {alert.affected_claim_ids.join(', ')}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* TAB 3: EXPLICIT RISKS & BLOCKERS LIST */}
      {activeTab === 'RISKS' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-[#171717] flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 text-[#D97706]" />
              <span className="tabular-nums">
                Extracted Ground-Truth Risks, Blockers & Dependencies ({riskClaims.length})
              </span>
            </h2>
          </div>

          <div className="space-y-3">
            {riskClaims.map(c => (
              <div
                key={c.id}
                className="bg-white border border-[#E9E2F5] rounded-2xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 text-xs hover:border-[#8B5CF6] transition-colors"
              >
                <div className="space-y-2 max-w-3xl">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
                    <span
                      className={`font-bold ${
                        c.type === 'BLOCKER'
                          ? 'text-[#DC2626]'
                          : c.type === 'DEPENDENCY'
                          ? 'text-[#8B5CF6]'
                          : 'text-[#D97706]'
                      }`}
                    >
                      {c.type}
                    </span>
                    <span className="text-[#71717A]" aria-hidden="true">·</span>
                    <span className="text-[#71717A]">{c.source_location}</span>
                    {c.owner && (
                      <>
                        <span className="text-[#71717A]" aria-hidden="true">·</span>
                        <span className="text-[#8B5CF6] font-semibold">Owner: {c.owner}</span>
                      </>
                    )}
                  </div>

                  <div className="font-bold text-[#171717] text-sm">{c.statement}</div>

                  <div className="text-[11px] text-[#52525B] italic bg-[#FAF8FF] p-2.5 rounded-lg border border-[#E9E2F5]">
                    Supporting Evidence: "{c.supporting_quote}"
                  </div>
                </div>

                <div className="flex flex-col items-end space-y-2 shrink-0">
                  <span className="font-mono text-[11px] text-[#16A34A] font-bold">
                    {c.reviewer_status}
                  </span>

                  <button
                    onClick={() => {
                      setSelectedClaim(c);
                      setActiveView('CLAIM_LEDGER');
                    }}
                    className="flex items-center space-x-1 text-[#8B5CF6] hover:text-[#7C3AED] font-semibold text-xs cursor-pointer"
                  >
                    <span>Open in Claim Ledger</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 4: CRITICAL OPERATIONAL GAPS & OWNERSHIP RISKS */}
      {activeTab === 'GAPS' && (
        <div className="space-y-4">
          <h2 className="text-sm font-bold text-[#171717] flex items-center space-x-2">
            <Flame className="w-4 h-4 text-[#DC2626]" />
            <span className="tabular-nums">
              Critical Operational Gaps & Ownership Risks ({gaps.length})
            </span>
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {gaps.map(g => (
              <div
                key={g.id}
                className="bg-white border border-[#FECACA] rounded-2xl p-5 flex flex-col justify-between space-y-4 hover:border-[#DC2626] transition-colors"
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[11px] font-mono">
                    <span className="text-[#DC2626] font-bold">{g.category}</span>
                    <span className="text-[#DC2626] font-bold">{g.severity}</span>
                  </div>

                  <div className="font-bold text-[#171717] text-sm leading-snug">{g.title}</div>

                  <p className="text-xs text-[#52525B] leading-relaxed">{g.description}</p>
                </div>

                <div className="pt-3 border-t border-[#E9E2F5] space-y-2 text-xs">
                  <div>
                    <span className="text-[11px] text-[#8B5CF6] font-semibold block">
                      Suggested Mitigation
                    </span>
                    <span className="text-[#171717] text-[11px] leading-snug block font-medium mt-0.5">
                      {g.suggested_action}
                    </span>
                  </div>

                  {g.source_reference && (
                    <div className="text-[11px] text-[#71717A] font-mono truncate">
                      Ref: {g.source_reference}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
