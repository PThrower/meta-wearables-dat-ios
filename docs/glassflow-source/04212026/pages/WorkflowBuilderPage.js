import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  Workflow, Play, Save, Plus, Trash2, Video, Brain,
  FileText, Filter, GitBranch, Zap, Eye, Code, X, Loader2, Copy,
  Download, Link2, GripVertical
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { getWorkflows, createWorkflow, updateWorkflow, runWorkflow, getNodeTypes } from '@/lib/api';
import { toast } from 'sonner';

const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.results)) return value.results;
  return [];
};

const normalizeWorkflow = (workflow = {}) => ({
  ...workflow,
  nodes: toArray(workflow?.nodes),
  edges: toArray(workflow?.edges),
});

const nodeConfigs = {
  input: { icon: Video, color: 'sky', label: 'Live Camera Feed' },
  output: { icon: FileText, color: 'lime', label: 'Guidance Output' },
  vlm: { icon: Eye, color: 'lime', label: 'Scene Analyzer', hasPrompt: true, models: ['gemini-2.0-flash', 'gpt-4o', 'claude-3.5-sonnet'] },
  llm: { icon: Brain, color: 'amber', label: 'Guidance LLM', hasPrompt: true, models: ['gpt-4o', 'claude-3.5-sonnet', 'gemini-pro', 'llama-3.1-70b'] },
  processor: { icon: Zap, color: 'pink', label: 'Processor', processors: ['transcriber', 'frame_sampler', 'audio_extractor', 'guidance_generator'] },
  filter: { icon: Filter, color: 'cyan', label: 'Filter' },
  aggregator: { icon: GitBranch, color: 'lime', label: 'Aggregator' },
};

const defaultPrompts = {
  vlm: `Analyze this camera frame from a worker's smart glasses:\n1. Current work environment and task scene\n2. Tools and materials visible\n3. Worker hand positioning and actions\n4. Safety compliance (PPE, posture, hazards)\n\nRespond in JSON format.`,
  llm: `Given the scene analysis, generate real-time guidance for the worker:\n1. Next step instruction based on current task progress\n2. Safety warnings if hazards detected\n3. Error corrections if deviations observed\n4. Tool/material identification and verification\n\nInput: {input}\n\nRespond in JSON format.`
};

export default function WorkflowBuilderPage() {
  const canvasRef = useRef(null);
  const [workflows, setWorkflows] = useState([]);
  const [currentWorkflow, setCurrentWorkflow] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [selectedNode, setSelectedNode] = useState(null);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [showJsonDialog, setShowJsonDialog] = useState(false);
  const [newWorkflowName, setNewWorkflowName] = useState('');
  const [connectingFrom, setConnectingFrom] = useState(null);
  const [draggingNode, setDraggingNode] = useState(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [workflowsData] = await Promise.all([getWorkflows(), getNodeTypes()]);
      const normalizedWorkflows = toArray(workflowsData).map(normalizeWorkflow);
      setWorkflows(normalizedWorkflows);
      setCurrentWorkflow(normalizedWorkflows.length > 0 ? normalizedWorkflows[0] : null);
    } catch (error) {
      toast.error('Failed to load workflows');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateWorkflow = async () => {
    if (!newWorkflowName.trim()) return toast.error('Enter a workflow name');
    try {
      const newWorkflow = await createWorkflow({
        name: newWorkflowName,
        description: 'New workflow',
        nodes: [
          { id: 'input-1', type: 'input', data: { label: 'Live Camera Feed' }, position: { x: 80, y: 150 } },
          { id: 'output-1', type: 'output', data: { label: 'Guidance Output' }, position: { x: 600, y: 150 } },
        ],
        edges: []
      });
      const normalizedWorkflow = normalizeWorkflow(newWorkflow);
      setWorkflows((prev) => [...prev, normalizedWorkflow]);
      setCurrentWorkflow(normalizedWorkflow);
      setShowNewDialog(false);
      setNewWorkflowName('');
      toast.success('Workflow created');
    } catch (error) {
      toast.error('Failed to create workflow');
    }
  };

  const handleSaveWorkflow = async () => {
    if (!currentWorkflow) return;
    setSaving(true);
    try {
      await updateWorkflow(currentWorkflow.id, currentWorkflow);
      toast.success('Workflow saved');
    } catch (error) {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleRunWorkflow = async () => {
    if (!currentWorkflow) return;
    setRunning(true);
    try {
      const result = await runWorkflow(currentWorkflow.id);
      toast.success(result.message);
    } catch (error) {
      toast.error('Failed to run');
    } finally {
      setRunning(false);
    }
  };

  const handleAddNode = (type) => {
    if (!currentWorkflow) return;
    const config = nodeConfigs[type];
    const newNode = {
      id: `${type}-${Date.now()}`,
      type,
      data: {
        label: config.label,
        ...(config.hasPrompt && { prompt: defaultPrompts[type] || '', model: config.models?.[0], temperature: 0.7, max_tokens: 2048 }),
        ...(config.processors && { processor_type: config.processors[0] })
      },
      position: { x: 250 + Math.random() * 100, y: 100 + currentWorkflow.nodes.length * 80 }
    };
    setCurrentWorkflow({ ...currentWorkflow, nodes: [...currentWorkflow.nodes, newNode] });
    setSelectedNode(newNode.id);
  };

  const handleDeleteNode = (nodeId) => {
    if (!currentWorkflow) return;
    setCurrentWorkflow({
      ...currentWorkflow,
      nodes: currentWorkflow.nodes.filter(n => n.id !== nodeId),
      edges: currentWorkflow.edges.filter(e => e.source !== nodeId && e.target !== nodeId)
    });
    if (selectedNode === nodeId) setSelectedNode(null);
  };

  const handleStartConnection = (nodeId, e) => {
    e.stopPropagation();
    setConnectingFrom(nodeId);
    toast.info('Click another node to connect');
  };

  const handleNodeClick = (nodeId, e) => {
    e.stopPropagation();
    if (connectingFrom && connectingFrom !== nodeId) {
      const edgeExists = currentWorkflow.edges.some(e => e.source === connectingFrom && e.target === nodeId);
      if (!edgeExists) {
        setCurrentWorkflow({
          ...currentWorkflow,
          edges: [...currentWorkflow.edges, { id: `e-${connectingFrom}-${nodeId}`, source: connectingFrom, target: nodeId }]
        });
        toast.success('Connected');
      }
      setConnectingFrom(null);
    } else {
      setSelectedNode(nodeId);
      setConnectingFrom(null);
    }
  };

  const handleDeleteEdge = (edgeId) => {
    if (!currentWorkflow) return;
    setCurrentWorkflow({ ...currentWorkflow, edges: currentWorkflow.edges.filter(e => e.id !== edgeId) });
  };

  const handleMouseDown = (nodeId, e) => {
    e.stopPropagation();
    const node = currentWorkflow?.nodes.find(n => n.id === nodeId);
    if (!node || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    setDraggingNode(nodeId);
    setDragOffset({ x: e.clientX - rect.left - node.position.x, y: e.clientY - rect.top - node.position.y });
  };

  const handleMouseMove = useCallback((e) => {
    if (!draggingNode || !currentWorkflow || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const newX = Math.max(0, e.clientX - rect.left - dragOffset.x);
    const newY = Math.max(0, e.clientY - rect.top - dragOffset.y);
    setCurrentWorkflow(prev => ({
      ...prev,
      nodes: prev.nodes.map(n => n.id === draggingNode ? { ...n, position: { x: newX, y: newY } } : n)
    }));
  }, [draggingNode, dragOffset]);

  const handleMouseUp = useCallback(() => {
    setDraggingNode(null);
  }, []);

  useEffect(() => {
    if (draggingNode) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [draggingNode, handleMouseMove, handleMouseUp]);

  const updateNodeData = (nodeId, key, value) => {
    setCurrentWorkflow(prev => ({
      ...prev,
      nodes: prev.nodes.map(n => n.id === nodeId ? { ...n, data: { ...n.data, [key]: value } } : n)
    }));
  };

  const generateJson = () => {
    if (!currentWorkflow) return null;
    return {
      workflow_id: currentWorkflow.id,
      name: currentWorkflow.name,
      pipeline: currentWorkflow.nodes.map(node => ({
        node_id: node.id,
        type: node.type,
        label: node.data.label,
        config: { ...node.data },
        outputs_to: currentWorkflow.edges.filter(e => e.source === node.id).map(e => e.target)
      }))
    };
  };

  const selectedNodeData = currentWorkflow?.nodes?.find(n => n.id === selectedNode);
  const selectedConfig = selectedNodeData ? nodeConfigs[selectedNodeData.type] : null;

  return (
    <div
      className="gf-page h-screen flex flex-col overflow-hidden"
      data-testid="workflow-builder-page"
      style={{ background: 'var(--gf-bg)', color: 'var(--gf-text)' }}
    >
      {/* Workflow Toolbar */}
      <div
        className="h-12 border-b hairline flex items-center justify-between px-4 flex-shrink-0"
        style={{ background: 'var(--gf-surface)', borderBottomColor: 'var(--gf-line)' }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="h-6 w-6 rounded-md flex items-center justify-center shrink-0"
            style={{ background: 'var(--lime-soft)' }}
          >
            <Workflow className="h-3 w-3" style={{ color: 'var(--lime)' }} strokeWidth={1.5} />
          </div>
          <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--gf-text)' }}>
            {currentWorkflow?.name || 'No workflow'}
          </span>
          <span className="text-[10px] gf-mono" style={{ color: 'var(--gf-text-faint)' }}>
            {currentWorkflow?.nodes?.length || 0} nodes · {currentWorkflow?.edges?.length || 0} connections
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowJsonDialog(true)}
            className="btn-ghost h-8 px-3 rounded-md text-[11.5px] flex items-center gap-1.5"
          >
            <Code className="h-3 w-3" strokeWidth={1.5} /> JSON
          </button>
          <button
            onClick={handleSaveWorkflow}
            disabled={!currentWorkflow || saving}
            className="btn-ghost h-8 px-3 rounded-md text-[11.5px] flex items-center gap-1.5 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" strokeWidth={1.5} />}
            Save
          </button>
          <button
            onClick={handleRunWorkflow}
            disabled={!currentWorkflow || running}
            className="btn-lime h-8 px-4 rounded-md text-[11.5px] font-medium flex items-center gap-1.5 disabled:opacity-50"
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" strokeWidth={1.5} />}
            Test run
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar - Workflows & Nodes */}
        <aside
          className="w-60 border-r hairline flex flex-col flex-shrink-0 overflow-hidden"
          style={{ background: 'var(--gf-surface)', borderRightColor: 'var(--gf-line)' }}
        >
          <div className="p-3 border-b hairline" style={{ borderBottomColor: 'var(--gf-line)' }}>
            <span className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--gf-text-faint)' }}>Workflows</span>
          </div>
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-2 space-y-1">
              <button
                onClick={() => setShowNewDialog(true)}
                className="w-full px-3 h-8 rounded-md border border-dashed flex items-center gap-2 text-[11.5px] transition-colors"
                style={{ color: 'var(--gf-text-faint)', borderColor: 'var(--gf-line)' }}
              >
                <Plus className="h-3 w-3" strokeWidth={1.5} />
                New workflow
              </button>
              {loading ? (
                [...Array(3)].map((_, i) => (
                  <div
                    key={i}
                    className="h-10 rounded-md animate-pulse"
                    style={{ background: 'var(--gf-surface-2)' }}
                  />
                ))
              ) : (
                workflows.map((wf) => {
                  const active = currentWorkflow?.id === wf.id;
                  return (
                    <button
                      key={wf.id}
                      onClick={() => { setCurrentWorkflow(wf); setSelectedNode(null); }}
                      className="w-full text-left px-3 h-9 rounded-md flex items-center gap-2 text-[12px] transition"
                      style={{
                        background: active ? 'var(--lime-soft)' : 'transparent',
                        color: active ? 'var(--lime)' : 'var(--gf-text-dim)',
                      }}
                    >
                      <Workflow className="h-3 w-3 shrink-0" strokeWidth={1.5} />
                      <span className="flex-1 truncate">{wf.name}</span>
                      <span className="text-[9px] gf-mono opacity-60">{wf.nodes?.length || 0}</span>
                    </button>
                  );
                })
              )}
            </div>
          </ScrollArea>

          {/* Node Palette */}
          <div className="border-t hairline p-3 flex-shrink-0" style={{ borderTopColor: 'var(--gf-line)' }}>
            <span className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--gf-text-faint)' }}>Add nodes</span>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {Object.entries(nodeConfigs).map(([type, config]) => {
                const Icon = config.icon;
                return (
                  <button
                    key={type}
                    onClick={() => handleAddNode(type)}
                    disabled={!currentWorkflow}
                    className="px-2 py-1.5 rounded-md border hairline text-left transition disabled:opacity-40 flex items-start gap-1.5"
                    style={{ background: 'var(--gf-surface-2)', borderColor: 'var(--gf-line)' }}
                  >
                    <Icon className="h-3 w-3 mt-0.5 shrink-0" style={{ color: 'var(--lime)' }} strokeWidth={1.5} />
                    <div className="text-[10px] font-medium truncate" style={{ color: 'var(--gf-text)' }}>{config.label}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        {/* Canvas */}
        <main
          ref={canvasRef}
          className="flex-1 relative overflow-hidden dot-grid"
          style={{ cursor: draggingNode ? 'grabbing' : 'default', background: 'var(--gf-bg)' }}
          onClick={() => { setSelectedNode(null); setConnectingFrom(null); }}
        >

          {currentWorkflow ? (
            <>
              {/* Edges SVG */}
              <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ overflow: 'visible' }}>
                <defs>
                  <marker id="arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                    <polygon points="0 0, 8 3, 0 6" fill="rgba(224,255,0,0.7)" />
                  </marker>
                </defs>
                {currentWorkflow.edges?.map((edge) => {
                  const source = currentWorkflow.nodes?.find(n => n.id === edge.source);
                  const target = currentWorkflow.nodes?.find(n => n.id === edge.target);
                  if (!source || !target) return null;
                  const x1 = source.position.x + 150, y1 = source.position.y + 30;
                  const x2 = target.position.x, y2 = target.position.y + 30;
                  const midX = (x1 + x2) / 2;
                  return (
                    <g key={edge.id} className="pointer-events-auto cursor-pointer" onClick={(e) => { e.stopPropagation(); handleDeleteEdge(edge.id); }}>
                      <path
                        d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                        stroke="rgba(224,255,0,0.5)"
                        strokeWidth="2"
                        fill="none"
                        markerEnd="url(#arrow)"
                        className="hover:stroke-red-500 transition-colors"
                      />
                    </g>
                  );
                })}
              </svg>

              {/* Nodes */}
              {currentWorkflow.nodes?.map((node) => {
                const config = nodeConfigs[node.type] || nodeConfigs.processor;
                const Icon = config.icon;
                const isSelected = selectedNode === node.id;
                const isConnecting = connectingFrom === node.id;
                const accent =
                  node.type === 'input' ? '#7FB7FF' :
                  node.type === 'output' ? 'var(--mint)' :
                  node.type === 'vlm' || node.type === 'llm' ? 'var(--lime)' :
                  node.type === 'filter' ? 'var(--amber)' :
                  '#B794FF';

                return (
                  <div
                    key={node.id}
                    style={{
                      position: 'absolute',
                      left: node.position.x,
                      top: node.position.y,
                      width: 160,
                      background: 'var(--gf-surface-2)',
                      borderColor: isSelected || isConnecting ? 'var(--lime)' : 'var(--gf-line-2)',
                      boxShadow: isSelected ? '0 8px 30px -12px rgba(212,255,58,0.4)' : '0 6px 20px -10px rgba(0,0,0,0.6)',
                    }}
                    className="rounded-lg border-2 shadow-md transition-shadow select-none"
                    onClick={(e) => handleNodeClick(node.id, e)}
                    data-testid={`workflow-node-${node.id}`}
                  >
                    {/* Drag Handle */}
                    <div
                      className="px-2 py-1.5 border-b cursor-grab active:cursor-grabbing flex items-center gap-1.5 rounded-t-md"
                      style={{ background: `${accent}1A`, borderBottomColor: `${accent}33` }}
                      onMouseDown={(e) => handleMouseDown(node.id, e)}
                    >
                      <GripVertical className="h-2.5 w-2.5" style={{ color: 'var(--gf-text-faint)' }} strokeWidth={1.5} />
                      <div
                        className="h-4 w-4 rounded-md flex items-center justify-center"
                        style={{ background: `${accent}33`, border: `1px solid ${accent}55` }}
                      >
                        <Icon className="h-2.5 w-2.5" style={{ color: accent }} strokeWidth={1.5} />
                      </div>
                      <span className="text-[10px] font-medium truncate flex-1" style={{ color: 'var(--gf-text)' }}>
                        {node.data.label}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteNode(node.id); }}
                        className="h-4 w-4 rounded flex items-center justify-center transition"
                        style={{ color: 'var(--gf-text-faint)' }}
                      >
                        <X className="h-2.5 w-2.5" strokeWidth={1.5} />
                      </button>
                    </div>
                    <div className="p-2 space-y-1">
                      <div className="text-[9px] gf-mono uppercase tracking-wider" style={{ color: 'var(--gf-text-faint)' }}>
                        {node.type === 'vlm' ? 'Scene Analyzer' : node.type === 'llm' ? 'Guidance LLM' : node.type}
                      </div>
                      {node.data.model && (
                        <div
                          className="text-[9px] gf-mono px-1.5 py-0.5 rounded truncate"
                          style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--gf-text-dim)' }}
                        >
                          {node.data.model}
                        </div>
                      )}
                      {node.data.processor_type && (
                        <div
                          className="text-[9px] gf-mono px-1.5 py-0.5 rounded truncate"
                          style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--gf-text-dim)' }}
                        >
                          {node.data.processor_type}
                        </div>
                      )}
                    </div>
                    {/* Connection Ports */}
                    <div
                      className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full border-2 transition-colors cursor-pointer"
                      style={{ background: 'var(--gf-surface-3)', borderColor: 'var(--gf-bg)' }}
                    />
                    <div
                      className={`absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full border-2 cursor-pointer transition-all ${isConnecting ? 'scale-125' : 'hover:scale-125'}`}
                      style={{ background: 'var(--lime)', borderColor: 'var(--gf-bg)' }}
                      onClick={(e) => handleStartConnection(node.id, e)}
                    />
                  </div>
                );
              })}

              {/* Connection Hint */}
              {connectingFrom && (
                <div
                  className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md text-[10px] flex items-center gap-1.5 border"
                  style={{ background: 'var(--lime-soft)', color: 'var(--lime)', borderColor: 'rgba(212,255,58,0.35)' }}
                >
                  <Link2 className="h-3 w-3" strokeWidth={1.5} />
                  Click another node to connect
                </div>
              )}
            </>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center">
                <Workflow className="h-10 w-10 mx-auto mb-2 opacity-30" strokeWidth={1} />
                <p className="text-sm font-medium mb-1" style={{ color: 'var(--gf-text)' }}>Select a workflow</p>
                <p className="text-[10px] mb-3" style={{ color: 'var(--gf-text-dim)' }}>Choose from the left or create a new one</p>
                <button
                  onClick={() => setShowNewDialog(true)}
                  className="btn-lime h-8 px-4 rounded-md text-[12px] font-medium inline-flex items-center gap-1.5"
                >
                  <Plus className="h-3 w-3" strokeWidth={1.5} /> Create
                </button>
              </div>
            </div>
          )}
        </main>

        {/* Right Sidebar - Properties */}
        {selectedNodeData && (
          <aside
            className="w-64 border-l hairline flex flex-col flex-shrink-0 overflow-hidden"
            style={{ background: 'var(--gf-surface)', borderLeftColor: 'var(--gf-line)' }}
          >
            <div
              className="p-3 border-b hairline flex items-center justify-between"
              style={{ borderBottomColor: 'var(--gf-line)' }}
            >
              <span className="text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--gf-text-faint)' }}>Properties</span>
              <button
                onClick={() => setSelectedNode(null)}
                className="h-6 w-6 rounded flex items-center justify-center transition"
                style={{ color: 'var(--gf-text-faint)' }}
              >
                <X className="h-3 w-3" strokeWidth={1.5} />
              </button>
            </div>
            <ScrollArea className="flex-1 min-h-0">
              <div className="p-3 space-y-3">
                <div>
                  <label className="text-[10px]" style={{ color: 'var(--gf-text-faint)' }}>Label</label>
                  <Input
                    value={selectedNodeData.data.label}
                    onChange={(e) => updateNodeData(selectedNode, 'label', e.target.value)}
                    className="mt-1 h-8 text-[11px]"
                  />
                </div>
                <div>
                  <label className="text-[10px]" style={{ color: 'var(--gf-text-faint)' }}>Type</label>
                  <div
                    className="mt-1 px-2 py-1.5 rounded-md border hairline"
                    style={{ background: 'var(--lime-soft)', borderColor: 'rgba(212,255,58,0.3)' }}
                  >
                    <span className="text-[11px] font-medium capitalize" style={{ color: 'var(--lime)' }}>
                      {selectedNodeData.type === 'vlm' ? 'Scene Analyzer' : selectedNodeData.type === 'llm' ? 'Guidance LLM' : selectedNodeData.type}
                    </span>
                  </div>
                </div>
                {selectedConfig?.models && (
                  <div>
                    <label className="text-[9px] text-muted-foreground">Model</label>
                    <Select value={selectedNodeData.data.model} onValueChange={(v) => updateNodeData(selectedNode, 'model', v)}>
                      <SelectTrigger className="mt-0.5 h-7 text-[10px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {selectedConfig.models.map((m) => <SelectItem key={m} value={m} className="text-[10px]">{m}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {selectedConfig?.processors && (
                  <div>
                    <label className="text-[9px] text-muted-foreground">Processor</label>
                    <Select value={selectedNodeData.data.processor_type} onValueChange={(v) => updateNodeData(selectedNode, 'processor_type', v)}>
                      <SelectTrigger className="mt-0.5 h-7 text-[10px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {selectedConfig.processors.map((p) => <SelectItem key={p} value={p} className="text-[10px]">{p}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {selectedConfig?.hasPrompt && (
                  <>
                    <div>
                      <label className="text-[9px] text-muted-foreground">Temperature: {selectedNodeData.data.temperature || 0.7}</label>
                      <input type="range" min="0" max="1" step="0.1" value={selectedNodeData.data.temperature || 0.7} onChange={(e) => updateNodeData(selectedNode, 'temperature', parseFloat(e.target.value))} className="w-full mt-0.5 h-1" />
                    </div>
                    <div>
                      <label className="text-[9px] text-muted-foreground">Max Tokens</label>
                      <Input type="number" value={selectedNodeData.data.max_tokens || 2048} onChange={(e) => updateNodeData(selectedNode, 'max_tokens', parseInt(e.target.value))} className="mt-0.5 h-7 text-[10px]" />
                    </div>
                    <div>
                      <label className="text-[9px] text-muted-foreground">Prompt</label>
                      <Textarea value={selectedNodeData.data.prompt || ''} onChange={(e) => updateNodeData(selectedNode, 'prompt', e.target.value)} className="mt-0.5 min-h-[100px] text-[9px] font-mono" placeholder="Enter prompt..." />
                      <p className="mt-0.5 text-[8px] text-muted-foreground">Use {'{input}'} for previous output</p>
                    </div>
                  </>
                )}
                <div className="pt-3 border-t hairline space-y-1.5" style={{ borderTopColor: 'var(--gf-line)' }}>
                  <button
                    onClick={(e) => handleStartConnection(selectedNode, e)}
                    className="btn-ghost w-full h-8 px-3 rounded-md text-[11px] flex items-center justify-start gap-1.5"
                  >
                    <Link2 className="h-3 w-3" strokeWidth={1.5} /> Connect
                  </button>
                  <button
                    onClick={() => handleDeleteNode(selectedNode)}
                    className="w-full h-8 px-3 rounded-md text-[11px] flex items-center justify-start gap-1.5 border hairline transition"
                    style={{ color: 'var(--red)', background: 'transparent', borderColor: 'var(--gf-line)' }}
                  >
                    <Trash2 className="h-3 w-3" strokeWidth={1.5} /> Delete
                  </button>
                </div>
              </div>
            </ScrollArea>
          </aside>
        )}
      </div>

      {/* New Workflow Dialog */}
      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogContent className="max-w-sm bg-background border-border">
          <DialogHeader>
            <DialogTitle className="text-sm">New Workflow</DialogTitle>
            <DialogDescription className="text-[10px]">Create a new AI pipeline</DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Input value={newWorkflowName} onChange={(e) => setNewWorkflowName(e.target.value)} placeholder="Workflow name" className="h-8 text-sm" />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowNewDialog(false)} size="sm" className="h-7 text-[10px] border border-border">Cancel</Button>
            <Button onClick={handleCreateWorkflow} variant="hex" size="sm" className="h-7 text-[10px]">Create</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* JSON Dialog */}
      <Dialog open={showJsonDialog} onOpenChange={setShowJsonDialog}>
        <DialogContent className="max-w-2xl max-h-[70vh] bg-background border-border">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <Code className="h-4 w-4 text-[#E0FF00]" strokeWidth={1.5} />
              Workflow Configuration
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="h-[40vh]">
            <pre className="p-3 rounded-lg bg-muted text-[10px] font-mono text-foreground/80 overflow-x-auto">
              {JSON.stringify(generateJson(), null, 2)}
            </pre>
          </ScrollArea>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { navigator.clipboard.writeText(JSON.stringify(generateJson(), null, 2)); toast.success('Copied'); }} className="h-7 text-[10px] border border-border">
              <Copy className="h-3 w-3 mr-1" strokeWidth={1.5} />Copy
            </Button>
            <Button size="sm" onClick={() => {
              const blob = new Blob([JSON.stringify(generateJson(), null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${currentWorkflow?.name || 'workflow'}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }} className="h-7 text-[10px] bg-[#E0FF00] hover:bg-[#E0FF00]/80 text-black">
              <Download className="h-3 w-3 mr-1" strokeWidth={1.5} />Download
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
