import {
  Project,
  Source,
  Claim,
  Conflict,
  GapOrMissingEvidence,
  Handover,
  AuthSession,
  AuthUser,
  AssistantResponse,
  DependencyGraphResponse,
  DriftAnalysisReport,
  DriftAlert
} from '../types';

const AUTH_TOKEN_KEY = 'dnyanex_auth_token';

export function getStoredAuthToken(): string | null {
  try {
    return window.localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredAuthToken(token: string | null): void {
  try {
    if (token) {
      window.localStorage.setItem(AUTH_TOKEN_KEY, token);
    } else {
      window.localStorage.removeItem(AUTH_TOKEN_KEY);
    }
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = getStoredAuthToken();
  const headers = new Headers(init.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}

async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    return data.message || data.error || fallback;
  } catch {
    return fallback;
  }
}

export const api = {
  // Authentication
  async login(email: string, password: string): Promise<AuthSession> {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) {
      throw new Error(await parseErrorMessage(res, 'Invalid email or password'));
    }
    const session: AuthSession = await res.json();
    setStoredAuthToken(session.token);
    return session;
  },

  async logout(): Promise<void> {
    const token = getStoredAuthToken();
    try {
      if (token) {
        await apiFetch('/api/auth/logout', { method: 'POST' });
      }
    } finally {
      setStoredAuthToken(null);
    }
  },

  async getMe(): Promise<{ user: AuthUser }> {
    const res = await apiFetch('/api/auth/me');
    if (!res.ok) {
      throw new Error(await parseErrorMessage(res, 'Session expired'));
    }
    return res.json();
  },

  // Projects
  async getProjects(): Promise<Project[]> {
    const res = await apiFetch('/api/projects');
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to fetch projects'));
    return res.json();
  },

  async getProject(id: string): Promise<Project & { metrics: any }> {
    const res = await apiFetch(`/api/projects/${id}`);
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to fetch project details'));
    return res.json();
  },

  async createProject(name: string, description: string): Promise<Project> {
    const res = await apiFetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description })
    });
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to create project'));
    return res.json();
  },

  // Sources
  async getSources(projectId: string): Promise<Source[]> {
    const res = await apiFetch(`/api/projects/${projectId}/sources`);
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to fetch sources'));
    return res.json();
  },

  async addSource(
    projectId: string,
    payload: {
      name: string;
      source_type: string;
      raw_content: string;
      access_level?: string;
      metadata?: any;
    }
  ): Promise<Source> {
    const res = await apiFetch(`/api/projects/${projectId}/sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to add source'));
    return res.json();
  },

  async uploadSourceFile(
    projectId: string,
    file: File,
    accessLevel: string = 'INTERNAL',
    customName?: string
  ): Promise<Source> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('access_level', accessLevel);
    if (customName) formData.append('name', customName);

    const res = await apiFetch(`/api/projects/${projectId}/sources/upload`, {
      method: 'POST',
      body: formData
    });
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to upload source file'));
    return res.json();
  },

  async deleteSource(projectId: string, sourceId: string): Promise<{ success: boolean }> {
    const res = await apiFetch(`/api/projects/${projectId}/sources/${sourceId}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to delete source'));
    return res.json();
  },

  async updateSource(
    projectId: string,
    sourceId: string,
    payload: { raw_content: string; access_level?: string; change_summary?: string }
  ): Promise<{ source: Source; invalidated_claim_ids: string[] }> {
    const res = await apiFetch(`/api/projects/${projectId}/sources/${sourceId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to update source revision'));
    return res.json();
  },

  // Reconstruction
  async runReconstruction(projectId: string): Promise<{
    success: boolean;
    engine: string;
    claims_count: number;
    verified_count: number;
    conflicts_count: number;
    gaps_count: number;
    readiness_score: number;
    logs: { step: string; message: string; timestamp: string }[];
  }> {
    const res = await apiFetch(`/api/projects/${projectId}/reconstruct`, {
      method: 'POST'
    });
    if (!res.ok) {
      throw new Error(await parseErrorMessage(res, 'Reconstruction pipeline execution failed'));
    }
    return res.json();
  },

  // AI Project Assistant
  async askAssistant(
    projectId: string,
    question: string,
    history: { role: 'user' | 'assistant'; content: string }[] = []
  ): Promise<AssistantResponse> {
    const res = await apiFetch(`/api/projects/${projectId}/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history })
    });
    if (!res.ok) {
      throw new Error(await parseErrorMessage(res, 'Assistant request failed'));
    }
    return res.json();
  },

  // Claims
  async getClaims(
    projectId: string,
    filters?: {
      type?: string;
      evidence_status?: string;
      reviewer_status?: string;
      search?: string;
    }
  ): Promise<Claim[]> {
    const params = new URLSearchParams();
    if (filters?.type) params.set('type', filters.type);
    if (filters?.evidence_status) params.set('evidence_status', filters.evidence_status);
    if (filters?.reviewer_status) params.set('reviewer_status', filters.reviewer_status);
    if (filters?.search) params.set('search', filters.search);

    const res = await apiFetch(`/api/projects/${projectId}/claims?${params.toString()}`);
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to fetch claims'));
    return res.json();
  },

  async updateClaim(claimId: string, payload: Partial<Claim>): Promise<Claim> {
    const res = await apiFetch(`/api/claims/${claimId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to update claim'));
    return res.json();
  },

  // Conflicts
  async getConflicts(projectId: string): Promise<Conflict[]> {
    const res = await apiFetch(`/api/projects/${projectId}/conflicts`);
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to fetch conflicts'));
    return res.json();
  },

  async resolveConflict(
    conflictId: string,
    resolved_claim_id?: string,
    resolution_notes?: string
  ): Promise<Conflict> {
    const res = await apiFetch(`/api/conflicts/${conflictId}/resolve`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved_claim_id, resolution_notes })
    });
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to resolve conflict'));
    return res.json();
  },

  // Gaps
  async getGaps(projectId: string): Promise<GapOrMissingEvidence[]> {
    const res = await apiFetch(`/api/projects/${projectId}/gaps`);
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to fetch gaps'));
    return res.json();
  },

  // Readiness & Knowledge Dependency Graph
  async getReadiness(projectId: string): Promise<{
    score: number;
    totalClaims: number;
    verifiedClaims: number;
    approvedClaims: number;
    unresolvedConflicts: number;
    criticalGaps: number;
    coveragePercent: number;
    openDriftAlerts?: number;
    criticalDriftAlerts?: number;
    reverificationRecommendedCount?: number;
  }> {
    const res = await apiFetch(`/api/projects/${projectId}/readiness`);
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to fetch readiness'));
    return res.json();
  },

  async getDependencyGraph(projectId: string): Promise<DependencyGraphResponse> {
    const res = await apiFetch(`/api/projects/${projectId}/dependency-graph`);
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to build knowledge dependency graph'));
    return res.json();
  },

  // Knowledge Drift & Risk Intelligence Engine
  async getDriftAnalysis(projectId: string): Promise<DriftAnalysisReport> {
    const res = await apiFetch(`/api/projects/${projectId}/drift-analysis`);
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to load drift intelligence report'));
    return res.json();
  },

  async runDriftAnalysis(projectId: string): Promise<DriftAnalysisReport> {
    const res = await apiFetch(`/api/projects/${projectId}/drift-analysis`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Drift analysis scan failed'));
    return res.json();
  },

  async queueDriftReverification(
    projectId: string,
    alertId: string
  ): Promise<{ alert: DriftAlert; updated_claims: Claim[] }> {
    const res = await apiFetch(`/api/projects/${projectId}/drift-alerts/${alertId}/queue-reverification`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to queue claims for re-verification'));
    return res.json();
  },

  async updateDriftAlertStatus(
    projectId: string,
    alertId: string,
    status: 'RESOLVED' | 'DISMISSED',
    resolution_note?: string
  ): Promise<DriftAlert> {
    const res = await apiFetch(`/api/projects/${projectId}/drift-alerts/${alertId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, resolution_note })
    });
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to update drift alert'));
    return res.json();
  },

  // Handovers
  async getHandovers(projectId: string): Promise<Handover[]> {
    const res = await apiFetch(`/api/projects/${projectId}/handovers`);
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to fetch handovers'));
    return res.json();
  },

  async createHandover(
    projectId: string,
    payload: {
      target_role: string;
      title: string;
      summary: string;
    }
  ): Promise<Handover> {
    const res = await apiFetch(`/api/projects/${projectId}/handovers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to create handover'));
    return res.json();
  },

  async acknowledgeHandover(
    handoverId: string,
    name: string,
    role: string
  ): Promise<{
    success: boolean;
    acknowledgement: any;
    handover: Handover;
  }> {
    const res = await apiFetch(`/api/handovers/${handoverId}/acknowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, role })
    });
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to acknowledge handover'));
    return res.json();
  },

  // Reset Demo
  async resetDemo(): Promise<void> {
    const res = await apiFetch('/api/demo/reset', { method: 'POST' });
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'Failed to reset demo'));
  }
};
