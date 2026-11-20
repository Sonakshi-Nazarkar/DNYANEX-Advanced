import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Project, Role, Claim, Source, AuthUser } from '../types';
import { api, getStoredAuthToken, setStoredAuthToken } from '../services/api';
import { DEMO_ACCOUNTS } from '../data/seedData';

export type NavView =
  | 'LANDING'
  | 'DASHBOARD'
  | 'SOURCES'
  | 'RECONSTRUCTION'
  | 'CLAIM_LEDGER'
  | 'REVIEW_DESK'
  | 'TIMELINE'
  | 'RISK_MATRIX'
  | 'ASSISTANT'
  | 'HANDOVERS'
  | 'INCOMING_PORTAL'
  | 'DOCS';

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  message?: string;
}

const LOGOUT_FLAG_KEY = 'dnyanex_logged_out';

interface AppContextType {
  authUser: AuthUser | null;
  isAuthenticated: boolean;
  isAuthModalOpen: boolean;
  setIsAuthModalOpen: (open: boolean) => void;
  login: (email: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  switchRoleSession: (role: Role) => Promise<void>;
  currentRole: Role;
  setCurrentRole: (role: Role) => void;
  activeView: NavView;
  setActiveView: (view: NavView) => void;
  projects: Project[];
  activeProject: Project | null;
  setActiveProject: (proj: Project | null) => void;
  selectedClaim: Claim | null;
  setSelectedClaim: (claim: Claim | null) => void;
  highlightedSource: Source | null;
  setHighlightedSource: (source: Source | null) => void;
  demoStep: number;
  setDemoStep: (step: number) => void;
  toasts: ToastMessage[];
  addToast: (type: ToastMessage['type'], title: string, message?: string) => void;
  removeToast: (id: string) => void;
  refreshProjectData: () => Promise<void>;
  isLoading: boolean;
  resetDemoToCampusConnect: () => Promise<void>;
  isMobileMenuOpen: boolean;
  setIsMobileMenuOpen: (open: boolean) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const [currentRole, setCurrentRole] = useState<Role>('REVIEWER');
  const [activeView, setActiveView] = useState<NavView>('DASHBOARD');
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [selectedClaim, setSelectedClaim] = useState<Claim | null>(null);
  const [highlightedSource, setHighlightedSource] = useState<Source | null>(null);
  const [demoStep, setDemoStep] = useState<number>(1);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState<boolean>(false);

  const addToast = (type: ToastMessage['type'], title: string, message?: string) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts(prev => [...prev, { id, type, title, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4500);
  };

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const refreshProjectData = async () => {
    try {
      const projList = await api.getProjects();
      setProjects(projList);
      if (projList.length > 0) {
        setActiveProject(prev => {
          if (!prev || !projList.find(p => p.id === prev.id)) {
            return projList[0];
          }
          return projList.find(p => p.id === prev.id) || projList[0];
        });
      }
    } catch (err) {
      console.error('Error fetching projects:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (email: string, password: string): Promise<AuthUser> => {
    const session = await api.login(email, password);
    try {
      window.localStorage.removeItem(LOGOUT_FLAG_KEY);
    } catch {
      // Ignore storage error
    }
    setAuthUser(session.user);
    setCurrentRole(session.user.role);
    setIsAuthModalOpen(false);
    await refreshProjectData();
    return session.user;
  };

  const logout = async () => {
    await api.logout();
    try {
      window.localStorage.setItem(LOGOUT_FLAG_KEY, '1');
    } catch {
      // Ignore storage error
    }
    setAuthUser(null);
    setIsAuthModalOpen(true);
    await refreshProjectData();
    addToast('info', 'Signed Out', 'Your DNYANEX session has ended.');
  };

  const switchRoleSession = async (role: Role) => {
    const account = DEMO_ACCOUNTS.find(a => a.role === role);
    if (!account) return;
    try {
      const user = await login(account.email, account.password);
      setCurrentRole(user.role);
    } catch (err: any) {
      addToast('error', 'Role Authentication Failed', err.message);
    }
  };

  // Restore session on mount (or sign into default Reviewer demo session unless explicitly signed out)
  useEffect(() => {
    let mounted = true;
    async function init() {
      const existingToken = getStoredAuthToken();
      let explicitlyLoggedOut = false;
      try {
        explicitlyLoggedOut = window.localStorage.getItem(LOGOUT_FLAG_KEY) === '1';
      } catch {
        explicitlyLoggedOut = false;
      }

      if (existingToken) {
        try {
          const { user } = await api.getMe();
          if (mounted) {
            setAuthUser(user);
            setCurrentRole(user.role);
          }
        } catch {
          setStoredAuthToken(null);
        }
      } else if (!explicitlyLoggedOut) {
        const defaultAccount = DEMO_ACCOUNTS.find(a => a.role === 'REVIEWER');
        if (defaultAccount) {
          try {
            const session = await api.login(defaultAccount.email, defaultAccount.password);
            if (mounted) {
              setAuthUser(session.user);
              setCurrentRole(session.user.role);
            }
          } catch {
            // Leave signed out if server not ready
          }
        }
      }

      if (mounted) {
        await refreshProjectData();
      }
    }
    init();
    return () => {
      mounted = false;
    };
  }, []);

  const resetDemoToCampusConnect = async () => {
    try {
      setIsLoading(true);
      if (!authUser || authUser.role === 'INCOMING_MEMBER') {
        await switchRoleSession('REVIEWER');
      }
      await api.resetDemo();
      await refreshProjectData();
      setDemoStep(1);
      setActiveView('DASHBOARD');
      addToast('success', 'Demo Reset', 'CampusConnect Departure scenario reloaded with fresh state.');
    } catch (err: any) {
      addToast('error', 'Reset Failed', err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AppContext.Provider
      value={{
        authUser,
        isAuthenticated: !!authUser,
        isAuthModalOpen,
        setIsAuthModalOpen,
        login,
        logout,
        switchRoleSession,
        currentRole,
        setCurrentRole,
        activeView,
        setActiveView,
        projects,
        activeProject,
        setActiveProject,
        selectedClaim,
        setSelectedClaim,
        highlightedSource,
        setHighlightedSource,
        demoStep,
        setDemoStep,
        toasts,
        addToast,
        removeToast,
        refreshProjectData,
        isLoading,
        resetDemoToCampusConnect,
        isMobileMenuOpen,
        setIsMobileMenuOpen
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}
