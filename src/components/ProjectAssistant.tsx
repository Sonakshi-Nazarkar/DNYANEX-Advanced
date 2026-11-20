import React, { useState, useRef, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { api } from '../services/api';
import { AssistantMessage, Claim } from '../types';
import {
  Bot,
  Send,
  ShieldCheck,
  AlertTriangle,
  Sparkles,
  FileText,
  ArrowRight,
  Lock,
  Trash2,
  CheckCircle2,
  HelpCircle,
  Loader2
} from 'lucide-react';

const STARTER_PROMPTS = [
  {
    label: 'Auth & Database History',
    question: 'Why did the team migrate auth persistence to PostgreSQL and how is Redis used?'
  },
  {
    label: 'Release Schedule Check',
    question: 'When is the production rollout scheduled and are there any conflicting dates?'
  },
  {
    label: 'Ownership & Unresolved Risks',
    question: 'What critical billing or backup ownership risks exist before Sarah Chen departs?'
  },
  {
    label: 'Test Insufficient Evidence',
    question: 'What GraphQL schema and native iOS SwiftUI modules are documented for the mobile app?'
  }
];

export const ProjectAssistant: React.FC = () => {
  const {
    activeProject,
    currentRole,
    isAuthenticated,
    setIsAuthModalOpen,
    setActiveView,
    setSelectedClaim,
    addToast
  } = useApp();

  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [question, setQuestion] = useState('');
  const [isAsking, setIsAsking] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!activeProject?.id) return;
    api
      .getClaims(activeProject.id)
      .then(setClaims)
      .catch(() => {});
  }, [activeProject, currentRole]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isAsking]);

  const handleAsk = async (promptText?: string) => {
    const q = (promptText ?? question).trim();
    if (!q || !activeProject || isAsking) return;

    if (!isAuthenticated) {
      addToast('warning', 'Authentication Required', 'Please sign in to query the AI Project Assistant.');
      setIsAuthModalOpen(true);
      return;
    }

    const userMsg: AssistantMessage = {
      id: `msg_${Date.now()}_u`,
      role: 'user',
      content: q,
      timestamp: new Date().toISOString()
    };

    const historyPayload = messages
      .filter(m => !m.error)
      .slice(-6)
      .map(m => ({ role: m.role, content: m.content }));

    setMessages(prev => [...prev, userMsg]);
    if (!promptText) setQuestion('');
    setIsAsking(true);

    try {
      const response = await api.askAssistant(activeProject.id, q, historyPayload);
      const assistantMsg: AssistantMessage = {
        id: `msg_${Date.now()}_a`,
        role: 'assistant',
        content: response.answer,
        timestamp: new Date().toISOString(),
        response
      };
      setMessages(prev => [...prev, assistantMsg]);
    } catch (err: any) {
      const errorMsg: AssistantMessage = {
        id: `msg_${Date.now()}_err`,
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
        error: err.message || 'Unable to generate grounded response.'
      };
      setMessages(prev => [...prev, errorMsg]);
      addToast('error', 'Assistant Error', err.message);
    } finally {
      setIsAsking(false);
    }
  };

  const handleInspectClaim = (claimId?: string | null) => {
    if (claimId) {
      const match = claims.find(c => c.id === claimId);
      if (match) setSelectedClaim(match);
    }
    setActiveView('CLAIM_LEDGER');
  };

  return (
    <div className="p-4 sm:p-6 md:p-8 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-[#E9E2F5]">
        <div>
          <div className="flex items-center space-x-2 text-xs font-mono text-[#8B5CF6] uppercase tracking-wider mb-1 font-semibold">
            <Bot className="w-4 h-4 text-[#8B5CF6]" />
            <span>Evidence-Grounded AI Project Assistant</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-[#171717]">
            Ask Your Project History
          </h1>
          <p className="text-xs sm:text-sm text-[#52525B] mt-1 max-w-2xl leading-relaxed">
            Ask natural-language questions about architectural decisions, ownership, conflicts, and blockers. Every answer is verified verbatim against connected project sources—or explicitly flagged when evidence is missing.
          </p>
        </div>

        <div className="flex items-center space-x-2 shrink-0">
          <div className="flex items-center space-x-1.5 text-[11px] font-mono bg-white border border-[#E9E2F5] px-3 py-2 rounded-xl text-[#52525B] shadow-2xs">
            <Lock className="w-3.5 h-3.5 text-[#8B5CF6]" />
            <span>
              Scope: <strong className="text-[#171717]">{currentRole}</strong>
              {currentRole === 'INCOMING_MEMBER' ? ' (Confidential Excluded)' : ' (Full Access)'}
            </span>
          </div>

          {messages.length > 0 && (
            <button
              onClick={() => setMessages([])}
              className="flex items-center space-x-1.5 text-xs text-[#52525B] hover:text-[#DC2626] bg-white border border-[#E9E2F5] px-3 py-2 rounded-xl transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Split Container */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Guided Questions & Grounding Guarantees (4 cols) */}
        <div className="lg:col-span-4 space-y-5">
          <div className="bg-white border border-[#E9E2F5] rounded-2xl p-5 space-y-4 shadow-xs">
            <div className="flex items-center space-x-2 text-xs font-bold text-[#171717]">
              <Sparkles className="w-4 h-4 text-[#8B5CF6]" />
              <span>Suggested Questions</span>
            </div>
            <div className="space-y-2">
              {STARTER_PROMPTS.map((item, idx) => (
                <button
                  key={idx}
                  onClick={() => handleAsk(item.question)}
                  disabled={isAsking}
                  className="w-full text-left p-3 rounded-xl bg-[#FAF8FF] hover:bg-[#F5F0FF] border border-[#E9E2F5] hover:border-[#8B5CF6] transition-all cursor-pointer group"
                >
                  <div className="text-[10px] font-mono uppercase font-bold text-[#8B5CF6] mb-0.5">
                    {item.label}
                  </div>
                  <div className="text-xs text-[#171717] font-medium leading-snug group-hover:text-[#7C3AED]">
                    {item.question}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="bg-white border border-[#E9E2F5] rounded-2xl p-5 space-y-3 text-xs shadow-xs">
            <div className="flex items-center space-x-2 font-bold text-[#171717]">
              <ShieldCheck className="w-4 h-4 text-[#16A34A]" />
              <span>Anti-Hallucination Guarantees</span>
            </div>
            <ul className="space-y-2 text-[#52525B] text-[11px] leading-relaxed">
              <li className="flex items-start space-x-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-[#16A34A] shrink-0 mt-0.5" />
                <span>Every citation is deterministically matched against raw source documents with exact character offsets.</span>
              </li>
              <li className="flex items-start space-x-2">
                <AlertTriangle className="w-3.5 h-3.5 text-[#D97706] shrink-0 mt-0.5" />
                <span>Questions without supporting source evidence explicitly return an Insufficient Evidence notice.</span>
              </li>
              <li className="flex items-start space-x-2">
                <Lock className="w-3.5 h-3.5 text-[#8B5CF6] shrink-0 mt-0.5" />
                <span>Sources marked CONFIDENTIAL are filtered out before AI context assembly for Incoming Developers.</span>
              </li>
            </ul>
          </div>
        </div>

        {/* Right: Chat & Evidence Arena (8 cols) */}
        <div className="lg:col-span-8 bg-white border border-[#E9E2F5] rounded-2xl flex flex-col min-h-[580px] max-h-[720px] shadow-xs overflow-hidden">
          {/* Messages Feed */}
          <div className="flex-1 p-5 overflow-y-auto space-y-5 scrollbar-thin bg-[#FAF8FF]/50">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center py-12 px-4 space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-[#F5F0FF] border border-[#E9E2F5] flex items-center justify-center">
                  <Bot className="w-6 h-6 text-[#8B5CF6]" />
                </div>
                <h2 className="text-base font-bold text-[#171717]">
                  Evidence-Grounded Project Intelligence Ready
                </h2>
                <p className="text-xs text-[#52525B] max-w-md leading-relaxed">
                  Ask any question about <span className="font-semibold text-[#171717]">{activeProject?.name || 'your project'}</span>. Responses cite verbatim evidence from your connected commits, ADRs, and meeting notes.
                </p>
              </div>
            ) : (
              messages.map(msg => {
                if (msg.role === 'user') {
                  return (
                    <div key={msg.id} className="flex justify-end">
                      <div className="max-w-xl bg-[#8B5CF6] text-white rounded-2xl rounded-br-xs px-4 py-3 text-xs leading-relaxed shadow-xs">
                        <div className="font-medium">{msg.content}</div>
                      </div>
                    </div>
                  );
                }

                if (msg.error) {
                  return (
                    <div key={msg.id} className="flex justify-start">
                      <div className="max-w-2xl bg-[#FEE2E2] border border-[#FECACA] text-[#DC2626] rounded-2xl p-4 text-xs space-y-1">
                        <div className="font-bold flex items-center space-x-1.5">
                          <AlertTriangle className="w-4 h-4" />
                          <span>Assistant Error</span>
                        </div>
                        <p>{msg.error}</p>
                      </div>
                    </div>
                  );
                }

                const resp = msg.response;
                const isInsufficient = resp && !resp.sufficient_evidence;

                return (
                  <div key={msg.id} className="flex justify-start">
                    <div className="w-full max-w-2xl bg-white border border-[#E9E2F5] rounded-2xl rounded-bl-xs p-5 space-y-4 shadow-2xs text-xs">
                      {/* Status Header */}
                      {resp && (
                        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#E9E2F5]">
                          <div className="flex items-center space-x-2">
                            {isInsufficient ? (
                              <span className="inline-flex items-center space-x-1.5 font-mono text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-[#FEF3C7] text-[#D97706] border border-[#FDE68A]">
                                <HelpCircle className="w-3 h-3" />
                                <span>INSUFFICIENT EVIDENCE IN SOURCES</span>
                              </span>
                            ) : (
                              <span className="inline-flex items-center space-x-1.5 font-mono text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-[#DCFCE7] text-[#16A34A] border border-[#BBF7D0]">
                                <ShieldCheck className="w-3 h-3" />
                                <span>EVIDENCE-GROUNDED ANSWER</span>
                              </span>
                            )}
                            <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-[#FAF8FF] border border-[#E9E2F5] text-[#52525B]">
                              Confidence: {resp.confidence.toUpperCase()}
                            </span>
                          </div>

                          <span className="font-mono text-[10px] text-[#71717A]">
                            {resp.accessible_sources_count} source(s)
                            {resp.restricted_sources_excluded > 0 &&
                              ` · ${resp.restricted_sources_excluded} confidential hidden`}
                          </span>
                        </div>
                      )}

                      {/* Missing Evidence Highlight */}
                      {isInsufficient && resp?.missing_evidence_reason && (
                        <div className="p-3 rounded-xl bg-[#FFFBEB] border border-[#FDE68A] text-[#92400E] text-[11px] leading-relaxed">
                          <strong className="text-[#D97706] block mb-0.5">Missing Documentation Notice:</strong>
                          {resp.missing_evidence_reason}
                        </div>
                      )}

                      {/* Main Answer Text */}
                      <div className="text-[#171717] text-xs sm:text-[13px] leading-relaxed whitespace-pre-line">
                        {msg.content}
                      </div>

                      {/* Supporting Citations */}
                      {resp && resp.citations.length > 0 && (
                        <div className="space-y-2 pt-2 border-t border-[#E9E2F5]">
                          <div className="text-[10px] font-mono uppercase font-bold text-[#8B5CF6]">
                            Supporting Evidence & Source References ({resp.citations.length})
                          </div>
                          {resp.citations.map((cit, cIdx) => (
                            <div
                              key={cIdx}
                              className="p-3 rounded-xl bg-[#FAF8FF] border border-[#E9E2F5] space-y-1.5"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center space-x-1.5 font-mono text-[10px] text-[#171717] font-bold">
                                  <FileText className="w-3.5 h-3.5 text-[#8B5CF6]" />
                                  <span>{cit.source_name}</span>
                                  {cit.source_location && cit.source_location !== cit.source_name && (
                                    <span className="text-[#71717A] font-normal">· {cit.source_location}</span>
                                  )}
                                </div>
                                <span
                                  className={`font-mono text-[9px] px-2 py-0.5 rounded-full border font-bold ${
                                    cit.exact_verified
                                      ? 'bg-[#DCFCE7] text-[#16A34A] border-[#BBF7D0]'
                                      : 'bg-[#FEF3C7] text-[#D97706] border-[#FDE68A]'
                                  }`}
                                >
                                  {cit.exact_verified
                                    ? `Exact Match (${cit.match_start_idx}–${cit.match_end_idx})`
                                    : 'Unverified Quote'}
                                </span>
                              </div>
                              <blockquote className="italic text-[11px] text-[#52525B] bg-white p-2 rounded-lg border border-[#E9E2F5]">
                                "{cit.supporting_quote}"
                              </blockquote>
                              {cit.claim_id && (
                                <button
                                  onClick={() => handleInspectClaim(cit.claim_id)}
                                  className="inline-flex items-center space-x-1 text-[10px] font-semibold text-[#8B5CF6] hover:text-[#7C3AED] cursor-pointer"
                                >
                                  <span>Inspect claim {cit.claim_id} in Claim Ledger</span>
                                  <ArrowRight className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Related Claim Deep Links */}
                      {resp && resp.related_claim_ids.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          <span className="text-[10px] font-mono text-[#71717A]">Related Claims:</span>
                          {resp.related_claim_ids.map(cid => (
                            <button
                              key={cid}
                              onClick={() => handleInspectClaim(cid)}
                              className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-md bg-[#F5F0FF] text-[#8B5CF6] border border-[#E9E2F5] hover:border-[#8B5CF6] cursor-pointer"
                            >
                              {cid}
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Suggested Follow-ups */}
                      {resp && resp.suggested_followups.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-2 border-t border-[#E9E2F5]">
                          {resp.suggested_followups.map((f, fIdx) => (
                            <button
                              key={fIdx}
                              onClick={() => handleAsk(f)}
                              disabled={isAsking}
                              className="text-[11px] px-2.5 py-1 rounded-lg bg-[#FAF8FF] hover:bg-[#F5F0FF] text-[#52525B] hover:text-[#8B5CF6] border border-[#E9E2F5] transition-colors cursor-pointer text-left"
                            >
                              {f}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}

            {isAsking && (
              <div className="flex justify-start">
                <div className="bg-white border border-[#E9E2F5] rounded-2xl px-4 py-3 text-xs text-[#52525B] flex items-center space-x-2 shadow-2xs">
                  <Loader2 className="w-4 h-4 text-[#8B5CF6] animate-spin" />
                  <span>Searching connected sources and verifying verbatim citations...</span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input Composer */}
          <form
            onSubmit={e => {
              e.preventDefault();
              handleAsk();
            }}
            className="p-4 bg-white border-t border-[#E9E2F5] flex items-center space-x-3"
          >
            <input
              type="text"
              value={question}
              onChange={e => setQuestion(e.target.value)}
              placeholder={
                isAuthenticated
                  ? 'Ask about decisions, deadlines, owners, secrets vault, or open blockers...'
                  : 'Sign in above to ask the Evidence-Grounded Project Assistant...'
              }
              disabled={isAsking}
              className="flex-1 bg-[#FAF8FF] border border-[#E9E2F5] rounded-xl px-4 py-2.5 text-xs text-[#171717] placeholder-[#A1A1AA] focus:outline-none focus:border-[#8B5CF6] focus:ring-1 focus:ring-[#8B5CF6]"
            />
            <button
              type="submit"
              disabled={isAsking || !question.trim()}
              className="flex items-center space-x-1.5 bg-[#8B5CF6] hover:bg-[#7C3AED] disabled:opacity-50 text-white font-bold px-4 py-2.5 rounded-xl text-xs transition-all cursor-pointer shadow-xs"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Ask</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
