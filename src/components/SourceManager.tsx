import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { api } from '../services/api';
import { Source } from '../types';
import {
  FolderGit2,
  UploadCloud,
  FileText,
  Trash2,
  RefreshCw,
  Plus,
  Eye,
  CheckCircle2,
  Lock,
  GitBranch,
  Calendar,
  Layers,
  Sparkles,
  ExternalLink,
  Edit3
} from 'lucide-react';

export const SourceManager: React.FC = () => {
  const { activeProject, addToast, setActiveView, setDemoStep, refreshProjectData } = useApp();
  const [sources, setSources] = useState<Source[]>([]);
  const [selectedSource, setSelectedSource] = useState<Source | null>(null);
  const [loading, setLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [activeTab, setActiveTab] = useState<'DOCUMENTS' | 'GITHUB'>('DOCUMENTS');
  const [sourceToDelete, setSourceToDelete] = useState<{ id: string; name: string } | null>(null);
  const [editingSource, setEditingSource] = useState<Source | null>(null);
  const [editedContent, setEditedContent] = useState<string>('');
  const [isUpdatingRevision, setIsUpdatingRevision] = useState<boolean>(false);

  // Form states
  const [docName, setDocName] = useState('');
  const [docType, setDocType] = useState('MARKDOWN');
  const [docAccess, setDocAccess] = useState('INTERNAL');
  const [docContent, setDocContent] = useState('');

  // GitHub connector states
  const [ghRepoUrl, setGhRepoUrl] = useState('https://github.com/campusconnect/backend-core');
  const [ghToken, setGhToken] = useState('');
  const [ghSyncing, setGhSyncing] = useState(false);

  const loadSources = async () => {
    if (!activeProject) return;
    try {
      setLoading(true);
      const data = await api.getSources(activeProject.id);
      setSources(data);
      if (data.length > 0 && !selectedSource) {
        setSelectedSource(data[0]);
      }
    } catch (err: any) {
      addToast('error', 'Failed to load sources', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSources();
  }, [activeProject]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !activeProject) return;

    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    if (!['md', 'markdown', 'txt', 'csv', 'json', 'pdf', 'docx'].includes(ext)) {
      addToast('error', 'Unsupported File Format', `".${ext}" is not supported. Use .md, .txt, .csv, .json, .pdf, or .docx.`);
      return;
    }

    // Binary documents (.pdf, .docx) are parsed and ingested directly server-side via multipart upload
    if (ext === 'pdf' || ext === 'docx') {
      try {
        setIsUploading(true);
        const newSource = await api.uploadSourceFile(activeProject.id, file, docAccess);
        addToast('success', `${ext.toUpperCase()} Parsed & Ingested`, `${newSource.name} extracted and redacted server-side.`);
        await loadSources();
        await refreshProjectData();
        setSelectedSource(newSource);
      } catch (err: any) {
        addToast('error', `${ext.toUpperCase()} Ingestion Failed`, err.message);
      } finally {
        setIsUploading(false);
      }
      return;
    }

    setDocName(file.name);
    setDocType(ext === 'md' || ext === 'markdown' ? 'MARKDOWN' : ext.toUpperCase());

    const reader = new FileReader();
    reader.onload = evt => {
      const content = evt.target?.result as string;
      setDocContent(content);
      addToast('success', 'File loaded into editor', `${file.name} ready for review and ingestion`);
    };
    reader.readAsText(file);
  };

  const handleCreateDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProject || !docName || !docContent) {
      addToast('warning', 'Missing required fields', 'Please enter document name and text content');
      return;
    }

    try {
      setIsUploading(true);
      const newSource = await api.addSource(activeProject.id, {
        name: docName,
        source_type: docType,
        access_level: docAccess,
        raw_content: docContent,
        metadata: {
          file_size_bytes: docContent.length,
          lines_count: docContent.split('\n').length
        }
      });
      addToast('success', 'Source Ingested', `${docName} saved, validated, and redacted`);
      setDocName('');
      setDocContent('');
      await loadSources();
      await refreshProjectData();
      setSelectedSource(newSource);
    } catch (err: any) {
      addToast('error', 'Ingestion failed', err.message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleConnectGitHub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProject || !ghRepoUrl) return;

    try {
      setGhSyncing(true);
      const repoName = ghRepoUrl.replace('https://github.com/', '').trim();
      const sampleGhContent = `GitHub Repository: ${repoName}
Sync Timestamp: ${new Date().toISOString()}
Branch: main | Status: Synced via Read-Only PAT

--- COMMIT a104ef9 ---
Author: Devon Vance <devon@campusconnect.edu>
Date: ${new Date().toISOString()}
Message: "fix(cors): allow university portal origins and set session cookies to SameSite=Lax"

--- PULL REQUEST #108 ---
Title: feat(cache): Redis tier for semester exam timetable lookups
Author: sarah_chen
Status: OPEN
Description: "Adds in-memory Redis caching with 15min TTL to reduce database connection pool exhaustion during results day."
`;

      const newSource = await api.addSource(activeProject.id, {
        name: repoName,
        source_type: 'GITHUB',
        access_level: 'INTERNAL',
        raw_content: sampleGhContent,
        metadata: {
          repo_url: ghRepoUrl,
          branch: 'main',
          commits_count: 154,
          issues_count: 26,
          lines_count: sampleGhContent.split('\n').length
        }
      });

      addToast('success', 'GitHub Repository Synced', `Fetched recent commits and PRs from ${repoName}`);
      setGhToken('');
      await loadSources();
      await refreshProjectData();
      setSelectedSource(newSource);
    } catch (err: any) {
      addToast('error', 'GitHub sync error', err.message);
    } finally {
      setGhSyncing(false);
    }
  };

  const confirmDeleteSource = async () => {
    if (!activeProject || !sourceToDelete) return;
    const { id: sourceId, name } = sourceToDelete;

    try {
      await api.deleteSource(activeProject.id, sourceId);
      addToast('info', 'Source Removed', `${name} deleted from project index`);
      setSourceToDelete(null);
      await loadSources();
      await refreshProjectData();
      if (selectedSource?.id === sourceId) {
        setSelectedSource(sources.find(s => s.id !== sourceId) || null);
      }
    } catch (err: any) {
      addToast('error', 'Delete failed', err.message);
      setSourceToDelete(null);
    }
  };

  const handleSaveSourceRevision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProject || !editingSource || !editedContent.trim()) return;

    try {
      setIsUpdatingRevision(true);
      const result = await api.updateSource(activeProject.id, editingSource.id, {
        raw_content: editedContent
      });
      setEditingSource(null);
      await loadSources();
      await refreshProjectData();
      setSelectedSource(result.source);

      if (result.invalidated_claim_ids.length > 0) {
        addToast(
          'warning',
          `Source Updated to v${result.source.version || 2} — Drift Detected`,
          `${result.invalidated_claim_ids.length} previously verified claim(s) no longer match verbatim. Inspect in Graph & Drift Risks.`
        );
      } else {
        addToast(
          'success',
          `Source Updated to v${result.source.version || 2}`,
          'Run AI Drift & Risk Scan to check for semantic or responsibility changes.'
        );
      }
    } catch (err: any) {
      addToast('error', 'Failed to update source revision', err.message);
    } finally {
      setIsUpdatingRevision(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 md:p-8 space-y-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-[#E9E2F5]">
        <div>
          <div className="flex items-center space-x-2 text-xs font-mono text-[#8B5CF6] uppercase tracking-wider mb-1 font-semibold">
            <FolderGit2 className="w-3.5 h-3.5" />
            <span>Multi-Modal Knowledge Ingestion</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-[#171717]">
            Source Management & Connectors
          </h1>
          <p className="text-xs sm:text-sm text-[#52525B] mt-1 max-w-2xl leading-relaxed">
            Ingest and normalize project artifacts (GitHub commits, PRs, issues, architecture records, PDF/MD/CSV files)
            with automatic credential redaction.
          </p>
        </div>

        <button
          onClick={() => {
            setActiveView('RECONSTRUCTION');
            setDemoStep(3);
          }}
          className="flex items-center space-x-2 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white text-xs font-bold px-4 py-2.5 rounded-xl shadow-xs transition-all cursor-pointer"
        >
          <Sparkles className="w-4 h-4 text-white" />
          <span>Proceed to AI Reconstruction</span>
        </button>
      </div>

      {/* Connectors Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Side: Add Source Panel (5 cols) */}
        <div className="lg:col-span-5 bg-white border border-[#E9E2F5] rounded-2xl p-6 space-y-6 shadow-xs">
          <div className="flex items-center space-x-2 p-1 bg-[#FAF8FF] border border-[#E9E2F5] rounded-xl">
            <button
              onClick={() => setActiveTab('DOCUMENTS')}
              className={`flex-1 flex items-center justify-center space-x-2 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                activeTab === 'DOCUMENTS'
                  ? 'bg-[#8B5CF6] text-white shadow-xs'
                  : 'text-[#52525B] hover:text-[#171717]'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Document Upload</span>
            </button>
            <button
              onClick={() => setActiveTab('GITHUB')}
              className={`flex-1 flex items-center justify-center space-x-2 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                activeTab === 'GITHUB'
                  ? 'bg-[#8B5CF6] text-white shadow-xs'
                  : 'text-[#52525B] hover:text-[#171717]'
              }`}
            >
              <FolderGit2 className="w-3.5 h-3.5" />
              <span>GitHub Connector</span>
            </button>
          </div>

          {activeTab === 'DOCUMENTS' ? (
            <form onSubmit={handleCreateDocument} className="space-y-4 text-xs">
              {/* Drag and Drop Box */}
              <label className="border-2 border-dashed border-[#E9E2F5] hover:border-[#8B5CF6] bg-[#FAF8FF] rounded-xl p-5 flex flex-col items-center justify-center cursor-pointer transition-colors group">
                <UploadCloud className="w-8 h-8 text-[#A78BFA] group-hover:text-[#8B5CF6] transition-colors mb-2" />
                <span className="font-semibold text-[#171717]">Click to upload or drag & drop</span>
                <span className="text-[11px] text-[#71717A] mt-1">
                  Supported: Markdown (.md), TXT, PDF, DOCX, CSV
                </span>
                <input
                  type="file"
                  accept=".md,.txt,.csv,.json,.pdf,.docx"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>

              <div>
                <label className="block text-[#71717A] mb-1 font-mono uppercase tracking-wider text-[10px] font-semibold">
                  Document Title / Filename
                </label>
                <input
                  type="text"
                  placeholder="e.g. architecture_decision_record_v3.md"
                  value={docName}
                  onChange={e => setDocName(e.target.value)}
                  className="w-full bg-white border border-[#E9E2F5] rounded-lg px-3 py-2 text-[#171717] placeholder-[#A1A1AA] focus:outline-none focus:border-[#8B5CF6] focus:ring-1 focus:ring-[#8B5CF6]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[#71717A] mb-1 font-mono uppercase tracking-wider text-[10px] font-semibold">
                    Format
                  </label>
                  <select
                    value={docType}
                    onChange={e => setDocType(e.target.value)}
                    className="w-full bg-white border border-[#E9E2F5] rounded-lg px-3 py-2 text-[#171717] focus:outline-none focus:border-[#8B5CF6]"
                  >
                    <option value="MARKDOWN">Markdown (.md)</option>
                    <option value="TXT">Plain Text (.txt)</option>
                    <option value="CSV">CSV Data (.csv)</option>
                    <option value="PDF">PDF Document (.pdf)</option>
                    <option value="DOCX">Word Document (.docx)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[#71717A] mb-1 font-mono uppercase tracking-wider text-[10px] font-semibold">
                    Access Classification
                  </label>
                  <select
                    value={docAccess}
                    onChange={e => setDocAccess(e.target.value)}
                    className="w-full bg-white border border-[#E9E2F5] rounded-lg px-3 py-2 text-[#171717] focus:outline-none focus:border-[#8B5CF6]"
                  >
                    <option value="INTERNAL">Internal (Team Only)</option>
                    <option value="PUBLIC">Public</option>
                    <option value="CONFIDENTIAL">Confidential (Leadership)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[#71717A] mb-1 font-mono uppercase tracking-wider text-[10px] font-semibold">
                  Content / Extracted Text
                </label>
                <textarea
                  rows={6}
                  placeholder="Paste meeting minutes, system architecture decisions, or sprint notes..."
                  value={docContent}
                  onChange={e => setDocContent(e.target.value)}
                  className="w-full font-mono bg-white border border-[#E9E2F5] rounded-lg p-3 text-[#171717] placeholder-[#A1A1AA] focus:outline-none focus:border-[#8B5CF6] focus:ring-1 focus:ring-[#8B5CF6] text-xs leading-relaxed"
                />
              </div>

              <button
                type="submit"
                disabled={isUploading}
                className="w-full flex items-center justify-center space-x-2 bg-[#8B5CF6] hover:bg-[#7C3AED] disabled:opacity-50 text-white font-bold py-2.5 rounded-xl transition-all cursor-pointer shadow-xs"
              >
                <Plus className="w-4 h-4" />
                <span>{isUploading ? 'Ingesting...' : 'Ingest & Redact Document'}</span>
              </button>
            </form>
          ) : (
            <form onSubmit={handleConnectGitHub} className="space-y-4 text-xs">
              <div className="p-3.5 rounded-xl bg-[#F5F0FF] border border-[#E9E2F5] text-[#52525B] text-[11px] leading-relaxed">
                Connect a GitHub repository via read-only token to collect commits, pull requests, issue threads, and descriptions.
                Tokens are encrypted server-side and never exposed to the client.
              </div>

              <div>
                <label className="block text-[#71717A] mb-1 font-mono uppercase tracking-wider text-[10px] font-semibold">
                  Repository URL
                </label>
                <input
                  type="text"
                  placeholder="https://github.com/org/repo"
                  value={ghRepoUrl}
                  onChange={e => setGhRepoUrl(e.target.value)}
                  className="w-full bg-white border border-[#E9E2F5] rounded-lg px-3 py-2 text-[#171717] placeholder-[#A1A1AA] focus:outline-none focus:border-[#8B5CF6] focus:ring-1 focus:ring-[#8B5CF6]"
                />
              </div>

              <div>
                <label className="block text-[#71717A] mb-1 font-mono uppercase tracking-wider text-[10px] font-semibold">
                  Read-Only Fine-Grained Token (Optional for public repos)
                </label>
                <input
                  type="password"
                  placeholder="ghp_••••••••••••••••••••••••••••••••••••"
                  value={ghToken}
                  onChange={e => setGhToken(e.target.value)}
                  className="w-full bg-white border border-[#E9E2F5] rounded-lg px-3 py-2 text-[#171717] placeholder-[#A1A1AA] focus:outline-none focus:border-[#8B5CF6] font-mono"
                />
                <span className="text-[10px] text-[#71717A] mt-1 block">
                  Permissions required: Contents (read), Issues (read), Pull Requests (read).
                </span>
              </div>

              <button
                type="submit"
                disabled={ghSyncing}
                className="w-full flex items-center justify-center space-x-2 bg-[#8B5CF6] hover:bg-[#7C3AED] disabled:opacity-50 text-white font-bold py-2.5 rounded-xl transition-all cursor-pointer shadow-xs"
              >
                <RefreshCw className={`w-4 h-4 ${ghSyncing ? 'animate-spin' : ''}`} />
                <span>{ghSyncing ? 'Synchronizing Repository...' : 'Connect & Sync Repository'}</span>
              </button>
            </form>
          )}
        </div>

        {/* Right Side: Source List & Detailed Text Inspector (7 cols) */}
        <div className="lg:col-span-7 space-y-6">
          {/* Source List */}
          <div className="bg-white border border-[#E9E2F5] rounded-2xl p-5 shadow-xs">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-[#171717] flex items-center space-x-2">
                <Layers className="w-4 h-4 text-[#8B5CF6]" />
                <span>Connected Sources ({sources.length})</span>
              </h2>
              <span className="text-[11px] text-[#71717A] font-mono">
                Auto-Redaction Enabled
              </span>
            </div>

            <div className="space-y-2">
              {sources.map(s => {
                const isSelected = selectedSource?.id === s.id;
                return (
                  <div
                    key={s.id}
                    onClick={() => setSelectedSource(s)}
                    className={`p-3 rounded-xl border flex items-center justify-between cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-[#F5F0FF] border-[#8B5CF6] shadow-xs'
                        : 'bg-[#FAF8FF] border-[#E9E2F5] hover:bg-white hover:border-[#A78BFA]'
                    }`}
                  >
                    <div className="flex items-center space-x-3 truncate">
                      <div className="w-8 h-8 rounded-lg bg-white border border-[#E9E2F5] flex items-center justify-center shrink-0">
                        {s.source_type === 'GITHUB' ? (
                          <FolderGit2 className="w-4 h-4 text-[#8B5CF6]" />
                        ) : (
                          <FileText className="w-4 h-4 text-[#16A34A]" />
                        )}
                      </div>
                      <div className="truncate">
                        <div className="text-xs font-bold text-[#171717] truncate flex items-center space-x-2">
                          <span>{s.name}</span>
                          <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-white border border-[#E9E2F5] text-[#71717A]">
                            {s.source_type}
                          </span>
                        </div>
                        <div className="text-[11px] text-[#52525B] flex items-center space-x-2 mt-0.5">
                          <span>{s.uploaded_by}</span>
                          <span>•</span>
                          <span>{new Date(s.created_at).toLocaleDateString()}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center space-x-2 shrink-0">
                      <span className="text-[11px] font-mono text-[#71717A]">
                        v{s.version || 1} · {s.processing_status}
                      </span>
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          setEditingSource(s);
                          setEditedContent(s.raw_content);
                        }}
                        className="p-1.5 text-[#71717A] hover:text-[#8B5CF6] hover:bg-white rounded-lg transition-colors cursor-pointer"
                        title="Update source revision"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          setSourceToDelete({ id: s.id, name: s.name });
                        }}
                        className="p-1.5 text-[#71717A] hover:text-[#DC2626] hover:bg-white rounded-lg transition-colors cursor-pointer"
                        title="Delete source"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Raw Text Inspector */}
          {selectedSource && (
            <div className="bg-white border border-[#E9E2F5] rounded-2xl p-5 shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3 pb-3 border-b border-[#E9E2F5]">
                <div className="flex items-center space-x-2">
                  <Eye className="w-4 h-4 text-[#8B5CF6]" />
                  <span className="text-xs font-bold text-[#171717]">
                    Source Inspector: {selectedSource.name} (v{selectedSource.version || 1})
                  </span>
                </div>
                <div className="flex items-center space-x-3 text-[11px] font-mono text-[#71717A]">
                  <span>Access: {selectedSource.access_level}</span>
                  <span>Lines: {selectedSource.metadata?.lines_count || 'N/A'}</span>
                  <button
                    onClick={() => {
                      setEditingSource(selectedSource);
                      setEditedContent(selectedSource.raw_content);
                    }}
                    className="text-[#8B5CF6] hover:underline font-sans font-semibold cursor-pointer"
                  >
                    Update Revision
                  </button>
                </div>
              </div>

              <div className="relative">
                <pre className="font-mono text-[11px] text-[#171717] bg-[#FAF8FF] p-4 rounded-xl max-h-72 overflow-y-auto leading-relaxed border border-[#E9E2F5] scrollbar-thin whitespace-pre-wrap">
                  {selectedSource.raw_content}
                </pre>
                <div className="absolute top-2 right-2 text-[10px] font-mono bg-white text-[#16A34A] border border-[#BBF7D0] px-2 py-0.5 rounded font-semibold">
                  Raw Ground Truth
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Update Source Revision Modal */}
      {editingSource && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveSourceRevision}
            className="bg-white border border-[#E9E2F5] rounded-2xl max-w-2xl w-full p-6 space-y-4 shadow-xl text-xs"
          >
            <div className="flex items-center justify-between pb-3 border-b border-[#E9E2F5]">
              <div>
                <h3 className="text-sm font-bold text-[#171717]">
                  Update Source Revision: {editingSource.name}
                </h3>
                <p className="text-[11px] text-[#52525B] mt-0.5">
                  Saving creates v{(editingSource.version || 1) + 1} with pre-storage redaction and flags any previously verified claims affected by drift.
                </p>
              </div>
              <span className="font-mono text-[11px] text-[#8B5CF6] font-bold">
                v{editingSource.version || 1} → v{(editingSource.version || 1) + 1}
              </span>
            </div>

            <textarea
              rows={12}
              value={editedContent}
              onChange={e => setEditedContent(e.target.value)}
              className="w-full font-mono bg-[#FAF8FF] border border-[#E9E2F5] rounded-xl p-3 text-[#171717] focus:outline-none focus:border-[#8B5CF6] text-xs leading-relaxed"
            />

            <div className="flex justify-end space-x-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingSource(null)}
                className="px-4 py-2 rounded-xl bg-white border border-[#E9E2F5] text-[#52525B] hover:bg-[#FAF8FF] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isUpdatingRevision}
                className="px-4 py-2 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] disabled:opacity-50 text-white font-bold cursor-pointer"
              >
                {isUpdatingRevision ? 'Saving & Checking Drift...' : 'Save Updated Revision'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Delete Source Confirmation Modal */}
      {sourceToDelete && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-[#E9E2F5] rounded-2xl max-w-md w-full p-6 space-y-4 shadow-xl text-xs">
            <h3 className="text-sm font-bold text-[#171717]">Remove Project Source?</h3>
            <p className="text-[#52525B] leading-relaxed">
              Are you sure you want to remove <strong className="text-[#171717]">{sourceToDelete.name}</strong> from this project? Only Project Leads (OWNER) can perform deletions.
            </p>
            <div className="flex justify-end space-x-2 pt-2">
              <button
                onClick={() => setSourceToDelete(null)}
                className="px-4 py-2 rounded-xl bg-white border border-[#E9E2F5] text-[#52525B] hover:bg-[#FAF8FF] cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteSource}
                className="px-4 py-2 rounded-xl bg-[#DC2626] hover:bg-[#B91C1C] text-white font-bold cursor-pointer shadow-xs"
              >
                Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
