import express, { Request, Response, NextFunction } from 'express';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import multer from 'multer';
import crypto from 'crypto';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  DEMO_ACCOUNTS,
  INITIAL_PROJECT,
  INITIAL_SOURCES,
  INITIAL_CLAIMS,
  INITIAL_CONFLICTS,
  INITIAL_GAPS,
  INITIAL_HANDOVERS
} from './src/data/seedData';
import {
  AuthUser,
  AssistantCitation,
  AssistantResponse,
  Project,
  Source,
  SourceType,
  Claim,
  Conflict,
  GapOrMissingEvidence,
  Handover,
  Role,
  DependencyNode,
  DependencyNodeType,
  DependencyEdge,
  DependencyGraphResponse,
  DriftAlert,
  DriftAnalysisReport,
  DriftCategory,
  DriftSeverity
} from './src/types';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Extend Express Request with authenticated user
interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

// Initialize Google GenAI Server-side Client
const geminiApiKey = process.env.GEMINI_API_KEY || '';
const ai = new GoogleGenAI({
  apiKey: geminiApiKey,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build'
    }
  }
});

async function generateContentResilient(
  params: Omit<Parameters<typeof ai.models.generateContent>[0], 'model'>,
  timeoutMs = 35000
): Promise<{ response: any; modelUsed: string }> {
  const attempts: { model: string; backoffMs: number }[] = [
    { model: 'gemini-4-hydrogen', backoffMs: 1200 },
    { model: 'gemini-3.1-flash-lite', backoffMs: 2400 },
    { model: 'gemini-3.1-flash-lite', backoffMs: 0 }
  ];

  let lastError: any;
  for (let i = 0; i < attempts.length; i++) {
    const { model, backoffMs } = attempts[i];
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Gemini call (${model}) timed out after ${timeoutMs / 1000}s`)), timeoutMs)
      );
      const mergedConfig =
        model === 'gemini-4-hydrogen'
          ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, ...(params.config || {}) }
          : { ...(params.config || {}) };
      const apiPromise = ai.models.generateContent({
        ...params,
        config: mergedConfig,
        model
      });
      const response = await Promise.race([apiPromise, timeoutPromise]);
      return { response, modelUsed: model };
    } catch (err: any) {
      lastError = err;
      const msg = String(err?.message || err || '');
      const isTransient =
        msg.includes('503') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('429') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('500') ||
        msg.includes('502') ||
        msg.includes('504') ||
        msg.includes('ECONNRESET') ||
        msg.includes('fetch failed') ||
        msg.includes('high demand') ||
        msg.includes('timed out');
      if (!isTransient) {
        throw err;
      }
      if (backoffMs > 0 && i < attempts.length - 1) {
        const jitter = Math.floor(Math.random() * 400);
        await new Promise(resolve => setTimeout(resolve, backoffMs + jitter));
      }
    }
  }
  throw lastError;
}

// Active Sessions Store (token -> AuthUser)
const sessions = new Map<string, AuthUser>();

// Storage In-Memory State initialized with CampusConnect Synthetic Seed
let projects: Project[] = [JSON.parse(JSON.stringify(INITIAL_PROJECT))];
let sources: Source[] = JSON.parse(JSON.stringify(INITIAL_SOURCES));
let claims: Claim[] = JSON.parse(JSON.stringify(INITIAL_CLAIMS));
let conflicts: Conflict[] = JSON.parse(JSON.stringify(INITIAL_CONFLICTS));
let gaps: GapOrMissingEvidence[] = JSON.parse(JSON.stringify(INITIAL_GAPS));
let handovers: Handover[] = JSON.parse(JSON.stringify(INITIAL_HANDOVERS));
let driftAlerts: DriftAlert[] = [];

const ALLOWED_SOURCE_TYPES: SourceType[] = [
  'GITHUB',
  'PDF',
  'DOCX',
  'MARKDOWN',
  'TXT',
  'CSV',
  'JSON'
];

const ALLOWED_ACCESS_LEVELS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'] as const;

// Configure Multer memory upload (10MB max)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ==========================================
// AUTH & RBAC MIDDLEWARE
// ==========================================
function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

function optionalAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  const token = extractBearerToken(req);
  if (token && sessions.has(token)) {
    req.user = sessions.get(token);
  }
  next();
}

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = extractBearerToken(req);
  if (!token || !sessions.has(token)) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Please sign in with a valid DNYANEX session token.'
    });
  }
  req.user = sessions.get(token);
  next();
}

function requireRole(...allowedRoles: Role[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        message: `Role "${req.user.role}" is not authorized for this action. Required: ${allowedRoles.join(' or ')}.`
      });
    }
    next();
  };
}

function isConfidentialRestrictedFor(user?: AuthUser): boolean {
  return !user || user.role === 'INCOMING_MEMBER';
}

function getAccessibleSources(projectId: string, user?: AuthUser): {
  accessible: Source[];
  excludedCount: number;
} {
  const all = sources.filter(s => s.project_id === projectId);
  if (!isConfidentialRestrictedFor(user)) {
    return { accessible: all, excludedCount: 0 };
  }
  const accessible = all.filter(s => s.access_level !== 'CONFIDENTIAL');
  return { accessible, excludedCount: all.length - accessible.length };
}

// ==========================================
// DETERMINISTIC SECURITY & PARSING HELPERS
// ==========================================
function redactSensitiveData(text: string): { cleanText: string; redactedCount: number } {
  let count = 0;
  let cleanText = text;

  // Private key PEM blocks
  cleanText = cleanText.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    () => {
      count++;
      return '[REDACTED_PRIVATE_KEY_BLOCK]';
    }
  );

  // GitHub Personal Access Tokens / fine-grained tokens
  cleanText = cleanText.replace(/gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{30,}/g, () => {
    count++;
    return '[REDACTED_GITHUB_TOKEN]';
  });

  // Google API keys
  cleanText = cleanText.replace(/AIza[0-9A-Za-z-_]{35}/g, () => {
    count++;
    return '[REDACTED_GOOGLE_API_KEY]';
  });

  // AWS Access Key IDs
  cleanText = cleanText.replace(/\bAKIA[0-9A-Z]{16}\b/g, () => {
    count++;
    return '[REDACTED_AWS_KEY]';
  });

  // OpenAI / Stripe / Anthropic style secret keys
  cleanText = cleanText.replace(/sk[-_](live|test|proj|ant)?[-_a-zA-Z0-9]{20,}/g, () => {
    count++;
    return '[REDACTED_API_SECRET]';
  });

  // JWT tokens
  cleanText = cleanText.replace(/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, () => {
    count++;
    return '[REDACTED_JWT_TOKEN]';
  });

  // Bearer auth headers
  cleanText = cleanText.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, () => {
    count++;
    return 'Bearer [REDACTED_BEARER_TOKEN]';
  });

  // Database / service connection URI credentials: scheme://user:password@host
  cleanText = cleanText.replace(
    /\b((?:postgres|postgresql|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^:\s/@]*:)([^@\s]+)(@)/gi,
    (_match, prefix, _secret, at) => {
      count++;
      return `${prefix}[REDACTED_DB_PASSWORD]${at}`;
    }
  );

  // Generic Passwords or auth key/values in configs/notes
  cleanText = cleanText.replace(
    /\b(password|passwd|secret|token|api_key|apikey|client_secret|access_key|private_key|db_password)\b\s*[:=]\s*["']?([^\s"']{6,})["']?/gi,
    (_match, key) => {
      count++;
      return `${key}: [REDACTED_CREDENTIAL]`;
    }
  );

  return { cleanText, redactedCount: count };
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// Pure Node DOCX (ZIP + word/document.xml) text extractor
function extractTextFromDocx(buffer: Buffer): string {
  // Check ZIP PK header
  if (buffer.length < 30 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('Invalid DOCX file: missing ZIP container header.');
  }

  let offset = 0;
  let xmlContent = '';

  while (offset + 30 <= buffer.length) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;

    const flags = buffer.readUInt16LE(offset + 6);
    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);

    const fileNameStart = offset + 30;
    const fileName = buffer.toString('utf8', fileNameStart, fileNameStart + fileNameLen);
    const dataStart = fileNameStart + fileNameLen + extraLen;

    // Handle data descriptor bit (flag bit 3) if compressedSize is 0
    let dataEnd = dataStart + compressedSize;
    if ((flags & 0x08) !== 0 && compressedSize === 0) {
      const nextSig = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), dataStart);
      const centralSig = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), dataStart);
      const nextBoundary =
        nextSig !== -1 && centralSig !== -1
          ? Math.min(nextSig, centralSig)
          : Math.max(nextSig, centralSig);
      dataEnd = nextBoundary !== -1 ? nextBoundary : buffer.length;
    }

    if (fileName === 'word/document.xml') {
      const compressedData = buffer.subarray(dataStart, dataEnd);
      if (compressionMethod === 0) {
        xmlContent = compressedData.toString('utf8');
      } else if (compressionMethod === 8) {
        xmlContent = zlib.inflateRawSync(compressedData).toString('utf8');
      } else {
        throw new Error(`Unsupported DOCX compression method (${compressionMethod}).`);
      }
      break;
    }

    if (compressedSize === 0 && (flags & 0x08) !== 0) {
      offset = dataEnd;
    } else {
      offset = dataEnd;
    }
  }

  if (!xmlContent) {
    throw new Error('Invalid DOCX archive: word/document.xml not found.');
  }

  const text = decodeXmlEntities(
    xmlContent
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:br\s*\/?>/g, '\n')
      .replace(/<w:tab\s*\/?>/g, '\t')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text) {
    throw new Error('DOCX document contains no readable text content.');
  }
  return text;
}

function unescapePdfString(str: string): string {
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

function extractPdfOperatorsText(content: string): string[] {
  const chunks: string[] = [];
  // Match literal strings followed by Tj or inside [...] TJ arrays
  const tjArrayRegex = /\[([\s\S]*?)\]\s*TJ/g;
  let m: RegExpExecArray | null;
  while ((m = tjArrayRegex.exec(content)) !== null) {
    const inner = m[1];
    const parts: string[] = [];
    const strRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)/g;
    let sm: RegExpExecArray | null;
    while ((sm = strRegex.exec(inner)) !== null) {
      parts.push(unescapePdfString(sm[1]));
    }
    if (parts.length > 0) chunks.push(parts.join(''));
  }

  const tjSingleRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g;
  while ((m = tjSingleRegex.exec(content)) !== null) {
    const val = unescapePdfString(m[1]).trim();
    if (val) chunks.push(val);
  }
  return chunks;
}

// Pure Node PDF text extractor (validates %PDF- header + extracts text from uncompressed or FlateDecode streams)
function extractTextFromPdf(buffer: Buffer): string {
  const header = buffer.subarray(0, 8).toString('latin1');
  if (!header.startsWith('%PDF-')) {
    throw new Error('Invalid PDF file: missing %PDF- signature.');
  }

  const rawLatin = buffer.toString('latin1');
  const extractedChunks: string[] = [];

  // Process stream blocks
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRegex.exec(rawLatin)) !== null) {
    const startIdx = match.index + match[0].indexOf(match[1]);
    const endIdx = startIdx + match[1].length;
    const streamBuf = buffer.subarray(startIdx, endIdx);

    let decoded = '';
    try {
      decoded = zlib.inflateSync(streamBuf).toString('latin1');
    } catch {
      decoded = streamBuf.toString('latin1');
    }

    const opTexts = extractPdfOperatorsText(decoded);
    if (opTexts.length > 0) {
      extractedChunks.push(opTexts.join('\n'));
    }
  }

  // Fallback for direct non-stream literal operators if simple PDF
  if (extractedChunks.length === 0) {
    const directOps = extractPdfOperatorsText(rawLatin);
    if (directOps.length > 0) {
      extractedChunks.push(directOps.join('\n'));
    }
  }

  const text = extractedChunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) {
    throw new Error(
      'Unable to extract readable text from PDF (scanned image-only or unsupported font encoding). Please paste text or upload a text-based PDF.'
    );
  }
  return text;
}

// Deterministic Exact Quote Verifier (true offsets in raw sourceText, zero fabricated fallback)
function verifySupportingQuote(
  sourceText: string,
  quote: string
): { isMatch: boolean; startIdx: number; endIdx: number } {
  if (!quote || !sourceText) {
    return { isMatch: false, startIdx: -1, endIdx: -1 };
  }

  const trimmedQuote = quote.trim();
  if (!trimmedQuote) {
    return { isMatch: false, startIdx: -1, endIdx: -1 };
  }

  // 1. Direct substring match
  const directIdx = sourceText.indexOf(trimmedQuote);
  if (directIdx !== -1) {
    return { isMatch: true, startIdx: directIdx, endIdx: directIdx + trimmedQuote.length };
  }

  // 2. Whitespace/newline-tolerant exact token match directly on raw sourceText
  const escapedTokens = trimmedQuote
    .split(/\s+/)
    .filter(Boolean)
    .map(tok => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (escapedTokens.length > 0) {
    try {
      const pattern = new RegExp(escapedTokens.join('\\s+'), 'i');
      const regexMatch = pattern.exec(sourceText);
      if (regexMatch && regexMatch.index !== undefined) {
        return {
          isMatch: true,
          startIdx: regexMatch.index,
          endIdx: regexMatch.index + regexMatch[0].length
        };
      }
    } catch {
      // Ignore invalid regex edge cases
    }
  }

  return { isMatch: false, startIdx: -1, endIdx: -1 };
}

// Generalized Cross-Source Conflict Detector
function detectConflictsAcrossClaims(projectId: string, candidateClaims: Claim[]): Conflict[] {
  const detected: Conflict[] = [];
  const monthDayRegex =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s+\d{4})?\b|\b(\d{4}-\d{2}-\d{2})\b/i;
  const releaseKeywords = /\b(release|rollout|deploy|deployment|launch|freeze|deadline|ship|cutover)\b/i;

  for (let i = 0; i < candidateClaims.length; i++) {
    for (let j = i + 1; j < candidateClaims.length; j++) {
      const c1 = candidateClaims[i];
      const c2 = candidateClaims[j];

      const text1 = `${c1.statement} ${c1.event_date || ''}`;
      const text2 = `${c2.statement} ${c2.event_date || ''}`;

      const isRelease1 = releaseKeywords.test(c1.statement) || c1.type === 'DECISION';
      const isRelease2 = releaseKeywords.test(c2.statement) || c2.type === 'DECISION';

      if (isRelease1 && isRelease2) {
        const d1Match = monthDayRegex.exec(c1.statement);
        const d2Match = monthDayRegex.exec(c2.statement);
        const dateToken1 = d1Match ? (d1Match[0] || '').toLowerCase().replace(',', '') : '';
        const dateToken2 = d2Match ? (d2Match[0] || '').toLowerCase().replace(',', '') : '';

        if (dateToken1 && dateToken2 && dateToken1 !== dateToken2) {
          c1.evidence_status = 'CONFLICTING';
          c2.evidence_status = 'CONFLICTING';
          detected.push({
            id: `cnf_${Date.now()}_${i}_${j}`,
            project_id: projectId,
            topic: 'Release / Milestone Date Discrepancy',
            claim_a_id: c1.id,
            claim_b_id: c2.id,
            explanation: `${c1.source_name} specifies "${d1Match![0]}", whereas ${c2.source_name} specifies "${d2Match![0]}".`,
            status: 'UNRESOLVED'
          });
        }
      }

      // Also avoid unused var lint
      void text1;
      void text2;
    }
  }

  return detected;
}

// Generalized Gap Detector
function detectGapsAcrossClaims(projectId: string, candidateClaims: Claim[]): GapOrMissingEvidence[] {
  const detected: GapOrMissingEvidence[] = [];

  for (const c of candidateClaims) {
    if ((c.type === 'TASK' || c.type === 'NEXT_ACTION') && !c.owner) {
      detected.push({
        id: `gap_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        project_id: projectId,
        title: `Unassigned Task: ${c.statement.slice(0, 48)}${c.statement.length > 48 ? '...' : ''}`,
        description: c.statement,
        category: 'UNASSIGNED_TASK',
        severity: 'CRITICAL',
        suggested_action: 'Assign a clear owner before outgoing member departs.',
        source_reference: c.source_location
      });
    } else if (
      (c.type === 'RISK' || c.type === 'BLOCKER' || c.type === 'DEPENDENCY') &&
      /(single[- ]point|only .* owner|sole|no failover|zero automated failover|billing.*root)/i.test(
        c.statement
      )
    ) {
      detected.push({
        id: `gap_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        project_id: projectId,
        title: `Single-Point Bottleneck: ${c.statement.slice(0, 42)}${c.statement.length > 42 ? '...' : ''}`,
        description: c.statement,
        category: 'SINGLE_POINT_FAILURE',
        severity: 'CRITICAL',
        suggested_action: 'Transfer administrative ownership or provision automated failover.',
        source_reference: c.source_location
      });
    } else if (c.evidence_status === 'MISSING_EVIDENCE') {
      detected.push({
        id: `gap_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        project_id: projectId,
        title: `Unverified Evidence Claim`,
        description: c.statement,
        category: 'MISSING_DEPLOY_SPEC',
        severity: 'WARNING',
        suggested_action: 'Locate supporting documentation or reject ungrounded claim in Review Desk.',
        source_reference: c.source_location
      });
    }
  }

  return detected;
}

// Knowledge Dependency Graph Builder (connects Decisions, Tasks, Owners, Dependencies, Blockers & Risks)
const DOMAIN_KEYWORDS: { key: string; label: string }[] = [
  { key: 'postgresql|postgres|supabase|database', label: 'PostgreSQL / DB' },
  { key: 'redis|cache|blocklist|oom|ttl', label: 'Redis Cache' },
  { key: 'stripe|razorpay|payment|webhook|refund|upi', label: 'Payments & Webhooks' },
  { key: 'twilio|sms|otp', label: 'Twilio OTP' },
  { key: 'cloudflare|rate limit|x-forwarded-for|proxy', label: 'Ingress & Rate Limit' },
  { key: 'doppler|secret|billing|root', label: 'Vault & Root Access' },
  { key: 'release|rollout|december|november|backup|rollback', label: 'Release & Rollback' }
];

function extractDomainTopics(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const kw of DOMAIN_KEYWORDS) {
    if (new RegExp(kw.key, 'i').test(lower)) {
      hits.push(kw.label);
    }
  }
  return hits;
}

function buildDependencyGraph(projectId: string, user?: AuthUser): DependencyGraphResponse {
  const { accessible: accessibleSources } = getAccessibleSources(projectId, user);
  const accessibleIds = new Set(accessibleSources.map(s => s.id));
  const activeClaims = claims.filter(
    c => c.project_id === projectId && accessibleIds.has(c.source_id) && c.reviewer_status !== 'REJECTED'
  );
  const unresolvedConflicts = conflicts.filter(c => c.project_id === projectId && c.status === 'UNRESOLVED');
  const conflictClaimIds = new Set<string>();
  unresolvedConflicts.forEach(cnf => {
    conflictClaimIds.add(cnf.claim_a_id);
    conflictClaimIds.add(cnf.claim_b_id);
  });

  const nodes: DependencyNode[] = [];
  const edges: DependencyEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (edge: DependencyEdge) => {
    const key = `${edge.from}->${edge.to}:${edge.relation}`;
    if (!edgeKeys.has(key) && edge.from !== edge.to) {
      edgeKeys.add(key);
      edges.push(edge);
    }
  };

  // Column x coordinates in 1120x620 SVG space
  const COL_X: Record<DependencyNodeType, number> = {
    OWNER: 120,
    DECISION: 340,
    DEPENDENCY: 560,
    TASK: 770,
    BLOCKER: 560,
    RISK: 980
  };

  // 1. Create Owner Nodes
  const ownerMap = new Map<string, { label: string; claimIds: string[] }>();
  for (const c of activeClaims) {
    const rawOwner = c.owner ? c.owner.split('/')[0].trim() : 'Unassigned Ownership';
    if (!ownerMap.has(rawOwner)) {
      ownerMap.set(rawOwner, { label: rawOwner, claimIds: [] });
    }
    ownerMap.get(rawOwner)!.claimIds.push(c.id);
  }

  const ownerEntries = Array.from(ownerMap.entries());
  ownerEntries.forEach(([ownerName, info], idx) => {
    const isUnassigned = ownerName === 'Unassigned Ownership';
    const yStep = Math.max(85, 520 / Math.max(ownerEntries.length, 1));
    const y = Math.round(70 + idx * yStep);
    nodes.push({
      id: `owner_${ownerName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
      label: ownerName,
      subtitle: isUnassigned
        ? `${info.claimIds.length} unassigned record(s)`
        : `Owns ${info.claimIds.length} claim(s)`,
      node_type: 'OWNER',
      severity: isUnassigned ? 'CRITICAL' : info.claimIds.length >= 3 ? 'HIGH' : 'MEDIUM',
      owner: ownerName,
      statement: isUnassigned
        ? `Knowledge records without a designated engineer create immediate transition blind spots.`
        : `${ownerName} is directly responsible for ${info.claimIds.length} project decision, task, or risk records.`,
      x: COL_X.OWNER,
      y
    });
  });

  // 2. Bucket Claim Nodes into DECISION, DEPENDENCY, BLOCKER, TASK, RISK
  const buckets: Record<Exclude<DependencyNodeType, 'OWNER'>, Claim[]> = {
    DECISION: [],
    DEPENDENCY: [],
    BLOCKER: [],
    TASK: [],
    RISK: []
  };

  for (const c of activeClaims) {
    if (c.type === 'DECISION' || c.type === 'OWNER') buckets.DECISION.push(c);
    else if (c.type === 'DEPENDENCY' || c.type === 'CONTACT_OR_RESOURCE') buckets.DEPENDENCY.push(c);
    else if (c.type === 'BLOCKER') buckets.BLOCKER.push(c);
    else if (c.type === 'RISK' || c.type === 'RECURRING_PROBLEM') buckets.RISK.push(c);
    else buckets.TASK.push(c);
  }

  const layoutColumn = (list: Claim[], colType: Exclude<DependencyNodeType, 'OWNER'>, yStart: number, yEnd: number) => {
    const count = Math.max(list.length, 1);
    const step = (yEnd - yStart) / count;
    list.forEach((c, idx) => {
      const isConflict = conflictClaimIds.has(c.id);
      const sev: DependencyNode['severity'] =
        isConflict || colType === 'BLOCKER' || (colType === 'RISK' && !c.owner)
          ? 'CRITICAL'
          : colType === 'RISK' || !c.owner
            ? 'HIGH'
            : colType === 'DECISION' || colType === 'DEPENDENCY'
              ? 'MEDIUM'
              : 'LOW';

      nodes.push({
        id: `claim_${c.id}`,
        label: c.statement.length > 34 ? c.statement.slice(0, 32) + '...' : c.statement,
        subtitle: isConflict
          ? `CONFLICT · ${c.reviewer_status}`
          : `${c.type} · ${c.reviewer_status}`,
        node_type: colType,
        severity: sev,
        claim_id: c.id,
        claim_type: c.type,
        source_id: c.source_id,
        source_name: c.source_name,
        source_location: c.source_location,
        owner: c.owner || null,
        evidence_status: c.evidence_status,
        reviewer_status: c.reviewer_status,
        statement: c.statement,
        supporting_quote: c.supporting_quote,
        x: COL_X[colType],
        y: Math.round(yStart + idx * step + step * 0.4)
      });
    });
  };

  layoutColumn(buckets.DECISION, 'DECISION', 55, 560);
  // Share middle column cleanly: top half DEPENDENCY, bottom half BLOCKER
  layoutColumn(buckets.DEPENDENCY, 'DEPENDENCY', 50, 290);
  layoutColumn(buckets.BLOCKER, 'BLOCKER', 320, 570);
  layoutColumn(buckets.TASK, 'TASK', 55, 560);
  layoutColumn(buckets.RISK, 'RISK', 55, 560);

  // 3. Connect Owners -> Claims
  for (const c of activeClaims) {
    const rawOwner = c.owner ? c.owner.split('/')[0].trim() : 'Unassigned Ownership';
    const ownerNodeId = `owner_${rawOwner.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    const isUnassigned = rawOwner === 'Unassigned Ownership';
    addEdge({
      id: `edge_${ownerNodeId}_${c.id}`,
      from: ownerNodeId,
      to: `claim_${c.id}`,
      relation: isUnassigned ? 'UNASSIGNED_RISK' : 'OWNS',
      label: isUnassigned ? 'Unassigned' : 'Owns',
      reason: isUnassigned
        ? 'No owner recorded — high knowledge loss risk during transition.'
        : `${rawOwner} holds operational responsibility.`,
      is_critical: isUnassigned || c.type === 'BLOCKER'
    });
  }

  // 4. Connect Conflicts explicitly
  for (const cnf of unresolvedConflicts) {
    if (activeClaims.some(c => c.id === cnf.claim_a_id) && activeClaims.some(c => c.id === cnf.claim_b_id)) {
      addEdge({
        id: `edge_cnf_${cnf.id}`,
        from: `claim_${cnf.claim_a_id}`,
        to: `claim_${cnf.claim_b_id}`,
        relation: 'CONFLICTS_WITH',
        label: 'Contradicts',
        reason: cnf.explanation,
        is_critical: true
      });
    }
  }

  // 5. Connect Decisions <-> Dependencies <-> Blockers <-> Tasks <-> Risks via Shared Domain Topics or Same Source
  const claimNodes = nodes.filter(n => n.claim_id);
  for (let i = 0; i < claimNodes.length; i++) {
    for (let j = i + 1; j < claimNodes.length; j++) {
      const a = claimNodes[i];
      const b = claimNodes[j];
      const topicsA = extractDomainTopics(a.statement);
      const topicsB = extractDomainTopics(b.statement);
      const shared = topicsA.filter(t => topicsB.includes(t));

      if (shared.length === 0) continue;

      // Determine causal direction based on component role
      const orderRank: Record<DependencyNodeType, number> = {
        OWNER: 0,
        DECISION: 1,
        DEPENDENCY: 2,
        BLOCKER: 2,
        TASK: 3,
        RISK: 4
      };
      const [srcNode, dstNode] = orderRank[a.node_type] <= orderRank[b.node_type] ? [a, b] : [b, a];
      if (srcNode.node_type === dstNode.node_type) continue;

      let relation: DependencyEdge['relation'] = 'AFFECTS';
      let label = shared[0];
      let isCritical = false;

      if (srcNode.node_type === 'BLOCKER' || dstNode.node_type === 'BLOCKER') {
        relation = 'BLOCKS';
        label = `Blocks (${shared[0]})`;
        isCritical = true;
      } else if (srcNode.node_type === 'DEPENDENCY' || dstNode.node_type === 'DEPENDENCY') {
        relation = 'DEPENDS_ON';
        label = `Depends (${shared[0]})`;
      } else if (dstNode.node_type === 'RISK') {
        relation = 'AFFECTS';
        label = `Risk Link (${shared[0]})`;
        isCritical = dstNode.severity === 'CRITICAL';
      } else {
        relation = 'AFFECTS';
        label = `Impacts (${shared[0]})`;
      }

      addEdge({
        id: `edge_${srcNode.id}_${dstNode.id}`,
        from: srcNode.id,
        to: dstNode.id,
        relation,
        label,
        reason: `Both records govern "${shared.join(', ')}".`,
        is_critical: isCritical
      });
    }
  }

  // Ensure every Blocker connects to at least one impacted Task or Decision in the same source if no keyword match
  for (const blk of nodes.filter(n => n.node_type === 'BLOCKER')) {
    const hasOut = edges.some(e => e.from === blk.id);
    if (!hasOut) {
      const fallbackTarget = nodes.find(
        n => n.id !== blk.id && (n.node_type === 'TASK' || n.node_type === 'DECISION') && n.source_id === blk.source_id
      );
      if (fallbackTarget) {
        addEdge({
          id: `edge_src_${blk.id}_${fallbackTarget.id}`,
          from: blk.id,
          to: fallbackTarget.id,
          relation: 'BLOCKS',
          label: 'Blocks Same Source',
          reason: `Located in ${blk.source_name} alongside target component.`,
          is_critical: true
        });
      }
    }
  }

  return {
    project_id: projectId,
    nodes,
    edges,
    stats: {
      owners: nodes.filter(n => n.node_type === 'OWNER').length,
      decisions: buckets.DECISION.length,
      tasks: buckets.TASK.length,
      dependencies: buckets.DEPENDENCY.length,
      blockers: buckets.BLOCKER.length,
      risks: buckets.RISK.length,
      total_edges: edges.length
    }
  };
}

// Knowledge Drift & Risk Intelligence Helpers
function runDeterministicDriftChecks(
  projectId: string,
  accessibleSources: Source[],
  accessibleClaims: Claim[]
): DriftAlert[] {
  const alerts: DriftAlert[] = [];
  const nowIso = new Date().toISOString();

  // 1. Source Modifications & Verbatim Evidence Invalidation (Outdated Claims)
  for (const src of accessibleSources) {
    const isModified = Boolean(src.updated_at && src.previous_content !== undefined);
    const relatedClaims = accessibleClaims.filter(c => c.source_id === src.id && c.reviewer_status !== 'REJECTED');

    for (const clm of relatedClaims) {
      const check = verifySupportingQuote(src.raw_content, clm.supporting_quote);
      if (isModified && !check.isMatch) {
        alerts.push({
          id: `drf_outdated_${clm.id}`,
          project_id: projectId,
          category: 'OUTDATED_CLAIM',
          severity: 'CRITICAL',
          title: `Outdated Claim: "${clm.statement.slice(0, 56)}${clm.statement.length > 56 ? '...' : ''}"`,
          description: `Source "${src.name}" was updated (v${src.version || 2}), and the previously verified supporting quote no longer exists verbatim in the document.`,
          affected_claim_ids: [clm.id],
          affected_source_id: src.id,
          affected_source_name: src.name,
          previous_evidence: clm.supporting_quote,
          new_evidence: src.raw_content.slice(0, 260) + (src.raw_content.length > 260 ? '...' : ''),
          recommended_action: `Queue claim "${clm.id}" for mandatory re-verification against ${src.name} before handover publication.`,
          requires_reverification: true,
          status: 'OPEN',
          detected_at: nowIso
        });
      } else if (isModified && clm.reviewer_status === 'APPROVED' && src.updated_at! > (clm.reviewed_at || clm.created_at)) {
        alerts.push({
          id: `drf_stale_review_${clm.id}`,
          project_id: projectId,
          category: 'OUTDATED_CLAIM',
          severity: 'HIGH',
          title: `Source Updated After Approval: ${src.name}`,
          description: `Claim "${clm.statement.slice(0, 52)}..." was approved prior to the latest edit on ${src.name}. Confirm details remain accurate.`,
          affected_claim_ids: [clm.id],
          affected_source_id: src.id,
          affected_source_name: src.name,
          previous_evidence: clm.supporting_quote,
          new_evidence: `Updated source revision v${src.version || 2} at ${new Date(src.updated_at!).toLocaleString()}`,
          recommended_action: `Review diff on ${src.name} and re-confirm claim ${clm.id}.`,
          requires_reverification: true,
          status: 'OPEN',
          detected_at: nowIso
        });
      }
    }
  }

  // 2. Unresolved Conflicts across Sources
  const unresolvedConflicts = conflicts.filter(c => c.project_id === projectId && c.status === 'UNRESOLVED');
  for (const cnf of unresolvedConflicts) {
    const cA = accessibleClaims.find(c => c.id === cnf.claim_a_id);
    const cB = accessibleClaims.find(c => c.id === cnf.claim_b_id);
    if (cA && cB) {
      alerts.push({
        id: `drf_conflict_${cnf.id}`,
        project_id: projectId,
        category: 'CONFLICTING_UPDATE',
        severity: 'CRITICAL',
        title: `Conflicting Update: ${cnf.topic}`,
        description: cnf.explanation,
        affected_claim_ids: [cA.id, cB.id],
        affected_source_id: cB.source_id,
        affected_source_name: `${cA.source_name} vs ${cB.source_name}`,
        previous_evidence: cA.supporting_quote,
        new_evidence: cB.supporting_quote,
        recommended_action: 'Resolve contradiction in Review Desk and re-verify winning record before handover.',
        requires_reverification: true,
        status: 'OPEN',
        detected_at: nowIso
      });
    }
  }

  // 3. Unresolved Blockers
  const openBlockers = accessibleClaims.filter(
    c => c.type === 'BLOCKER' && c.reviewer_status !== 'REJECTED'
  );
  for (const blk of openBlockers) {
    alerts.push({
      id: `drf_blocker_${blk.id}`,
      project_id: projectId,
      category: 'UNRESOLVED_BLOCKER',
      severity: blk.reviewer_status === 'PENDING' ? 'CRITICAL' : 'HIGH',
      title: `Active Blocker: ${blk.statement.slice(0, 56)}${blk.statement.length > 56 ? '...' : ''}`,
      description: `Production/onboarding blocker logged in ${blk.source_location} requires explicit mitigation owner and handover check.`,
      affected_claim_ids: [blk.id],
      affected_source_id: blk.source_id,
      affected_source_name: blk.source_name,
      previous_evidence: blk.supporting_quote,
      new_evidence: `Status: ${blk.reviewer_status} · Owner: ${blk.owner || 'Unassigned'}`,
      recommended_action: blk.owner
        ? `Confirm mitigation plan with ${blk.owner} and verify blocker resolution status.`
        : 'Assign remediation owner and verify blocker status before handover.',
      requires_reverification: blk.reviewer_status !== 'APPROVED',
      status: 'OPEN',
      detected_at: nowIso
    });
  }

  // 4. Critical Gaps & Unassigned Responsibilities
  const projGaps = gaps.filter(g => g.project_id === projectId && g.severity === 'CRITICAL');
  for (const g of projGaps) {
    const matchingClaims = accessibleClaims
      .filter(c => c.source_location === g.source_reference || (g.category === 'UNASSIGNED_TASK' && !c.owner))
      .map(c => c.id)
      .slice(0, 3);

    alerts.push({
      id: `drf_gap_${g.id}`,
      project_id: projectId,
      category: g.category === 'UNASSIGNED_TASK' ? 'CHANGED_RESPONSIBILITY' : 'CRITICAL_GAP',
      severity: 'HIGH',
      title: g.title,
      description: g.description,
      affected_claim_ids: matchingClaims,
      affected_source_name: g.source_reference || 'Project Baseline',
      previous_evidence: g.description,
      new_evidence: g.suggested_action,
      recommended_action: g.suggested_action,
      requires_reverification: matchingClaims.length > 0,
      status: 'OPEN',
      detected_at: nowIso
    });
  }

  return alerts;
}

function buildDriftReport(
  projectId: string,
  modelLabel: string,
  alertsList: DriftAlert[],
  accessibleSources: Source[],
  accessibleClaims: Claim[]
): DriftAnalysisReport {
  const openAlerts = alertsList.filter(a => a.status === 'OPEN' || a.status === 'REVERIFICATION_QUEUED');
  const claimIdsNeedingReverify = Array.from(
    new Set(
      openAlerts
        .filter(a => a.requires_reverification)
        .flatMap(a => a.affected_claim_ids)
    )
  );
  const criticalBlockingDrift = alertsList.filter(
    a =>
      a.status === 'OPEN' &&
      a.severity === 'CRITICAL' &&
      (a.category === 'OUTDATED_CLAIM' || a.category === 'CONFLICTING_UPDATE')
  );

  return {
    project_id: projectId,
    analyzed_at: new Date().toISOString(),
    model: modelLabel,
    sources_compared: accessibleSources.length,
    modified_sources_count: accessibleSources.filter(s => Boolean(s.updated_at)).length,
    verified_claims_checked: accessibleClaims.filter(c => c.reviewer_status !== 'REJECTED').length,
    alerts: alertsList,
    summary: {
      total_alerts: alertsList.length,
      open_alerts: openAlerts.length,
      critical_count: openAlerts.filter(a => a.severity === 'CRITICAL').length,
      outdated_claims_count: openAlerts.filter(a => a.category === 'OUTDATED_CLAIM').length,
      changed_responsibilities_count: openAlerts.filter(a => a.category === 'CHANGED_RESPONSIBILITY').length,
      unresolved_blockers_count: openAlerts.filter(a => a.category === 'UNRESOLVED_BLOCKER').length,
      conflicting_updates_count: openAlerts.filter(a => a.category === 'CONFLICTING_UPDATE').length,
      critical_gaps_count: openAlerts.filter(a => a.category === 'CRITICAL_GAP').length,
      claims_needing_reverification: claimIdsNeedingReverify,
      handover_safe_to_publish: criticalBlockingDrift.length === 0
    }
  };
}

// Calculate Handover Readiness Score deterministically
function calculateReadinessScore(projectId: string): {
  score: number;
  totalClaims: number;
  verifiedClaims: number;
  approvedClaims: number;
  unresolvedConflicts: number;
  criticalGaps: number;
  coveragePercent: number;
  openDriftAlerts: number;
  criticalDriftAlerts: number;
  reverificationRecommendedCount: number;
} {
  const projectClaims = claims.filter(c => c.project_id === projectId);
  const totalClaims = projectClaims.length;
  const projDrift = driftAlerts.filter(d => d.project_id === projectId && (d.status === 'OPEN' || d.status === 'REVERIFICATION_QUEUED'));
  const critDrift = projDrift.filter(d => d.severity === 'CRITICAL' && (d.category === 'OUTDATED_CLAIM' || d.category === 'CONFLICTING_UPDATE')).length;
  const reverifClaims = new Set(projDrift.filter(d => d.requires_reverification).flatMap(d => d.affected_claim_ids));

  if (totalClaims === 0) {
    return {
      score: 0,
      totalClaims: 0,
      verifiedClaims: 0,
      approvedClaims: 0,
      unresolvedConflicts: 0,
      criticalGaps: 0,
      coveragePercent: 0,
      openDriftAlerts: projDrift.length,
      criticalDriftAlerts: critDrift,
      reverificationRecommendedCount: reverifClaims.size
    };
  }

  const verifiedClaims = projectClaims.filter(c => c.exact_quote_match && c.evidence_status === 'VERIFIED').length;
  const approvedClaims = projectClaims.filter(c => c.reviewer_status === 'APPROVED').length;
  const unresolvedConflicts = conflicts.filter(c => c.project_id === projectId && c.status === 'UNRESOLVED').length;
  const criticalGaps = gaps.filter(g => g.project_id === projectId && g.severity === 'CRITICAL').length;

  const coveragePercent = Math.round((verifiedClaims / totalClaims) * 100);
  const approvalPercent = Math.round((approvedClaims / totalClaims) * 100);

  let rawScore = coveragePercent * 0.45 + approvalPercent * 0.35;
  rawScore -= unresolvedConflicts * 15;
  rawScore -= criticalGaps * 10;
  rawScore -= critDrift * 8;

  const finalScore = Math.max(0, Math.min(100, Math.round(rawScore)));

  return {
    score: finalScore,
    totalClaims,
    verifiedClaims,
    approvedClaims,
    unresolvedConflicts,
    criticalGaps,
    coveragePercent,
    openDriftAlerts: projDrift.length,
    criticalDriftAlerts: critDrift,
    reverificationRecommendedCount: reverifClaims.size
  };
}

function ingestValidatedSource(params: {
  projectId: string;
  name: string;
  sourceType: SourceType;
  accessLevel: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL';
  rawText: string;
  uploadedBy: string;
  extraMetadata?: Record<string, any>;
}): { status: number; error?: string; source?: Source } {
  const { projectId, name, sourceType, accessLevel, rawText, uploadedBy, extraMetadata } = params;
  const trimmedName = name.trim();
  const normalizedText = rawText.replace(/\r\n/g, '\n');

  if (!trimmedName || !normalizedText.trim()) {
    return { status: 400, error: 'Source name and non-empty readable content are required.' };
  }

  if (Buffer.byteLength(normalizedText, 'utf8') > 2 * 1024 * 1024) {
    return { status: 400, error: 'Source text exceeds maximum allowed 2MB size.' };
  }

  if (!ALLOWED_SOURCE_TYPES.includes(sourceType)) {
    return {
      status: 400,
      error: `Unsupported source type "${sourceType}". Allowed: ${ALLOWED_SOURCE_TYPES.join(', ')}.`
    };
  }

  if (!ALLOWED_ACCESS_LEVELS.includes(accessLevel)) {
    return { status: 400, error: `Invalid access_level "${accessLevel}".` };
  }

  // Redact secrets BEFORE saving or hashing
  const { cleanText, redactedCount } = redactSensitiveData(normalizedText);
  const contentHash = crypto.createHash('sha256').update(cleanText).digest('hex');

  // Check duplicate by normalized name or identical content hash within same project
  const projSources = sources.filter(s => s.project_id === projectId);
  const duplicateName = projSources.find(s => s.name.trim().toLowerCase() === trimmedName.toLowerCase());
  if (duplicateName) {
    return {
      status: 409,
      error: `Duplicate source name: "${trimmedName}" already exists in this project.`
    };
  }

  const duplicateContent = projSources.find(
    s =>
      s.metadata?.content_hash === contentHash ||
      crypto.createHash('sha256').update(s.normalized_content).digest('hex') === contentHash
  );
  if (duplicateContent) {
    return {
      status: 409,
      error: `Duplicate content detected: matches existing source "${duplicateContent.name}".`
    };
  }

  const newSource: Source = {
    id: `src_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    project_id: projectId,
    name: trimmedName,
    source_type: sourceType,
    access_level: accessLevel,
    raw_content: cleanText,
    normalized_content: cleanText,
    uploaded_by: uploadedBy,
    created_at: new Date().toISOString(),
    processing_status: 'PROCESSED',
    metadata: {
      file_size_bytes: Buffer.byteLength(cleanText, 'utf8'),
      lines_count: cleanText.split('\n').length,
      content_hash: contentHash,
      redacted_secrets_count: redactedCount,
      ...(extraMetadata || {})
    }
  };

  sources.push(newSource);
  return { status: 201, source: newSource };
}

// ==========================================
// AUTHENTICATION ROUTES
// ==========================================
app.post('/api/auth/login', (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const account = DEMO_ACCOUNTS.find(
    acc => acc.email.toLowerCase() === email.trim().toLowerCase() && acc.password === password
  );

  if (!account) {
    return res.status(401).json({
      error: 'Invalid credentials',
      message: 'Incorrect email or password.'
    });
  }

  const token = `dnx_${crypto.randomBytes(24).toString('hex')}`;
  const user: AuthUser = {
    id: account.id,
    name: account.name,
    email: account.email,
    role: account.role,
    title: account.title
  };
  sessions.set(token, user);

  res.json({ token, user });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  const token = extractBearerToken(req);
  if (token) {
    sessions.delete(token);
  }
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  res.json({ user: req.user });
});

// ==========================================
// HEALTH & PROJECT ROUTES
// ==========================================
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    app: 'DNYANEX',
    geminiConfigured: !!geminiApiKey,
    sourcesCount: sources.length,
    claimsCount: claims.length
  });
});

app.get('/api/projects', optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  const enriched = projects.map(p => {
    const r = calculateReadinessScore(p.id);
    const { accessible: pSources } = getAccessibleSources(p.id, req.user);
    const accessibleIds = new Set(pSources.map(s => s.id));
    const pClaims = claims.filter(c => c.project_id === p.id && accessibleIds.has(c.source_id));
    return {
      ...p,
      sources_count: pSources.length,
      claims_count: pClaims.length,
      verified_count: pClaims.filter(c => c.evidence_status === 'VERIFIED').length,
      pending_count: pClaims.filter(c => c.reviewer_status === 'PENDING').length,
      conflicts_count: conflicts.filter(c => c.project_id === p.id && c.status === 'UNRESOLVED').length,
      readiness_score: r.score
    };
  });
  res.json(enriched);
});

app.post('/api/projects', requireAuth, requireRole('OWNER'), (req: AuthenticatedRequest, res: Response) => {
  const { name, description } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Project name is required' });
  }

  const newProj: Project = {
    id: `proj_${Date.now()}`,
    name: name.trim(),
    description: typeof description === 'string' ? description.trim() : '',
    created_at: new Date().toISOString(),
    members: [
      {
        id: req.user!.id,
        name: req.user!.name,
        email: req.user!.email,
        role: req.user!.role
      }
    ],
    sources_count: 0,
    claims_count: 0,
    verified_count: 0,
    pending_count: 0,
    conflicts_count: 0,
    readiness_score: 0
  };

  projects.unshift(newProj);
  res.status(201).json(newProj);
});

app.get('/api/projects/:id', optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  const proj = projects.find(p => p.id === req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const r = calculateReadinessScore(proj.id);
  const { accessible: pSources } = getAccessibleSources(proj.id, req.user);
  const accessibleIds = new Set(pSources.map(s => s.id));
  const pClaims = claims.filter(c => c.project_id === proj.id && accessibleIds.has(c.source_id));

  res.json({
    ...proj,
    sources_count: pSources.length,
    claims_count: pClaims.length,
    verified_count: pClaims.filter(c => c.evidence_status === 'VERIFIED').length,
    pending_count: pClaims.filter(c => c.reviewer_status === 'PENDING').length,
    conflicts_count: conflicts.filter(c => c.project_id === proj.id && c.status === 'UNRESOLVED').length,
    readiness_score: r.score,
    metrics: r
  });
});

// ==========================================
// SOURCE ROUTES (WITH RBAC, REDACTION, FILE PARSING & DUPLICATE CHECKS)
// ==========================================
app.get('/api/projects/:id/sources', optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  const { accessible } = getAccessibleSources(req.params.id, req.user);
  res.json(accessible);
});

app.post(
  '/api/projects/:id/sources',
  requireAuth,
  requireRole('OWNER', 'REVIEWER'),
  (req: AuthenticatedRequest, res: Response) => {
    const proj = projects.find(p => p.id === req.params.id);
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    const { name, source_type, raw_content, access_level, metadata } = req.body || {};
    if (!name || typeof name !== 'string' || !raw_content || typeof raw_content !== 'string') {
      return res.status(400).json({ error: 'Source name and non-empty content are required' });
    }

    const result = ingestValidatedSource({
      projectId: proj.id,
      name,
      sourceType: (source_type || 'MARKDOWN') as SourceType,
      accessLevel: (access_level || 'INTERNAL') as 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL',
      rawText: raw_content,
      uploadedBy: req.user!.name,
      extraMetadata: metadata
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    res.status(201).json(result.source);
  }
);

app.post(
  '/api/projects/:id/sources/upload',
  requireAuth,
  requireRole('OWNER', 'REVIEWER'),
  (req: AuthenticatedRequest, res: Response) => {
    upload.single('file')(req, res, (uploadErr: any) => {
      if (uploadErr) {
        return res.status(400).json({ error: uploadErr.message || 'File upload failed.' });
      }

      const proj = projects.find(p => p.id === req.params.id);
      if (!proj) return res.status(404).json({ error: 'Project not found' });

      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'No file attached in multipart request.' });
      }
      if (file.size === 0) {
        return res.status(400).json({ error: 'Uploaded file is empty.' });
      }

      const ext = path.extname(file.originalname).toLowerCase();
      let inferredType: SourceType;
      if (ext === '.pdf') inferredType = 'PDF';
      else if (ext === '.docx') inferredType = 'DOCX';
      else if (ext === '.md' || ext === '.markdown') inferredType = 'MARKDOWN';
      else if (ext === '.csv') inferredType = 'CSV';
      else if (ext === '.json') inferredType = 'JSON';
      else if (ext === '.txt') inferredType = 'TXT';
      else {
        return res.status(400).json({
          error: `Unsupported file format "${ext || 'unknown'}". Allowed: .pdf, .docx, .md, .txt, .csv, .json`
        });
      }

      let extractedText = '';
      try {
        if (inferredType === 'PDF') {
          extractedText = extractTextFromPdf(file.buffer);
        } else if (inferredType === 'DOCX') {
          extractedText = extractTextFromDocx(file.buffer);
        } else if (inferredType === 'JSON') {
          const raw = file.buffer.toString('utf8');
          JSON.parse(raw); // validate JSON syntax
          extractedText = raw;
        } else if (inferredType === 'CSV') {
          extractedText = file.buffer.toString('utf8');
          if (!extractedText.trim() || !extractedText.includes(',')) {
            return res.status(400).json({ error: 'Invalid or empty CSV file.' });
          }
        } else {
          extractedText = file.buffer.toString('utf8');
        }
      } catch (parseErr: any) {
        return res.status(400).json({
          error: parseErr.message || 'Failed to parse uploaded file content.'
        });
      }

      const accessLevel = ((req.body?.access_level as string) || 'INTERNAL') as
        | 'PUBLIC'
        | 'INTERNAL'
        | 'CONFIDENTIAL';
      const sourceName = (req.body?.name as string)?.trim() || file.originalname;

      const result = ingestValidatedSource({
        projectId: proj.id,
        name: sourceName,
        sourceType: inferredType,
        accessLevel,
        rawText: extractedText,
        uploadedBy: req.user!.name
      });

      if (result.error) {
        return res.status(result.status).json({ error: result.error });
      }

      return res.status(201).json(result.source);
    });
  }
);

app.put(
  '/api/projects/:id/sources/:sourceId',
  requireAuth,
  requireRole('OWNER', 'REVIEWER'),
  (req: AuthenticatedRequest, res: Response) => {
    const idx = sources.findIndex(s => s.project_id === req.params.id && s.id === req.params.sourceId);
    if (idx === -1) {
      return res.status(404).json({ error: 'Source not found' });
    }

    const existing = sources[idx];
    const { raw_content, access_level } = req.body || {};
    if (!raw_content || typeof raw_content !== 'string' || !raw_content.trim()) {
      return res.status(400).json({ error: 'Updated source content cannot be empty.' });
    }

    const nextAccess = (access_level || existing.access_level) as 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL';
    if (!ALLOWED_ACCESS_LEVELS.includes(nextAccess)) {
      return res.status(400).json({ error: `Invalid access_level "${nextAccess}".` });
    }

    const normalized = raw_content.replace(/\r\n/g, '\n');
    const { cleanText, redactedCount } = redactSensitiveData(normalized);
    const newHash = crypto.createHash('sha256').update(cleanText).digest('hex');

    const updatedSource: Source = {
      ...existing,
      access_level: nextAccess,
      previous_content: existing.raw_content,
      raw_content: cleanText,
      normalized_content: cleanText,
      updated_at: new Date().toISOString(),
      version: (existing.version || 1) + 1,
      metadata: {
        ...existing.metadata,
        previous_hash: existing.metadata?.content_hash,
        content_hash: newHash,
        file_size_bytes: Buffer.byteLength(cleanText, 'utf8'),
        lines_count: cleanText.split('\n').length,
        redacted_secrets_count: (existing.metadata?.redacted_secrets_count || 0) + redactedCount
      }
    };

    sources[idx] = updatedSource;

    // Detect any claims referencing this source whose supporting quote is now invalidated
    const invalidatedClaimIds: string[] = [];
    for (const c of claims) {
      if (c.project_id === req.params.id && c.source_id === existing.id && c.reviewer_status !== 'REJECTED') {
        const verification = verifySupportingQuote(cleanText, c.supporting_quote);
        if (!verification.isMatch) {
          invalidatedClaimIds.push(c.id);
          c.exact_quote_match = false;
          c.evidence_status = 'MISSING_EVIDENCE';
          c.audit_history.push({
            timestamp: new Date().toISOString(),
            action: 'SOURCE_DRIFT_QUOTE_INVALIDATED',
            actor: `${req.user!.name} (${req.user!.role})`,
            details: `Source "${existing.name}" updated to v${updatedSource.version}; original quote no longer matches verbatim.`
          });
        }
      }
    }

    // Refresh deterministic baseline drift alerts for this project while preserving resolved statuses
    const { accessible } = getAccessibleSources(req.params.id, req.user);
    const projClaims = claims.filter(c => c.project_id === req.params.id);
    const freshDet = runDeterministicDriftChecks(req.params.id, accessible, projClaims);
    const existingMap = new Map<string, DriftAlert>(driftAlerts.map(a => [a.id, a]));
    for (const a of freshDet) {
      const prev = existingMap.get(a.id);
      if (prev && prev.status === 'RESOLVED') {
        continue;
      }
      existingMap.set(a.id, a);
    }
    driftAlerts = Array.from(existingMap.values());

    res.json({
      source: updatedSource,
      invalidated_claim_ids: invalidatedClaimIds
    });
  }
);

app.delete(
  '/api/projects/:id/sources/:sourceId',
  requireAuth,
  requireRole('OWNER'),
  (req: AuthenticatedRequest, res: Response) => {
    const exists = sources.some(s => s.project_id === req.params.id && s.id === req.params.sourceId);
    if (!exists) {
      return res.status(404).json({ error: 'Source not found' });
    }
    sources = sources.filter(s => !(s.project_id === req.params.id && s.id === req.params.sourceId));
    res.json({ success: true });
  }
);

// ==========================================
// AI KNOWLEDGE RECONSTRUCTION PIPELINE
// ==========================================
app.post(
  '/api/projects/:id/reconstruct',
  requireAuth,
  requireRole('OWNER', 'REVIEWER'),
  async (req: AuthenticatedRequest, res: Response) => {
    const projectId = req.params.id;
    const projSources = sources.filter(s => s.project_id === projectId);

    if (projSources.length === 0) {
      return res
        .status(400)
        .json({ error: 'No sources connected to project. Upload documents or connect GitHub first.' });
    }

    if (!geminiApiKey) {
      return res.status(503).json({
        error: 'Gemini API key is not configured on the server.',
        message: 'Set GEMINI_API_KEY in server environment to run AI reconstruction.'
      });
    }

    const reconstructionLog: { step: string; message: string; timestamp: string }[] = [];
    const log = (step: string, message: string) => {
      reconstructionLog.push({ step, message, timestamp: new Date().toISOString() });
    };

    try {
      log('1. INGESTION', `Reading ${projSources.length} connected source documents.`);

      log('2. REDACTION', 'Scanning text streams for API tokens, secret credentials and private keys.');
      let totalRedacted = 0;
      const sanitizedSources = projSources.map(s => {
        const { cleanText, redactedCount } = redactSensitiveData(s.raw_content);
        totalRedacted += redactedCount;
        return {
          ...s,
          sanitized_content: cleanText
        };
      });
      log('2. REDACTION', `Protected ${totalRedacted} credential patterns before AI ingestion.`);

      log('3. CHUNKING', 'Assembling source chunks with verified coordinate anchors.');

      const combinedSourceText = sanitizedSources
        .map(
          s => `
=== SOURCE [ID: ${s.id}] [NAME: ${s.name}] [TYPE: ${s.source_type}] ===
${s.sanitized_content}
=== END SOURCE [ID: ${s.id}] ===
`
        )
        .join('\n\n');

      const extractionEngine = 'Gemini 4 Hydrogen (Server-Side @google/genai)';
      log('4. AI_EXTRACTION', 'Executing Gemini 4 Hydrogen structured knowledge extraction with schema.');

      const prompt = `You are DNYANEX Knowledge Extraction Engine.
Transform ONLY the provided project sources into atomic, evidence-backed claims for an incoming team member handover.

CRITICAL GROUNDING INSTRUCTIONS:
1. Every claim MUST include a direct 'supporting_quote' copied VERBATIM (exact characters) from the corresponding source text. NEVER fabricate, paraphrase, or invent project information!
2. Output claims only for facts explicitly present in the provided sources.
3. Types must strictly be one of: DECISION, TASK, OWNER, RISK, DEPENDENCY, BLOCKER, NEXT_ACTION, OPEN_QUESTION, RECURRING_PROBLEM, CONTACT_OR_RESOURCE.
4. If a task has no assigned owner in the source, set owner to null.
5. If an event has no date in the source, set event_date to null.
6. If the sources show contradictions (e.g. conflicting release dates or specs), output BOTH statements as separate claims.

SOURCES:
${combinedSourceText}
`;

      const { response, modelUsed } = await generateContentResilient(
        {
          contents: prompt,
          config: {
            systemInstruction:
              'You extract strictly factual, verifiable claims grounded verbatim in the provided engineering documentation. Never invent claims or quotes. Return structured JSON only.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  source_id: { type: Type.STRING },
                  type: {
                    type: Type.STRING,
                    enum: [
                      'DECISION',
                      'TASK',
                      'OWNER',
                      'RISK',
                      'DEPENDENCY',
                      'BLOCKER',
                      'NEXT_ACTION',
                      'OPEN_QUESTION',
                      'RECURRING_PROBLEM',
                      'CONTACT_OR_RESOURCE'
                    ]
                  },
                  statement: { type: Type.STRING },
                  supporting_quote: { type: Type.STRING },
                  source_location: { type: Type.STRING },
                  owner: { type: Type.STRING, nullable: true },
                  event_date: { type: Type.STRING, nullable: true },
                  confidence: { type: Type.STRING, enum: ['high', 'medium', 'low'] },
                  reasoning: { type: Type.STRING }
                },
                required: ['source_id', 'type', 'statement', 'supporting_quote', 'confidence', 'reasoning']
              }
            }
          }
        },
        45000
      );

      const jsonStr = (response.text ?? '[]').trim();
      const extractedItems: any[] = JSON.parse(jsonStr);

      if (!Array.isArray(extractedItems)) {
        throw new Error('Upstream Gemini model returned non-array structured payload.');
      }

      log('4. AI_EXTRACTION', `${modelUsed} extracted ${extractedItems.length} candidate claims.`);
      log('5. VERIFICATION', 'Running deterministic evidence verifier against exact raw source texts.');

      const newClaims: Claim[] = [];
      let verifiedQuotesCount = 0;
      let failedQuotesCount = 0;

      for (const item of extractedItems) {
        const matchedSource = projSources.find(s => s.id === item.source_id);
        const verificationSource = matchedSource || projSources[0];
        const { isMatch, startIdx, endIdx } = matchedSource
          ? verifySupportingQuote(matchedSource.raw_content, item.supporting_quote)
          : { isMatch: false, startIdx: -1, endIdx: -1 };

        if (isMatch) verifiedQuotesCount++;
        else failedQuotesCount++;

        const claimId = `clm_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const evidenceStatus = isMatch ? 'VERIFIED' : 'MISSING_EVIDENCE';

        newClaims.push({
          id: claimId,
          project_id: projectId,
          source_id: verificationSource.id,
          source_name: verificationSource.name,
          type: item.type || 'DECISION',
          statement: item.statement,
          supporting_quote: item.supporting_quote,
          source_location: item.source_location || verificationSource.name,
          confidence: isMatch ? item.confidence || 'high' : 'low',
          evidence_status: evidenceStatus,
          reviewer_status: 'PENDING',
          owner: item.owner || null,
          event_date: item.event_date || null,
          reasoning: item.reasoning || 'Extracted during AI reconstruction.',
          exact_quote_match: isMatch,
          match_start_idx: startIdx,
          match_end_idx: endIdx,
          created_at: new Date().toISOString(),
          audit_history: [
            {
              timestamp: new Date().toISOString(),
              action: 'RECONSTRUCTED',
              actor: extractionEngine
            },
            {
              timestamp: new Date().toISOString(),
              action: isMatch ? 'VERIFIED_EXACT_QUOTE' : 'FLAGGED_UNVERIFIED_QUOTE',
              actor: 'Deterministic Verification Engine',
              details: isMatch
                ? `Matched verbatim at offset ${startIdx}-${endIdx}`
                : 'Quote could not be verified verbatim in target source'
            }
          ]
        });
      }

      log(
        '5. VERIFICATION',
        `Verified ${verifiedQuotesCount} quotes verbatim. Flagged ${failedQuotesCount} unverified.`
      );

      log('6. CONFLICT_DETECTION', 'Analyzing cross-source statements for contradictory facts and dates.');
      const detectedConflicts = detectConflictsAcrossClaims(projectId, newClaims);
      log(
        '6. CONFLICT_DETECTION',
        `Identified ${detectedConflicts.length} contradictory claim pairs requiring reviewer resolution.`
      );

      log('7. GAP_DETECTION', 'Scanning for unassigned critical tasks and single-person bottlenecks.');
      const detectedGaps = detectGapsAcrossClaims(projectId, newClaims);
      log('7. GAP_DETECTION', `Identified ${detectedGaps.length} mission-critical operational gaps.`);

      claims = claims.filter(c => c.project_id !== projectId).concat(newClaims);
      conflicts = conflicts.filter(c => c.project_id !== projectId).concat(detectedConflicts);
      gaps = gaps.filter(g => g.project_id !== projectId).concat(detectedGaps);

      const readiness = calculateReadinessScore(projectId);
      log('8. COMPLETE', `Reconstruction finished. Handover Readiness calculated at ${readiness.score}%.`);

      res.json({
        success: true,
        engine: extractionEngine,
        claims_count: newClaims.length,
        verified_count: verifiedQuotesCount,
        conflicts_count: detectedConflicts.length,
        gaps_count: detectedGaps.length,
        readiness_score: readiness.score,
        logs: reconstructionLog
      });
    } catch (err: any) {
      console.error('Reconstruction error:', err);
      log('ERROR', err.message || 'Upstream Gemini extraction failed');
      res.status(502).json({
        error: 'AI reconstruction failed',
        message: err.message || 'Upstream Gemini extraction failed',
        logs: reconstructionLog
      });
    }
  }
);

// ==========================================
// EVIDENCE-GROUNDED AI PROJECT ASSISTANT
// ==========================================
app.post(
  '/api/projects/:id/assistant',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const projectId = req.params.id;
    const proj = projects.find(p => p.id === projectId);
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    const { question, history } = req.body || {};
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'A non-empty question is required.' });
    }

    if (!geminiApiKey) {
      return res.status(503).json({
        error: 'Gemini API key is not configured on the server.',
        message: 'Set GEMINI_API_KEY in server environment to use the AI Project Assistant.'
      });
    }

    const { accessible: accessibleSources, excludedCount } = getAccessibleSources(projectId, req.user);
    const accessibleIds = new Set(accessibleSources.map(s => s.id));

    if (accessibleSources.length === 0) {
      const emptyResp: AssistantResponse = {
        answer:
          'No accessible project sources are currently available for your permission level, so there is insufficient evidence to answer this question.',
        sufficient_evidence: false,
        missing_evidence_reason:
          excludedCount > 0
            ? 'All matching sources are marked CONFIDENTIAL and restricted from your current role.'
            : 'No sources are connected to this project yet.',
        confidence: 'low',
        citations: [],
        related_claim_ids: [],
        suggested_followups: [],
        accessible_sources_count: 0,
        restricted_sources_excluded: excludedCount,
        model: 'gemini-4-hydrogen'
      };
      return res.json(emptyResp);
    }

    const accessibleClaims = claims.filter(
      c => c.project_id === projectId && accessibleIds.has(c.source_id) && c.reviewer_status !== 'REJECTED'
    );
    const projectConflicts = conflicts.filter(c => c.project_id === projectId);
    const projectGaps = gaps.filter(g => g.project_id === projectId);

    const sourcesContext = accessibleSources
      .map(s => {
        const { cleanText } = redactSensitiveData(s.raw_content);
        return `=== SOURCE [ID: ${s.id}] [NAME: ${s.name}] [TYPE: ${s.source_type}] [ACCESS: ${s.access_level}] ===\n${cleanText}\n=== END SOURCE [${s.id}] ===`;
      })
      .join('\n\n');

    const claimsContext = accessibleClaims
      .map(
        c =>
          `- [${c.id}] (${c.type} | Evidence: ${c.evidence_status} | Review: ${c.reviewer_status} | Source: ${c.source_id} / ${c.source_name}): ${c.statement} | Owner: ${c.owner || 'Unassigned'} | Quote: "${c.supporting_quote}"`
      )
      .join('\n');

    const conflictsContext =
      projectConflicts.length > 0
        ? projectConflicts
          .map(cnf => `- [${cnf.id}] (${cnf.status}): ${cnf.topic} — ${cnf.explanation}`)
          .join('\n')
        : 'None';

    const gapsContext =
      projectGaps.length > 0
        ? projectGaps.map(g => `- [${g.id}] (${g.severity}): ${g.title} — ${g.description}`).join('\n')
        : 'None';

    const recentHistoryText = Array.isArray(history)
      ? history
        .slice(-6)
        .map((h: any) => `${h.role === 'user' ? 'USER' : 'ASSISTANT'}: ${String(h.content || '').slice(0, 500)}`)
        .join('\n')
      : '';

    const assistantPrompt = `Project: ${proj.name}
Description: ${proj.description}
Asking User Role: ${req.user!.role} (${req.user!.title})

CONNECTED ACCESSIBLE SOURCES:
${sourcesContext}

EXTRACTED CLAIMS LEDGER:
${claimsContext || 'No claims extracted yet.'}

CONFLICTS:
${conflictsContext}

OPERATIONAL GAPS:
${gapsContext}

${recentHistoryText ? `RECENT CONVERSATION:\n${recentHistoryText}\n` : ''}
USER QUESTION:
${question.trim()}
`;

    try {
      const { response, modelUsed } = await generateContentResilient(
        {
          contents: assistantPrompt,
          config: {
            systemInstruction: `You are DNYANEX's Evidence-Grounded AI Project Assistant helping team members understand project history, decisions, responsibilities, risks, and unresolved issues.

STRICT ANTI-HALLUCINATION RULES:
1. Answer ONLY using facts explicitly contained in CONNECTED ACCESSIBLE SOURCES, EXTRACTED CLAIMS LEDGER, CONFLICTS, and OPERATIONAL GAPS provided above.
2. NEVER invent, guess, or extrapolate external knowledge, dates, owners, or technical details not documented in the sources.
3. If the connected sources do NOT contain sufficient evidence to answer the question reliably, you MUST set "sufficient_evidence" to false, state clearly what information is missing in both "answer" and "missing_evidence_reason", set "confidence" to "low", and return an empty "citations" array.
4. When evidence IS present, set "sufficient_evidence" to true and provide 1-5 "citations". Each citation MUST include the exact "source_id" and a "supporting_quote" copied VERBATIM character-for-character from that source's text!
5. If sources contain unresolved contradictions (conflicts) relevant to the question, explain BOTH conflicting positions clearly and cite both sources.
6. If any matching claims from EXTRACTED CLAIMS LEDGER support your answer, list their IDs in "related_claim_ids".`,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                answer: { type: Type.STRING },
                sufficient_evidence: { type: Type.BOOLEAN },
                missing_evidence_reason: { type: Type.STRING, nullable: true },
                confidence: { type: Type.STRING, enum: ['high', 'medium', 'low'] },
                citations: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      source_id: { type: Type.STRING },
                      source_location: { type: Type.STRING },
                      supporting_quote: { type: Type.STRING },
                      claim_id: { type: Type.STRING, nullable: true }
                    },
                    required: ['source_id', 'supporting_quote']
                  }
                },
                related_claim_ids: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING }
                },
                suggested_followups: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING }
                }
              },
              required: ['answer', 'sufficient_evidence', 'confidence', 'citations', 'related_claim_ids']
            }
          }
        },
        30000
      );

      const parsed = JSON.parse((response.text ?? '{}').trim());

      // Deterministic server-side verification of every citation against accessible sources ONLY
      const verifiedCitations: AssistantCitation[] = [];
      for (const rawCit of Array.isArray(parsed.citations) ? parsed.citations : []) {
        const matchedSource = accessibleSources.find(
          s => s.id === rawCit.source_id || s.name === rawCit.source_id
        );
        if (!matchedSource) continue; // Ignore citations pointing to unknown or restricted sources

        const { isMatch, startIdx, endIdx } = verifySupportingQuote(
          matchedSource.raw_content,
          rawCit.supporting_quote || ''
        );

        verifiedCitations.push({
          source_id: matchedSource.id,
          source_name: matchedSource.name,
          source_location: rawCit.source_location || matchedSource.name,
          supporting_quote: rawCit.supporting_quote || '',
          claim_id: rawCit.claim_id || null,
          exact_verified: isMatch,
          match_start_idx: startIdx,
          match_end_idx: endIdx
        });
      }

      const validRelatedClaimIds = (Array.isArray(parsed.related_claim_ids) ? parsed.related_claim_ids : []).filter(
        (id: string) => accessibleClaims.some(c => c.id === id)
      );

      let sufficient = Boolean(parsed.sufficient_evidence);
      let confidence: 'high' | 'medium' | 'low' = parsed.confidence || 'medium';
      const hasAtLeastOneVerifiedQuote = verifiedCitations.some(c => c.exact_verified);

      // Guardrail: If AI claimed sufficient evidence but zero quotes verified against accessible sources
      if (sufficient && !hasAtLeastOneVerifiedQuote && validRelatedClaimIds.length === 0) {
        sufficient = false;
        confidence = 'low';
      }

      const assistantResponse: AssistantResponse = {
        answer:
          parsed.answer ||
          'Insufficient evidence in connected project sources to provide a verified answer.',
        sufficient_evidence: sufficient,
        missing_evidence_reason:
          parsed.missing_evidence_reason ||
          (!sufficient
            ? 'No verbatim supporting evidence found in connected accessible project sources.'
            : null),
        confidence,
        citations: verifiedCitations,
        related_claim_ids: validRelatedClaimIds,
        suggested_followups: Array.isArray(parsed.suggested_followups)
          ? parsed.suggested_followups.slice(0, 3)
          : [],
        accessible_sources_count: accessibleSources.length,
        restricted_sources_excluded: excludedCount,
        model: modelUsed
      };

      res.json(assistantResponse);
    } catch (err: any) {
      console.error('AI Project Assistant error:', err);
      res.status(502).json({
        error: 'Assistant request failed',
        message: err.message || 'Upstream Gemini model error while generating grounded answer.'
      });
    }
  }
);

// ==========================================
// CLAIMS, CONFLICTS, GAPS & READINESS
// ==========================================
app.get('/api/projects/:id/claims', optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  const { type, evidence_status, reviewer_status, search } = req.query;
  const { accessible } = getAccessibleSources(req.params.id, req.user);
  const accessibleSourceIds = new Set(accessible.map(s => s.id));

  let result = claims.filter(
    c => c.project_id === req.params.id && accessibleSourceIds.has(c.source_id)
  );

  if (type) result = result.filter(c => c.type === type);
  if (evidence_status) result = result.filter(c => c.evidence_status === evidence_status);
  if (reviewer_status) result = result.filter(c => c.reviewer_status === reviewer_status);
  if (search && typeof search === 'string') {
    const q = search.toLowerCase();
    result = result.filter(
      c =>
        c.statement.toLowerCase().includes(q) ||
        c.supporting_quote.toLowerCase().includes(q) ||
        c.source_location.toLowerCase().includes(q) ||
        (c.owner && c.owner.toLowerCase().includes(q))
    );
  }

  res.json(result);
});

app.patch(
  '/api/claims/:id',
  requireAuth,
  requireRole('OWNER', 'REVIEWER'),
  (req: AuthenticatedRequest, res: Response) => {
    const claimIdx = claims.findIndex(c => c.id === req.params.id);
    if (claimIdx === -1) return res.status(404).json({ error: 'Claim not found' });

    const claim = claims[claimIdx];
    const { statement, reviewer_status, reviewer_decision_notes, owner, type } = req.body || {};

    if (
      reviewer_status !== undefined &&
      !['PENDING', 'APPROVED', 'REJECTED', 'EDITED'].includes(reviewer_status)
    ) {
      return res.status(400).json({ error: 'Invalid reviewer_status value.' });
    }

    const previousStatus = claim.reviewer_status;

    if (statement !== undefined) claim.statement = statement;
    if (reviewer_status !== undefined) claim.reviewer_status = reviewer_status;
    if (reviewer_decision_notes !== undefined) claim.reviewer_decision_notes = reviewer_decision_notes;
    if (owner !== undefined) claim.owner = owner;
    if (type !== undefined) claim.type = type;

    claim.reviewed_by = `${req.user!.name} (${req.user!.role})`;
    claim.reviewed_at = new Date().toISOString();

    claim.audit_history.push({
      timestamp: new Date().toISOString(),
      action: `REVIEW_${reviewer_status || 'UPDATE'}`,
      actor: `${req.user!.name} (${req.user!.role})`,
      details:
        reviewer_decision_notes || `Status changed from ${previousStatus} to ${claim.reviewer_status}`
    });

    claims[claimIdx] = claim;
    res.json(claim);
  }
);

app.get('/api/projects/:id/conflicts', (_req: Request, res: Response) => {
  const projConflicts = conflicts.filter(c => c.project_id === _req.params.id);
  const enriched = projConflicts.map(c => ({
    ...c,
    claim_a: claims.find(clm => clm.id === c.claim_a_id),
    claim_b: claims.find(clm => clm.id === c.claim_b_id)
  }));
  res.json(enriched);
});

app.patch(
  '/api/conflicts/:id/resolve',
  requireAuth,
  requireRole('OWNER', 'REVIEWER'),
  (req: AuthenticatedRequest, res: Response) => {
    const confIdx = conflicts.findIndex(c => c.id === req.params.id);
    if (confIdx === -1) return res.status(404).json({ error: 'Conflict not found' });

    const { resolved_claim_id, resolution_notes } = req.body || {};
    const conf = conflicts[confIdx];
    const resolvedAt = new Date().toISOString();
    const actorLabel = `${req.user!.name} (${req.user!.role})`;

    conf.status = 'RESOLVED';
    conf.resolved_claim_id = resolved_claim_id;
    conf.resolution_notes = resolution_notes || 'Resolved by lead reviewer';
    conf.resolved_by = actorLabel;
    conf.resolved_at = resolvedAt;

    const claimA = claims.find(c => c.id === conf.claim_a_id);
    const claimB = claims.find(c => c.id === conf.claim_b_id);

    for (const c of [claimA, claimB]) {
      if (!c) continue;
      if (resolved_claim_id && c.id === resolved_claim_id) {
        c.evidence_status = c.exact_quote_match ? 'VERIFIED' : 'INFERRED';
        c.reviewer_status = 'APPROVED';
        c.reviewed_by = actorLabel;
        c.reviewed_at = resolvedAt;
        c.reviewer_decision_notes = `Conflict resolved (Selected): ${conf.resolution_notes}`;
        c.audit_history.push({
          timestamp: resolvedAt,
          action: 'CONFLICT_RESOLVED_APPROVED',
          actor: actorLabel,
          details: conf.resolution_notes
        });
      } else {
        c.evidence_status = c.exact_quote_match ? 'VERIFIED' : 'INFERRED';
        c.reviewer_status = 'REJECTED';
        c.reviewed_by = actorLabel;
        c.reviewed_at = resolvedAt;
        c.reviewer_decision_notes = `Superseded during conflict resolution: ${conf.resolution_notes}`;
        c.audit_history.push({
          timestamp: resolvedAt,
          action: 'CONFLICT_SUPERSEDED_REJECTED',
          actor: actorLabel,
          details: conf.resolution_notes
        });
      }
    }

    conflicts[confIdx] = conf;
    res.json(conf);
  }
);

app.get('/api/projects/:id/gaps', (req: Request, res: Response) => {
  const projGaps = gaps.filter(g => g.project_id === req.params.id);
  res.json(projGaps);
});

app.get('/api/projects/:id/readiness', (req: Request, res: Response) => {
  const metrics = calculateReadinessScore(req.params.id);
  res.json(metrics);
});

// ==========================================
// INTERACTIVE KNOWLEDGE DEPENDENCY GRAPH
// ==========================================
app.get('/api/projects/:id/dependency-graph', optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  const proj = projects.find(p => p.id === req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const graph = buildDependencyGraph(req.params.id, req.user);
  res.json(graph);
});

// ==========================================
// KNOWLEDGE DRIFT & RISK INTELLIGENCE ENGINE
// ==========================================
app.get('/api/projects/:id/drift-analysis', optionalAuth, (req: AuthenticatedRequest, res: Response) => {
  const projectId = req.params.id;
  const proj = projects.find(p => p.id === projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const { accessible: accessibleSources } = getAccessibleSources(projectId, req.user);
  const accessibleIds = new Set(accessibleSources.map(s => s.id));
  const accessibleClaims = claims.filter(
    c => c.project_id === projectId && accessibleIds.has(c.source_id)
  );

  let projAlerts = driftAlerts.filter(a => a.project_id === projectId);
  if (projAlerts.length === 0) {
    const deterministicBaseline = runDeterministicDriftChecks(projectId, accessibleSources, accessibleClaims);
    driftAlerts = driftAlerts.concat(deterministicBaseline);
    projAlerts = deterministicBaseline;
  }

  // RBAC: Filter out alerts referencing restricted CONFIDENTIAL sources for non-privileged roles
  const visibleAlerts = projAlerts.filter(
    a => !a.affected_source_id || accessibleIds.has(a.affected_source_id)
  );

  res.json(
    buildDriftReport(
      projectId,
      'Deterministic Baseline + Structural Drift Engine',
      visibleAlerts,
      accessibleSources,
      accessibleClaims
    )
  );
});

app.post(
  '/api/projects/:id/drift-analysis',
  requireAuth,
  requireRole('OWNER', 'REVIEWER'),
  async (req: AuthenticatedRequest, res: Response) => {
    const projectId = req.params.id;
    const proj = projects.find(p => p.id === projectId);
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    if (!geminiApiKey) {
      return res.status(503).json({
        error: 'Gemini API key is not configured on the server.',
        message: 'Set GEMINI_API_KEY in server environment to run AI drift intelligence.'
      });
    }

    const { accessible: accessibleSources } = getAccessibleSources(projectId, req.user);
    const accessibleIds = new Set(accessibleSources.map(s => s.id));
    const accessibleClaims = claims.filter(
      c => c.project_id === projectId && accessibleIds.has(c.source_id) && c.reviewer_status !== 'REJECTED'
    );

    if (accessibleSources.length === 0) {
      return res.status(400).json({ error: 'No project sources available for drift comparison.' });
    }

    // 1. Deterministic structural & quote-invalidation drift checks
    const deterministicAlerts = runDeterministicDriftChecks(projectId, accessibleSources, accessibleClaims);

    // 2. Semantic Drift Comparison via Gemini against updated/newly added sources & previously verified claims
    const sourcesSummary = accessibleSources
      .map(s => {
        const { cleanText } = redactSensitiveData(s.raw_content);
        const prevExcerpt = s.previous_content
          ? `\n--- PREVIOUS VERSION (v${(s.version || 2) - 1}) ---\n${redactSensitiveData(s.previous_content).cleanText}\n--- END PREVIOUS VERSION ---`
          : '';
        return `=== SOURCE [ID: ${s.id}] [NAME: ${s.name}] [VER: v${s.version || 1}] [UPDATED: ${s.updated_at || s.created_at}] ===${prevExcerpt}\n--- CURRENT VERSION ---\n${cleanText}\n=== END SOURCE [${s.id}] ===`;
      })
      .join('\n\n');

    const verifiedBaselineSummary = accessibleClaims
      .map(
        c =>
          `- [${c.id}] (${c.type} | Status: ${c.reviewer_status} | Evidence: ${c.evidence_status} | Owner: ${c.owner || 'Unassigned'} | Source: ${c.source_id}): ${c.statement} | Verbatim Quote: "${c.supporting_quote}"`
      )
      .join('\n');

    const driftPrompt = `Project: ${proj.name}
Analyze the current and updated project sources against the previously extracted/verified claims ledger to detect knowledge drift and handover risks.

VERIFIED / EXISTING CLAIMS LEDGER:
${verifiedBaselineSummary || 'No claims extracted yet.'}

CURRENT & UPDATED SOURCES:
${sourcesSummary}

Identify ONLY real discrepancies supported by the text:
1. OUTDATED_CLAIM: Previously verified claims whose specs, dates, architecture choices, or metrics changed in updated or newer sources.
2. CHANGED_RESPONSIBILITY: Ownership shifts, departed engineers still assigned, or newly assigned engineers replacing prior owners.
3. UNRESOLVED_BLOCKER: Open technical/operational blockers impacting handover readiness.
4. CONFLICTING_UPDATE: Direct contradictions between newly updated/added sources and previously verified claims.
5. CRITICAL_GAP: Missing rollback specs, unassigned tasks, or undocumented single-person dependencies.

Return only grounded items using exact claim IDs (clm_*) and source IDs (src_*) from above.`;

    try {
      const { response, modelUsed } = await generateContentResilient(
        {
          contents: driftPrompt,
          config: {
            systemInstruction:
              'You are DNYANEX Knowledge Drift & Risk Intelligence Engine. Compare newly updated project sources against previously verified claims and identify real outdated claims, changed responsibilities, unresolved blockers, conflicting updates, and critical knowledge gaps. Never invent IDs or facts.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  category: {
                    type: Type.STRING,
                    enum: [
                      'OUTDATED_CLAIM',
                      'CHANGED_RESPONSIBILITY',
                      'UNRESOLVED_BLOCKER',
                      'CONFLICTING_UPDATE',
                      'CRITICAL_GAP'
                    ]
                  },
                  severity: { type: Type.STRING, enum: ['CRITICAL', 'HIGH', 'MEDIUM'] },
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  affected_claim_ids: { type: Type.ARRAY, items: { type: Type.STRING } },
                  affected_source_id: { type: Type.STRING, nullable: true },
                  previous_evidence: { type: Type.STRING },
                  new_evidence: { type: Type.STRING },
                  recommended_action: { type: Type.STRING },
                  requires_reverification: { type: Type.BOOLEAN }
                },
                required: [
                  'category',
                  'severity',
                  'title',
                  'description',
                  'affected_claim_ids',
                  'previous_evidence',
                  'new_evidence',
                  'recommended_action',
                  'requires_reverification'
                ]
              }
            }
          }
        },
        35000
      );

      const aiItems: any[] = JSON.parse((response.text ?? '[]').trim());
      const nowIso = new Date().toISOString();
      const validClaimIdsSet = new Set(accessibleClaims.map(c => c.id));
      const aiAlerts: DriftAlert[] = [];

      if (Array.isArray(aiItems)) {
        aiItems.forEach((item, idx) => {
          const validAffected = (Array.isArray(item.affected_claim_ids) ? item.affected_claim_ids : []).filter(
            (cid: string) => validClaimIdsSet.has(cid)
          );
          const matchedSrc = accessibleSources.find(s => s.id === item.affected_source_id);

          // Skip duplicate if deterministic alert already covers same category & overlapping claim
          const overlapsDet = deterministicAlerts.some(
            d =>
              d.category === item.category &&
              (validAffected.length > 0
                ? d.affected_claim_ids.some(cid => validAffected.includes(cid))
                : d.affected_source_id === matchedSrc?.id)
          );
          if (overlapsDet) return;

          aiAlerts.push({
            id: `drf_ai_${Date.now()}_${idx}`,
            project_id: projectId,
            category: item.category as DriftCategory,
            severity: (item.severity || 'HIGH') as DriftSeverity,
            title: String(item.title || 'Semantic Drift Detected'),
            description: String(item.description || ''),
            affected_claim_ids: validAffected,
            affected_source_id: matchedSrc?.id,
            affected_source_name: matchedSrc?.name || 'Cross-Source Analysis',
            previous_evidence: String(item.previous_evidence || ''),
            new_evidence: String(item.new_evidence || ''),
            recommended_action: String(item.recommended_action || 'Re-verify impacted record in Review Desk.'),
            requires_reverification: Boolean(item.requires_reverification) && validAffected.length > 0,
            status: 'OPEN',
            detected_at: nowIso
          });
        });
      }

      // Preserve prior resolved/queued statuses for unchanged deterministic alert IDs
      const prevStatusById = new Map(
        driftAlerts.filter(a => a.project_id === projectId).map(a => [a.id, a])
      );
      const merged = [...deterministicAlerts, ...aiAlerts].map(alert => {
        const prev = prevStatusById.get(alert.id);
        if (prev && prev.status !== 'OPEN') {
          return {
            ...alert,
            status: prev.status,
            resolved_by: prev.resolved_by,
            resolved_at: prev.resolved_at,
            resolution_note: prev.resolution_note
          };
        }
        return alert;
      });

      driftAlerts = driftAlerts.filter(a => a.project_id !== projectId).concat(merged);

      res.json(
        buildDriftReport(
          projectId,
          `${modelUsed} + Deterministic Drift Engine`,
          merged,
          accessibleSources,
          accessibleClaims
        )
      );
    } catch (err: any) {
      console.error('Drift analysis error:', err);
      res.status(502).json({
        error: 'Drift intelligence scan failed',
        message: err.message || 'Upstream Gemini model failed during drift comparison.'
      });
    }
  }
);

app.post(
  '/api/projects/:id/drift-alerts/:alertId/queue-reverification',
  requireAuth,
  requireRole('OWNER', 'REVIEWER'),
  (req: AuthenticatedRequest, res: Response) => {
    const { id: projectId, alertId } = req.params;
    const alertIdx = driftAlerts.findIndex(a => a.project_id === projectId && a.id === alertId);
    if (alertIdx === -1) return res.status(404).json({ error: 'Drift alert not found' });

    const alert = driftAlerts[alertIdx];
    const nowIso = new Date().toISOString();
    const actor = `${req.user!.name} (${req.user!.role})`;
    const updatedClaims: Claim[] = [];

    for (const cid of alert.affected_claim_ids) {
      const claim = claims.find(c => c.id === cid && c.project_id === projectId);
      if (claim) {
        claim.reviewer_status = 'PENDING';
        claim.reviewer_decision_notes = `Flagged for re-verification (${alert.category}): ${alert.recommended_action}`;
        claim.audit_history.push({
          timestamp: nowIso,
          action: 'QUEUED_FOR_REVERIFICATION_BY_DRIFT',
          actor,
          details: alert.title
        });
        updatedClaims.push(claim);
      }
    }

    alert.status = 'REVERIFICATION_QUEUED';
    alert.resolved_by = actor;
    alert.resolved_at = nowIso;
    alert.resolution_note = `Queued ${updatedClaims.length} claim(s) for re-verification in Review Desk.`;
    driftAlerts[alertIdx] = alert;

    res.json({ alert, updated_claims: updatedClaims });
  }
);

app.patch(
  '/api/projects/:id/drift-alerts/:alertId',
  requireAuth,
  requireRole('OWNER', 'REVIEWER'),
  (req: AuthenticatedRequest, res: Response) => {
    const { id: projectId, alertId } = req.params;
    const alertIdx = driftAlerts.findIndex(a => a.project_id === projectId && a.id === alertId);
    if (alertIdx === -1) return res.status(404).json({ error: 'Drift alert not found' });

    const { status, resolution_note } = req.body || {};
    if (!['RESOLVED', 'DISMISSED'].includes(status)) {
      return res.status(400).json({ error: 'Status must be RESOLVED or DISMISSED.' });
    }

    const alert = driftAlerts[alertIdx];
    alert.status = status;
    alert.resolved_by = `${req.user!.name} (${req.user!.role})`;
    alert.resolved_at = new Date().toISOString();
    alert.resolution_note = resolution_note || `Marked ${status} by reviewer.`;
    driftAlerts[alertIdx] = alert;

    res.json(alert);
  }
);

// ==========================================
// HANDOVER COMPILATION & ACKNOWLEDGEMENT
// ==========================================
app.get('/api/projects/:id/handovers', (req: Request, res: Response) => {
  const projHandovers = handovers.filter(h => h.project_id === req.params.id);
  res.json(projHandovers);
});

app.post(
  '/api/projects/:id/handovers',
  requireAuth,
  requireRole('OWNER', 'REVIEWER'),
  (req: AuthenticatedRequest, res: Response) => {
    const { target_role, title, summary } = req.body || {};
    const projectId = req.params.id;
    const proj = projects.find(p => p.id === projectId);
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    const readiness = calculateReadinessScore(projectId);

    // Server-side Gate 1: Unresolved Conflicts block handover publication
    if (readiness.unresolvedConflicts > 0) {
      return res.status(409).json({
        error: 'Publication blocked: unresolved contradictions exist',
        message: `Resolve all ${readiness.unresolvedConflicts} unresolved conflict(s) at the Review Desk before publishing a handover.`,
        unresolvedConflicts: readiness.unresolvedConflicts
      });
    }

    // Server-side Gate 2: Open CRITICAL Outdated-Claim or Conflicting-Update Drift blocks stale handover publication
    const blockingDrift = driftAlerts.filter(
      a =>
        a.project_id === projectId &&
        a.status === 'OPEN' &&
        a.severity === 'CRITICAL' &&
        a.category === 'OUTDATED_CLAIM'
    );
    if (blockingDrift.length > 0) {
      return res.status(409).json({
        error: 'Publication blocked: outdated knowledge drift detected',
        message: `${blockingDrift.length} critical outdated claim alert(s) require re-verification in Drift Intelligence before publishing.`,
        blockingDriftAlerts: blockingDrift.map(d => d.id)
      });
    }

    // Only approved and non-conflicting claims enter a handover packet
    const approvedClaims = claims.filter(
      c =>
        c.project_id === projectId &&
        c.reviewer_status === 'APPROVED' &&
        c.evidence_status !== 'CONFLICTING'
    );

    const roleTarget = target_role || 'DEVELOPER';
    let filteredClaims = approvedClaims;
    if (roleTarget === 'DEVELOPER') {
      filteredClaims = approvedClaims.filter(c =>
        ['DECISION', 'TASK', 'BLOCKER', 'DEPENDENCY', 'NEXT_ACTION', 'RECURRING_PROBLEM'].includes(c.type)
      );
    } else if (roleTarget === 'PROJECT_MANAGER') {
      filteredClaims = approvedClaims.filter(c =>
        ['DECISION', 'TASK', 'RISK', 'DEPENDENCY', 'OWNER', 'OPEN_QUESTION'].includes(c.type)
      );
    } else if (roleTarget === 'STUDENT_INTERN') {
      filteredClaims = approvedClaims.filter(c =>
        ['DECISION', 'TASK', 'NEXT_ACTION', 'CONTACT_OR_RESOURCE'].includes(c.type)
      );
    }

    // Server-side Gate 2: Cannot publish empty/unapproved packet
    if (filteredClaims.length === 0) {
      return res.status(400).json({
        error: 'No approved claims match this handover role',
        message: 'Approve at least one matching claim in the Review Desk before publishing.'
      });
    }

    const snapshotClaims: Claim[] = JSON.parse(JSON.stringify(filteredClaims));

    const newHandover: Handover = {
      id: `hnd_${Date.now()}`,
      project_id: projectId,
      version: `v${handovers.filter(h => h.project_id === projectId).length + 1}.0`,
      target_role: roleTarget,
      title: title || `${roleTarget} Knowledge Handover`,
      summary: summary || 'Curated, evidence-verified knowledge packet for onboarding successor.',
      approved_claims_count: snapshotClaims.length,
      readiness_score: readiness.score,
      created_by: `${req.user!.name} (${req.user!.role})`,
      created_at: new Date().toISOString(),
      published_at: new Date().toISOString(),
      is_published: true,
      claims: snapshotClaims,
      acknowledgements: []
    };

    handovers.unshift(newHandover);
    res.status(201).json(newHandover);
  }
);

app.get('/api/handovers/:id', (req: Request, res: Response) => {
  const handover = handovers.find(h => h.id === req.params.id);
  if (!handover) return res.status(404).json({ error: 'Handover packet not found' });
  res.json(handover);
});

app.post(
  '/api/handovers/:id/acknowledge',
  requireAuth,
  requireRole('INCOMING_MEMBER', 'REVIEWER', 'OWNER'),
  (req: AuthenticatedRequest, res: Response) => {
    const handover = handovers.find(h => h.id === req.params.id);
    if (!handover) return res.status(404).json({ error: 'Handover not found' });

    const { name, role } = req.body || {};
    const signerName = (typeof name === 'string' && name.trim()) || req.user!.name;
    const signatureHash = `sig_${crypto.randomBytes(6).toString('hex')}_${Date.now().toString(16)}`;

    const ack = {
      acknowledged_by: signerName,
      role: (typeof role === 'string' && role.trim()) || handover.target_role,
      timestamp: new Date().toISOString(),
      signature_hash: signatureHash
    };

    handover.acknowledgements.push(ack);
    res.json({ success: true, acknowledgement: ack, handover });
  }
);

app.post(
  '/api/demo/reset',
  requireAuth,
  requireRole('OWNER', 'REVIEWER'),
  (_req: AuthenticatedRequest, res: Response) => {
    projects = [JSON.parse(JSON.stringify(INITIAL_PROJECT))];
    sources = JSON.parse(JSON.stringify(INITIAL_SOURCES));
    claims = JSON.parse(JSON.stringify(INITIAL_CLAIMS));
    conflicts = JSON.parse(JSON.stringify(INITIAL_CONFLICTS));
    gaps = JSON.parse(JSON.stringify(INITIAL_GAPS));
    handovers = JSON.parse(JSON.stringify(INITIAL_HANDOVERS));
    driftAlerts = [];

    res.json({
      success: true,
      message: 'Reset demo environment to CampusConnect Departure scenario successfully.'
    });
  }
);

// ==========================================
// VITE OR STATIC CLIENT SERVING
// ==========================================
async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DNYANEX Platform running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
